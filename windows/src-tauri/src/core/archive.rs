// Pinned-download helpers shared by modules that fetch a zip (module code must not call other modules).

use std::io::{Read, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

const MAX_UNPACKED: u64 = 80 * 1024 * 1024;
const MAX_ENTRIES: usize = 200;

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
    extract_zip_where(zip_path, dest, |_| true)
}

/// Like `extract_zip`, but writes only the entries whose path `keep` accepts (all entries are still safety-checked).
pub fn extract_zip_where(zip_path: &Path, dest: &Path, keep: impl Fn(&Path) -> bool) -> Result<usize, String> {
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
        if !f.is_dir() && !keep(&rel) {
            continue;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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

    #[test]
    fn filtered_extract_skips_other_entries() {
        let d = scratch("filter");
        let z = d.join("f.zip");
        make_zip(&z, &["a.exe", "b.txt"]);
        extract_zip_where(&z, &d.join("out"), |p| p.extension().is_some_and(|e| e == "exe")).unwrap();
        assert!(d.join("out/a.exe").is_file() && !d.join("out/b.txt").exists());
        let _ = std::fs::remove_dir_all(d);
    }
}
