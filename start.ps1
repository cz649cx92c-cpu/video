$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$binary = Join-Path $projectRoot 'target\x86_64-pc-windows-gnullvm\release\rv1126b-video-wall.exe'
$url = 'http://127.0.0.1:9076'
$mediaMtx = Join-Path $projectRoot 'tools\mediamtx\mediamtx.exe'
$mediaMtxConfig = Join-Path $projectRoot 'mediamtx.yml'
$runtimeDir = Join-Path $projectRoot 'runtime'
$mediaMtxPidFile = Join-Path $runtimeDir 'mediamtx.pid'
$gnuRoot = Join-Path $env:USERPROFILE '.rustup\toolchains\stable-x86_64-pc-windows-gnullvm'
$gnuBin = Join-Path $gnuRoot 'bin'
$gnuRustLib = Join-Path $gnuRoot 'lib\rustlib\x86_64-pc-windows-gnullvm\bin'

Set-Location -LiteralPath $projectRoot

$listener = Get-NetTCPConnection -LocalPort 9076 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Start-Process $url
    Write-Host "RV / VISION is already running: $url" -ForegroundColor Green
    exit 0
}

if (-not (Test-Path -LiteralPath $mediaMtx)) {
    $mediaMtxVersion = 'v1.21.0'
    $mediaMtxArchive = "mediamtx_${mediaMtxVersion}_windows_amd64.zip"
    $mediaMtxUrl = "https://github.com/bluenviron/mediamtx/releases/download/$mediaMtxVersion/$mediaMtxArchive"
    $mediaMtxSha256 = '8a58a9b8c25ee99a96c23dc0a17f39ace3072c01d2e148329073c64ddf83493d'
    $toolsDir = Join-Path $projectRoot 'tools'
    $archivePath = Join-Path $toolsDir $mediaMtxArchive
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    Write-Host "Downloading MediaMTX $mediaMtxVersion..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $mediaMtxUrl -OutFile $archivePath
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $mediaMtxSha256) {
        Remove-Item -LiteralPath $archivePath -Force
        throw "MediaMTX SHA-256 verification failed. The download was removed."
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $mediaMtx) -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath (Split-Path -Parent $mediaMtx) -Force
    Remove-Item -LiteralPath $archivePath -Force
}

$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -Recurse -File) + @(Get-Item -LiteralPath (Join-Path $projectRoot 'Cargo.toml'))
$needsBuild = -not (Test-Path -LiteralPath $binary)
if (-not $needsBuild) {
    $binaryTime = (Get-Item -LiteralPath $binary).LastWriteTimeUtc
    $needsBuild = [bool]($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $binaryTime } | Select-Object -First 1)
}

if ($needsBuild) {
    Write-Host 'Building the Rust receiver...' -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath (Join-Path $gnuBin 'cargo.exe'))) {
        throw 'Rust GNU/LLVM toolchain not found. Install stable-x86_64-pc-windows-gnullvm first.'
    }
    $env:PATH = "$gnuBin;$gnuRustLib;$env:PATH"
    $env:RUSTC = Join-Path $gnuBin 'rustc.exe'
    $env:RUSTDOC = Join-Path $gnuBin 'rustdoc.exe'
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER = Join-Path $gnuRustLib 'rust-lld.exe'
    & (Join-Path $gnuBin 'cargo.exe') build --release
}

$runtimeDll = Join-Path $gnuBin 'libunwind.dll'
$binaryDll = Join-Path (Split-Path -Parent $binary) 'libunwind.dll'
if ((Test-Path -LiteralPath $runtimeDll) -and -not (Test-Path -LiteralPath $binaryDll)) {
    Copy-Item -LiteralPath $runtimeDll -Destination $binaryDll
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$mediaMtxListener = Get-NetTCPConnection -LocalPort 8889 -State Listen -ErrorAction SilentlyContinue
if (-not $mediaMtxListener) {
    $mediaMtxOut = Join-Path $runtimeDir 'mediamtx-output.log'
    $mediaMtxErr = Join-Path $runtimeDir 'mediamtx-error.log'
    $mediaMtxProcess = Start-Process -FilePath $mediaMtx -ArgumentList @($mediaMtxConfig) -WorkingDirectory $projectRoot -RedirectStandardOutput $mediaMtxOut -RedirectStandardError $mediaMtxErr -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $mediaMtxPidFile -Value $mediaMtxProcess.Id
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Get-NetTCPConnection -LocalPort 8889 -State Listen -ErrorAction SilentlyContinue) { break }
        if ($mediaMtxProcess.HasExited) { throw "MediaMTX failed to start. Check: $mediaMtxErr" }
        Start-Sleep -Milliseconds 200
    }
}

Write-Host 'Starting RV / VISION WebRTC...' -ForegroundColor Green
$process = Start-Process -FilePath $binary -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri "$url/api/streams" -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -eq 200) { break }
    } catch {
        Start-Sleep -Milliseconds 300
    }
}

Start-Process $url
Write-Host "RV / VISION opened: $url" -ForegroundColor Green
Write-Host "Background process PID: $($process.Id)"
