$base = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $base 'runtime\MeshBridge.exe'
if (-not (Test-Path -LiteralPath $wrapper)) { Write-Host 'NOT_INSTALLED'; exit 3 }
$service = Get-Service -Name 'MeshBridge' -ErrorAction SilentlyContinue
if ($null -eq $service) { Write-Host 'NOT_INSTALLED'; exit 3 }
Write-Host $service.Status
if ($service.Status -eq 'Running') { exit 0 }
exit 1
