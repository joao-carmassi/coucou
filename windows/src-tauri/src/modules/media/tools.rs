// Media tools, pure logic: what a file can be asked to do, where the result goes, size math and the
// ffmpeg command lines. No I/O besides the `exists` probe the caller passes in.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Video,
    Pdf,
    Other,
}

pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];
pub const VIDEO_EXT: &[&str] = &["mp4", "mkv", "mov", "webm", "avi"];

pub fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn kind_of(path: &Path) -> Kind {
    let e = ext_of(path);
    if IMAGE_EXT.contains(&e.as_str()) {
        Kind::Image
    } else if VIDEO_EXT.contains(&e.as_str()) {
        Kind::Video
    } else if e == "pdf" {
        Kind::Pdf
    } else {
        Kind::Other
    }
}

/// Operation ids the UI may ask for, per kind (the Rust side re-checks: the webview is not trusted).
pub fn ops_for(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Image => &["convert", "resize", "compress", "strip", "clipboard", "ocr"],
        Kind::Video => &["gif", "vcompress", "audio"],
        Kind::Pdf | Kind::Other => &[],
    }
}

pub fn needs_ffmpeg(op: &str) -> bool {
    matches!(op, "gif" | "vcompress" | "audio")
}

/// Formats `convert` writes.
pub fn target_format(arg: &str) -> Option<&'static str> {
    match arg.to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "webp" => Some("webp"),
        _ => None,
    }
}

/// Size after scaling by `percent` (1..=100), never below 1 px.
pub fn scaled(w: u32, h: u32, percent: u32) -> (u32, u32) {
    let p = percent.clamp(1, 100) as u64;
    let f = |v: u32| ((v as u64 * p + 50) / 100).max(1) as u32;
    (f(w), f(h))
}

/// "1,4 MB" style size, pt-BR decimal comma.
pub fn human_size(bytes: u64) -> String {
    const U: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{bytes} B") } else { format!("{v:.1} {}", U[i]).replace('.', ",") }
}

/// `dir/stem<suffix>.ext`, or `... (2)`, `(3)`... until `exists` says it is free. Never an existing path.
pub fn unique_path(dir: &Path, stem: &str, suffix: &str, ext: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let name = |n: u32| {
        let tag = if n == 1 { String::new() } else { format!(" ({n})") };
        dir.join(format!("{stem}{suffix}{tag}.{ext}"))
    };
    (1..).map(name).find(|p| !exists(p)).expect("unbounded range")
}

/// Suffix and extension of the result of `op` for a source with extension `src_ext`.
pub fn output_name(op: &str, arg: &str, src_ext: &str) -> Option<(String, String)> {
    Some(match op {
        "convert" => {
            let to = target_format(arg)?;
            // Converting to the same format still needs a different name.
            (if to == src_ext || (to == "jpg" && src_ext == "jpeg") { "-convertido".into() } else { String::new() }, to.into())
        }
        "resize" => (format!("-{}pct", arg.parse::<u32>().ok().filter(|p| (1..100).contains(p))?), src_ext.into()),
        "compress" => ("-comprimido".into(), src_ext.into()),
        "strip" => ("-semmeta".into(), src_ext.into()),
        "ocr" => ("-texto".into(), "txt".into()),
        "gif" => (String::new(), "gif".into()),
        "vcompress" => ("-comprimido".into(), "mp4".into()),
        "audio" => (String::new(), "mp3".into()),
        _ => return None,
    })
}

/// `-progress pipe:1` prefix shared by every ffmpeg run; `-n` refuses to overwrite.
fn base(input: &Path) -> Vec<String> {
    ["-hide_banner", "-nostdin", "-n", "-progress", "pipe:1", "-nostats", "-i"]
        .iter().map(|s| s.to_string()).chain([input.to_string_lossy().into_owned()]).collect()
}

pub fn ffmpeg_args(op: &str, input: &Path, output: &Path) -> Option<Vec<String>> {
    let mut a = base(input);
    let tail: &[&str] = match op {
        // 12 fps, 480 px wide, one generated palette: small and not banded.
        "gif" => &["-vf", "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-an"],
        "vcompress" => &["-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"],
        "audio" => &["-vn", "-c:a", "libmp3lame", "-q:a", "2"],
        _ => return None,
    };
    a.extend(tail.iter().map(|s| s.to_string()));
    a.push(output.to_string_lossy().into_owned());
    Some(a)
}

/// "Duration: 00:01:23.45," in ffmpeg's banner, as ms.
pub fn parse_duration_ms(banner: &str) -> Option<u64> {
    let rest = banner.split("Duration:").nth(1)?.trim_start();
    let t = rest.split(',').next()?.trim();
    let mut p = t.split(':');
    let (h, m, s) = (p.next()?.parse::<f64>().ok()?, p.next()?.parse::<f64>().ok()?, p.next()?.parse::<f64>().ok()?);
    Some(((h * 3600.0 + m * 60.0 + s) * 1000.0) as u64)
}

