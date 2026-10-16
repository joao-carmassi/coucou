// LibreHardwareMonitor, optional: read its local web server, or download the pinned release the user chose to fetch.
// We never elevate and never touch its driver: the UAC prompt belongs to LibreHardwareMonitor itself.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// The one release we ever download. Changing the version means changing all four constants together.
pub const VERSION: &str = "0.9.6";
pub const URL: &str = "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v0.9.6/LibreHardwareMonitor.zip";
pub const SIZE: u64 = 6_632_626;
/// SHA-256 of the zip (also the digest GitHub lists for the asset).
pub const SHA256: &str = "086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001";
const EXE: &str = "LibreHardwareMonitor.exe";
const MAX_UNPACKED: u64 = 80 * 1024 * 1024;
const MAX_ENTRIES: usize = 200;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub hardware: String,
    pub label: String,
    pub celsius: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub version: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub installed: bool,
    pub dir: String,
}

pub fn tools_dir() -> PathBuf {
    crate::core::settings::local_dir().join("tools")
}

fn install_dir() -> PathBuf {
    tools_dir().join(format!("LibreHardwareMonitor-{VERSION}"))
}

pub fn exe_path() -> PathBuf {
    install_dir().join(EXE)
}

pub fn info() -> Info {
    Info { version: VERSION, url: URL, size: SIZE, sha256: SHA256, installed: exe_path().is_file(), dir: install_dir().display().to_string() }
}

// ---- reading data.json ----

/// "45,0 °C" / "45.5 °C" -> 45.0 / 45.5. Anything else is not a temperature.
pub fn parse_celsius(v: &str) -> Option<f32> {
    let (num, unit) = v.trim().split_once(' ')?;
    if unit.trim() != "°C" {
        return None;
    }
    num.replace(',', ".").parse::<f32>().ok().filter(|c| (-40.0..=200.0).contains(c))
}

/// Walks LibreHardwareMonitor's sensor tree (Text/Value/Children). Hardware = the node above the "Temperatures" group.
pub fn parse_data(json: &str) -> Vec<Reading> {
    fn walk(n: &serde_json::Value, path: &mut Vec<String>, out: &mut Vec<Reading>) {
        let text = n["Text"].as_str().unwrap_or("").to_string();
        let kids = n["Children"].as_array();
        if kids.is_none_or(|k| k.is_empty()) {
            if let Some(c) = n["Value"].as_str().and_then(parse_celsius) {
                let hardware = path.len().checked_sub(2).map_or(String::new(), |i| path[i].clone());
                out.push(Reading { hardware, label: text, celsius: c });
            }
            return;
        }
        path.push(text);
        for k in kids.unwrap() {
            walk(k, path, out);
        }
        path.pop();
    }
    let mut out = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
        walk(&v, &mut Vec::new(), &mut out);
    }
    out.truncate(40);
    out
}

/// Loopback only, short timeout. `None` = not running / server off.
pub async fn read(port: u16) -> Option<Vec<Reading>> {
    if port < 1024 {
        return None;
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_millis(1500)).no_proxy().redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let mut resp = client.get(format!("http://127.0.0.1:{port}/data.json")).send().await.ok()?.error_for_status().ok()?;
    let mut body = Vec::new();
    while let Some(c) = resp.chunk().await.ok()? {
        body.extend_from_slice(&c);
        if body.len() > 2_000_000 {
            return None; // stream-capped: a hostile local listener cannot make us buffer more
        }
    }
    Some(parse_data(&String::from_utf8_lossy(&body)))
}

