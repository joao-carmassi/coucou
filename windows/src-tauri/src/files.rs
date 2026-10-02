// Dropped files are copied into %LOCALAPPDATA%\Coucou\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("não consegui ler {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Ainda não dá para soltar pastas.".into());
    }

    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let mut dest = dir.join(&name);
    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        for i in 2..1000 {
            let candidate = dir.join(format!("{stem} ({i}){ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    std::fs::copy(src, &dest).map_err(|e| format!("não consegui copiar: {e}"))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// Writes a window capture (RGB, 8-bit) to the inbox as `{app}-{unix_secs}.png`,
/// shrunk to 1568 px wide so a 4K window stays under the API's 5 MB image limit.
pub fn save_capture(app: &str, w: u32, h: u32, rgb: &[u8]) -> Result<DroppedFile, String> {
    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let (w, h, rgb) = shrink(w, h, rgb, 1568);
    let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let name = format!("{app}-{secs}.png");
    let dest = dir.join(&name);
    let file = std::fs::File::create(&dest).map_err(|e| format!("não consegui salvar a captura: {e}"))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()
        .and_then(|mut writer| writer.write_image_data(&rgb))
        .map_err(|e| format!("não consegui salvar a captura: {e}"))?;
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0),
    })
}

/// Box-downscales an RGB image to `max` px wide (unchanged if already narrower).
fn shrink(w: u32, h: u32, rgb: &[u8], max: u32) -> (u32, u32, Vec<u8>) {
    if w <= max {
        return (w, h, rgb.to_vec());
    }
    let (nw, nh) = (max, ((h as u64 * max as u64 / w as u64) as u32).max(1));
    // Source span of output cell `i` of `n` over `len` pixels, never empty.
    let span = |i: u32, n: u32, len: u32| {
        let a = (i as u64 * len as u64 / n as u64) as u32;
        let b = (((i as u64 + 1) * len as u64 / n as u64) as u32).max(a + 1).min(len);
        a..b
    };
    let mut out = Vec::with_capacity((nw * nh * 3) as usize);
    for y in 0..nh {
        for x in 0..nw {
            let (mut sum, mut n) = ([0u32; 3], 0u32);
            for sy in span(y, nh, h) {
                for sx in span(x, nw, w) {
                    let i = ((sy * w + sx) * 3) as usize;
                    for c in 0..3 {
                        sum[c] += rgb[i + c] as u32;
                    }
                    n += 1;
                }
            }
            out.extend(sum.map(|s| (s / n) as u8));
        }
    }
    (nw, nh, out)
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shrink_averages_and_capture_is_a_png() {
        // 4x2 -> 2x1: each output pixel averages a 2x2 block.
        let rgb: Vec<u8> = (0..8u8).flat_map(|i| [i * 10; 3]).collect();
        let (w, h, out) = shrink(4, 2, &rgb, 2);
        assert_eq!((w, h), (2, 1));
        // left block = pixels 0,1,4,5 -> (0+10+40+50)/4 = 25; right = 2,3,6,7 -> 45
        assert_eq!(out, vec![25, 25, 25, 45, 45, 45]);

        let saved = save_capture("coucou-test", 2, 2, &[255; 12]).unwrap();
        let bytes = std::fs::read(&saved.path).unwrap();
        assert!(bytes.starts_with(b"\x89PNG"));
        let info = png::Decoder::new(bytes.as_slice()).read_info().unwrap();
        assert_eq!((info.info().width, info.info().height), (2, 2));
        let _ = std::fs::remove_file(&saved.path);
    }

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("coucou-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
