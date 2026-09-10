$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node src/cb/cli.mjs stop --mode paper
