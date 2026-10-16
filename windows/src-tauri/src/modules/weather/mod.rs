// Weather (Open-Meteo, no API key). Two commands, fetched only when the view asks (the TS side caches ~10 min).
// The only data sent is the chosen city's coordinates, and the search text for the geocoding lookup.
// No Module impl: nothing runs in the background, so there is no start/stop.

use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::core::host::ModuleHost;

pub const PREFIXES: &[&str] = &["weather_"];

const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const HOURS: usize = 12;
const CURRENT: &str = "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m";
const HOURLY: &str = "temperature_2m,weather_code,precipitation_probability";
const DAILY: &str = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub time: String,
    pub temp: f64,
    pub feels: f64,
    pub humidity: f64,
    pub wind: f64,
    pub code: u32,
    pub is_day: bool,
}

/// `rain` is the precipitation probability, in percent.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Hour {
    pub time: String,
    pub temp: f64,
    pub code: u32,
    pub rain: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Day {
    pub date: String,
    pub min: f64,
    pub max: f64,
    pub code: u32,
    pub rain: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Forecast {
    pub current: Current,
    pub hours: Vec<Hour>,
    pub days: Vec<Day>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Place {
    pub name: String,
    pub admin: String,
    pub country: String,
    pub lat: f64,
    pub lon: f64,
}

fn valid_coord(lat: f64, lon: f64) -> bool {
    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

pub fn forecast_url(lat: f64, lon: f64, fahrenheit: bool) -> Result<reqwest::Url, String> {
    let unit = if fahrenheit { "fahrenheit" } else { "celsius" };
    reqwest::Url::parse_with_params(
        FORECAST_URL,
        &[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", CURRENT.to_string()),
            ("hourly", HOURLY.to_string()),
            ("daily", DAILY.to_string()),
            ("forecast_days", "5".to_string()),
            ("timezone", "auto".to_string()),
            ("temperature_unit", unit.to_string()),
            ("wind_speed_unit", "kmh".to_string()),
        ],
    )
    .map_err(|e| e.to_string())
}

pub fn search_url(query: &str) -> Result<reqwest::Url, String> {
    reqwest::Url::parse_with_params(GEOCODE_URL, &[("name", query), ("count", "5"), ("language", "pt"), ("format", "json")])
        .map_err(|e| e.to_string())
}

fn field<'a>(o: &'a Value, k: &str) -> Result<&'a Value, String> {
    o.get(k).ok_or_else(|| format!("campo ausente: {k}"))
}

fn num(o: &Value, k: &str) -> Result<f64, String> {
    field(o, k)?.as_f64().ok_or_else(|| format!("campo inválido: {k}"))
}

/// Entries may be null in Open-Meteo's arrays; the caller skips the ones it cannot use.
fn opt_nums(o: &Value, k: &str) -> Result<Vec<Option<f64>>, String> {
    Ok(field(o, k)?.as_array().ok_or_else(|| format!("campo inválido: {k}"))?.iter().map(Value::as_f64).collect())
}

fn strs(o: &Value, k: &str) -> Result<Vec<String>, String> {
    field(o, k)?
        .as_array()
        .ok_or_else(|| format!("campo inválido: {k}"))?
        .iter()
        .map(|x| x.as_str().map(str::to_string).ok_or_else(|| format!("valor inválido em {k}")))
        .collect()
}

/// Open-Meteo JSON -> Forecast. Hours start at the current hour (the API starts at midnight), 12 of them.
/// An hour or day without a temperature or code is skipped; a missing probability reads as 0.
pub fn parse_forecast(v: &Value) -> Result<Forecast, String> {
    let cur = field(v, "current")?;
    let current = Current {
        time: field(cur, "time")?.as_str().ok_or("campo inválido: time")?.to_string(),
        temp: num(cur, "temperature_2m")?,
        feels: num(cur, "apparent_temperature")?,
        humidity: num(cur, "relative_humidity_2m")?,
        wind: num(cur, "wind_speed_10m")?,
        code: num(cur, "weather_code")? as u32,
        is_day: num(cur, "is_day")? == 1.0,
    };

    // Hourly times are whole hours; the current time carries minutes, so the window starts at the current hour.
    let since = current.time.get(..13).unwrap_or(&current.time).to_string() + ":00";
    let hourly = field(v, "hourly")?;
    let (ht, htemp, hcode, hrain) = (
        strs(hourly, "time")?,
        opt_nums(hourly, "temperature_2m")?,
        opt_nums(hourly, "weather_code")?,
        opt_nums(hourly, "precipitation_probability")?,
    );
    let hours = (0..ht.len())
        .filter_map(|i| {
            let t = ht.get(i)?;
            let temp = htemp.get(i).copied().flatten()?;
            let code = hcode.get(i).copied().flatten()?;
            if t.as_str() < since.as_str() {
                return None;
            }
            let rain = hrain.get(i).copied().flatten().unwrap_or(0.0);
            Some(Hour { time: t.clone(), temp, code: code as u32, rain })
        })
        .take(HOURS)
        .collect();

    let daily = field(v, "daily")?;
    let (dd, dmin, dmax, dcode, drain) = (
        strs(daily, "time")?,
        opt_nums(daily, "temperature_2m_min")?,
        opt_nums(daily, "temperature_2m_max")?,
        opt_nums(daily, "weather_code")?,
        opt_nums(daily, "precipitation_probability_max")?,
    );
    let days = (0..dd.len())
        .filter_map(|i| {
            let d = dd.get(i)?;
            let min = dmin.get(i).copied().flatten()?;
            let max = dmax.get(i).copied().flatten()?;
            let code = dcode.get(i).copied().flatten()?;
            let rain = drain.get(i).copied().flatten().unwrap_or(0.0);
            Some(Day { date: d.clone(), min, max, code: code as u32, rain })
        })
        .collect();

    Ok(Forecast { current, hours, days })
}

/// Geocoding JSON -> places. An unknown name has no `results` key: that is an empty list, not an error.
pub fn parse_places(v: &Value) -> Vec<Place> {
    v.get("results")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some(Place {
                        name: r.get("name")?.as_str()?.to_string(),
                        admin: r.get("admin1").and_then(Value::as_str).unwrap_or("").to_string(),
                        country: r.get("country").and_then(Value::as_str).unwrap_or("").to_string(),
                        lat: r.get("latitude")?.as_f64()?,
                        lon: r.get("longitude")?.as_f64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The answer is a few KiB; anything bigger is not Open-Meteo and is not read.
const MAX_BODY: usize = 256 * 1024;

async fn get_json(url: reqwest::Url) -> Result<Value, String> {
    // Redirects off: the hosts are fixed, a redirect would send the request somewhere else.
    static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    });
    let mut res = HTTP.get(url).send().await.map_err(|_| "sem conexão com o serviço de clima".to_string())?;
    if !res.status().is_success() {
        return Err(format!("o serviço de clima respondeu {}", res.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "falha ao ler a resposta do serviço de clima".to_string())? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("resposta grande demais do serviço de clima".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "resposta inválida do serviço de clima".to_string())
}

/// `units`: "F" for Fahrenheit, anything else Celsius.
#[tauri::command]
pub async fn weather_forecast(host: State<'_, ModuleHost>, lat: f64, lon: f64, units: String) -> Result<Forecast, String> {
    host.require("weather")?;
    if !valid_coord(lat, lon) {
        return Err("coordenadas inválidas".into());
    }
    let v = get_json(forecast_url(lat, lon, units == "F")?).await?;
    parse_forecast(&v)
}

#[tauri::command]
pub async fn weather_search(host: State<'_, ModuleHost>, query: String) -> Result<Vec<Place>, String> {
    host.require("weather")?;
    let q = query.trim();
    if q.is_empty() || q.chars().count() > 100 {
        return Err("digite o nome de uma cidade (até 100 letras)".into());
    }
    let v = get_json(search_url(q)?).await?;
    Ok(parse_places(&v))
}

pub fn modules() -> Vec<Box<dyn crate::core::host::Module>> {
    Vec::new()
}

pub fn handler() -> crate::core::host::Handler {
    crate::core::host::handler(tauri::generate_handler![weather_forecast, weather_search])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "current": { "time": "2026-10-15T14:20", "temperature_2m": 21.4, "apparent_temperature": 20.1,
                "relative_humidity_2m": 60, "is_day": 1, "weather_code": 3, "wind_speed_10m": 12.5 },
            "hourly": {
                "time": ["2026-10-15T00:00", "2026-10-15T14:00", "2026-10-15T15:00", "2026-10-15T16:00"],
                "temperature_2m": [15.0, 21.0, 22.0, 20.5],
                "weather_code": [0, 3, 61, 61],
                "precipitation_probability": [null, 10, 70, 80]
            },
            "daily": {
                "time": ["2026-10-15", "2026-10-16"],
                "weather_code": [3, 95],
                "temperature_2m_max": [24.0, 19.5],
                "temperature_2m_min": [13.0, 11.0],
                "precipitation_probability_max": [20, null]
            }
        })
    }

    #[test]
    fn forecast_keeps_hours_from_now_and_days() {
        let f = parse_forecast(&sample()).unwrap();
        assert_eq!(f.current.code, 3);
        assert!(f.current.is_day);
        assert_eq!(f.hours.len(), 3, "midnight hour is in the past");
        assert_eq!(f.hours[0].time, "2026-10-15T14:00");
        assert_eq!(f.hours[2].rain, 80.0);
        assert_eq!(f.days.len(), 2);
        assert_eq!(f.days[1].code, 95);
        assert_eq!(f.days[1].rain, 0.0, "null probability reads as 0");
    }

    #[test]
    fn forecast_caps_hours_at_twelve() {
        let hours: Vec<String> = (0..24).map(|h| format!("2026-10-15T{h:02}:00")).collect();
        let temps = vec![20.0; 24];
        let codes = vec![0; 24];
        let rain = vec![0; 24];
        let mut v = sample();
        v["current"]["time"] = json!("2026-10-15T00:20");
        v["hourly"] = json!({ "time": hours, "temperature_2m": temps, "weather_code": codes, "precipitation_probability": rain });
        assert_eq!(parse_forecast(&v).unwrap().hours.len(), HOURS);
    }

    #[test]
    fn null_entries_are_skipped_not_fatal() {
        let mut v = sample();
        // Last hour has no temperature, last day no code: both are dropped, the rest still parses.
        v["hourly"]["temperature_2m"][3] = json!(null);
        v["daily"]["weather_code"][1] = json!(null);
        let f = parse_forecast(&v).unwrap();
        assert_eq!(f.hours.len(), 2);
        assert_eq!(f.hours.last().unwrap().time, "2026-10-15T15:00");
        assert_eq!(f.days.len(), 1);
    }

    #[test]
    fn forecast_rejects_missing_fields() {
        let mut v = sample();
        v["current"].as_object_mut().unwrap().remove("temperature_2m");
        assert!(parse_forecast(&v).unwrap_err().contains("temperature_2m"));
        assert!(parse_forecast(&json!({})).is_err());
    }

    #[test]
    fn coordinates_are_checked() {
        assert!(valid_coord(-23.55, -46.63));
        assert!(!valid_coord(91.0, 0.0));
        assert!(!valid_coord(0.0, 181.0));
        assert!(!valid_coord(f64::NAN, 0.0));
    }

    #[test]
    fn forecast_url_has_units_and_coordinates() {
        let c = forecast_url(-23.5, -46.6, false).unwrap().to_string();
        assert!(c.starts_with("https://api.open-meteo.com/v1/forecast?"));
        assert!(c.contains("latitude=-23.5"));
        assert!(c.contains("temperature_unit=celsius"));
        assert!(c.contains("wind_speed_unit=kmh"));
        let f = forecast_url(0.0, 0.0, true).unwrap().to_string();
        assert!(f.contains("temperature_unit=fahrenheit"));
    }

    #[test]
    fn search_url_encodes_the_query() {
        let u = search_url("São Paulo & co").unwrap();
        assert_eq!(u.host_str(), Some("geocoding-api.open-meteo.com"));
        let q: Vec<(String, String)> = u.query_pairs().map(|(a, b)| (a.into(), b.into())).collect();
        assert!(q.contains(&("name".into(), "São Paulo & co".into())));
    }

    #[test]
    fn places_parse_and_unknown_city_is_empty() {
        let v = json!({ "results": [
            { "name": "Campinas", "admin1": "São Paulo", "country": "Brasil", "latitude": -22.9, "longitude": -47.06 },
            { "name": "Campinas", "latitude": 1.0 }
        ] });
        let p = parse_places(&v);
        assert_eq!(p.len(), 1, "entry without longitude is dropped");
        assert_eq!(p[0].admin, "São Paulo");
        assert!(parse_places(&json!({ "generationtime_ms": 0.3 })).is_empty());
    }
}
