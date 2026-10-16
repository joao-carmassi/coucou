// System readings: plain Win32 counters (no driver, no admin, no vendor SDK). Everything here runs only when the
// view asks for a sample; the Sampler holds the previous reading (for rates) and one PDH query, and is dropped on stop.

use std::collections::HashMap;
use std::time::Instant;

use serde::Serialize;
use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};
use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::{
    GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::IO::DeviceIoControl;

const DRIVE_FIXED: u32 = 3;
const IF_TYPE_LOOPBACK: u32 = 24;
const IF_TYPE_TUNNEL: u32 = 131;
const IF_OPER_UP: i32 = 1;
const PDH_MORE_DATA: u32 = 0x800007D2;
const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D1400;
const STORAGE_DEVICE_TEMPERATURE_PROPERTY: u32 = 52;
const TOP_N: usize = 8;

// ---- pure logic ----

pub fn ft(f: FILETIME) -> u64 {
    ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64
}

/// (idle, kernel, user) -> busy percent between two readings. Kernel time includes idle time.
pub fn cpu_pct(prev: (u64, u64, u64), cur: (u64, u64, u64)) -> Option<f32> {
    let total = cur.1.checked_sub(prev.1)? + cur.2.checked_sub(prev.2)?;
    if total == 0 {
        return None;
    }
    let idle = cur.0.checked_sub(prev.0)?.min(total);
    Some(((total - idle) as f64 * 100.0 / total as f64) as f32)
}

/// Bytes per second between two counter readings; a reset counter reads as 0.
pub fn rate(prev: u64, cur: u64, secs: f64) -> u64 {
    if secs <= 0.0 {
        return 0;
    }
    (cur.saturating_sub(prev) as f64 / secs) as u64
}

/// GPU engine instances ("pid_1_luid_..._eng_0_engtype_3D", percent): per engine type the sum, overall the busiest type.
pub fn gpu_load(items: &[(String, f64)]) -> f32 {
    let mut by_type: HashMap<&str, f64> = HashMap::new();
    for (name, v) in items {
        let ty = name.rsplit_once("engtype_").map_or("", |(_, t)| t);
        *by_type.entry(ty).or_default() += v;
    }
    by_type.values().cloned().fold(0.0, f64::max).clamp(0.0, 100.0) as f32
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub mem: u64,
}

/// The `n` busiest by CPU and the `n` biggest by memory.
pub fn top_n(all: &[Proc], n: usize) -> (Vec<Proc>, Vec<Proc>) {
    let mut a = all.to_vec();
    a.sort_by(|x, y| y.cpu.total_cmp(&x.cpu));
    a.truncate(n);
    let mut b = all.to_vec();
    b.sort_by(|x, y| y.mem.cmp(&x.mem));
    b.truncate(n);
    (a, b)
}

// ---- readings ----

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub name: String,
    pub total: u64,
    pub free: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveTemp {
    pub name: String,
    pub celsius: f32,
}

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub cpu: Option<f32>,
    pub ram_used: u64,
    pub ram_total: u64,
    pub disks: Vec<Disk>,
    pub disk_busy: Option<f32>,
    pub net_down: Option<u64>,
    pub net_up: Option<u64>,
    pub gpu: Option<f32>,
    pub gpu_mem: Option<u64>,
    pub drive_temps: Vec<DriveTemp>,
    pub by_cpu: Option<Vec<Proc>>,
    pub by_mem: Option<Vec<Proc>>,
}

pub fn cpu_times() -> Option<(u64, u64, u64)> {
    let (mut i, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetSystemTimes(Some(&mut i), Some(&mut k), Some(&mut u)).ok()? };
    Some((ft(i), ft(k), ft(u)))
}

/// (used, total) physical memory in bytes.
pub fn ram() -> Option<(u64, u64)> {
    let mut m = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut m).ok()? };
    Some((m.ullTotalPhys.saturating_sub(m.ullAvailPhys), m.ullTotalPhys))
}

pub fn disks() -> Vec<Disk> {
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + i as u8) as char);
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        unsafe {
            if GetDriveTypeW(PCWSTR(wide.as_ptr())) != DRIVE_FIXED {
                continue;
            }
            let (mut free, mut total) = (0u64, 0u64);
            if GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), Some(&mut total), None).is_ok() && total > 0 {
                out.push(Disk { name: root[..2].into(), total, free });
            }
        }
    }
    out
}

