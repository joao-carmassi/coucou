# Read-only idle sampler for the running Coucou process (never touches it).
# Works on Windows PowerShell 5 and pwsh.
# Usage: powershell -File scripts/idle-measure.ps1 [-Seconds 60] [-Warmup 10] [-Name coucou] [-Hidden] [-HiddenWait 180]
# -Hidden first waits (up to -HiddenWait s) for the island window to collapse to the wake strip; the island hides
# compactHideInterval (60 s) after the last event, so sampling earlier measures the visible compact island (~10 ms/s
# of main thread from the cursor poll and frames), not the hidden one. Exit 2 if it never collapses (a Claude session
# keeps it up: end the session or use tray Pause).
# Sampling starts after -Warmup seconds. Exit 1 if: main CPU > 50 ms per 60 s (scaled to the window),
# threads grew by more than 3, handles moved by more than 15, or (-Hidden) webview2 sum > 1 % of a core.
# Without -Hidden the webview2 % is informational only.
param([int]$Seconds = 60, [int]$Warmup = 10, [string]$Name = 'coucou', [switch]$Hidden, [int]$HiddenWait = 180)
$ErrorActionPreference = 'Stop'
$main = Get-Process -Name $Name -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
if (-not $main) { Write-Host "process '$Name' not running"; exit 2 }
$id = $main.Id

# Height of the shortest visible top-level window of the process (the collapsed wake strip is 6 px).
Add-Type -Namespace Idle -Name Win -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32")] public static extern bool EnumWindows(EnumProc p, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32")] public static extern bool IsWindowVisible(System.IntPtr h);
public static int MinHeight(uint pid) {
  int min = int.MaxValue;
  EnumWindows(delegate(System.IntPtr h, System.IntPtr l) {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p == pid && IsWindowVisible(h)) { RECT r; if (GetRect(h, out r) && r.b - r.t > 1 && r.b - r.t < min) min = r.b - r.t; }
    return true; }, System.IntPtr.Zero);
  return min;
}
public struct RECT { public int l, t, r, b; }
[System.Runtime.InteropServices.DllImport("user32", EntryPoint = "GetWindowRect")] static extern bool GetRect(System.IntPtr h, out RECT r);
'@

function Get-Set {
  $p = Get-Process -Id $id -ErrorAction Stop
  $all = Get-CimInstance Win32_Process
  $ids = @($id); do { $n = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids }).ProcessId; $ids += $n } while ($n.Count)
  $kids = @($all | Where-Object { $_.Name -eq "msedgewebview2.exe" -and $_.ProcessId -in $ids } |
    ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ })
  $tm = @{}
  foreach ($t in $p.Threads) { $tm[$t.Id] = $t.TotalProcessorTime.TotalMilliseconds }
  [pscustomobject]@{
    MainCpu = $p.TotalProcessorTime.TotalMilliseconds; Threads = $p.Threads.Count; Handles = $p.HandleCount
    WS = $p.WorkingSet64; WebCpu = [double](($kids | ForEach-Object { $_.TotalProcessorTime.TotalMilliseconds } | Measure-Object -Sum).Sum)
    PerProc = @($kids | ForEach-Object { $c = ($all | Where-Object ProcessId -eq $_.Id).CommandLine; [pscustomobject]@{ Id = $_.Id; Type = $(if ($c -match '--type=([\w-]+)') { $matches[1] } else { 'browser' }); Cpu = $_.TotalProcessorTime.TotalMilliseconds } })
    WebCount = $kids.Count; WebWS = [double](($kids | Measure-Object -Property WorkingSet64 -Sum).Sum); ThreadCpu = $tm
  }
}
if ($Hidden) {
  Write-Host "waiting for the island to hide (up to $HiddenWait s)"
  $until = (Get-Date).AddSeconds($HiddenWait)
  while ([Idle.Win]::MinHeight($id) -gt 8) {
    if ((Get-Date) -gt $until) { Write-Host 'island never collapsed to the wake strip: not hidden, nothing measured'; exit 2 }
    Start-Sleep -Seconds 2
  }
}
if ($Warmup -gt 0) { Write-Host "warmup $Warmup s"; Start-Sleep -Seconds $Warmup }
$first = Get-Set; $last = $first
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  Start-Sleep -Seconds ([Math]::Min(5, [Math]::Max(1, [int]($end - (Get-Date)).TotalSeconds)))
  $last = Get-Set
  Write-Host ("{0:HH:mm:ss} cpu+{1,7:N0} ms  threads {2}  handles {3}  ws {4:N0} MB  webview2 {5} procs {6:N0} MB" -f (Get-Date), ($last.MainCpu - $first.MainCpu), $last.Threads, $last.Handles, ($last.WS / 1MB), $last.WebCount, ($last.WebWS / 1MB))
}
$dMain = $last.MainCpu - $first.MainCpu; $dWeb = $last.WebCpu - $first.WebCpu
$core = $Seconds * 1000
"{0,-22}{1,12}{2,14}" -f 'process', 'CPU delta ms', '% of 1 core'
"{0,-22}{1,12:N0}{2,14:N3}" -f "$Name (main)", $dMain, (100 * $dMain / $core)
"{0,-22}{1,12:N0}{2,14:N3}" -f 'msedgewebview2 (sum)', $dWeb, ($webPct = 100 * $dWeb / $core)
foreach ($q in $last.PerProc) { $b = $first.PerProc | Where-Object Id -eq $q.Id; if ($b) { "  webview2 {0,-10} pid {1,6} +{2,6:N0} ms  {3,6:N2} %" -f $q.Type, $q.Id, ($q.Cpu - $b.Cpu), (100 * ($q.Cpu - $b.Cpu) / $core) } }
"threads {0} -> {1}   handles {2} -> {3}" -f $first.Threads, $last.Threads, $first.Handles, $last.Handles
$top = $last.ThreadCpu.GetEnumerator() | ForEach-Object {
  $b = $first.ThreadCpu[$_.Key]; if ($null -ne $b) { [pscustomobject]@{ Tid = $_.Key; DeltaMs = $_.Value - $b } } } |
  Sort-Object DeltaMs -Descending | Select-Object -First 1
if ($top) { "busiest thread: tid {0} +{1:N0} ms" -f $top.Tid, $top.DeltaMs }
$limit = 50 * $Seconds / 60
$why = @()
if ($dMain -gt $limit) { $why += "main CPU $([int]$dMain) ms > $limit ms" }
if ($last.Threads - $first.Threads -gt 3) { $why += 'threads grew > 3' }
if ([Math]::Abs($last.Handles - $first.Handles) -gt 15) { $why += 'handles moved > 15' }
if ($Hidden -and $webPct -gt 1) { $why += ('webview2 {0:N2} % > 1 % while hidden' -f $webPct) }
if ($why) { 'FAIL: ' + ($why -join '; '); exit 1 } else { 'OK'; exit 0 }
