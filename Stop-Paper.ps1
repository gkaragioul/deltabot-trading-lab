$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node src/cli.mjs stop
