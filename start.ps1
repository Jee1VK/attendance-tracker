# Staff Attendance Tracker - NAS Multi-PC Launcher Script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Starting Staff Attendance Tracker (Standalone NAS App)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$exePath = Join-Path -Path $scriptDir -ChildPath "AttendanceServer.exe"
$cmdToRun = $null

if (Test-Path $exePath) {
    Write-Host "[+] Found Standalone Server Binary: AttendanceServer.exe" -ForegroundColor Green
    Write-Host "[+] NO PYTHON INSTALLATION REQUIRED ON THIS PC!" -ForegroundColor Green
    $cmdToRun = "`"$exePath`""
} else {
    if (Get-Command python -ErrorAction SilentlyContinue) {
        $cmdToRun = "python `"$scriptDir\server.py`""
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        $cmdToRun = "py `"$scriptDir\server.py`""
    } else {
        $possiblePaths = @(
            "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe",
            "C:\Python*\python.exe",
            "C:\Program Files\Python*\python.exe"
        )
        foreach ($p in $possiblePaths) {
            $found = Get-Item $p -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found) {
                $cmdToRun = "`"$($found.FullName)`" `"$scriptDir\server.py`""
                break
            }
        }
    }
}

if (-not $cmdToRun) {
    Write-Host "[!] Could not find AttendanceServer.exe or Python on this PC." -ForegroundColor Red
    Write-Host "    Please ensure AttendanceServer.exe is present in the NAS folder." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit..."
    exit 1
}

Write-Host "[+] Launching backend server on http://localhost:8000 ..." -ForegroundColor Yellow
Write-Host "[+] Opening web browser in 2 seconds..." -ForegroundColor Green
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Keep this window open while using the Attendance Tracker." -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Launch browser after 2.5 seconds
Start-Process "powershell" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"Start-Sleep -Seconds 2.5; Start-Process 'http://localhost:8000'`"" -WindowStyle Hidden

# Launch standalone server (PowerShell natively handles NAS network share paths!)
Set-Location -Path $scriptDir
Invoke-Expression "& $cmdToRun"
