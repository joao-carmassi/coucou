// The on-disk counter index and the incremental scan. Nothing here runs unless the view asks for a refresh.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::parse::{claude_line, codex_line, CodexState, Totals};

/// Message keys remembered across all files. Resumed or forked sessions copy earlier messages into a new log.
const SEEN_MAX: usize = 20_000;
/// Most bytes read from one file per step, so a huge log is spread over several budgeted calls.
const CHUNK: u64 = 8 << 20;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Claude,
    Codex,
}

#[derive(Default, Serialize, Deserialize)]
pub struct FileMark {
    pub size: u64,
    pub mtime: u64,
    pub offset: u64,
    /// Codex: last cumulative total and current model, so a resumed read keeps taking deltas.
    pub codex_total: Option<Totals>,
    pub codex_model: String,
}

/// Hashes of recent Claude message keys, oldest first; stored as a plain list.
#[derive(Default, Clone)]
pub struct Seen {
    order: VecDeque<u64>,
    set: HashSet<u64>,
}

impl Seen {
    /// True when the key is new (and now remembered).
    pub fn insert(&mut self, key: &str) -> bool {
        let h = fnv(key);
        if !self.set.insert(h) {
            return false;
        }
        self.order.push_back(h);
        if self.order.len() > SEEN_MAX {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

impl From<Vec<u64>> for Seen {
    fn from(v: Vec<u64>) -> Self {
        Seen { set: v.iter().copied().collect(), order: v.into() }
    }
}

impl From<Seen> for Vec<u64> {
    fn from(s: Seen) -> Self {
        s.order.into()
    }
}

/// FNV-1a: a stable key for a path, so the index never holds a path (the folder name is a project slug).
pub fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

#[derive(Default, Serialize, Deserialize)]
pub struct Day {
    pub tok: Totals,
    pub by_model: BTreeMap<String, Totals>,
    pub by_project: BTreeMap<String, u64>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Index {
    pub v: u32,
    #[serde(with = "seen_serde", default)]
    pub seen: Seen,
    pub files: BTreeMap<String, FileMark>,
    pub days: BTreeMap<String, Day>,
    /// A log shrank and was read again from the start: its old tokens stay counted (shortcut: cannot subtract).
    pub approx: bool,
}

mod seen_serde {
    use super::Seen;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(s: &Seen, ser: S) -> Result<S::Ok, S::Error> {
        Vec::<u64>::from(s.clone()).serialize(ser)
    }
    pub fn deserialize<'a, D: Deserializer<'a>>(de: D) -> Result<Seen, D::Error> {
        Ok(Vec::<u64>::deserialize(de)?.into())
    }
}

/// Reads whole lines of `chunk` into `days`; returns the bytes consumed (up to the last '\n').
pub fn ingest(mark: &mut FileMark, seen: &mut Seen, days: &mut BTreeMap<String, Day>, chunk: &[u8], kind: Kind, off: i64) -> usize {
    let Some(end) = chunk.iter().rposition(|&b| b == b'\n') else { return 0 };
    let mut st = CodexState { model: mark.codex_model.clone(), last: mark.codex_total };
    for line in chunk[..end].split(|&b| b == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else { continue };
        match kind {
            Kind::Claude => {
                let Some(r) = claude_line(line, off) else { continue };
                if !seen.insert(&r.key) {
                    continue;
                }
                let d = days.entry(r.day).or_default();
                d.tok.add(&r.tok);
                d.by_model.entry(r.model).or_default().add(&r.tok);
                if !r.project.is_empty() {
                    *d.by_project.entry(r.project).or_insert(0) += r.tok.sum();
                }
            }
            Kind::Codex => {
                let Some((day, model, t)) = codex_line(line, &mut st, off) else { continue };
                let d = days.entry(day).or_default();
                d.tok.add(&t);
                d.by_model.entry(model).or_default().add(&t);
            }
        }
    }
    mark.codex_model = st.model;
    mark.codex_total = st.last;
    end + 1
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() && depth < 6 => collect(&p, out, depth + 1),
            Ok(t) if t.is_file() && p.extension().is_some_and(|x| x == "jsonl") => out.push(p),
            _ => {}
        }
    }
}

/// Reads what changed since the last scan. Returns true when more is left (budget or chunk limit hit).
pub fn scan(index: &mut Index, roots: &[(PathBuf, Kind)], budget: Duration, off: i64) -> bool {
    let t0 = Instant::now();
    let mut more = false;
    for (root, kind) in roots {
        let mut files = Vec::new();
        collect(root, &mut files, 0);
        for p in files {
            if t0.elapsed() >= budget {
                return true;
            }
            let Ok(meta) = std::fs::metadata(&p) else { continue };
            let size = meta.len();
            let mtime = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            let mark = index.files.entry(format!("{:016x}", fnv(&p.to_string_lossy()))).or_default();
            if mark.size == size && mark.mtime == mtime {
                continue;
            }
            if size < mark.offset {
                *mark = FileMark::default();
                index.approx = true;
            }
            let Ok(mut f) = std::fs::File::open(&p) else { continue };
            if f.seek(SeekFrom::Start(mark.offset)).is_err() {
                continue;
            }
            let mut buf = Vec::new();
            if f.take(CHUNK).read_to_end(&mut buf).is_err() {
                continue;
            }
            let full = buf.len() as u64 == CHUNK;
            let n = ingest(mark, &mut index.seen, &mut index.days, &buf, *kind, off);
            // A full chunk without a newline is one oversized line: skip it rather than stall forever.
            let n = if n == 0 && full { buf.len() } else { n };
            mark.offset += n as u64;
            if full {
                mark.mtime = 0; // look at this file again on the next step
                more = true;
            } else {
                (mark.size, mark.mtime) = (size, mtime);
            }
        }
    }
    more
}

/// Drops days before `cutoff` ("YYYY-MM-DD"); ISO keys sort as text.
pub fn prune(index: &mut Index, cutoff: &str) {
    index.days.retain(|k, _| k.as_str() >= cutoff);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude(id: &str, out: u64) -> String {
        format!(r#"{{"type":"assistant","timestamp":"2026-10-02T13:00:00Z","cwd":"/x/p","requestId":"r","message":{{"id":"{id}","model":"m","usage":{{"input_tokens":1,"output_tokens":{out}}}}}}}"#)
    }

    #[test]
    fn dedupes_in_scan_and_across_scans() {
        let (mut mark, mut seen, mut days) = (FileMark::default(), Seen::default(), BTreeMap::new());
        let a = format!("{}\n{}\n{}\n", claude("a", 5), claude("a", 5), claude("b", 7));
        assert_eq!(ingest(&mut mark, &mut seen, &mut days, a.as_bytes(), Kind::Claude, 0), a.len());
        let b = format!("{}\n{}\n", claude("b", 7), claude("c", 1));
        ingest(&mut mark, &mut seen, &mut days, b.as_bytes(), Kind::Claude, 0);
        let d = &days["2026-10-02"];
        assert_eq!(d.tok.output, 13, "a=5 b=7 c=1");
        assert_eq!(d.by_project["p"], 16);
        assert_eq!(d.by_model["m"].input, 3);
    }

    #[test]
    fn forked_log_does_not_double_count() {
        let (mut seen, mut days) = (Seen::default(), BTreeMap::new());
        let (mut m1, mut m2) = (FileMark::default(), FileMark::default());
        let a = format!("{}\n{}\n", claude("a", 5), claude("b", 7));
        ingest(&mut m1, &mut seen, &mut days, a.as_bytes(), Kind::Claude, 0);
        let fork = format!("{a}{}\n", claude("c", 1)); // a resumed session copies the earlier messages
        ingest(&mut m2, &mut seen, &mut days, fork.as_bytes(), Kind::Claude, 0);
        assert_eq!(days["2026-10-02"].tok.output, 13);
        let mut back: Seen = Vec::<u64>::from(seen).into();
        assert!(!back.insert("a|r"), "the list survives a round-trip");
        assert!(back.insert("zzz|r"));
    }

    #[test]
    fn partial_last_line_waits() {
        let (mut mark, mut seen, mut days) = (FileMark::default(), Seen::default(), BTreeMap::new());
        let full = format!("{}\n", claude("a", 5));
        let text = format!("{full}{}", &claude("b", 9)[..40]);
        let n = ingest(&mut mark, &mut seen, &mut days, text.as_bytes(), Kind::Claude, 0);
        assert_eq!(n, full.len());
        assert_eq!(days["2026-10-02"].tok.output, 5);
        assert_eq!(ingest(&mut mark, &mut seen, &mut days, b"no newline", Kind::Claude, 0), 0);
    }

    #[test]
    fn codex_resumes_with_the_saved_total() {
        let tc = |i: u64| format!("{{\"timestamp\":\"2026-10-02T10:00:00Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"input_tokens\":{i},\"output_tokens\":0}}}}}}}}\n");
        let (mut mark, mut seen, mut days) = (FileMark::default(), Seen::default(), BTreeMap::new());
        ingest(&mut mark, &mut seen, &mut days, tc(100).as_bytes(), Kind::Codex, 0);
        ingest(&mut mark, &mut seen, &mut days, tc(130).as_bytes(), Kind::Codex, 0);
        assert_eq!(days["2026-10-02"].tok.input, 130);
    }

    #[test]
    fn prune_and_round_trip() {
        let mut ix = Index { v: 1, ..Default::default() };
        for k in ["2026-01-01", "2026-09-30", "2026-10-02"] {
            ix.days.insert(k.into(), Day::default());
        }
        ix.days.get_mut("2026-10-02").unwrap().tok.output = 4;
        ix.files.insert("f".into(), FileMark { offset: 9, ..Default::default() });
        prune(&mut ix, "2026-09-30");
        assert_eq!(ix.days.keys().collect::<Vec<_>>(), ["2026-09-30", "2026-10-02"]);
        let back: Index = serde_json::from_str(&serde_json::to_string(&ix).unwrap()).unwrap();
        assert_eq!((back.days["2026-10-02"].tok.output, back.files["f"].offset), (4, 9));
    }

    #[test]
    fn scan_reads_only_new_bytes() {
        let dir = std::env::temp_dir().join(format!("coucou-aistats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let f = dir.join("sub").join("s.jsonl");
        std::fs::write(&f, format!("{}\n", claude("a", 5))).unwrap();
        let roots = [(dir.clone(), Kind::Claude)];
        let mut ix = Index::default();
        assert!(!scan(&mut ix, &roots, Duration::from_secs(5), 0));
        let mut s = std::fs::read_to_string(&f).unwrap();
        s.push_str(&format!("{}\n", claude("b", 6)));
        std::fs::write(&f, s).unwrap();
        scan(&mut ix, &roots, Duration::from_secs(5), 0);
        scan(&mut ix, &roots, Duration::from_secs(5), 0);
        assert_eq!(ix.days["2026-10-02"].tok.output, 11);
        std::fs::write(&f, format!("{}\n", claude("z", 1))).unwrap(); // shrank
        scan(&mut ix, &roots, Duration::from_secs(5), 0);
        assert!(ix.approx);
        assert!(ix.files.keys().all(|k| k.len() == 16 && !k.contains(['/', '\\'])), "no path in the index");
        assert!(scan(&mut ix, &roots, Duration::ZERO, 0), "no budget leaves work");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
