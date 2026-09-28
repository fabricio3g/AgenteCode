# Install Agente on Windows.
#
#   irm https://raw.githubusercontent.com/fabricio3g/AgenteCode/main/install.ps1 | iex
#
# Installs Agente Code (the `agente` command) into %LOCALAPPDATA%\Agente\bin
# and adds it to your user PATH. For Agente Desktop too, run:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/fabricio3g/AgenteCode/main/install.ps1))) -Desktop
#
# Parameters: -Desktop (also Desktop), -DesktopOnly, -Version vX.Y.Z.
# $env:AGENTE_REPO overrides the GitHub repository (owner/name).
param(
    [switch]$Desktop,
    [switch]$DesktopOnly,
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far faster without it

$Repo = if ($env:AGENTE_REPO) { $env:AGENTE_REPO } else { 'fabricio3g/AgenteCode' }
$Target = 'x86_64-pc-windows-msvc'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw "Agente for Windows is built for x64; this machine is $($env:PROCESSOR_ARCHITECTURE)."
}

if (-not $Version) {
    $latest = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'agente-install' }
    $Version = $latest.tag_name
}
$Base = "https://github.com/$Repo/releases/download/$Version"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("agente-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

function Install-Cli {
    $name = "agente-$Version-$Target"
    Write-Host "Downloading Agente Code $Version ($Target)..."
    Invoke-WebRequest "$Base/$name.zip" -OutFile "$Tmp\$name.zip"
    Invoke-WebRequest "$Base/SHA256SUMS" -OutFile "$Tmp\SHA256SUMS"
    $line = Get-Content "$Tmp\SHA256SUMS" | Where-Object { $_ -match " $([regex]::Escape("$name.zip"))$" }
    if (-not $line) { throw "No checksum for $name.zip" }
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash "$Tmp\$name.zip" -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { throw "Checksum mismatch for $name.zip" }

    $bin = Join-Path $env:LOCALAPPDATA 'Agente\bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Expand-Archive "$Tmp\$name.zip" -DestinationPath "$Tmp\cli" -Force
    Copy-Item "$Tmp\cli\agente.exe" "$bin\agente.exe" -Force
    Write-Host "Installed agente to $bin\agente.exe"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $bin) {
        [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User')
        Write-Host "Added $bin to your PATH (open a new terminal to use 'agente')."
    }
}

function Install-Desktop {
    $number = $Version.TrimStart('v')
    $file = "Agente-$number-x64.exe"
    Write-Host "Downloading Agente Desktop $Version..."
    Invoke-WebRequest "$Base/$file" -OutFile "$Tmp\$file"
    Write-Host 'Running the installer...'
    Start-Process "$Tmp\$file" -Wait
    Write-Host 'Agente Desktop is installed (look for Agente in the Start menu).'
}

try {
    if (-not $DesktopOnly) { Install-Cli }
    if ($Desktop -or $DesktopOnly) { Install-Desktop }
    Write-Host 'Done.'
} finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
