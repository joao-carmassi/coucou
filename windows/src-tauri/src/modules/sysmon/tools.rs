// The things the user asks for by clicking: listening ports, end a process, speed test. Nothing here runs by itself.

use std::time::{Duration, Instant};

use serde::Serialize;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

use super::metrics;

const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub port: u16,
    pub pid: u32,
    pub process: String,
    /// Reachable from other machines (bound to every address), not only this one.
    pub exposed: bool,
}

/// The port is stored in network byte order in the low 16 bits.
pub fn port_of(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}

/// Sorted by port; one row per (port, pid) even when both IPv4 and IPv6 listen.
pub fn dedupe(mut v: Vec<Port>) -> Vec<Port> {
    v.sort_by(|a, b| (a.port, a.pid, !a.exposed).cmp(&(b.port, b.pid, !b.exposed)));
    v.dedup_by(|b, a| a.port == b.port && a.pid == b.pid);
    v
}

fn table(af: u32) -> Option<Vec<u8>> {
    let mut size = 0u32;
    unsafe {
        let _ = GetExtendedTcpTable(None, &mut size, false, af, TCP_TABLE_OWNER_PID_LISTENER, 0);
        for _ in 0..3 {
            let mut buf = vec![0u8; size as usize + 512];
            let mut len = buf.len() as u32;
            match GetExtendedTcpTable(Some(buf.as_mut_ptr() as *mut _), &mut len, false, af, TCP_TABLE_OWNER_PID_LISTENER, 0) {
                0 => return Some(buf),
                122 => size = len, // ERROR_INSUFFICIENT_BUFFER: the table grew meanwhile
                _ => return None,
            }
        }
    }
    None
}

pub fn listening_ports() -> Vec<Port> {
    let names: std::collections::HashMap<u32, String> = metrics::processes().into_iter().map(|(p, n, ..)| (p, n)).collect();
    let name = |pid: u32| names.get(&pid).cloned().unwrap_or_default();
    let mut out = Vec::new();
    if let Some(b) = table(AF_INET) {
        unsafe {
            let n = *(b.as_ptr() as *const u32) as usize;
            let rows = std::slice::from_raw_parts(b.as_ptr().add(4) as *const MIB_TCPROW_OWNER_PID, n);
            out.extend(rows.iter().map(|r| Port { port: port_of(r.dwLocalPort), pid: r.dwOwningPid, process: name(r.dwOwningPid), exposed: r.dwLocalAddr != u32::from_ne_bytes([127, 0, 0, 1]) }));
        }
    }
    if let Some(b) = table(AF_INET6) {
        unsafe {
            let n = *(b.as_ptr() as *const u32) as usize;
            let rows = std::slice::from_raw_parts(b.as_ptr().add(4) as *const MIB_TCP6ROW_OWNER_PID, n);
            let loopback = |a: &[u8; 16]| a[..15].iter().all(|x| *x == 0) && a[15] == 1;
            out.extend(rows.iter().map(|r| Port { port: port_of(r.dwLocalPort), pid: r.dwOwningPid, process: name(r.dwOwningPid), exposed: !loopback(&r.ucLocalAddr) }));
        }
    }
    dedupe(out)
}

/// Ends one process the user picked. The name must still match (the pid may have been reused); never Coucou itself,
/// System or Idle. Needs no elevation: protected processes answer "acesso negado" and stay alive.
pub fn kill(pid: u32, name: &str) -> Result<(), String> {
    if pid <= 4 || pid == std::process::id() {
        return Err("este processo não pode ser encerrado".into());
    }
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|_| "acesso negado ou o processo já fechou".to_string())?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let res = if !ok || !same_exe(&path, name) {
            Err("o processo mudou desde a leitura; atualize a lista".to_string())
        } else {
            TerminateProcess(h, 1).map_err(|e| e.message())
        };
        let _ = CloseHandle(h);
        res
    }
}

