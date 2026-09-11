$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  corepack enable pnpm 2>$null
  if ($LASTEXITCODE -ne 0) { corepack enable --install-directory (npm config get prefix) pnpm }
}
pnpm --version | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "pnpm is not available; see README"; exit 1 }
pnpm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm build
exit $LASTEXITCODE
