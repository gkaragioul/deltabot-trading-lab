$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'Install uv before running this setup.' }
    if (-not (Test-Path -LiteralPath '.venv-research/Scripts/python.exe')) {
        uv venv --python 3.12 .venv-research
        if ($LASTEXITCODE -ne 0) { throw 'Research environment creation failed.' }
    }
    uv pip sync --python .venv-research/Scripts/python.exe --require-hashes --link-mode copy integrations/python/requirements.lock
    if ($LASTEXITCODE -ne 0) { throw 'Research dependency installation failed.' }
    & .venv-research/Scripts/python.exe -m unittest discover -s integrations/python -v
    if ($LASTEXITCODE -ne 0) { throw 'Research integration checks failed.' }
} finally { Pop-Location }
