$ErrorActionPreference = 'SilentlyContinue'
$receiverChildren = @()
try {
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:9076/api/streams' -TimeoutSec 2
    $receiverChildren = @($status.streams | Where-Object { $_.pid } | Select-Object -ExpandProperty pid -Unique)
} catch {}

$connections = Get-NetTCPConnection -LocalPort 9076 -State Listen
$processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)

if ($processIds.Count -eq 0) {
    Write-Host '页面服务当前没有运行。'
}

foreach ($processId in $processIds) {
    Stop-Process -Id $processId -Force
}
foreach ($childId in $receiverChildren) {
    Stop-Process -Id $childId -Force
}

$mediaMtxPidFile = Join-Path $PSScriptRoot 'runtime\mediamtx.pid'
if (Test-Path -LiteralPath $mediaMtxPidFile) {
    $mediaMtxPid = [int](Get-Content -LiteralPath $mediaMtxPidFile -ErrorAction SilentlyContinue)
    if ($mediaMtxPid) { Stop-Process -Id $mediaMtxPid -Force }
    Remove-Item -LiteralPath $mediaMtxPidFile -Force
}

Write-Host 'RV / VISION WebRTC 已停止。'
