param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$logDir = Join-Path $PSScriptRoot 'artifacts'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
try {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $pythonPath = (Get-Command python -ErrorAction Stop).Source
    if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $pythonPath -ArgumentList @('-m','http.server','8080','--bind','127.0.0.1') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'local-web.log') -RedirectStandardError (Join-Path $logDir 'local-web-error.log') | Out-Null
    }
    # Verify the existing web server belongs to this application before opening it.
    $web = $null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try { $web = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/codex-local.js' -UseBasicParsing -TimeoutSec 3; break }
        catch { Start-Sleep -Milliseconds 300 }
    }
    if ($web.Content -notmatch 'window.CodexLocal') { throw 'Port 8080 is in use by another application.' }
    if (-not (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $nodePath -ArgumentList @('codex-bridge.cjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'codex-bridge.log') -RedirectStandardError (Join-Path $logDir 'codex-bridge-error.log') | Out-Null
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8081/status' -Headers @{ Origin = 'http://127.0.0.1:8080' } -TimeoutSec 12
            if ($status.service -ne 'roam-codex') { throw 'Port 8081 is in use by another application.' }
            break
        } catch {
            if ($_.Exception.Response.StatusCode.value__ -eq 401) { break }
            if ($attempt -eq 9) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8080/' }
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("Unable to start the local travel planner. Check Node.js, Python and ports 8080/8081.`n$($_.Exception.Message)", 'TourismPlanning') | Out-Null
    exit 1
}
