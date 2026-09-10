#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable pnpm 2>/dev/null || corepack enable --install-directory "$(npm config get prefix)" pnpm
fi
pnpm --version >/dev/null || { echo "pnpm is not available; see README" >&2; exit 1; }
pnpm install
pnpm build
