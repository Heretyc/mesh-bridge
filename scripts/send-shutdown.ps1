# WinSW stop executable: ask the running bridge to shut down over local IPC so
# the Node process exits by itself instead of waiting out the stoptimeout kill.
# Best effort by design - this script must ALWAYS exit 0, because a failure here
# must not block WinSW's fallback ProcessKill path.
$ErrorActionPreference = 'Stop'

try {
  $Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

  $token = $null
  foreach ($line in Get-Content -LiteralPath (Join-Path $Root '.env')) {
    if ($line -match '^\s*IPC_TOKEN\s*=\s*(.*)\s*$') {
      $token = $Matches[1].Trim().Trim('"', "'")
      break
    }
  }
  if ([string]::IsNullOrEmpty($token)) { throw 'IPC_TOKEN not found in .env.' }

  $port = 47652
  $configPath = Join-Path $Root 'config.jsonc'
  if (Test-Path -LiteralPath $configPath) {
    foreach ($line in Get-Content -LiteralPath $configPath) {
      if ($line -match '^\s*"ipcPort"\s*:\s*(\d+)') {
        $port = [int]$Matches[1]
        break
      }
    }
  }

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(2000)) { throw "Timed out connecting to IPC port $port." }
    $client.EndConnect($connect)
    $client.SendTimeout = 2000

    $stream = $client.GetStream()
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $writer = [System.IO.StreamWriter]::new($stream, $utf8)
    $writer.NewLine = "`n"
    $writer.WriteLine($token)
    $writer.WriteLine('shutdown')
    $writer.Flush()
    # Give the service a moment to read the command before the socket drops.
    Start-Sleep -Milliseconds 250
  } finally {
    $client.Close()
  }
} catch {
  Write-Host "send-shutdown: $($_.Exception.Message) (falling back to forced kill)"
}

# WinSW 2.12 applies NO stoptimeout around a configured stopexecutable, so this
# script must own the kill deadline. Regardless of whether the IPC send above
# succeeded, wait up to 15s for the bridge Node process(es) to exit on their own,
# then force-kill any that remain. This runs even after a send failure so the
# stop can never hang.
try {
  $Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  # Match only the bridge process for THIS repo: node.exe whose command line
  # references this worktree's dist\service.js (case-insensitive substring).
  $needle = (Join-Path $Root 'dist\service.js')

  $deadline = (Get-Date).AddSeconds(15)
  do {
    $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle.ToLower()) })
    if ($procs.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle.ToLower()) })
  foreach ($p in $procs) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Write-Host "send-shutdown: force-killed bridge PID $($p.ProcessId)."
    } catch {
      Write-Host "send-shutdown: could not kill PID $($p.ProcessId): $($_.Exception.Message)"
    }
  }
} catch {
  Write-Host "send-shutdown: force-kill phase failed: $($_.Exception.Message)"
}

exit 0
