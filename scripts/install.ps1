$ErrorActionPreference = 'Stop'
$base = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $base 'runtime'
$wrapper = Join-Path $runtime 'MeshBridge.exe'
$config = Join-Path $runtime 'MeshBridge.xml'
$envFile = Join-Path $base '.env'
$serviceJs = Join-Path $base 'dist\service.js'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) { throw 'Run this script from an elevated PowerShell window.' }
if (-not (Test-Path -LiteralPath $envFile)) { throw 'Missing .env. Copy .env.example and configure it first.' }
if (-not (Test-Path -LiteralPath $serviceJs)) { throw 'Missing dist\service.js. Run npm ci and npm run build first.' }

$node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $runtime, (Join-Path $base 'logs') | Out-Null

$url = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$expectedHash = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
if (-not (Test-Path -LiteralPath $wrapper)) {
    $download = Join-Path $runtime 'MeshBridge.download'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $download
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash -ne $expectedHash) {
        Remove-Item -LiteralPath $download -Force
        throw 'WinSW download hash mismatch.'
    }
    Move-Item -LiteralPath $download -Destination $wrapper
}
elseif ((Get-FileHash -Algorithm SHA256 -LiteralPath $wrapper).Hash -ne $expectedHash) {
    throw 'Existing runtime\MeshBridge.exe is not the pinned WinSW 2.12.0 binary.'
}

$xmlNode = [Security.SecurityElement]::Escape($node)
$xmlBase = [Security.SecurityElement]::Escape($base)
$xmlScript = [Security.SecurityElement]::Escape($serviceJs)
@"
<service>
  <id>MeshBridge</id>
  <name>Mesh Bridge</name>
  <description>Discord to Meshtastic USB serial bridge</description>
  <executable>$xmlNode</executable>
  <arguments>&quot;$xmlScript&quot;</arguments>
  <workingdirectory>$xmlBase</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart/>
  <serviceaccount>
    <domain>NT AUTHORITY</domain>
    <user>LocalService</user>
  </serviceaccount>
  <stoptimeout>20 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec" />
  <resetfailure>1 hour</resetfailure>
  <logpath>$xmlBase\logs</logpath>
  <log mode="roll"></log>
</service>
"@ | Set-Content -LiteralPath $config -Encoding UTF8

& icacls.exe $base /grant '*S-1-5-19:(OI)(CI)(RX)' /T /C | Out-Null
& icacls.exe (Join-Path $base 'logs') /grant '*S-1-5-19:(OI)(CI)(M)' /T /C | Out-Null
& icacls.exe $runtime /grant '*S-1-5-19:(OI)(CI)(M)' /T /C | Out-Null
& icacls.exe $envFile /grant '*S-1-5-19:(R)' /C | Out-Null

& $wrapper install
if ($LASTEXITCODE -ne 0) { throw "WinSW install failed with exit code $LASTEXITCODE." }
Write-Host 'Mesh Bridge installed with Automatic (delayed) startup. Run scripts\start.ps1 to start it.'
