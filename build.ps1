$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
corepack enable pnpm
pnpm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm build
exit $LASTEXITCODE
