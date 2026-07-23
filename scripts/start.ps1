$base = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $base 'runtime\MeshBridge.exe'
if (-not (Test-Path -LiteralPath $wrapper)) { throw 'Service is not installed. Run scripts\install.ps1 from elevated PowerShell.' }
$service = Get-Service -Name 'MeshBridge' -ErrorAction Stop
if ($service.Status -eq 'StopPending') { $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
& $wrapper start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
(Get-Service -Name 'MeshBridge').WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
