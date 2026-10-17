import { commandOrThrow } from "../../kit/tauri";

export interface Disk { name: string; total: number; free: number }
export interface Snapshot {
  cpu: number | null; ramUsed: number; ramTotal: number; disks: Disk[]; diskBusy: number | null;
  netDown: number | null; netUp: number | null; gpu: number | null; gpuMem: number | null;
  driveTemps: { name: string; celsius: number }[];
}
export interface Probe { cpu: number | null; ram: number | null; disk: number | null }
export interface Quick { cpu: number | null; ram: number | null }
export interface LhmInfo { version: string; url: string; size: number; sha256: string; installed: boolean; dir: string }
export interface Reading { hardware: string; label: string; celsius: number }

export const SysmonBridge = {
  sample: (temps: boolean) => commandOrThrow<Snapshot>("sysmon_sample", { opts: { temps } }),
  release: () => commandOrThrow<void>("sysmon_release"),
  alertProbe: (tick: number) => commandOrThrow<Probe>("sysmon_alert_probe", { tick }),
  quick: (fresh: boolean) => commandOrThrow<Quick>("sysmon_quick", { fresh }),
  lhmInfo: () => commandOrThrow<LhmInfo>("sysmon_lhm_info"),
  lhmRead: (port: number) => commandOrThrow<Reading[] | null>("sysmon_lhm_read", { port }),
  lhmInstall: () => commandOrThrow<LhmInfo>("sysmon_lhm_install"),
  lhmOpen: () => commandOrThrow<void>("sysmon_lhm_open"),
};
