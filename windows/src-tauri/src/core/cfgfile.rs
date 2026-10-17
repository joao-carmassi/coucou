// Checked editing of small config files: strict read, fingerprint, diff,
// dated backup, and a write that refuses when the file changed since preview.
//
// Consumers land in later tasks; until then nothing in the crate calls these.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::platform;

/// Missing file -> `{}`. Anything unreadable, invalid or non-object is an
/// error, never `{}`: treating an unreadable file as empty would let a caller
/// write it back over the user's content.
pub fn read_json_strict(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => parse_json(&bytes, &path.display().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("Não consegui ler {}: {e}", path.display())),
    }
}

fn parse_json(bytes: &[u8], path: &str) -> Result<Value, String> {
    // Some editors and PowerShell write a UTF-8 BOM, which serde_json refuses.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} não é um objeto JSON — o Coucou não vai mexer nele.")),
        Err(e) => Err(format!(
            "{path} não é um JSON válido ({e}). Corrija ou mova o arquivo e tente de novo — o Coucou não vai sobrescrevê-lo."
        )),
    }
}

/// FNV-1a over the file bytes; a missing file hashes like an empty one.
pub fn fingerprint_of(path: &Path) -> String {
    fnv(&std::fs::read(path).unwrap_or_default())
}

fn fnv(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// `<name>.bak-YYYYMMDD-HHMMSS`, to the second so two backups in a minute differ.
pub fn backup_path(path: &Path) -> PathBuf {
    let t = platform::local_time();
    path.with_file_name(format!(
        "{}.bak-{:04}{:02}{:02}-{:02}{:02}{:02}",
        file_name(path), t.year, t.month, t.day, t.hour, t.minute, t.second
    ))
}

fn changed_msg(path: &Path) -> String {
    format!("{} mudou desde a prévia. Nada foi gravado — confira o novo diff.", path.display())
}

/// Backs up (if the file exists), then writes `bytes` via temp file + rename.
/// Refuses when the file no longer matches `fingerprint`. Returns the backup
/// path, or "" when there was nothing to back up.
pub fn write_checked(path: &Path, fingerprint: &str, bytes: &[u8]) -> Result<String, String> {
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    if fingerprint_of(path) != fingerprint {
        return Err(changed_msg(path));
    }
    let backup = backup_if_exists(path)?;

    let temp = path.with_file_name(format!("{}.tmp-{}", file_name(path), std::process::id()));
    let res = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, path));
    if let Err(e) = res {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("falha ao gravar: {e}"));
    }
    Ok(backup)
}

/// Backs up, then deletes the file. Same fingerprint refusal as `write_checked`.
pub fn remove_checked(path: &Path, fingerprint: &str) -> Result<String, String> {
    if fingerprint_of(path) != fingerprint {
        return Err(changed_msg(path));
    }
    let backup = backup_if_exists(path)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(backup),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(backup),
        Err(e) => Err(format!("falha ao remover: {e}")),
    }
}

fn backup_if_exists(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let backup = backup_path(path);
    std::fs::copy(path, &backup).map_err(|e| format!("falha no backup: {e}"))?;
    Ok(backup.to_string_lossy().to_string())
}

/// Line diff by plain O(n·m) LCS (fine for small files), 3 lines of context.
pub fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());

    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }

    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "Sem alterações.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        for k in idx.saturating_sub(3)..(idx + 4).min(out.len()) {
            keep[k] = true;
        }
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cfgfile-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("cfg.json")
    }

    #[test]
    fn read_strict() {
        let p = tmp("read");
        assert_eq!(read_json_strict(&p).unwrap(), json!({}));
        std::fs::write(&p, b"\xEF\xBB\xBF{\"a\":1}").unwrap();
        assert_eq!(read_json_strict(&p).unwrap(), json!({"a": 1}));
        std::fs::write(&p, b"  \n").unwrap();
        assert_eq!(read_json_strict(&p).unwrap(), json!({}));
        std::fs::write(&p, b"{nope").unwrap();
        assert!(read_json_strict(&p).is_err());
        std::fs::write(&p, b"[1]").unwrap();
        assert!(read_json_strict(&p).is_err());
    }

    #[test]
    fn fingerprint_missing_equals_empty() {
        let p = tmp("fp");
        assert_eq!(fingerprint_of(&p), fnv(b""));
        std::fs::write(&p, b"x").unwrap();
        assert_ne!(fingerprint_of(&p), fnv(b""));
    }

    #[test]
    fn diff() {
        assert_eq!(unified_diff("a\nb", "a\nb"), "Sem alterações.");
        let d = unified_diff("a\nb\nc", "a\nB\nc");
        assert!(d.contains("- b") && d.contains("+ B") && d.contains("  a"));
    }

    #[test]
    fn backup_name() {
        let n = file_name(&backup_path(Path::new("/x/cfg.json")));
        assert!(n.starts_with("cfg.json.bak-") && n.len() == "cfg.json.bak-".len() + 15);
    }

    #[test]
    fn write_backs_up_and_replaces() {
        let p = tmp("write");
        std::fs::write(&p, b"old").unwrap();
        let fp = fingerprint_of(&p);
        let bak = write_checked(&p, &fp, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        assert_eq!(std::fs::read(&bak).unwrap(), b"old");
        let stray = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(stray, 0);
    }

    #[test]
    fn write_new_file_no_backup() {
        let p = tmp("new");
        let bak = write_checked(&p, &fingerprint_of(&p), b"{}").unwrap();
        assert_eq!(bak, "");
        assert_eq!(std::fs::read(&p).unwrap(), b"{}");
    }

    #[test]
    fn changed_fingerprint_refused_untouched() {
        let p = tmp("stale");
        std::fs::write(&p, b"old").unwrap();
        let fp = fingerprint_of(&p);
        std::fs::write(&p, b"edited").unwrap();
        let err = write_checked(&p, &fp, b"new").unwrap_err();
        assert!(err.contains("mudou desde a prévia"));
        assert_eq!(std::fs::read(&p).unwrap(), b"edited");
        assert!(remove_checked(&p, &fp).is_err());
        assert!(p.exists());
    }

    #[test]
    fn remove_backs_up_then_deletes() {
        let p = tmp("rm");
        std::fs::write(&p, b"bye").unwrap();
        let bak = remove_checked(&p, &fingerprint_of(&p)).unwrap();
        assert!(!p.exists());
        assert_eq!(std::fs::read(&bak).unwrap(), b"bye");
    }
}
