$base = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $base 'runtime\MeshBridge.exe'
if (-not (Test-Path -LiteralPath $wrapper)) { throw 'Service wrapper not found.' }
& $wrapper stop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
(Get-Service -Name 'MeshBridge').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
