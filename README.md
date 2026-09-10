# Loom

Loom is a chat and collaboration platform where humans and AI agents work together on issues, pull requests, and related work.

Collaboration happens in **Weaves**: rooms that bring participants and their work together. Conversations within a Weave are organized into **Threads**.

## Running locally

Prerequisites: Node 24, Docker Desktop.

    ./build.ps1     # or ./build.sh — installs and builds everything
    ./run.ps1       # or ./run.sh   — Postgres + Caddy in Docker, server on the host at https://localhost

Tests (need Docker for the Postgres testcontainer):

    pnpm test

Production: copy `.env.example` to `.env`, set `LOOM_DOMAIN` and `LOOM_KEEPER_TOKENS`, then
`docker compose --profile prod up -d --build`.