/// Total (in, out) octets of the physical interfaces that are up.
pub fn net_octets() -> Option<(u64, u64)> {
    unsafe {
        let mut t: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut t).0 != 0 || t.is_null() {
            return None;
        }
        let rows = std::slice::from_raw_parts((*t).Table.as_ptr(), (*t).NumEntries as usize);
        let (mut rx, mut tx) = (0u64, 0u64);
        for r in rows {
            let hardware = r.InterfaceAndOperStatusFlags._bitfield & 1 != 0;
            if hardware && r.OperStatus.0 == IF_OPER_UP && r.Type != IF_TYPE_LOOPBACK && r.Type != IF_TYPE_TUNNEL {
                rx += r.InOctets;
                tx += r.OutOctets;
            }
        }
        FreeMibTable(t as *const _);
        Some((rx, tx))
    }
}

/// Every process: (pid, exe name, 100 ns CPU time, working set). Handles are closed before returning.
pub fn processes() -> Vec<(u32, String, u64, u64)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok {
            let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            let name = String::from_utf16_lossy(&e.szExeFile[..n]);
            let (mut cpu, mut mem) = (0u64, 0u64);
            if e.th32ProcessID > 4 {
                if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, e.th32ProcessID) {
                    let (mut c, mut x, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
                    if GetProcessTimes(h, &mut c, &mut x, &mut k, &mut u).is_ok() {
                        cpu = ft(k) + ft(u);
                    }
                    let mut pm = PROCESS_MEMORY_COUNTERS { cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
                    if K32GetProcessMemoryInfo(h, &mut pm, pm.cb).as_bool() {
                        mem = pm.WorkingSetSize as u64;
                    }
                    let _ = CloseHandle(h);
                }
            }
            out.push((e.th32ProcessID, name, cpu, mem));
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

// ---- NVMe / SATA drive temperature (IOCTL_STORAGE_QUERY_PROPERTY, no admin on current Windows) ----

#[repr(C)]
struct PropertyQuery {
    property_id: u32,
    query_type: u32,
    extra: [u8; 1],
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct TempInfo {
    index: u16,
    temperature: i16,
    over: i16,
    under: i16,
    flags: [u8; 4],
}

#[repr(C)]
#[derive(Default)]
struct TempDescriptor {
    version: u32,
    size: u32,
    critical: i16,
    warning: i16,
    info_count: u16,
    reserved0: [u8; 2],
    reserved1: [u32; 2],
    info: [TempInfo; 4],
}

/// The composite temperature of `\\.\PhysicalDriveN`, when the driver reports one.
pub fn drive_temp(n: u32) -> Option<f32> {
    let path: Vec<u16> = format!("\\\\.\\PhysicalDrive{n}").encode_utf16().chain(Some(0)).collect();
    unsafe {
        let h: HANDLE = CreateFileW(PCWSTR(path.as_ptr()), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, Default::default(), None).ok()?;
        let q = PropertyQuery { property_id: STORAGE_DEVICE_TEMPERATURE_PROPERTY, query_type: 0, extra: [0] };
        let mut d = TempDescriptor::default();
        let mut got = 0u32;
        let ok = DeviceIoControl(
            h,
            IOCTL_STORAGE_QUERY_PROPERTY,
            Some(&q as *const _ as *const _),
            size_of::<PropertyQuery>() as u32,
            Some(&mut d as *mut _ as *mut _),
            size_of::<TempDescriptor>() as u32,
            Some(&mut got),
            None,
        )
        .is_ok();
        let _ = CloseHandle(h);
        parse_drive_temp(ok, got as usize, d.info_count, d.info[0].temperature)
    }
}

/// A reading counts only when the call worked, the descriptor is complete and the value is plausible.
pub fn parse_drive_temp(ok: bool, got: usize, count: u16, celsius: i16) -> Option<f32> {
    (ok && got >= 16 && count >= 1 && (1..=150).contains(&celsius)).then_some(celsius as f32)
}

fn drive_temps() -> Vec<DriveTemp> {
    (0..8).filter_map(|n| drive_temp(n).map(|c| DriveTemp { name: format!("Disco {n}"), celsius: c })).collect()
}

// ---- PDH: GPU engines, GPU memory, disk busy ----

struct Pdh {
    q: PDH_HQUERY,
    gpu: PDH_HCOUNTER,
    gpu_mem: PDH_HCOUNTER,
    disk: PDH_HCOUNTER,
}

// shortcut: PDH handles are used only under the SAMPLER mutex, one thread at a time.
unsafe impl Send for Pdh {}

impl Pdh {
    fn open() -> Option<Self> {
        unsafe {
            let mut q = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut q) != 0 {
                return None;
            }
            let add = |path: PCWSTR| {
                let mut c = PDH_HCOUNTER::default();
                if PdhAddEnglishCounterW(q, path, 0, &mut c) == 0 { c } else { PDH_HCOUNTER::default() }
            };
            let p = Pdh {
                q,
                gpu: add(w!("\\GPU Engine(*)\\Utilization Percentage")),
                gpu_mem: add(w!("\\GPU Adapter Memory(*)\\Dedicated Usage")),
                disk: add(w!("\\PhysicalDisk(_Total)\\% Disk Time")),
            };
            let _ = PdhCollectQueryData(q);
            Some(p)
        }
    }

    fn array(&self, counter: PDH_HCOUNTER) -> Vec<(String, f64)> {
        if counter == PDH_HCOUNTER::default() {
            return Vec::new();
        }
        unsafe {
            let (mut size, mut count) = (0u32, 0u32);
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None) != PDH_MORE_DATA {
                return Vec::new();
            }
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                return Vec::new();
            }
            std::slice::from_raw_parts(items, count as usize)
                .iter()
                .filter(|i| i.FmtValue.CStatus == 0)
                .map(|i| (PWSTR(i.szName.0).to_string().unwrap_or_default(), i.FmtValue.Anonymous.doubleValue))
                .collect()
        }
    }

    fn collect(&self) -> (Option<f32>, Option<u64>, Option<f32>) {
        unsafe {
            if PdhCollectQueryData(self.q) != 0 {
                return (None, None, None);
            }
        }
        let gpu = self.array(self.gpu);
        let mem = self.array(self.gpu_mem);
        let disk = self.array(self.disk);
        (
            (!gpu.is_empty()).then(|| gpu_load(&gpu)),
            (!mem.is_empty()).then(|| mem.iter().map(|(_, v)| *v as u64).sum()),
            disk.first().map(|(_, v)| v.clamp(0.0, 100.0) as f32),
        )
    }
}

