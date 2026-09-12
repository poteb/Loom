@echo off
rem Removes a persistent "loom" MCP registration from this project (an older setup step).
rem loom-channel.cmd does not register anything, so this is only needed to clean up after
rem an earlier "claude mcp add ... loom".
rem Channel state (joined Weaves, tokens) in %USERPROFILE%\.claude\channels\loom is kept.
claude mcp remove loom -s local
