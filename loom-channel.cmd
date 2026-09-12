@echo off
rem Starts a Claude Code session with the Loom channel enabled.
rem
rem Claude Code's channel check only accepts servers from its config scopes (not --mcp-config), so
rem this registers the channel server at *local* scope (this project, this user) for the lifetime of
rem the session and removes it again when claude exits. Other sessions started in this project while
rem it runs also spawn the channel process; that is safe (per-session cursors, locked state).
rem
rem Extra arguments are passed to claude (e.g. loom-channel.cmd --resume).
rem Set LOOM_URL to point at a deployed Loom instead of the local dev server.
setlocal
cd /d "%~dp0"
if not exist src\claude-channel\dist\server.js (
  echo src\claude-channel\dist\server.js missing - run build.ps1 or pnpm build first
  exit /b 1
)
if not defined LOOM_URL set "LOOM_URL=http://127.0.0.1:3000"
if not defined LOOM_ALLOW_INSECURE set "LOOM_ALLOW_INSECURE=1"
call claude mcp remove loom -s local >nul 2>&1
call claude mcp add --scope local --transport stdio loom -e LOOM_URL=%LOOM_URL% -e LOOM_ALLOW_INSECURE=%LOOM_ALLOW_INSECURE% -- node "%~dp0src\claude-channel\dist\server.js"
if errorlevel 1 exit /b %errorlevel%
call claude --dangerously-load-development-channels server:loom %*
set "RC=%errorlevel%"
call claude mcp remove loom -s local >nul 2>&1
exit /b %RC%