impl Drop for Pdh {
    fn drop(&mut self) {
        unsafe {
            let _ = PdhCloseQuery(self.q);
        }
    }
}

// ---- the sampler ----

pub struct Sampler {
    at: Instant,
    n: u64,
    cpu: Option<(u64, u64, u64)>,
    net: Option<(u64, u64)>,
    procs: HashMap<u32, u64>,
    pdh: Option<Pdh>,
    drive_temps: Vec<DriveTemp>,
}

/// Longer than this between samples (the view was away): the old reading is no baseline for a rate.
const STALE_SECS: f64 = 10.0;

impl Sampler {
    pub fn new() -> Self {
        Sampler { at: Instant::now(), n: 0, cpu: None, net: None, procs: HashMap::new(), pdh: Pdh::open(), drive_temps: Vec::new() }
    }

    pub fn sample(&mut self, with_procs: bool, with_temps: bool) -> Snapshot {
        let secs = self.at.elapsed().as_secs_f64();
        let stale = self.n == 0 || secs > STALE_SECS;
        let mut s = Snapshot::default();

        let cpu = cpu_times();
        if let (Some(p), Some(c), false) = (self.cpu, cpu, stale) {
            s.cpu = cpu_pct(p, c);
        }
        self.cpu = cpu;

        (s.ram_used, s.ram_total) = ram().unwrap_or_default();
        s.disks = disks();

        let net = net_octets();
        if let (Some(p), Some(c), false) = (self.net, net, stale) {
            s.net_down = Some(rate(p.0, c.0, secs));
            s.net_up = Some(rate(p.1, c.1, secs));
        }
        self.net = net;

        if let Some(p) = &self.pdh {
            (s.gpu, s.gpu_mem, s.disk_busy) = p.collect();
        }
        if stale {
            s.gpu = None; // first PDH reading of a rate counter is meaningless
            s.disk_busy = None;
        }

        if with_temps && (self.n % 5 == 0 || self.drive_temps.is_empty() && self.n < 2) {
            self.drive_temps = drive_temps();
        }
        if with_temps {
            s.drive_temps = self.drive_temps.clone();
        }

        if with_procs {
            let all = processes();
            let ncpu = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
            let list: Vec<Proc> = all
                .iter()
                .filter(|(pid, ..)| *pid != 0)
                .map(|(pid, name, cpu, mem)| {
                    let d = self.procs.get(pid).map_or(0, |p| cpu.saturating_sub(*p));
                    let pct = if stale || secs <= 0.0 { 0.0 } else { (d as f64 / 1e7 / secs / ncpu * 100.0).min(100.0) as f32 };
                    Proc { pid: *pid, name: name.clone(), cpu: pct, mem: *mem }
                })
                .collect();
            self.procs = all.iter().map(|(pid, _, cpu, _)| (*pid, *cpu)).collect();
            let (a, b) = top_n(&list, TOP_N);
            s.by_cpu = Some(a);
            s.by_mem = Some(b);
        }
        self.at = Instant::now();
        self.n += 1;
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_percent_from_deltas() {
        assert_eq!(cpu_pct((0, 0, 0), (50, 100, 100)), Some(75.0)); // total 200, idle 50
        assert_eq!(cpu_pct((10, 20, 20), (10, 20, 20)), None, "no time passed");
        assert_eq!(cpu_pct((5, 10, 10), (4, 20, 20)), None, "counter went back");
    }

    #[test]
    fn rates_never_underflow() {
        assert_eq!(rate(100, 300, 2.0), 100);
        assert_eq!(rate(300, 100, 2.0), 0);
        assert_eq!(rate(1, 2, 0.0), 0);
    }

    #[test]
    fn gpu_is_the_busiest_engine_type() {
        let v = vec![
            ("pid_1_luid_0_phys_0_eng_0_engtype_3D".to_string(), 30.0),
            ("pid_2_luid_0_phys_0_eng_0_engtype_3D".to_string(), 25.0),
            ("pid_2_luid_0_phys_0_eng_3_engtype_VideoDecode".to_string(), 40.0),
        ];
        assert_eq!(gpu_load(&v), 55.0);
        assert_eq!(gpu_load(&[("x_engtype_3D".into(), 400.0)]), 100.0, "clamped");
        assert_eq!(gpu_load(&[]), 0.0);
    }

    #[test]
    fn top_lists_are_sorted_and_cut() {
        let p = |pid, cpu, mem| Proc { pid, name: format!("p{pid}"), cpu, mem };
        let all = vec![p(1, 5.0, 100), p(2, 50.0, 10), p(3, 20.0, 900)];
        let (c, m) = top_n(&all, 2);
        assert_eq!(c.iter().map(|x| x.pid).collect::<Vec<_>>(), [2, 3]);
        assert_eq!(m.iter().map(|x| x.pid).collect::<Vec<_>>(), [3, 1]);
    }

    #[test]
    fn drive_temp_needs_a_plausible_complete_answer() {
        assert_eq!(parse_drive_temp(true, 32, 1, 41), Some(41.0));
        assert_eq!(parse_drive_temp(false, 32, 1, 41), None);
        assert_eq!(parse_drive_temp(true, 8, 1, 41), None, "short answer");
        assert_eq!(parse_drive_temp(true, 32, 0, 41), None, "no sensor");
        assert_eq!(parse_drive_temp(true, 32, 1, 0), None);
        assert_eq!(parse_drive_temp(true, 32, 1, -5), None);
    }

    #[test]
    fn live_readings_are_sane() {
        let (used, total) = ram().unwrap();
        assert!(total > 0 && used <= total);
        assert!(!disks().is_empty());
        assert!(net_octets().is_some());
        let mut s = Sampler::new();
        let a = s.sample(true, true);
        assert!(a.cpu.is_none(), "first sample has no CPU baseline");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let b = s.sample(true, true);
        assert!(b.cpu.is_some_and(|c| (0.0..=100.0).contains(&c)));
        assert!(b.by_cpu.as_ref().is_some_and(|l| !l.is_empty()) && b.by_mem.as_ref().is_some_and(|l| !l.is_empty()));
        eprintln!("sysmon live: gpu={:?} gpuMem={:?} diskBusy={:?} net={:?}/{:?} driveTemps={:?}", b.gpu, b.gpu_mem, b.disk_busy, b.net_down, b.net_up, b.drive_temps);
    }

    fn handle_count() -> u32 {
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
        let mut n = 0;
        unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut n).unwrap() };
        n
    }

    // A view opened and closed 100 times: the sampler (PDH query, snapshots, process handles) leaks nothing.
    #[test]
    fn open_close_100_times_keeps_handles_flat() {
        let mut warm = Sampler::new();
        warm.sample(true, true);
        drop(warm);
        let before = handle_count();
        for _ in 0..100 {
            let mut s = Sampler::new();
            s.sample(true, true);
            s.sample(true, true);
        }
        let after = handle_count();
        assert!(after <= before + 8, "handles grew {before} -> {after}");
    }
}