/// `out_time_us=1234567` from `-progress`, as ms. (`out_time_ms` is also microseconds in ffmpeg: not used.)
pub fn parse_progress_ms(line: &str) -> Option<u64> {
    line.trim().strip_prefix("out_time_us=")?.parse::<u64>().ok().map(|us| us / 1000)
}

pub fn percent(done_ms: u64, total_ms: u64) -> u8 {
    if total_ms == 0 { 0 } else { (done_ms.saturating_mul(100) / total_ms).min(99) as u8 }
}

/// Counts "/Type /Page" objects (not "/Pages"). Good enough for the size line; compressed object streams hide some.
pub fn count_pdf_pages(bytes: &[u8]) -> u32 {
    let mut n = 0;
    let mut i = 0;
    while let Some(p) = bytes[i..].windows(5).position(|w| w == b"/Type") {
        let mut j = i + p + 5;
        while j < bytes.len() && bytes[j] == b' ' { j += 1; }
        if bytes[j..].starts_with(b"/Page") && !bytes[j..].starts_with(b"/Pages") { n += 1; }
        i += p + 5;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_by_extension() {
        assert_eq!(kind_of(Path::new("a/B.PNG")), Kind::Image);
        assert_eq!(kind_of(Path::new("x.mkv")), Kind::Video);
        assert_eq!(kind_of(Path::new("x.pdf")), Kind::Pdf);
        assert_eq!(kind_of(Path::new("x")), Kind::Other);
        assert!(ops_for(Kind::Image).contains(&"ocr") && !ops_for(Kind::Image).contains(&"gif"));
        assert!(ops_for(Kind::Other).is_empty());
        assert!(needs_ffmpeg("gif") && !needs_ffmpeg("convert"));
    }

    #[test]
    fn size_math() {
        assert_eq!(scaled(1000, 501, 50), (500, 251));
        assert_eq!(scaled(1, 1, 10), (1, 1));
        assert_eq!(scaled(100, 100, 500), (100, 100));
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1536), "1,5 KB");
        assert_eq!(human_size(92_234_348), "88,0 MB");
    }

    #[test]
    fn names_never_collide() {
        let taken = ["d/a.png".to_string(), "d/a (2).png".to_string()];
        let ex = |p: &Path| taken.iter().any(|t| Path::new(t) == p);
        assert_eq!(unique_path(Path::new("d"), "a", "", "png", ex), Path::new("d/a (3).png"));
        assert_eq!(unique_path(Path::new("d"), "b", "-x", "jpg", ex), Path::new("d/b-x.jpg"));
    }

    #[test]
    fn output_names() {
        assert_eq!(output_name("convert", "JPG", "png"), Some(("".into(), "jpg".into())));
        assert_eq!(output_name("convert", "jpg", "jpeg"), Some(("-convertido".into(), "jpg".into())));
        assert_eq!(output_name("convert", "gif", "png"), None);
        assert_eq!(output_name("resize", "50", "webp"), Some(("-50pct".into(), "webp".into())));
        assert_eq!(output_name("resize", "100", "webp"), None);
        assert_eq!(output_name("ocr", "", "png").unwrap().1, "txt");
        assert_eq!(output_name("nope", "", "png"), None);
    }

    #[test]
    fn ffmpeg_command_lines() {
        let a = ffmpeg_args("gif", Path::new("in.mp4"), Path::new("out.gif")).unwrap();
        assert_eq!(&a[..3], ["-hide_banner", "-nostdin", "-n"], "never overwrite");
        assert_eq!(a[a.iter().position(|x| x == "-i").unwrap() + 1], "in.mp4");
        assert_eq!(a.last().unwrap(), "out.gif");
        assert!(a.contains(&"-an".to_string()));
        assert!(ffmpeg_args("audio", Path::new("i"), Path::new("o.mp3")).unwrap().contains(&"libmp3lame".to_string()));
        assert!(ffmpeg_args("convert", Path::new("i"), Path::new("o")).is_none());
    }

    #[test]
    fn progress_parsing() {
        assert_eq!(parse_duration_ms("  Duration: 00:01:23.50, start: 0.0"), Some(83_500));
        assert_eq!(parse_duration_ms("Duration: N/A, x"), None);
        assert_eq!(parse_progress_ms("out_time_us=2500000\n"), Some(2500));
        assert_eq!(parse_progress_ms("out_time_us=N/A"), None);
        assert_eq!(percent(50, 100), 50);
        assert_eq!(percent(200, 100), 99);
        assert_eq!(percent(1, 0), 0);
    }

    #[test]
    fn pdf_pages() {
        let pdf = b"<</Type /Pages /Count 2>> <</Type /Page>> <</Type/Page /X 1>> <</Type /Catalog>>";
        assert_eq!(count_pdf_pages(pdf), 2);
    }
}
