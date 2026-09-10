$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$cbNode = (Get-Command node -ErrorAction Stop).Source
$cbRecorderDir = 'runtime/coinbase-books'
New-Item -ItemType Directory -Path $cbRecorderDir -Force | Out-Null
$cbProcess = Start-Process -FilePath $cbNode -ArgumentList @('src/cb/record-books.mjs','run') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "$cbRecorderDir/worker.log" -RedirectStandardError "$cbRecorderDir/worker-error.log"
Write-Output "Public Coinbase book recorder launched (PID $($cbProcess.Id)). No trading permissions used."