// ---- download, verify, extract ----

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hash of a file, streamed.
pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// Extracts every entry under `dest`. An entry whose name would leave `dest` (or is absolute) aborts the whole thing.
pub fn extract_zip(zip_path: &Path, dest: &Path) -> Result<usize, String> {
    let mut z = zip::ZipArchive::new(std::fs::File::open(zip_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if z.len() > MAX_ENTRIES {
        return Err("arquivo zip com entradas demais".into());
    }
    let mut total = 0u64;
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(|e| e.to_string())?;
        total += f.size();
        if total > MAX_UNPACKED {
            return Err("conteúdo do zip maior que o esperado".into());
        }
        f.enclosed_name().ok_or_else(|| format!("caminho inseguro no zip: {}", f.name()))?;
    }
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let rel = f.enclosed_name().ok_or("caminho inseguro no zip")?;
        let out = dest.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(z.len())
}

/// Download the pinned zip, check size and SHA-256 BEFORE extracting, extract to a temp folder, then rename into place.
static INSTALLING: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

/// Clears the busy flag on every exit path.
struct Busy;
impl Drop for Busy {
    fn drop(&mut self) {
        *INSTALLING.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
    }
}

pub async fn install() -> Result<(), String> {
    {
        let mut b = INSTALLING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if *b {
            return Err("já há um download em andamento".into());
        }
        *b = true;
    }
    let _busy = Busy;
    let tools = tools_dir();
    std::fs::create_dir_all(&tools).map_err(|e| e.to_string())?;
    let part = tools.join("LibreHardwareMonitor.zip.part");
    let _ = std::fs::remove_file(&part);
    let res = fetch_and_unpack(&tools, &part).await;
    let _ = std::fs::remove_file(&part);
    res
}

async fn fetch_and_unpack(tools: &Path, part: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .https_only(true)
        .redirect(reqwest::redirect::Policy::custom(|a| {
            let ok = a.url().host_str().is_some_and(|h| h == "github.com" || h.ends_with(".githubusercontent.com"));
            if a.previous().len() >= 5 || !ok { a.stop() } else { a.follow() }
        }))
        .build().map_err(|e| e.to_string())?;
    let mut resp = client.get(URL).send().await.map_err(|e| format!("falha ao baixar: {e}"))?.error_for_status().map_err(|e| format!("falha ao baixar: {e}"))?;
    let mut file = std::fs::File::create(part).map_err(|e| e.to_string())?;
    let mut got = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("falha ao baixar: {e}"))? {
        got += chunk.len() as u64;
        if got > SIZE {
            return Err("o arquivo é maior que o esperado; download cancelado".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    drop(file);
    if got != SIZE {
        return Err(format!("tamanho inesperado ({got} bytes); nada foi extraído"));
    }
    if sha256_file(part).map_err(|e| e.to_string())? != SHA256 {
        return Err("a verificação SHA-256 falhou; nada foi extraído".into());
    }
    let tmp = tools.join(format!("LibreHardwareMonitor-{VERSION}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    let part = part.to_path_buf();
    let dest = tmp.clone();
    let done = crate::core::host::blocking(move || extract_zip(&part, &dest)).await?;
    if let Err(e) = done {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    if !tmp.join(EXE).is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("o zip não contém o LibreHardwareMonitor.exe".into());
    }
    let fin = install_dir();
    let _ = std::fs::remove_dir_all(&fin);
    std::fs::rename(&tmp, &fin).map_err(|e| e.to_string())
}

/// Starts the installed program the way Explorer would (its own manifest asks Windows for administrator rights).
pub fn open() -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let exe = exe_path();
    if !exe.is_file() {
        return Err("o LibreHardwareMonitor não está instalado".into());
    }
    let dir = install_dir();
    let code = unsafe {
        ShellExecuteW(None, w!("open"), &HSTRING::from(exe.as_os_str()), PCWSTR::null(), &HSTRING::from(dir.as_os_str()), SW_SHOWNORMAL).0 as usize
    };
    if code > 32 { Ok(()) } else { Err(format!("o Windows não abriu o programa (código {code})")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn celsius_parsing() {
        assert_eq!(parse_celsius("45,5 °C"), Some(45.5));
        assert_eq!(parse_celsius("45.0 °C"), Some(45.0));
        assert_eq!(parse_celsius("1200 RPM"), None);
        assert_eq!(parse_celsius("12,0 %"), None);
        assert_eq!(parse_celsius("999 °C"), None);
        assert_eq!(parse_celsius(""), None);
    }

    #[test]
    fn data_tree_gives_hardware_and_label() {
        let j = r#"{"Text":"Sensor","Children":[{"Text":"PC","Children":[
          {"Text":"Intel Core i7","Children":[
            {"Text":"Temperatures","Children":[{"Text":"CPU Package","Value":"52,0 °C","Children":[]},{"Text":"Core #1","Value":"49,0 °C"}]},
            {"Text":"Load","Children":[{"Text":"CPU Total","Value":"10,0 %"}]}]},
          {"Text":"NVIDIA RTX","Children":[{"Text":"Temperatures","Children":[{"Text":"GPU Core","Value":"61,0 °C"}]}]}]}]}"#;
        let r = parse_data(j);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0], Reading { hardware: "Intel Core i7".into(), label: "CPU Package".into(), celsius: 52.0 });
        assert_eq!(r[2].hardware, "NVIDIA RTX");
        assert!(parse_data("not json").is_empty());
    }

    #[test]
    fn pinned_constants_are_well_formed() {
        assert_eq!(SHA256.len(), 64);
        assert!(SHA256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert!(URL.starts_with("https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/"));
        assert!(URL.contains(&format!("v{VERSION}/")));
    }

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("coucou-sysmon-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn make_zip(path: &Path, names: &[&str]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for n in names {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"data").unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn hash_detects_a_changed_file() {
        let d = scratch("hash");
        let f = d.join("a.bin");
        std::fs::write(&f, b"abc").unwrap();
        // SHA-256("abc")
        assert_eq!(sha256_file(&f).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        std::fs::write(&f, b"abd").unwrap();
        assert_ne!(sha256_file(&f).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn extract_stays_inside_and_refuses_traversal() {
        let d = scratch("zip");
        let ok = d.join("ok.zip");
        make_zip(&ok, &["LibreHardwareMonitor.exe", "de/res.dll"]);
        assert_eq!(extract_zip(&ok, &d.join("out")).unwrap(), 2);
        assert!(d.join("out/de/res.dll").is_file());

        let bad = d.join("bad.zip");
        make_zip(&bad, &["fine.txt", "../evil.txt"]);
        assert!(extract_zip(&bad, &d.join("out2")).is_err());
        assert!(!d.join("evil.txt").exists());
        assert!(!d.join("out2/fine.txt").exists(), "nothing is written when any entry is unsafe");
        let _ = std::fs::remove_dir_all(d);
    }
}
