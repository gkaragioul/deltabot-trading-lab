$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$cbNode = (Get-Command node -ErrorAction Stop).Source
$cbForwardDir = 'runtime/coinbase-forward-momentum-1.5-hold-180'
New-Item -ItemType Directory -Path $cbForwardDir -Force | Out-Null
$cbProcess = Start-Process -FilePath $cbNode -ArgumentList @('src/cb/cli.mjs','run','--paper-strategy','momentum-1.5-hold-180') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "$cbForwardDir/worker.log" -RedirectStandardError "$cbForwardDir/worker-error.log"
Write-Output "Exploratory Coinbase PAPER challenger started (PID $($cbProcess.Id)). It does not place real orders."
