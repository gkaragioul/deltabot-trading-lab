$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$cbNode = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path 'runtime/coinbase-paper' -Force | Out-Null
$cbProcess = Start-Process -FilePath $cbNode -ArgumentList @('src/cb/supervisor.mjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput 'runtime/coinbase-paper/supervisor.log' -RedirectStandardError 'runtime/coinbase-paper/supervisor-error.log'
Write-Output "Coinbase paper supervisor started (PID $($cbProcess.Id)). Run node src/cb/cli.mjs status."
