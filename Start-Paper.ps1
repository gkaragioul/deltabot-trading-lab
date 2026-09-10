$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$labNode = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'runtime/paper') -Force | Out-Null
$labProcess = Start-Process -FilePath $labNode -ArgumentList @('src/supervisor.mjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput 'runtime/paper/supervisor.log' -RedirectStandardError 'runtime/paper/supervisor-error.log'
Write-Output "Paper supervisor started (PID $($labProcess.Id)). Run node src/cli.mjs status to inspect it."
