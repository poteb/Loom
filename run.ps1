# Starts Postgres + Caddy (https://localhost) in Docker and the server on the host in watch mode.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "created .env from .env.example" }
Get-Content .env | Where-Object { $_ -match '^\s*[^#][^=]*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), "Process")
}
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = "postgres://loom:loom@localhost:5433/loom" }
docker compose --profile dev up -d postgres caddy-dev
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "waiting for postgres..."
do { Start-Sleep -Seconds 1; docker compose exec -T postgres pg_isready -U loom *> $null } until ($LASTEXITCODE -eq 0)
pnpm --filter @loom/web build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Loom: https://localhost/w/<secret>  (API on http://127.0.0.1:3000)"
pnpm --filter @loom/server dev
