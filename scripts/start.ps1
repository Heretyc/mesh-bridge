$base = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $base 'runtime\MeshBridge.exe'
if (-not (Test-Path -LiteralPath $wrapper)) { throw 'Service is not installed. Run scripts\install.ps1 from elevated PowerShell.' }
& $wrapper start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
