$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Write-Host 'This starts REAL Coinbase spot orders with a 20-USDC strategy budget.'
Write-Host 'This strategy has no demonstrated profitability. Keep this window open to manage positions.'
$cbConfirmation = Read-Host 'Type START20 to activate; anything else exits'
if ($cbConfirmation -cne 'START20') { return }
$cbPriorActivation = $env:COINBASE_LIVE_TRADING
try {
    $env:COINBASE_LIVE_TRADING = '1'
    node src/cb/cli.mjs run --mode live --activate-live
} finally {
    if ($null -eq $cbPriorActivation) { Remove-Item Env:COINBASE_LIVE_TRADING -ErrorAction SilentlyContinue }
    else { $env:COINBASE_LIVE_TRADING = $cbPriorActivation }
}
