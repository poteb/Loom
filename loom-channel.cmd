@echo off
rem Starts a Claude Code session with the Loom channel enabled, for this session only.
rem
rem The channel server is handed to claude with --mcp-config (a generated file with absolute paths),
rem so no other Claude Code session spawns it and nothing is registered in your config. Claude Code
rem 2.1.269 still prints "server:loom - no MCP server configured with that name" under the banner
rem for --mcp-config servers; that line is cosmetic - delivery works (verified 2026-09-12).
rem
rem Works from any directory. Extra arguments are passed to claude (e.g. loom-channel.cmd --resume).
rem Set LOOM_URL to point at a deployed Loom instead of the local dev server.
setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:\=/%"
if not exist "%~dp0src\claude-channel\dist\server.js" goto :missing
if not defined LOOM_URL set "LOOM_URL=http://127.0.0.1:3000"
if not defined LOOM_ALLOW_INSECURE set "LOOM_ALLOW_INSECURE=1"
set "CFG=%TEMP%\loom-channel-%RANDOM%%RANDOM%.mcp.json"
> "%CFG%" echo {"mcpServers":{"loom":{"command":"node","args":["%ROOT%src/claude-channel/dist/server.js"],"env":{"LOOM_URL":"%LOOM_URL%","LOOM_ALLOW_INSECURE":"%LOOM_ALLOW_INSECURE%"}}}}
call claude --mcp-config "%CFG%" --dangerously-load-development-channels server:loom %*
set "RC=%errorlevel%"
del "%CFG%" >nul 2>&1
exit /b %RC%

:missing
echo "%~dp0src\claude-channel\dist\server.js" missing - run build.ps1 or pnpm build first
exit /b 1
