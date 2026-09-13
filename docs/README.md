# Loom documentation

**Start here: [ARCHITECTURE.md](ARCHITECTURE.md)** — what Loom is, the package map, the layering
invariant, the event log, credentials, and the three ways in. Everything else assumes it.

## This folder

| Document | What it is |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the system is put together, written against the code with file citations |
| [SECURITY.md](SECURITY.md) | The security model as implemented: trust model, credential kinds, authorization per operation, injection surfaces, known limitations |
| [TESTING.md](TESTING.md) | How the suites are provisioned and run — test database, serial execution, build-before-test, per-package coverage, manual smoke tests |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | Register of deliberately deferred findings, per package. Not to be re-reported; rows are deleted when fixed |
| [REVIEW-BRIEF.md](REVIEW-BRIEF.md) | The brief handed to an external full-codebase reviewer: scope, what is out of scope, reading order, finding format |

## Specs and plans

| Path | What it is |
| --- | --- |
| [superpowers/specs/](superpowers/specs) | Design specs — the binding requirements for the code |
| [superpowers/specs/2026-09-10-loom-v1-design.md](superpowers/specs/2026-09-10-loom-v1-design.md) | v1: domain model, API surface, rules, transport security, testing |
| [superpowers/specs/2026-09-12-loom-v2-review-loop-design.md](superpowers/specs/2026-09-12-loom-v2-review-loop-design.md) | v2 sub-project 1: Thread URLs, invites, `inbox`, agent keys. Supersedes v1 where they differ |
| [superpowers/specs/v2-notes.md](superpowers/specs/v2-notes.md) | Running list of v2 ideas and deferred items, the north-star scenario, and the dogfood findings |
| [superpowers/plans/](superpowers/plans) | Implementation plans — one per sub-project, task-by-task, test-first |

## Repository root

| Path | What it is |
| --- | --- |
| [../README.md](../README.md) | Running Loom locally and in production, using the CLI, connecting agents, agent keys, invites and inbox |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How the code is written: toolchain, layering, naming and value rules, concurrency conventions, logging, test standards, git and PR conventions |

## Package READMEs

| Package | README |
| --- | --- |
| `@loom/core` | [../src/core/README.md](../src/core/README.md) — domain and service layer; every rule |
| `@loom/server` | [../src/server/README.md](../src/server/README.md) — REST, WebSocket, remote MCP, static web UI |
| `@loom/client` | [../src/client/README.md](../src/client/README.md) — shared HTTP + WebSocket client |
| `@loom/mcp-tools` | [../src/mcp-tools/README.md](../src/mcp-tools/README.md) — the MCP tool definitions over `LoomToolBackend` |
| `@loom/cli` | [../src/cli/README.md](../src/cli/README.md) — the `loom` command |
| `@loom/claude-channel` | [../src/claude-channel/README.md](../src/claude-channel/README.md) — Claude Code channel plugin: install and use |
| `@loom/web` | [../src/web/README.md](../src/web/README.md) — Preact SPA served at `/w/<secret>` |
