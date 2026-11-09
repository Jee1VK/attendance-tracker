param(
    [Parameter(Position=0)]
    [string]$Mode = "prod"
)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
Set-Location $RootDir
node "$ScriptDir\switch-mode.js" $Mode