pub fn same_exe(full_path: &str, name: &str) -> bool {
    full_path.rsplit(['\\', '/']).next().is_some_and(|f| f.eq_ignore_ascii_case(name)) && !name.is_empty()
}

// ---- speed test ----

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeedResult {
    pub host: String,
    pub bytes: u64,
    pub ms: u64,
    pub mbps: f64,
}

/// https only, a host, no credentials in the URL. Returns the host the click will contact.
pub fn endpoint_host(url: &str) -> Result<String, String> {
    if url.len() > 2048 {
        return Err("endereço longo demais".into());
    }
    let u = reqwest::Url::parse(url.trim()).map_err(|_| "endereço inválido".to_string())?;
    if u.scheme() != "https" {
        return Err("use um endereço https://".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("o endereço não pode conter usuário ou senha".into());
    }
    u.host_str().map(|h| h.to_string()).ok_or_else(|| "endereço sem servidor".into())
}

const MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TIME: Duration = Duration::from_secs(12);

pub fn mbps(bytes: u64, ms: u64) -> f64 {
    if ms == 0 { 0.0 } else { bytes as f64 * 8.0 / (ms as f64 / 1000.0) / 1e6 }
}

/// One GET of the user's endpoint, read for at most 12 s / 50 MB, body discarded. No redirects: it contacts what was shown.
pub async fn speedtest(url: &str) -> Result<SpeedResult, String> {
    let host = endpoint_host(url)?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(MAX_TIME + Duration::from_secs(3)).build().map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let mut resp = client.get(url.trim()).send().await.map_err(|e| format!("falha: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("o servidor respondeu {}", resp.status()));
    }
    let mut bytes = 0u64;
    while let Some(c) = resp.chunk().await.map_err(|e| format!("falha: {e}"))? {
        bytes += c.len() as u64;
        if bytes >= MAX_BYTES || t0.elapsed() >= MAX_TIME {
            break;
        }
    }
    let ms = t0.elapsed().as_millis() as u64;
    if bytes == 0 {
        return Err("o servidor não enviou dados".into());
    }
    Ok(SpeedResult { host, bytes, ms, mbps: mbps(bytes, ms) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_byte_order() {
        assert_eq!(port_of(0x5000), 80);
        assert_eq!(port_of(0xBB01), 443);
    }

    #[test]
    fn ports_are_deduped_per_pid() {
        let p = |port, pid, exposed| Port { port, pid, process: String::new(), exposed };
        let d = dedupe(vec![p(80, 4, false), p(22, 9, true), p(80, 4, true), p(80, 5, false)]);
        assert_eq!(d.iter().map(|x| (x.port, x.pid)).collect::<Vec<_>>(), [(22, 9), (80, 4), (80, 5)]);
        assert!(d[1].exposed, "exposed wins when one family is open to the network");
    }

    #[test]
    fn kill_refuses_system_and_self() {
        assert!(kill(0, "x").is_err() && kill(4, "System").is_err());
        assert!(kill(std::process::id(), "coucou.exe").is_err());
    }

    #[test]
    fn exe_name_check() {
        assert!(same_exe("C:\\Windows\\notepad.EXE", "notepad.exe"));
        assert!(!same_exe("C:\\Windows\\notepad.exe", "calc.exe"));
        assert!(!same_exe("C:\\x\\", ""));
    }

    #[test]
    fn endpoint_rules() {
        assert_eq!(endpoint_host("https://speed.example.com/file?x=1").unwrap(), "speed.example.com");
        assert!(endpoint_host("http://speed.example.com/f").is_err());
        assert!(endpoint_host("https://user:pw@speed.example.com/f").is_err());
        assert!(endpoint_host("ftp://x/y").is_err());
        assert!(endpoint_host("not a url").is_err());
    }

    #[test]
    fn speed_math() {
        assert_eq!(mbps(12_500_000, 1000), 100.0);
        assert_eq!(mbps(1, 0), 0.0);
    }

    #[test]
    fn listening_ports_run() {
        let _ = listening_ports(); // must not crash or leak on this machine
    }
}
