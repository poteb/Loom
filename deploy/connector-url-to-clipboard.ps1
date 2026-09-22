$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$agentFile = Join-Path (Join-Path $env:USERPROFILE ".loom") "live-chatgpt.json"
if (-not (Test-Path $agentFile)) { throw "missing $agentFile - mint the ChatGPT agent key first" }

$a = Get-Content $agentFile -Raw | ConvertFrom-Json
if (-not $a.key) { throw "no key in $agentFile" }

Set-Clipboard -Value "https://loom.3dbox.dk/mcp?agent=$($a.key)"
Write-Output "connector URL is on the clipboard"
