$base = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $base 'runtime\MeshBridge.exe'
if (-not (Test-Path -LiteralPath $wrapper)) { Write-Host 'Mesh Bridge is not installed.'; exit 0 }
& $wrapper stop | Out-Null
& $wrapper uninstall
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Mesh Bridge service uninstalled. Configuration, the %ProgramData%\Mesh Bridge state (logs and journal), and the wrapper remain on disk.'
