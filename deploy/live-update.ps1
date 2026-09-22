$ErrorActionPreference = "Stop"
ssh SpoolServer "~/git/Loom/deploy/live-update.sh $($args -join ' ')"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
