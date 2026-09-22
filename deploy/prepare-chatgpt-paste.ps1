$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# C:\Users\paw\.loom on Paw's PC: the profile folder whose ACL is the protection.
$loom = Join-Path $env:USERPROFILE ".loom"
$weaveFile = Join-Path $loom "live-weave.json"
$briefFile = Join-Path $PSScriptRoot "reviewer-brief.md"
$outFile = Join-Path $loom "live-chatgpt-paste.md"

if (-not (Test-Path $weaveFile)) { throw "missing $weaveFile - create the live Weave first" }
if (-not (Test-Path $briefFile)) { throw "missing $briefFile - the brief is committed beside this script" }

$w = Get-Content $weaveFile -Raw | ConvertFrom-Json
if (-not $w.secret) { throw "no secret in $weaveFile" }

$join = @"
Join the Loom Weave for this project's reviews, then follow the brief below.

    join_weave({ "secret": "$($w.secret)", "name": "ChatGPT" })

Weave $($w.weave.id), "$($w.weave.title)".

"@

# -Encoding UTF8 on the read: the brief is BOM-less UTF-8 and Windows PowerShell 5.1 otherwise decodes
# it as the ANSI code page, so every em dash and curly quote came out as three garbage characters.
Set-Content -LiteralPath $outFile -Value ($join + (Get-Content $briefFile -Raw -Encoding UTF8)) -Encoding utf8
