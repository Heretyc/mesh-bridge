$base = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $base 'runtime\MeshBridge.exe'
if (-not (Test-Path -LiteralPath $wrapper)) { Write-Host 'NOT_INSTALLED'; exit 3 }
& $wrapper status
exit $LASTEXITCODE
