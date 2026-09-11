@echo off
rem Registers the Loom Claude Code channel (local scope = this project only) against the dev server.
rem Then start a channel-enabled session with:  claude --dangerously-load-development-channels server:loom
cd /d "%~dp0"
if not exist src\claude-channel\dist\server.js (
  echo src\claude-channel\dist\server.js missing - run build.cmd or pnpm build first
  exit /b 1
)
claude mcp add --scope local --transport stdio loom -e LOOM_URL=http://127.0.0.1:3000 -e LOOM_ALLOW_INSECURE=1 -- node "%~dp0src\claude-channel\dist\server.js"
