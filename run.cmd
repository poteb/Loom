@echo off
rem Starts Postgres + Caddy (https://localhost) in Docker and the server on the host in watch mode.
rem Double-clickable equivalent of run.ps1 / run.sh.
setlocal
cd /d "%~dp0"
if not exist .env (
  copy /y .env.example .env >nul
  echo created .env from .env.example
)
rem Load KEY=VALUE lines from .env into this process; lines starting with # are comments.
for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do set "%%A=%%B"
if not defined DATABASE_URL set "DATABASE_URL=postgres://loom:loom@localhost:5432/loom"
docker compose --profile dev up -d postgres caddy-dev
if errorlevel 1 exit /b %errorlevel%
echo waiting for postgres...
:wait
timeout /t 1 /nobreak >nul
docker compose exec -T postgres pg_isready -U loom >nul 2>&1
if errorlevel 1 goto wait
call pnpm --filter @loom/web build
if errorlevel 1 exit /b %errorlevel%
echo Loom: https://localhost/w/^<secret^>  (API on http://127.0.0.1:3000)
call pnpm --filter @loom/server dev
