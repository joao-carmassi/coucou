# Read-only idle sampler for the running Coucou process (never touches it).
# Usage: powershell -File scripts/idle-measure.ps1 [-Seconds 60] [-Name coucou]
# Exit 1 if CPU delta > 50 ms per 60 s (scaled to the window) or threads/handles grew.
param([int]$Seconds = 60, [string]$Name = 'coucou')
$ErrorActionPreference = 'Stop'
$main = Get-Process -Name $Name -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
if (-not $main) { Write-Host "process '$Name' not running"; exit 2 }
$id = $main.Id

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
    WS = $p.WorkingSet64; WebCpu = ($kids | Measure-Object { $_.TotalProcessorTime.TotalMilliseconds } -Sum).Sum
    WebCount = $kids.Count; WebWS = ($kids | Measure-Object WorkingSet64 -Sum).Sum; ThreadCpu = $tm
  }
}
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
"{0,-22}{1,12:N0}{2,14:N3}" -f 'msedgewebview2 (sum)', $dWeb, (100 * $dWeb / $core)
"threads {0} -> {1}   handles {2} -> {3}" -f $first.Threads, $last.Threads, $first.Handles, $last.Handles
$top = $last.ThreadCpu.GetEnumerator() | ForEach-Object {
  $b = $first.ThreadCpu[$_.Key]; if ($null -ne $b) { [pscustomobject]@{ Tid = $_.Key; DeltaMs = $_.Value - $b } } } |
  Sort-Object DeltaMs -Descending | Select-Object -First 1
if ($top) { "busiest thread: tid {0} +{1:N0} ms" -f $top.Tid, $top.DeltaMs }
$limit = 50 * $Seconds / 60
$fail = $dMain -gt $limit -or $last.Threads -gt $first.Threads -or $last.Handles -gt $first.Handles
if ($fail) { "FAIL (limit $limit ms, threads/handles must not grow)"; exit 1 } else { 'OK'; exit 0 }
