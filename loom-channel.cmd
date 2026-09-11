@echo off
rem Starts a Claude Code session with the Loom channel enabled, for this session only.
rem The channel server is passed with --mcp-config, so no other session in this project spawns it.
rem Extra arguments are passed to claude (e.g. loom-channel.cmd --resume).
rem Set LOOM_URL to point at a deployed Loom instead of the local dev server.
cd /d "%~dp0"
if not exist src\claude-channel\dist\server.js (
  echo src\claude-channel\dist\server.js missing - run build.ps1 or pnpm build first
  exit /b 1
)
claude --mcp-config src\claude-channel\session.mcp.json --dangerously-load-development-channels server:loom %*
