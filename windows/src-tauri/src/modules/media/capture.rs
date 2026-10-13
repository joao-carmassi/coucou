// Screenshot of the window under the cursor: Mochi dropped on it (attach_window).
// The pixels go through files::save_capture into the inbox, then the Mídia list.

use ::windows::core::PWSTR;
use ::windows::Win32::Foundation::{CloseHandle, POINT, RECT};
use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use ::windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use ::windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetWindowRect, GetWindowThreadProcessId, IsIconic, WindowFromPoint, GA_ROOT,
};

/// Screenshots the top-level window under the cursor. Returns (app name, width,
/// height, RGB pixels) in physical pixels. Our own windows and minimized ones are
/// refused, so a drop on the island never captures Coucou.
pub fn capture_under_cursor() -> Result<(String, u32, u32, Vec<u8>), String> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).map_err(|_| "Não consegui ler o cursor.".to_string())? };
    // The whole top-level window, not the child control under the cursor.
    let hwnd = unsafe { GetAncestor(WindowFromPoint(p), GA_ROOT) };
    if hwnd.0.is_null() {
        return Err("Não há janela embaixo do Mochi.".into());
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == std::process::id() {
        return Err("Solte o Mochi na janela de outro app.".into());
    }
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return Err("Essa janela está minimizada.".into());
    }

    // The visible frame: GetWindowRect includes Win11's invisible border and the
    // overhang of maximized windows.
    let mut rect = RECT::default();
    let dwm = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if dwm.is_err() {
        unsafe { GetWindowRect(hwnd, &mut rect).map_err(|_| "Não consegui ler o tamanho da janela.".to_string())? };
    }
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    if !(8..=8192).contains(&w) || !(8..=8192).contains(&h) {
        return Err("Essa janela não tem um tamanho utilizável.".into());
    }

    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("Não consegui acessar a tela.".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        if mem.is_invalid() || bmp.is_invalid() {
            if !bmp.is_invalid() {
                let _ = DeleteObject(bmp.into());
            }
            if !mem.is_invalid() {
                let _ = DeleteDC(mem);
            }
            ReleaseDC(None, screen);
            return Err("Não consegui criar o buffer de captura.".into());
        }
        let old = SelectObject(mem, bmp.into());
        // A screen blit: what is visible there is what gets captured.
        let blit = BitBlt(mem, 0, 0, w, h, Some(screen), rect.left, rect.top, SRCCOPY).is_ok();
        SelectObject(mem, old);

        let result = if blit {
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                Some(bgra.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            );
            if lines == 0 {
                Err("Não consegui ler os pixels capturados.".to_string())
            } else {
                // BGRA to RGB: the alpha of a screen blit is garbage.
                let mut rgb = Vec::with_capacity((w * h * 3) as usize);
                for px in bgra.chunks_exact(4) {
                    rgb.extend_from_slice(&[px[2], px[1], px[0]]);
                }
                Ok(rgb)
            }
        } else {
            Err("Não consegui capturar essa janela.".to_string())
        };
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        result.map(|rgb| (process_stem(pid), w as u32, h as u32, rgb))
    }
}

/// File stem of the process's executable ("notepad"), or "window" if unknown.
fn process_stem(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return "window".into();
        };
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| ok && !s.is_empty())
            .unwrap_or_else(|| "window".into())
    }
}
