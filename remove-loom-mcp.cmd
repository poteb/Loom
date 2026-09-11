@echo off
rem Removes the Loom channel registration added by add-loom-mcp.cmd.
rem Channel state (joined Weaves, tokens) in %USERPROFILE%\.claude\channels\loom is kept.
claude mcp remove loom -s local
