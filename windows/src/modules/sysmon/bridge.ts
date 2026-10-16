import { commandOrThrow } from "../../kit/tauri";

export interface Proc { pid: number; name: string; cpu: number; mem: number }
export interface Disk { name: string; total: number; free: number }
export interface Snapshot {
  cpu: number | null; ramUsed: number; ramTotal: number; disks: Disk[]; diskBusy: number | null;
  netDown: number | null; netUp: number | null; gpu: number | null; gpuMem: number | null;
  driveTemps: { name: string; celsius: number }[]; byCpu: Proc[] | null; byMem: Proc[] | null;
}
export interface Probe { cpu: number | null; ram: number | null; disk: number | null }
export interface Port { port: number; pid: number; process: string; exposed: boolean }
export interface SpeedResult { host: string; bytes: number; ms: number; mbps: number }
export interface LhmInfo { version: string; url: string; size: number; sha256: string; installed: boolean; dir: string }
export interface Reading { hardware: string; label: string; celsius: number }

export const SysmonBridge = {
  sample: (procs: boolean, temps: boolean) => commandOrThrow<Snapshot>("sysmon_sample", { opts: { procs, temps } }),
  release: () => commandOrThrow<void>("sysmon_release"),
  alertProbe: (tick: number) => commandOrThrow<Probe>("sysmon_alert_probe", { tick }),
  ports: () => commandOrThrow<Port[]>("sysmon_ports"),
  kill: (pid: number, name: string) => commandOrThrow<void>("sysmon_kill", { pid, name }),
  endpoint: (url: string) => commandOrThrow<string>("sysmon_endpoint", { url }),
  speedtest: (url: string) => commandOrThrow<SpeedResult>("sysmon_speedtest", { url }),
  lhmInfo: () => commandOrThrow<LhmInfo>("sysmon_lhm_info"),
  lhmRead: (port: number) => commandOrThrow<Reading[] | null>("sysmon_lhm_read", { port }),
  lhmInstall: () => commandOrThrow<LhmInfo>("sysmon_lhm_install"),
  lhmOpen: () => commandOrThrow<void>("sysmon_lhm_open"),
};
