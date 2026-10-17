// Line parsers for the Claude and Codex JSONL logs. Counters only: no text, no paths (just a folder base name).
// Both formats belong to the tools and are undocumented, so every miss is a `None`, never an error.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Default, Debug, PartialEq, Serialize, Deserialize)]
pub struct Totals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Informational: already part of `output`.
    pub reasoning: u64,
}

impl Totals {
    pub fn add(&mut self, o: &Totals) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.reasoning += o.reasoning;
    }
    pub fn sum(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
    fn covers(&self, o: &Totals) -> bool {
        self.input >= o.input && self.output >= o.output && self.cache_read >= o.cache_read && self.cache_write >= o.cache_write
    }
    fn minus(&self, o: &Totals) -> Totals {
        Totals {
            input: self.input - o.input,
            output: self.output - o.output,
            cache_read: self.cache_read - o.cache_read,
            cache_write: self.cache_write - o.cache_write,
            reasoning: self.reasoning.saturating_sub(o.reasoning),
        }
    }
}

pub struct ClaudeRec {
    pub day: String,
    pub model: String,
    pub tok: Totals,
    pub key: String,
    pub project: String,
}

#[derive(Default)]
pub struct CodexState {
    pub model: String,
    pub last: Option<Totals>,
}

pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn day_key(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// "2026-10-02T13:27:36.517Z" (UTC) -> local day key; `off` = local minus UTC, in seconds.
pub fn local_day(ts: &str, off: i64) -> Option<String> {
    let n = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s + off;
    Some(day_key(secs.div_euclid(86_400)))
}

fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// Last component of a cwd, either separator. The full path is dropped.
fn base_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

pub fn claude_line(line: &str, off: i64) -> Option<ClaudeRec> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let msg = v.get("message")?;
    let usage = msg.get("usage")?;
    let tok = Totals {
        input: u(usage, "input_tokens"),
        output: u(usage, "output_tokens"),
        cache_read: u(usage, "cache_read_input_tokens"),
        cache_write: u(usage, "cache_creation_input_tokens"),
        reasoning: usage.get("output_tokens_details").map_or(0, |d| u(d, "thinking_tokens")),
    };
    let model = msg.get("model")?.as_str()?;
    if model.starts_with('<') {
        return None; // "<synthetic>" messages carry no real usage
    }
    let key = format!("{}|{}", msg.get("id").and_then(Value::as_str)?, v.get("requestId").and_then(Value::as_str).unwrap_or(""));
    Some(ClaudeRec {
        day: local_day(v.get("timestamp")?.as_str()?, off)?,
        model: model.to_string(),
        tok,
        key,
        project: base_name(v.get("cwd").and_then(Value::as_str).unwrap_or("")),
    })
}

pub fn codex_line(line: &str, st: &mut CodexState, off: i64) -> Option<(String, String, Totals)> {
    if !line.contains("token_count") && !line.contains("turn_context") {
        return None; // cheap reject: most lines are neither
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let p = v.get("payload")?;
    match v.get("type")?.as_str()? {
        "turn_context" => {
            if let Some(m) = p.get("model").and_then(Value::as_str) {
                st.model = m.to_string();
            }
            None
        }
        "event_msg" if p.get("type")?.as_str()? == "token_count" => {
            let t = p.get("info")?.get("total_token_usage")?; // info can be null
            let cached = u(t, "cached_input_tokens");
            let total = Totals {
                input: u(t, "input_tokens").saturating_sub(cached),
                output: u(t, "output_tokens"),
                cache_read: cached,
                cache_write: u(t, "cache_write_input_tokens"),
                reasoning: u(t, "reasoning_output_tokens"),
            };
            // Cumulative per file; a drop means the counter restarted, so the new value is all new.
            let delta = match st.last {
                Some(l) if total.covers(&l) => total.minus(&l),
                _ => total,
            };
            st.last = Some(total);
            if delta.sum() == 0 {
                return None;
            }
            let day = local_day(v.get("timestamp")?.as_str()?, off)?;
            let model = if st.model.is_empty() { "codex".to_string() } else { st.model.clone() };
            Some((day, model, delta))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = r#"{"type":"assistant","timestamp":"2026-10-02T13:27:36.517Z","cwd":"C:\\Users\\a\\proj","sessionId":"s","requestId":"req1","message":{"id":"msg1","model":"claude-opus-4-1","content":[{"type":"text","text":"SECRET"}],"usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":40,"output_tokens_details":{"thinking_tokens":5}}}}"#;

    #[test]
    fn claude_sample() {
        let r = claude_line(CLAUDE, 0).unwrap();
        assert_eq!((r.day.as_str(), r.model.as_str(), r.key.as_str(), r.project.as_str()), ("2026-10-02", "claude-opus-4-1", "msg1|req1", "proj"));
        assert_eq!(r.tok, Totals { input: 10, output: 20, cache_read: 40, cache_write: 30, reasoning: 5 });
        assert_eq!(claude_line(CLAUDE, -14 * 3600).unwrap().day, "2026-10-01", "local day, not UTC");
        assert!(claude_line(r#"{"type":"user","message":{}}"#, 0).is_none());
        assert!(claude_line("not json", 0).is_none());
        assert!(claude_line(&CLAUDE.replace("claude-opus-4-1", "<synthetic>"), 0).is_none());
    }

    fn tc(total_in: u64, cached: u64, out: u64) -> String {
        format!(r#"{{"timestamp":"2026-10-02T10:00:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{total_in},"cached_input_tokens":{cached},"output_tokens":{out},"reasoning_output_tokens":1}}}}}}}}"#)
    }

    #[test]
    fn codex_delta_and_reset() {
        let mut st = CodexState::default();
        assert!(codex_line(r#"{"type":"turn_context","payload":{"model":"gpt-5"}}"#, &mut st, 0).is_none());
        let (_, m, t) = codex_line(&tc(100, 60, 10), &mut st, 0).unwrap();
        assert_eq!((m.as_str(), t.input, t.cache_read, t.output), ("gpt-5", 40, 60, 10));
        let (_, _, t) = codex_line(&tc(150, 90, 25), &mut st, 0).unwrap();
        assert_eq!((t.input, t.cache_read, t.output), (20, 30, 15));
        assert!(codex_line(&tc(150, 90, 25), &mut st, 0).is_none(), "no change, no record");
        let (_, _, t) = codex_line(&tc(10, 0, 5), &mut st, 0).unwrap();
        assert_eq!((t.input, t.output), (10, 5), "reset takes the new total");
        let null_info = r#"{"timestamp":"2026-10-02T10:00:00Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#;
        assert!(codex_line(null_info, &mut st, 0).is_none());
    }

    #[test]
    fn civil_round_trip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        for d in [-1, 0, 11_000, 20_000, 19_782] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
        assert_eq!(day_key(days_from_civil(2024, 2, 29)), "2024-02-29");
    }
}
