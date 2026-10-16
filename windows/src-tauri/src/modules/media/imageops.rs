// Image tools on the `image` crate: convert, resize, compress, strip metadata, clipboard.
// Re-encoding drops EXIF/XMP/ICC by construction (the crate keeps none), which is what "strip" relies on.
// An animated GIF is read as its first frame.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageEncoder};

use super::tools;

const JPEG_COMPRESS: u8 = 70;
const JPEG_PLAIN: u8 = 92;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Encodes `img` as `ext` into `out`, which must not exist yet.
fn write(img: &DynamicImage, ext: &str, out: &Path, small: bool) -> Result<(), String> {
    let mut w = BufWriter::new(File::create_new(out).map_err(err)?);
    let res = (|| -> Result<(), String> {
        match ext {
            "jpg" | "jpeg" => {
                let rgb = img.to_rgb8();
                JpegEncoder::new_with_quality(&mut w, if small { JPEG_COMPRESS } else { JPEG_PLAIN })
                    .write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                    .map_err(err)
            }
            "webp" => {
                let rgba = img.to_rgba8();
                WebPEncoder::new_lossless(&mut w)
                    .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                    .map_err(err)
            }
            "png" => {
                let rgba = img.to_rgba8();
                let level = if small { CompressionType::Best } else { CompressionType::Default };
                PngEncoder::new_with_quality(&mut w, level, FilterType::Adaptive)
                    .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                    .map_err(err)
            }
            other => Err(format!("formato não suportado para gravar: {other}")),
        }?;
        w.flush().map_err(err)
    })();
    drop(w);
    if res.is_err() {
        let _ = std::fs::remove_file(out); // no half-written result left next to the source
    }
    res
}

/// Runs one image op. `arg` is the target format for convert and the percent for resize.
pub fn run(op: &str, src: &Path, arg: &str, out: &Path) -> Result<(), String> {
    let img = image::open(src).map_err(|e| format!("não consegui abrir a imagem: {e}"))?;
    let out_ext = tools::ext_of(out);
    match op {
        "convert" | "strip" => write(&img, &out_ext, out, false),
        "compress" => write(&img, &out_ext, out, true),
        "resize" => {
            let (w, h) = tools::scaled(img.width(), img.height(), arg.parse().map_err(err)?);
            write(&img.resize_exact(w, h, image::imageops::FilterType::Lanczos3), &out_ext, out, false)
        }
        _ => Err("operação desconhecida".into()),
    }
}

pub fn dimensions(path: &Path) -> Option<(u32, u32)> {
    image::image_dimensions(path).ok()
}

/// A bottom-up 32 bpp DIB (CF_DIB payload) with the alpha flattened onto white.
pub fn dib_bytes(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut v = Vec::with_capacity(40 + rgba.len());
    v.extend(40u32.to_le_bytes());
    v.extend((w as i32).to_le_bytes());
    v.extend((h as i32).to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(32u16.to_le_bytes());
    v.extend([0u8; 4]); // BI_RGB
    v.extend((rgba.len() as u32).to_le_bytes());
    v.extend([0u8; 16]);
    for row in rgba.chunks_exact(w as usize * 4).rev() {
        for p in row.chunks_exact(4) {
            let a = p[3] as u32;
            let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
            v.extend([mix(p[2]), mix(p[1]), mix(p[0]), 255]);
        }
    }
    v
}

/// Puts the image on the clipboard as CF_DIB (everything reads it) and as "PNG" (keeps the transparency).
pub fn to_clipboard(src: &Path) -> Result<(), String> {
    let img = image::open(src).map_err(|e| format!("não consegui abrir a imagem: {e}"))?;
    let rgba = img.to_rgba8();
    let dib = dib_bytes(&rgba, rgba.width(), rgba.height());
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
        .map_err(err)?;
    win::set(&[(8, &dib), (win::png_format(), &png)])
}

mod win {
    use windows::core::w;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    pub fn png_format() -> u32 {
        unsafe { RegisterClipboardFormatW(w!("PNG")) }
    }

    /// Replaces the clipboard with these (format, bytes) entries.
    pub fn set(items: &[(u32, &[u8])]) -> Result<(), String> {
        unsafe {
            OpenClipboard(None).map_err(|e| format!("área de transferência ocupada: {e}"))?;
            let r = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| e.to_string())?;
                for (fmt, data) in items {
                    let h: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, data.len()).map_err(|e| e.to_string())?;
                    let p = GlobalLock(h);
                    if p.is_null() {
                        let _ = GlobalFree(Some(h));
                        return Err("sem memória".into());
                    }
                    std::ptr::copy_nonoverlapping(data.as_ptr(), p as *mut u8, data.len());
                    let _ = GlobalUnlock(h);
                    // On success the clipboard owns the memory.
                    if let Err(e) = SetClipboardData(*fmt, Some(HANDLE(h.0))) {
                        let _ = GlobalFree(Some(h));
                        return Err(e.to_string());
                    }
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            r
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("coucou-imgops-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        let p = tmp(name);
        let _ = std::fs::remove_file(&p);
        let img = RgbaImage::from_fn(8, 4, |x, y| Rgba([(x * 30) as u8, (y * 60) as u8, 128, 255]));
        img.save(&p).unwrap();
        p
    }

    #[test]
    fn convert_resize_compress_strip() {
        let src = fixture("src.png");
        for (op, arg, ext) in [("convert", "jpg", "jpg"), ("convert", "webp", "webp"), ("compress", "", "png"), ("strip", "", "png")] {
            let out = tmp(&format!("o-{op}-{arg}.{ext}"));
            let _ = std::fs::remove_file(&out);
            run(op, &src, arg, &out).unwrap();
            assert_eq!(dimensions(&out), Some((8, 4)), "{op}");
        }
        let out = tmp("o-resize.png");
        let _ = std::fs::remove_file(&out);
        run("resize", &src, "50", &out).unwrap();
        assert_eq!(dimensions(&out), Some((4, 2)));
        // never overwrites
        assert!(run("resize", &src, "50", &out).is_err());
        assert!(run("bogus", &src, "", &tmp("o-bogus.png")).is_err());
        assert!(!tmp("o-bogus.png").exists(), "no leftover");
    }

    #[test]
    fn dib_layout() {
        // 1x2 image: top red opaque, bottom fully transparent (becomes white).
        let d = dib_bytes(&[255, 0, 0, 255, 0, 0, 0, 0], 1, 2);
        assert_eq!(d.len(), 40 + 8);
        assert_eq!(&d[40..44], [255, 255, 255, 255], "bottom row first, flattened onto white");
        assert_eq!(&d[44..48], [0, 0, 255, 255], "BGRA red");
    }
}
