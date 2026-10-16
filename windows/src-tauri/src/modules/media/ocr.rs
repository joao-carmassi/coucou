// OCR with the Windows.Media.Ocr engine: local, no network. Language = the user's profile languages
// (the OCR language packs installed in Windows). Call from a worker thread, never from the UI thread.

use std::path::Path;

use windows::core::HSTRING;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

pub fn recognize(path: &Path) -> Result<String, String> {
    let e = |e: windows::core::Error| e.message();
    let abs = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    // canonicalize gives \\?\C:\...; StorageFile wants the plain form.
    let plain = abs.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let inited = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
    let res = (|| {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| "O Windows não tem um idioma de OCR instalado.".to_string())?;
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(plain)).map_err(e)?.get().map_err(e)?;
        let stream = file.OpenAsync(FileAccessMode::Read).map_err(e)?.get().map_err(e)?;
        let bmp = BitmapDecoder::CreateAsync(&stream).map_err(e)?.get().map_err(e)?
            .GetSoftwareBitmapAsync().map_err(e)?.get().map_err(e)?;
        let max = OcrEngine::MaxImageDimension().unwrap_or(10000) as i32;
        if bmp.PixelWidth().unwrap_or(0) > max || bmp.PixelHeight().unwrap_or(0) > max {
            return Err("Imagem grande demais para o OCR do Windows.".to_string());
        }
        let out = engine.RecognizeAsync(&bmp).map_err(e)?.get().map_err(e)?;
        Ok(out.Text().map_err(e)?.to_string())
    })();
    if inited {
        unsafe { RoUninitialize() };
    }
    res
}
