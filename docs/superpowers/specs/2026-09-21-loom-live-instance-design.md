# Loom v2 — the always-on live instance, on the server that already runs the shop

Date: 2026-09-21
Status: spec, ready for review and planning. No implementation yet.
Sub-project: the next small slice after the Lobby listeners view. The predecessor text is
[DOGFOOD.md](../../DOGFOOD.md) §2, decided 2026-09-20; its gap list **is** this slice's scope. The
roadmap entry is "A live Loom instance for the project's own use" in
[v2-notes.md](v2-notes.md), and the findings that forced it are the
`## Dogfood findings (2026-09-20)` block in the same file.

Every decision below was approved by Paw in
[`.superpowers/live-instance-brainstorm.md`](../../../.superpowers/live-instance-brainstorm.md) on
2026-09-21, the design as a whole at about 07:45Z. That file is the owner's own words and it wins
over this one wherever they differ; §2 carries each decision across with the reason it was given.

This spec **amends nothing** in an earlier spec. It adds a deployment shape, two small pieces of
server code and one test-infrastructure fix, and it describes — as a dependency, not as work it
does — the one change the neighbouring Spool repository needs.

## 1. Purpose and scope

### The problem

Loom is used to review Loom, and the instance it is used on is a development server. Three things
follow, and all three were paid for on 2026-09-20.

**The room is disposable.** The interim is a server started from the `main` checkout on port 3000
against the **dev** database, and migrations run unconditionally at boot
([`main.ts:15`](../../../src/server/src/main.ts)). A server started from any branch that carries a
`.sql` file under `src/core/drizzle/` that `main` does not have migrates the database the review
conversation lives in. DOGFOOD §2 therefore says in as many words that the interim is acceptable
**only while no checked-out branch carries a migration**, and that the conversation in it must be
treated as throwaway. A review record that cannot outlive a branch is not a record.

**The reviewer cannot reach it.** ChatGPT's connectors are called from OpenAI's servers, so no
loopback URL can ever work for it, and the repository's only public path is
`start_cloudflare_tunnel.cmd` — a Cloudflare **quick** tunnel whose hostname is new on every start.
Every review session therefore begins with a human restarting a tunnel and re-adding a connector
under a fresh hostname. v2-notes calls the stable hostname "the top gap of the live-instance slice,
not a nicety", and it is right.

**Nothing can migrate without starting.** There is no standalone migration command at all: `migrate,
check, then start` does not exist, so a pull followed by a start is a schema change with no dry run
and no gate.

### What this builds

An **always-on Loom at `https://loom.3dbox.dk`**, in Docker on the Hetzner server that already runs
the 3dbox.dk webshop, fronted by that shop's existing Caddy through one generic hook, with its own
Postgres, its own volume, its own keeper and its own agent keys — and **one command** that updates
it after a merge: pull, back up, migrate or stop, restart, reload Caddy, check health.

Concretely, five pieces:

| Piece | Where |
| --- | --- |
| The deployment | `deploy/` in this repository — compose file, Caddy site block, `.env.example`, the update script, the local wrapper |
| A standalone migrate entry | `src/server/src/migrate.ts`, plus `migrationStatus` in `@loom/core` |
| A switch for the boot migration | `LOOM_MIGRATE_ON_BOOT` in `src/server/src/config.ts`, honoured in `main.ts` |
| The session-less `GET`/`DELETE /mcp` fix | `src/server/src/mcp/index.ts` — the open KNOWN-ISSUES row |
| A truncate guard that generalises | `src/core/test/db-guard.ts` and the global setup beside it |

### Success scenario

1. A pull request is merged on Paw's word. The session runs `deploy\live-update.cmd` from this
   repository on Paw's PC. It prints a backup path, "nothing to apply" or the migrations it applied,
   the image build, the restart, and `health: ok`.
2. The Thread for the next pull request is created on the live instance. The review conversation
   from three weeks ago is still in it, because no branch has ever touched that database.
3. ChatGPT's connector — added **once**, at `https://loom.3dbox.dk/mcp?agent=<key>` — is still the
   same connector. Its five-minute `inbox` heartbeat picks the Thread up with no human prompt, and
   its reconnect polls no longer log a 500 apiece.
4. A merge whose branch carried a migration does the same thing, except that step 1 prints the
   migration it applied and the `pg_dump` taken immediately before it.
5. A migration that fails prints its error, exits non-zero, and **the running Loom is not
   restarted** — the old image is still serving, and the backup taken a moment earlier is on disk.

### Explicitly out of scope

- **Loom's own `prod` profile.** [`docker-compose.yml`](../../../docker-compose.yml) and
  [`Caddyfile`](../../../Caddyfile) at the repository root are untouched. They remain the
  *standalone* install — one box, Loom owning 80 and 443 — and `deploy/` is the *beside another
  Caddy* install. Two shapes, two files, neither pretending to be the other.
- **Everything in §13.** Scheduled backups, monitoring, alerting, a second instance, staging, IPv6,
  any GitHub-side automation, and any change to Spool beyond the single hook of §7.
- **Visual design.** Nothing here renders anything.

## 2. The decisions, and the reason each was given

Straight from the brainstorm file, in the order Paw made them, including the one that was
superseded — because a reader who finds the tunnel work in `start_cloudflare_tunnel.cmd` needs to
know it was considered and dropped.

| Decision | Reason given |
| --- | --- |
| Loom runs on the **Hetzner server that hosts 3dbox.dk** (repo `D:\git\Spool`), in Docker, not on Paw's PC | The server exists, is always on, is already deployed to over SSH with a key Paw holds, and has the headroom: 4 vCPU, 7.7 GB, 29 GB free, against a shop taking about 50 visitors a day |
| Hostname `loom.3dbox.dk` | A subdomain of a domain Paw already controls, so there is **no tunnel and no domain to buy**, and the DNS record is one entry in Paw's own DanDomain panel |
| **Superseded:** a Cloudflare *named* tunnel with a domain bought at Cloudflare (about 10 USD/yr) | It was the answer while the host was Paw's PC. The Hetzner server has a public address and a domain already, so the tunnel buys nothing and costs a moving part |
| **One command** after each merge (`live-update`), run by the session as the last merge step, and by Paw when he wants | The update is the step that will be done most often and is the one with a database in it. A script is the only form that can be idempotent, ordered and stoppable |
| Spool's Caddy serves Loom through **one generic hook**: `import /etc/caddy/sites/*.caddy` plus a mounted host folder; Loom's deploy drops `loom.caddy` there and reloads | Spool must not have to change again for the next site. One hook, once; after that a new site is a file in a folder |
| Loom's container joins a **shared external Docker network** with Spool's Caddy | Caddy has to reach Loom by name without either project publishing a port to the world |
| The Loom repository is **public**, so the server clones `https://github.com/poteb/Loom.git` with **no credentials** | Unlike Spool, whose server checkout has a local git bundle as its origin because no GitHub credentials are allowed on that box by policy. Loom needs no credential, so the ordinary clone is fine |
| A **standalone migrate entry** with a `--check` mode, and a switch to turn the boot migration off | "Migrate, check, then start" is the gate the interim has no way to express |
| A session-less `GET /mcp` answers **400** | A real connector sends that request on every reconnect; five 500s in ChatGPT's first hour of polling |
| Paw does two things by hand: the **DNS A record**, and **re-adding the connector once** | They are in panels the session cannot reach, and they happen once |
| Out: Loom's own Caddy/prod profile, scheduled backups, monitoring, GitHub automation | The slice is "the room is always there and one command updates it". Everything else is a later slice with its own decision |

Server facts, from a read-only `ssh SpoolServer` on 2026-09-21 and used throughout below:
Hetzner `ubuntu-8gb-hel1-1` at **89.167.47.120**, root login, Ubuntu, Docker 29.6 with compose
v5.3, git 2.53. Spool runs as compose project **`spool`**: `spool-postgres-1` (Postgres 16),
`spool-api-1`, `spool-caddy-1` publishing 80 and 443, on network `spool_default`. Its checkout is
`~/git/Spool`.

## 3. What is already parameterised, and what the neighbour looks like

Read rather than assumed, because the whole of §4 depends on it.

**Loom's server process is fully environment-driven.** It reads five variables today
([`config.ts:15-29`](../../../src/server/src/config.ts)): `DATABASE_URL` (required, no default),
`PORT` (3000), `LOOM_HOST` (`127.0.0.1`), `LOOM_KEEPER_TOKENS` (empty), `LOOM_WEB_DIST`. This slice
adds one, `LOOM_MIGRATE_ON_BOOT` (§5.3). Nothing else about the process needs a live-specific code
path, and nothing in `deploy/` may introduce one.

**The image is already right for this.** [`src/server/Dockerfile`](../../../src/server/Dockerfile)
is a two-stage `node:24-alpine` build. Its runtime stage sets `LOOM_WEB_DIST=/app/src/web/dist` and
`LOOM_HOST=0.0.0.0`, its `WORKDIR` is `/app/src/server`, its `CMD` is `node dist/main.js`, and it
copies `src/core/drizzle` — so the migration SQL and the journal are in the image, and a second
entry point in the same image is `node dist/migrate.js` and nothing more. **The image needs no
change at all**, which is why `deploy/` can build from it directly.

**`runMigrations` finds its own folder.** [`src/core/src/db/index.ts:22-27`](../../../src/core/src/db/index.ts)
resolves `../../drizzle` relative to the compiled module, which lands on `/app/src/core/drizzle` in
the image and on `src/core/drizzle` in a source tree. §5.1 reuses that resolution rather than
repeating it.

**Spool's stack, which Loom must fit beside without disturbing.** From
`D:\git\Spool\deploy\docker-compose.yml`: `postgres` (16-alpine, unpublished, own volume), a one-shot
`migrate` service with `restart: "no"` whose successful completion gates `api` through
`depends_on: … condition: service_completed_successfully`, `api` with a healthcheck, and `caddy`
(`caddy:2-alpine`) publishing 80 and 443, mounting `./Caddyfile`, `caddydata` and `caddyconfig`, and
gated on `api` being healthy. Its `deploy/Caddyfile` has a canonical `{$SITE_ADDRESS}` block with
`encode zstd gzip`, a six-line security `header` block and `reverse_proxy api:8080`, plus a
`{$REDIRECT_ADDRESSES}` block that 301s the brand hosts to the canonical one.

Two properties of that file matter here and are easy to get wrong:

1. **The canonical block's HSTS carries `includeSubDomains`, and that does not cover
   `loom.3dbox.dk`.** The header is set on responses from `shop.3dbox.dk`, and `includeSubDomains`
   extends a host's HSTS policy to hosts **below that host** — `*.shop.3dbox.dk`. `loom.3dbox.dk`
   is a *sibling* of `shop.3dbox.dk`, not a child, so it inherits nothing. The apex `3dbox.dk` sets
   no HSTS at all, deliberately and with its reason written in Spool's Caddyfile: the apex's
   `includeSubDomains` would force HTTPS onto mail-adjacent hosts served elsewhere at DanDomain.
   **So Loom's site block must set its own HSTS** (§4.3). This corrects the assumption the brief for
   this spec carried.
2. **Certificate issuance for a host whose DNS does not yet point here is safe.** Spool's Caddyfile
   records it for the brand hosts: certificate management is asynchronous, a failing issuance blocks
   neither startup nor a reload and never touches an existing certificate, and a `caddy reload`
   after the DNS flip restarts issuance immediately instead of waiting out the retry backoff. §9
   relies on exactly that: Loom's site block may be installed before the A record exists.

## 4. `deploy/` in the Loom repository

Five files, and not one of them is generated: they are read by a human deciding whether to trust the
update that is about to run.

    deploy/docker-compose.yml     compose project `loom` on the server
    deploy/loom.caddy             the site block, installed into Spool's Caddy
    deploy/.env.example           every variable, with the command that generates the secrets
    deploy/live-update.sh         the one server-side command, idempotent
    deploy/live-update.ps1        the local wrapper: ssh, and nothing else
    deploy/live-update.cmd        a two-line shim so `deploy\live-update.cmd` works from cmd.exe

### 4.1 Where everything lives on the server

Stated exactly, because every path below is hard-coded in a script and a reader must be able to
check them.

| Thing | Path, and how it gets there |
| --- | --- |
| The checkout | `~/git/Loom` (i.e. `/root/git/Loom`), `git clone https://github.com/poteb/Loom.git`, **`main` only**. Cloned once by hand in §9. It is never checked out to a branch, never committed to, and `live-update.sh` only ever fast-forwards it |
| The compose project | `loom`, taken from the directory name: every compose command runs with `~/git/Loom/deploy` as its working directory, so containers are `loom-postgres-1`, `loom-migrate-1`, `loom-loom-1` and the volume is `loom_pgdata` |
| The environment file | `~/git/Loom/deploy/.env`, **`chmod 600`**, created by hand on the server in §9, never in git (`.env` is already in [`.gitignore`](../../../.gitignore)) |
| Database backups | `~/backups/loom/loom-pre-update-<UTC timestamp>.sql.gz`, created by `live-update.sh`. Root-only, like Spool's dumps |
| The shared Caddy sites folder | `/root/caddy-sites` on the host, mounted into `spool-caddy-1` at `/etc/caddy/sites:ro`. Created by hand, once, in §9 step 1 |
| The shared network | `web`, `docker network create web`, once, in §9 step 1. Declared `external: true` by both projects, so neither owns it and neither `down` removes it |

**Why `~/git/Loom` and not a path under Spool.** The two projects are independent and their
checkouts must be too: a `git pull` in one must not be able to touch the other's tree, and Spool's
origin is a local bundle by policy while Loom's is GitHub. `~/git/` already holds `~/git/Spool`, so
the convention exists.

### 4.2 `deploy/docker-compose.yml`

Three services and one external network. The shape follows Spool's file on purpose — a postgres, a
one-shot migrate gating the app, `restart: unless-stopped` on what must come back after a reboot —
so that someone who has read one has read both.

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: loom
      POSTGRES_USER: loom
      POSTGRES_PASSWORD: ${LOOM_DB_PASSWORD:?LOOM_DB_PASSWORD is required}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U loom -d loom"]
      interval: 5s
      timeout: 5s
      retries: 20

  migrate:
    build:
      context: ..
      dockerfile: src/server/Dockerfile
    restart: "no"
    command: ["node", "dist/migrate.js"]
    environment:
      DATABASE_URL: postgres://loom:${LOOM_DB_PASSWORD:?LOOM_DB_PASSWORD is required}@postgres:5432/loom
    depends_on:
      postgres:
        condition: service_healthy

  loom:
    build:
      context: ..
      dockerfile: src/server/Dockerfile
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://loom:${LOOM_DB_PASSWORD:?LOOM_DB_PASSWORD is required}@postgres:5432/loom
      LOOM_KEEPER_TOKENS: ${LOOM_KEEPER_TOKENS:-}
      LOOM_MIGRATE_ON_BOOT: "false"
      PORT: "3000"
    ports:
      - "127.0.0.1:3100:3000"
    depends_on:
      migrate:
        condition: service_completed_successfully
    networks:
      - default
      - web

volumes:
  pgdata:

networks:
  web:
    external: true
```

Every non-obvious line, with its reason:

- **`postgres` publishes nothing.** The only things that need it are `migrate` and `loom`, both on
  the project's default network. A published port would put the live database on the host's
  interface list for no gain, and `live-update.sh` reaches it with `docker compose exec` instead.
- **Postgres 17**, where Spool runs 16. They are separate servers in separate containers with
  separate volumes, so there is nothing to match; 17 is what the dev compose file and the test
  containers already use, which means the live database is the version every test ran against.
- **One secret, `LOOM_DB_PASSWORD`, and `DATABASE_URL` composed from it in this file.** The brief
  for this spec had `DATABASE_URL` itself in `.env`. That gives two places holding the same password
  — `POSTGRES_PASSWORD` and the URL's userinfo — which can drift, and a drift here is a Loom that
  cannot reach its own database. One value, substituted into both, cannot drift. It is also exactly
  what Spool does with `DB_PASSWORD`. Nothing is hard-coded and nothing is in git either way.
- **`${LOOM_DB_PASSWORD:?…}` and not `${LOOM_DB_PASSWORD:-loom}`.** A missing password must stop
  compose with a message, not silently bring up a live database with the development password. The
  `:-` form is right for `LOOM_KEEPER_TOKENS`, which is genuinely optional after the first boot
  (seeding only runs on an empty `keepers` table) and whose absence the server reports at boot.
- **`migrate` and `loom` are the same image**, built from the same context, so `docker compose build`
  builds once and both services use the result. `command:` and not `entrypoint:` — the image has no
  `ENTRYPOINT`, its `CMD` is `["node", "dist/main.js"]`, and `WORKDIR` is `/app/src/server`, so
  `["node", "dist/migrate.js"]` is the same shape one directory over.
- **`restart: "no"` on `migrate`**, because a one-shot that Docker restarts on exit 0 is a loop.
- **`depends_on: migrate: condition: service_completed_successfully` on `loom`.** It makes a bare
  `docker compose up -d` correct for someone who is not using the script: the schema is at the
  version the image expects before the server is asked to serve. `live-update.sh` runs migrate
  itself first anyway (§4.5), so this gate normally fires against an already-migrated database and
  prints "nothing to apply" — a no-op, deliberately kept rather than removed.
- **`LOOM_MIGRATE_ON_BOOT: "false"`, set here and not left to `.env`.** On this deployment the
  migration is the compose graph's job and the script's gate; a server that also migrated at boot
  would make the gate decorative. It is in `environment:` rather than `.env` because it is a
  property of *this topology*, not an operator choice — and `.env.example` says so in a comment.
- **`ports: 127.0.0.1:3100:3000`, and nothing else.** The one published port exists so the CLI can
  run **on the server** against the live instance (`LOOM_URL=http://127.0.0.1:3100
  LOOM_ALLOW_INSECURE=1`), which is how §9 mints keys and creates the Weave without a certificate
  existing yet, and how `live-update.sh` checks health. Bound to loopback, so it is not on the LAN
  or the public interface. 3100 rather than 3000 because DOGFOOD already names 3100 as the live
  instance's port, and because 3000 is the dev server's on Paw's PC.
- **`networks: [default, web]` on `loom` only.** Naming any network on a service drops the implicit
  default, so `default` is listed explicitly: `loom` needs the default network to reach `postgres`
  and the `web` network to be reachable from `spool-caddy-1`. `postgres` and `migrate` stay on the
  default alone — the live database must not be reachable from a network the shop's front door is
  on.
- **`web` is `external: true`.** It is created once by hand and owned by neither project, so
  `docker compose down` in either one leaves it alone. Compose puts the service name on as a network
  alias, so Caddy reaches Loom at `loom:3000` on that network; Spool has no service called `loom`,
  so there is no collision.
- **No healthcheck on `loom`.** Nothing depends on it — Caddy is in the other project and cannot
  `depends_on` across projects — so a healthcheck here would only decorate `docker compose ps`.
  The health check that matters is the one `live-update.sh` runs against the published port, which
  tests the same thing from outside and is the script's own gate (§4.5).

### 4.3 `deploy/loom.caddy`

```
loom.3dbox.dk {
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "interest-cohort=(), browsing-topics=()"
		-Server
	}

	reverse_proxy loom:3000
}
```

**The hostname is a literal, not `{$LOOM_DOMAIN}`.** This file is read by *Spool's* Caddy, whose
environment is Spool's `.env`. A variable Spool does not set would substitute empty, and an empty
site address makes Caddy read the block as global configuration and refuse the whole file — the
failure Spool's own compose comments warn about with a deliberately non-empty fallback. A literal
hostname in a file whose only purpose is this one host is also simply honest.

**Which of Spool's six headers apply, decided one at a time.**

| Header | On Loom? | Why |
| --- | --- | --- |
| `Strict-Transport-Security "max-age=31536000"` | **Yes**, and it must be its own | §3 point 1: `shop.3dbox.dk`'s `includeSubDomains` does not reach a sibling host and the apex sets none, so without this line `loom.3dbox.dk` has no HSTS. Loom carries credentials in URLs (`/w/<secret>`, `/mcp?agent=<key>`), so a downgrade to plain HTTP is the one thing that must be impossible once a browser has seen the host |
| `includeSubDomains` on it | **No** | There is nothing under `loom.3dbox.dk` and nothing planned. Adding it would commit every future `*.loom.3dbox.dk` to HTTPS for a year for no present benefit |
| `preload` on it | **No** | Preload submission is a decision about the whole registrable domain and belongs to whoever owns `3dbox.dk`'s DNS, not to one subdomain's site block. The directive on a subdomain buys nothing and reads as a claim this file cannot make |
| `X-Content-Type-Options "nosniff"` | **Yes** | Loom serves a JS bundle, JSON and user-supplied Markdown-ish text from one origin. Sniffing any of it into another type is pure downside |
| `X-Frame-Options "SAMEORIGIN"` | **Yes** | The web client has a join form, a composer and an accept control. Framing it elsewhere is a clickjacking surface, and Loom frames nothing of its own from another origin |
| `Referrer-Policy "strict-origin-when-cross-origin"` | **Yes**, and it matters more here than on the shop | Loom's secrets live in the **path** (`/w/<secret>`) and the **query** (`?agent=<key>`). This policy sends the origin alone across origins, so a human clicking a Thread's GitHub link from a `/w/<secret>` page leaks `https://loom.3dbox.dk` and not the secret. `no-referrer` would be a shade stricter; it is not taken, because origin-only already strips everything credential-bearing and one convention shared with the shop is worth more than the residual |
| `Permissions-Policy "interest-cohort=(), browsing-topics=()"` | **Yes** | Loom wants neither, the line is inert if the browser does not implement them, and it keeps the two site blocks on the box saying the same thing |
| `-Server` | **Yes** | No reason to advertise Hono/Node versions |
| A `Content-Security-Policy` | **No** — and this is recorded in §13 | Spool analysed one and deliberately did not ship it, for the reason that applies here too: a policy that is subtly wrong breaks the client silently and is worse than none. Loom's bundle has not been audited for inline style or for what the mention-completion and Markdown-ish rendering paths actually emit, and auditing it is not this slice |

**WebSockets and SSE, both of which Loom needs through this proxy.** Caddy 2's `reverse_proxy`
passes `Upgrade` through natively, so the web client's live stream needs no directive — this is
worth stating because it is the first thing a reviewer will look for and finding nothing could read
as an omission. Server-sent events from `/mcp` pass through `encode`: Caddy's encoder forwards each
upstream flush, so events are not held back. If the first deployment shows the reviewer's stream
stalling, the fix is a `match` block on the `encode` directive excluding `text/event-stream`, and
§9 step 10 — the connector actually listing Loom's tools — is what would surface it.

### 4.4 `deploy/.env.example`

Committed; `deploy/.env` is not, and is already covered by the root `.gitignore`'s `.env` line.

```
# Copy to .env on the server, chmod 600. Never commit the result.

# The live Postgres password. One value: docker-compose.yml substitutes it into both
# POSTGRES_PASSWORD and the DATABASE_URL the migrate and loom services get.
# Generate:  node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
LOOM_DB_PASSWORD=

# Instance keeper tokens, comma-separated, each 43 characters of base64url (32 random bytes).
# Seeded ONLY into an empty keepers table: a token added here later does nothing at all and the
# server says so at boot. Rotate with `loom admin keepers add` from an existing keeper instead.
# Generate:  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
LOOM_KEEPER_TOKENS=

# Not here on purpose:
#   DATABASE_URL         composed in docker-compose.yml from LOOM_DB_PASSWORD, so it cannot drift
#   LOOM_MIGRATE_ON_BOOT fixed to "false" in docker-compose.yml: on this deployment the migration
#                        is the `migrate` service's job and live-update.sh's gate, not the server's
#   PORT / LOOM_HOST     fixed in docker-compose.yml and in the image; the published port is
#                        127.0.0.1:3100 and only the server-local CLI uses it
```

The two `node -e` lines are the ones already in the README's production paragraph, so an operator
does not have to hold two recipes. 24 bytes for the database password and 32 for a keeper token,
because the keeper token's length is a validated contract (`KEEPER_TOKEN_RE`, 43 characters) and the
database password's is not.

### 4.5 `deploy/live-update.sh`

`#!/usr/bin/env bash` with `set -euo pipefail`, run on the server, **idempotent**: running it twice
with nothing merged in between pulls nothing, applies nothing, reloads nothing, and still ends on a
health check. It must be committed executable (`git update-index --chmod=+x`), because the server
checkout is created by `git clone` and nothing else will set the bit.

The ordered steps, each with what it prints and what makes it stop:

1. **Locate itself.** `cd "$(dirname "$0")"` — every compose command then runs in
   `~/git/Loom/deploy`, which is what fixes the project name to `loom` (§4.1).
2. **Pull.** `git -C .. pull --ff-only origin main`. `--ff-only` so a checkout that has somehow
   diverged — a hand-edit, a stray commit — **stops the script** instead of merging on a production
   box. Prints the new head SHA.
3. **Back up, unless there is nothing to back up.** `mkdir -p ~/backups/loom`, then
   `TS="$(date -u +%Y%m%dT%H%M%SZ)"` and

       docker compose exec -T postgres pg_dump -U loom loom | gzip > ~/backups/loom/loom-pre-update-$TS.sql.gz

   `exec -T`, so no TTY is needed over SSH; `pipefail` is what makes a failed `pg_dump` fail the
   script rather than leaving a truncated `.gz`. The backup is **before** the build and the
   migration, which is the only ordering worth having. It is **skipped with a printed line** when
   the `postgres` container is not running (`docker compose ps --status running -q postgres` is
   empty) — that is the first deployment, where there is no database yet, and treating it as an
   error would mean §9 could not use the script.
4. **Build.** `docker compose build`. Both services share the image, so this is one build. A build
   failure stops the script with Loom still serving the old image.
5. **Migrate, and stop on failure.**

       docker compose run --rm migrate

   `run --rm` rather than `up migrate`, deliberately and this is the one place the shape had to be
   chosen: `docker compose up <service>` **returns 0 even when the service exited non-zero**, and
   the flag that fixes that (`--exit-code-from migrate`) implies `--abort-on-container-exit`, which
   would stop the live `postgres` alongside the finished one-shot. `run --rm` propagates the
   container's exit code, starts `postgres` via `depends_on` without stopping it afterwards, and
   removes the container. With `set -e`, a non-zero exit **is** the stop: no restart happens, the
   old image keeps serving, and the backup from step 3 is on disk.
6. **Install the site block if it changed, and only then reload Caddy.**

       cmp -s loom.caddy /root/caddy-sites/loom.caddy || {
         install -m 644 loom.caddy /root/caddy-sites/loom.caddy
         docker exec spool-caddy-1 caddy reload --config /etc/caddy/Caddyfile
       }

   `cmp` first because that is what makes the step idempotent, and because a reload restarts
   certificate management — cheap, but not something to do on every update for no change. A failing
   reload stops the script: Caddy's reload validates the whole configuration and keeps the old one
   on error, so a stop here means the shop is still up and the file needs fixing.
7. **Restart Loom.** `docker compose up -d loom`. Compose recreates the container because the image
   id changed, and runs the `migrate` gate again — a no-op that prints "nothing to apply" (§4.2).
8. **Check health.** `curl -fsS http://127.0.0.1:3100/api/guidelines`, retried up to 30 times at one
   second apart, then `echo "health: ok"`; exhausting the retries **fails the script**.
   `/api/guidelines` rather than `/health`: `/health` answers `{"ok":true}` from the HTTP layer
   alone and would go green on a server that cannot reach its database, whereas
   `/api/guidelines` reads `settings` through core, so a 200 proves HTTP, the database connection
   and the migrated schema in one request. It needs no credential
   ([`routes/guidelines.ts:8`](../../../src/server/src/routes/guidelines.ts)), so the check carries
   no secret. 30 seconds because a cold container has to connect a pool, run `ensureLobby` and bind.

Nothing in the script prints a token, a secret or a `DATABASE_URL`. The one place a credential could
surface is a compose error echoing `environment:`, which is why `.env` holds only two values and
neither is echoed by the script itself.

### 4.6 The local wrapper

`deploy/live-update.ps1`:

```powershell
$ErrorActionPreference = "Stop"
ssh SpoolServer '~/git/Loom/deploy/live-update.sh'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

and `deploy/live-update.cmd`, two lines, so `deploy\live-update.cmd` works from `cmd.exe` and from
`run.cmd`'s habits:

```
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0live-update.ps1" %*
```

`SpoolServer` is the SSH host alias Paw already has configured for this box and deploys Spool
through; the wrapper deliberately contains no hostname, no user and no key path, so nothing here has
to change if any of them does. The single-quoted argument keeps `~` for the **remote** login shell
to expand. The exit code is forwarded, so a failed migration fails the local command — which is what
makes this usable as the last step of a merge.

## 5. Server code

Four small pieces. The layering rule applies unchanged: the rule goes in `core`, the entry point in
`server` is thin ([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Layering").

### 5.1 `migrationStatus` in `@loom/core`

New file `src/core/src/db/migrations.ts`, exported from the package.

```ts
export type MigrationStatus = {
  /** Journal tags already applied, oldest first. */
  readonly applied: readonly string[];
  /** Journal tags `runMigrations` would apply next, oldest first. */
  readonly pending: readonly string[];
};

export async function migrationStatus(db: Db): Promise<MigrationStatus>;
```

**Why in core and not in the server entry point.** It is a rule about the database — "which of these
migrations has this database had?" — and two callers need the same answer: the migrate entry and the
server's boot refusal (§5.3). One implementation, tested once, in the package that owns the schema.

**How it decides, and why it must be this and not a set comparison.** The journal
[`src/core/drizzle/meta/_journal.json`](../../../src/core/drizzle/meta/_journal.json) lists entries
with a `tag` and a `when` (epoch milliseconds); drizzle's postgres-js migrator records what it has
applied in the `drizzle` schema's `__drizzle_migrations` table, whose `created_at` column holds that
same `when`. The migrator's own rule is **"apply every journal entry whose `when` is greater than
the maximum `created_at` in the table"** — so `migrationStatus` uses exactly that rule, because its
whole value is agreeing with what `runMigrations` will actually do. A set difference would disagree
in one case and the disagreement would be silent.

That rule has a consequence worth writing down rather than discovering: a migration authored with a
`when` **earlier** than one already applied would be reported as applied and never run.
`drizzle-kit generate` stamps `Date.now()`, so it cannot happen in normal use; it could only arise
from a hand-edited journal or a merge that reordered one, and it is the migrator's behaviour, not
something this function may paper over.

Two details of the read:

- The table may not exist on a fresh database. `migrationStatus` asks
  `select to_regclass('drizzle.__drizzle_migrations')` first and treats a null answer as "nothing
  applied", rather than catching SQLSTATE `42P01` from a failed select — a probe that answers is
  clearer than an exception that has to be classified.
- The migrations folder is resolved by **one** exported helper shared with `runMigrations`
  (`migrationsFolder()` in [`src/core/src/db/index.ts`](../../../src/core/src/db/index.ts), pulled
  out of the body it is inlined in today), so the status and the application can never read
  different folders.

### 5.2 `src/server/src/migrate.ts` to `dist/migrate.js`

A thin adapter: load `DATABASE_URL`, ask core, print, exit.

```
Usage: node dist/migrate.js [--check]
```

| Invocation | What it does | Exit |
| --- | --- | --- |
| no flag, nothing pending | prints `migrations: 5 applied, nothing to apply` | 0 |
| no flag, some pending | prints the applied count, then `applying:` and each pending tag on its own line, runs `runMigrations`, then `migrations: applied 2 (0003_steep_dracula, 0004_furry_captain_stacy)` | 0 |
| `--check`, some pending | prints the same listing with `pending:` in place of `applying:` and **applies nothing** | **0** |
| `--check`, nothing pending | prints `migrations: 5 applied, nothing to apply` | 0 |
| cannot connect, cannot read the journal, or a migration throws | the error through `logError` (which redacts, and never prints a driver error's `query` or `parameters` — those carry the password from the URL) | 1 |
| any argument that is not `--check` | prints the usage line to stderr | 2 |

**The exit-code convention, stated because a script depends on it.** `0` means "I did what you
asked", `1` means "I failed", `2` means "you asked wrongly". In particular **`--check` exits 0 even
with migrations pending**: it answers *what would you do*, not *is this database up to date*. A
caller that wants a gate does not use `--check` at all — it runs the applying form and reads its
exit code, which is what `live-update.sh` step 5 does, or it starts the server with
`LOOM_MIGRATE_ON_BOOT=false` and lets the refusal of §5.3 be the gate. `--check` is for a human who
wants to know what the next update will touch before running it.

It closes the pool (`closeDb`) on every path, so the container exits rather than hanging on an open
connection. `DATABASE_URL` is read through `loadConfig` so that a missing one gives the same message
as it does for the server, and no second parser exists.

A `"migrate": "node dist/migrate.js"` script joins `start` in
[`src/server/package.json`](../../../src/server/package.json).

### 5.3 `LOOM_MIGRATE_ON_BOOT`

`Config` gains `migrateOnBoot: boolean`, **default `true`**. Default true so that every existing use
— the dev server, `run.cmd`, the root compose file's `prod` profile, the preview harness and every
test that boots a server — behaves exactly as it does today with nothing set. Only `deploy/` turns
it off.

**Parsing.** Trimmed and lower-cased, exactly `"true"` or `"false"`; anything else **throws** at
config load, with the variable name and the two accepted values in the message. This file already
throws on a malformed `PORT` and on a malformed keeper token rather than guessing
([`config.ts`](../../../src/server/src/config.ts)), and a permissive parser that read `"0"`,
`"no"` or `"False"` as some default is exactly the kind of value that only reveals itself in
production, on the one variable whose whole job is to stop a migration.

**What `main.ts` does when it is false.** It asks `migrationStatus` and **refuses to start** if
anything is pending:

    LOOM_MIGRATE_ON_BOOT=false and 2 migrations are pending (0003_steep_dracula,
    0004_furry_captain_stacy). Run `node dist/migrate.js` against this database before starting the
    server.

thrown from `main()`, so the existing `main().catch` path logs it through `logError` and exits 1 —
no new failure mechanism. With nothing pending it skips `runMigrations` entirely and boots normally.

**Why refuse rather than serve.** A server running against a schema older than its own code does not
fail once, visibly; it fails per request, as a 500 from every query touching a column that is not
there, while `docker compose ps` says `running` and the health check may well pass. One loud refusal
at one moment is diagnosable and is something a script can gate on; a half-working instance is
neither. It also makes the compose graph's `service_completed_successfully` gate meaningful instead
of advisory: if the gate is ever bypassed, the server itself says so.

### 5.4 The session-less `GET` and `DELETE /mcp` defect

The open row in [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) for
[`src/server/src/mcp/index.ts:111`](../../../src/server/src/mcp/index.ts): a `GET /mcp` with no
`mcp-session-id` header answers **500**. `app.all("/mcp", …)` treats *any* request without a known
session as a fresh session's `initialize`, builds a server and a transport, connects them and calls
`handleRequest`; the transport throws for a session-less `GET`
(`unhandled Error at StreamableHTTPTransport.#validateSession … handleGetRequest`) and
[`app.ts:56`](../../../src/server/src/app.ts) turns that into `internal`. ChatGPT's connector sends
exactly that request — `GET /mcp?agent=<key>` with `Accept: text/event-stream` — on every reconnect,
five times in its first hour of polling on 2026-09-20.

The fix, inside the `app.all("/mcp")` handler, **before** the credential resolution and before any
transport is constructed:

```ts
const sessionId = c.req.header("mcp-session-id");
if (sessionId === undefined && (c.req.method === "GET" || c.req.method === "DELETE")) {
  return c.json({ code: "validation", message: "mcp-session-id header is required for GET and DELETE /mcp" }, 400);
}
```

Three precise points about its scope:

- **`GET` and `DELETE` only.** `POST` without a session id is the `initialize` handshake and must
  keep working untouched. Other methods keep their current path as well, and that is not incidental:
  [`src/server/test/mcp.test.ts:95`](../../../src/server/test/mcp.test.ts) drives two concurrent
  session-less **`PUT`** requests through the injectable connect seam and asserts two connect
  attempts and two 405s — it is the deterministic test for the per-session connect gate. A
  method-allowlist that only let `POST` through would turn those into 400s with no connect and
  delete the coverage. So the guard names the two methods the transport actually throws for, and
  that test is **unchanged**.
- **The bogus-session path is unchanged.** A request carrying an `mcp-session-id` the server does not
  know still answers 404 `not_found` ([`mcp/index.ts:77`](../../../src/server/src/mcp/index.ts)),
  which is already correct and is already tested.
- **No work is done before the refusal.** In particular `core.resolveCredential` is not called, so a
  reconnect poll no longer touches the database at all — which also means a session-less `GET` with
  a revoked key is a 400 rather than a 401. That is the right answer: the request is malformed
  regardless of who sent it, and answering "malformed" before "unauthorised" leaks nothing about
  whether the key is good.

The KNOWN-ISSUES row is deleted in the pull request that lands this, per
[HANDBOOK.md](../../HANDBOOK.md) §6.

## 6. Test infrastructure: the truncate guard

[`src/core/test/helpers.ts:13`](../../../src/core/test/helpers.ts)'s `freshDb()` truncates ten
tables, and the guard in front of it refuses only a database named **exactly `loom`**
([`db-guard.ts:5`](../../../src/core/test/db-guard.ts)). Once a live instance exists on a box that
also runs `spool`, "the one name we thought of" is not a guard. Inverted:

```ts
/**
 * True unless `url`'s database name ends in `_test`. `freshDb()` truncates every table, so the
 * guard allow-lists the one naming convention every test database in this repository follows,
 * instead of denying the handful of real names someone happened to think of.
 */
export function isProtectedDatabase(url: string): boolean {
  return !/_test$/.test(dbName(url) ?? "");
}
```

- `loom`, `spool`, `loom_live`, `postgres` — **refused**.
- `loom_test` — allowed. So is any `<anything>_test`.
- A URL that does not parse now returns `true` (protected) where it returned `false`, because
  `dbName` answers `undefined`. Failing closed on an unparseable URL is the only defensible
  direction for a guard in front of a `truncate`.
- The escape hatch is unchanged: `LOOM_TEST_DATABASE_URL_USER_SET`, set by the global setup when the
  developer or CI supplied `TEST_DATABASE_URL` themselves, still bypasses the guard entirely
  ([`global-setup.ts:21-24`](../../../src/core/test/global-setup.ts)).

**And the change this forces, which is the point of putting it in the spec rather than leaving it to
the plan.** On the normal path the global setup does **not** set that marker: it starts a
Testcontainers Postgres and takes `container.getConnectionUri()`, whose database is the
`@testcontainers/postgresql` default **`test`** — which does not end in `_test`. Under the new rule
that URL is protected and **every test in the repository would refuse to run**. The existing case
`db-guard.test.ts:25`, "does not flag a testcontainer URL", is testing exactly that URL.

So the container is named:

```ts
container = await new PostgreSqlContainer("postgres:17-alpine").withDatabase("loom_test").start();
```

and `db-guard.test.ts`'s testcontainer case is **rewritten** to assert the new URL is allowed and
that the old bare `test` name is not. Two alternatives were considered and rejected: a second marker
for the testcontainer path (a second escape hatch weakens the guard for the case it is most often
run under), and allow-listing the name `test` as well (it re-introduces a name-by-name list, which
is the thing being removed). Naming the container's database costs one method call and leaves exactly
one rule with no exceptions. The fallback path already produces `loom_test`
([`db-guard.ts:22-26`](../../../src/core/test/db-guard.ts)), so after this change both paths agree.

`TEST_DATABASE_URL` and the marker are already documented in
[TESTING.md](../../TESTING.md) §1; that section gains the new rule in one sentence — *point
`TEST_DATABASE_URL` at a database whose name ends in `_test`, or set it explicitly and own the
consequences* — and the testcontainer's database name is corrected there.

## 7. The one change Spool needs — a dependency, not this slice's work

Spool is another repository (`D:\git\Spool`). This spec **describes** its change and does not make
it; it lands as its own small pull request there, and §9 step 1 will not proceed until it is merged
and applied. Three edits and two hand-run prerequisites.

**`deploy/Caddyfile`** — one line at top level, above the `{$SITE_ADDRESS}` block:

```
import /etc/caddy/sites/*.caddy
```

**`deploy/docker-compose.yml`** — the `caddy` service gains a mount and two networks, and the file
gains a top-level `networks` block:

```yaml
  caddy:
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - /root/caddy-sites:/etc/caddy/sites:ro
      - caddydata:/data
      - caddyconfig:/config
    networks:
      - default
      - web

networks:
  web:
    external: true
```

`default` is listed explicitly for the same reason as in §4.2: naming any network drops the implicit
one, and Caddy must keep reaching `api:8080` on `spool_default`. `:ro` because Caddy reads those
files and must never be able to write one.

**The two prerequisites, by hand, before Spool's compose is re-upped** — this ordering is the whole
of the risk in §7:

    docker network create web
    mkdir -p /root/caddy-sites

An `external: true` network that does not exist makes `docker compose up` **refuse**, which would
take the shop down for as long as it took to notice. A missing bind-mount source would be created by
Docker as a root-owned empty directory, which is harmless, but creating it deliberately is one
command and removes the question. The folder is created empty and stays that way in git — there is
no `.gitkeep`, because the folder is not in either repository: it is a host path both projects
reference.

**An empty sites folder.** A glob `import` that matches no files is not a Caddyfile error, so
Spool can merge and re-up before Loom exists. That claim is **verified rather than assumed** in §9
step 1, with `caddy validate`, and the step carries its contingency: if Caddy refuses the empty
glob, a `00-placeholder.caddy` holding a single `#` comment line goes in the folder, and
`live-update.sh` never touches it.

Spool's canonical block, its redirect block, its headers, its `api`, its `postgres` and its volumes
are **not** touched. Nothing about the shop's behaviour changes.

## 8. What Paw does by hand, and what the session does over SSH

Everything except the two items below is done by the session over `ssh SpoolServer`, which is how
Spool is already deployed. Hand-run steps go to Paw **one at a time, with the real values already
substituted**, waiting for each result ([HANDBOOK.md](../../HANDBOOK.md) §4).

**Paw, item 1 — the DNS record**, at DanDomain, in Paw's own panel:

| Field | Value |
| --- | --- |
| Type | `A` |
| Host | `loom` (i.e. `loom.3dbox.dk`) |
| Points to | `89.167.47.120` |
| TTL | **300** |

TTL 300 because this record may need to be corrected during the first deployment and a five-minute
cache is the difference between a retry and an afternoon. It can be raised later; nothing depends on
it being low.

**Paw, item 2 — the connector, once.** Remove ChatGPT's existing Loom connector and add
`https://loom.3dbox.dk/mcp?agent=<key>` as a remote MCP server of type **Streamable HTTP** — not
STDIO, which fails silently with the client reporting only that the connector's tools are not
exposed (DOGFOOD §3 step 4). This is the last time it has to be done: the hostname is now stable, so
the connector survives every restart and every update.

**Credentials never pass through the conversation.** This is a standing trap
([HANDBOOK.md](../../HANDBOOK.md) §5, from the 2026-09-20 run). Concretely, for this slice:

- The **keeper token** is generated **on the server**, by the session, straight into
  `~/git/Loom/deploy/.env`. It is never printed. A copy for Paw is written to
  `~/.loom/live-keeper.json` on Paw's PC (`C:\Users\paw\.loom\live-keeper.json`), and Paw is handed
  **that path** plus the one-line command that prints it.
- Each **agent key** is minted on the live instance and written to `~/.loom/live-<name>.json` —
  `~/.loom/live-claude-code.json` and `~/.loom/live-chatgpt.json`. Paw is handed the path and a
  one-line command that prints the connector URL from it, and copies the value out of a terminal.
- The Lobby secret the live instance prints at its first boot goes the same way.

## 9. The first deployment runbook

Twelve steps, in order, each ending on something checkable. Steps 1 and 6 are Paw's; the rest are
the session's, over SSH or over the loopback port.

1. **Spool's change is merged and applied.** Its pull request (§7) is merged on Paw's word; then, on
   the server: `docker network create web`, `mkdir -p /root/caddy-sites`, `git -C ~/git/Spool pull`,
   `docker compose -f ~/git/Spool/deploy/docker-compose.yml up -d caddy`, and
   `docker exec spool-caddy-1 caddy validate --config /etc/caddy/Caddyfile`.
   *Done when:* `caddy validate` prints `Valid configuration`, `docker network inspect web` lists
   `spool-caddy-1`, and `https://shop.3dbox.dk` still serves the shop. *If validate refuses the
   empty glob:* drop `/root/caddy-sites/00-placeholder.caddy` containing one `#` line and repeat.
2. **Clone Loom.** `git clone https://github.com/poteb/Loom.git ~/git/Loom` — no credentials, the
   repository is public. *Done when:* `git -C ~/git/Loom rev-parse HEAD` equals the `main` SHA the
   session expects, and `ls ~/git/Loom/deploy` lists all six files.
3. **Write `.env`.** `cp deploy/.env.example deploy/.env`, `chmod 600 deploy/.env`, then generate
   both values on the server with the `node -e` lines from the file and write them in. Neither is
   printed to the session's output. *Done when:* `stat -c %a deploy/.env` is `600`, and
   `grep -c '^LOOM_DB_PASSWORD=.\+' deploy/.env` and the same for `LOOM_KEEPER_TOKENS` are each `1`.
4. **Bring it up.** In `~/git/Loom/deploy`: `docker compose up -d`. Postgres starts, `migrate` runs
   to completion against an empty database and applies all five migrations, then `loom` starts.
   *Done when:* `docker compose ps` shows `postgres` and `loom` running and `migrate` exited 0, and
   `docker compose logs loom` carries `keepers: seeded 1 from LOOM_KEEPER_TOKENS`, `lobby: created
   /w/…` and `loom server listening on http://0.0.0.0:3000`.
5. **Install the site block and reload Caddy** — by running the real script, so that the first
   deployment exercises it: `~/git/Loom/deploy/live-update.sh`. It pulls nothing new, skips the
   backup only if Postgres is not up (it is, so it takes one), rebuilds, runs migrate (nothing to
   apply), installs `loom.caddy`, reloads Caddy, restarts `loom` and checks health. *Done when:* it
   prints `health: ok` and exits 0, and `/root/caddy-sites/loom.caddy` exists.
6. **Paw adds the DNS A record** (§8 item 1). *Done when:* `dig +short loom.3dbox.dk` from the
   server answers `89.167.47.120`.
7. **Watch the certificate.** `docker compose -f ~/git/Spool/deploy/docker-compose.yml logs -f caddy`
   — or re-reload Caddy to skip the accumulated ACME backoff, which is the trick Spool's own cutover
   runbook records. *Done when:* the log carries a successful certificate obtain for
   `loom.3dbox.dk`, and `curl -fsS https://loom.3dbox.dk/api/guidelines` from Paw's PC answers 200
   with no certificate warning.
8. **Keeper check over the public hostname**, which is the first thing to prove end to end because
   it exercises TLS, Caddy, the `web` network and the database in one call. From Paw's PC:
   `LOOM_KEEPER_TOKEN=<token> loom --url https://loom.3dbox.dk admin weaves`. *Done when:* it prints
   a list rather than `invalid_token`. (Note the global `--url` comes **before** the command name.)
9. **Mint the two agent keys** on the live instance:
   `loom --url https://loom.3dbox.dk admin agents add Claude-Code` and the same for `ChatGPT`, with
   `LOOM_KEEPER_TOKEN` in front. Each prints its connector URL and its key **once**. Written to
   `~/.loom/live-claude-code.json` and `~/.loom/live-chatgpt.json`; nothing printed into the
   conversation (§8). *Done when:* `loom --url https://loom.3dbox.dk admin agents list` shows both,
   unrevoked, and both files exist.
10. **Create the Weave.** `loom --url https://loom.3dbox.dk create --title "Loom development" --name
    Claude-Code --kind agent --guidelines -`, with the guidelines text from
    [DOGFOOD.md](../../DOGFOOD.md) §3 step 2 on stdin, verbatim — it is the approved text and this
    step copies it rather than rewriting it. *Done when:*
    `loom --url https://loom.3dbox.dk guidelines` prints the instance layer under
    `## Loom guidelines` and that text under `## Guidelines for this Weave`.
11. **Paw re-adds the connector** (§8 item 2), and ChatGPT calls `join_weave`. *Done when:* the
    reviewer's client lists Loom's tools, `join_weave` returns an identity and both guideline
    layers, and the server's log shows **no** 500 from its reconnect polls — which is §5.4 proved in
    the place the defect was found.
12. **Run one review round on the live instance**, by the protocol in
    [DOGFOOD.md](../../DOGFOOD.md) §4 — for this slice's own pull request, if the timing allows, and
    otherwise for the next one. *Done when:* a round completes on the live instance with the
    reviewer's closing message in the Thread.

**Then retire the interim.** Its Threads are closed
(`loom --url http://127.0.0.1:3000 --weave <id> thread close <threadId>` for each, with
`LOOM_ALLOW_INSECURE=1`), the dev server is stopped, and DOGFOOD §2's interim paragraph is replaced
by the live runbook (§10). The interim's dev database is **not** dropped — it is the development
database and the dev Lobby's 60 `seed-N` listeners live in it; only the Weave is done with.
*Done when:* DOGFOOD no longer describes an interim as the thing to use, and no Thread on the dev
server is open.

## 10. Documentation this slice must update

Listed here so the plan can assign each one to a task; none of it is optional, and a pull request
that ships the code without it leaves the repository describing a world that no longer exists.

| Document | The edit |
| --- | --- |
| [DOGFOOD.md](../../DOGFOOD.md) §2 | Replaced: the section becomes **the live instance** — where it runs, its hostname, `deploy/`, the one-command update, and the CLI invocation against `https://loom.3dbox.dk`. The interim paragraph and the whole gap list go, except the rows §13 keeps, which move to "still true of the live instance" |
| [DOGFOOD.md](../../DOGFOOD.md) §1.2 | "The always-on instance does not exist yet" becomes "it exists", with the date and the hostname |
| [DOGFOOD.md](../../DOGFOOD.md) preamble | The `loom` invocation line: the live instance is `--url https://loom.3dbox.dk` with no `LOOM_ALLOW_INSECURE`, and `http://127.0.0.1:3100` is the **server-local** form only |
| [DOGFOOD.md](../../DOGFOOD.md) §3 step 5 | The tunnel paragraph is replaced by the stable hostname. The server-side loopback reasoning stays — it is still true and still the reason the dev server needs no TLS |
| [HANDBOOK.md](../../HANDBOOK.md) §6 "current state" | The live instance, its hostname, and where its credentials' file paths are |
| [HANDBOOK.md](../../HANDBOOK.md) §3 step 13 | Merge gains its last action: run `deploy\live-update.cmd` and report what it printed |
| [HANDBOOK.md](../../HANDBOOK.md) §5 traps | Two new ones, both paid for in writing this: `docker compose up <service>` **returns 0 even when the service failed**, and `--exit-code-from` implies `--abort-on-container-exit`, which would stop the live database — use `docker compose run --rm`; and **HSTS `includeSubDomains` does not cover a sibling host**, so `loom.3dbox.dk` needs its own |
| [ARCHITECTURE.md](../../ARCHITECTURE.md) §10 | A third paragraph: the two root-level profiles are the **standalone** install, `deploy/` is the **beside another Caddy** install, and this is where the shared `web` network and the sites-folder hook are described. The sentence "Migrations run on every boot in `main.ts`" is corrected to name `LOOM_MIGRATE_ON_BOOT` |
| [README.md](../../../README.md) "Running locally" | A short **Deploying beside another Caddy** paragraph pointing at `deploy/` and naming the one command; the existing production paragraph keeps describing the standalone `--profile prod` install |
| [TESTING.md](../../TESTING.md) §1 | The generalised truncate guard (`_test` suffix), the testcontainer's database name, and the sentence about pointing `TEST_DATABASE_URL` somewhere safe (§6) |
| [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) | **Rows deleted:** the `mcp/index.ts:111` session-less `GET` 500 (§5.4). **Rows added:** none — §13 is scope, not defects |
| [v2-notes.md](v2-notes.md) | The "A live Loom instance …" entry becomes **built**, dated, with the hostname, the `deploy/` path and a one-line pointer to this spec; the 2026-09-20 dogfood finding about the session-less `GET` gains its "fixed in PR #N" note |
| [CONTRIBUTING.md](../../../CONTRIBUTING.md) | Nothing. No convention changes |
| `.claude/launch.json` | **Unchanged, deliberately.** It stays pinned to port 3000: it is the *development* preview harness on Paw's PC, and the live instance is not something the harness starts. DOGFOOD's gap list said it "cannot start the live instance without editing it" — that row is not a gap any more, it is the right behaviour, and §13 says so |

## 11. Tests

Every test below is assigned to exactly one plan task
([HANDBOOK.md](../../HANDBOOK.md) §3 step 5). The two groups are honest about what is and is not
covered by an automated suite.

### 11.1 `migrationStatus` and the migrate entry — `src/core/test/migration-status.test.ts`

Against a **dedicated Testcontainers Postgres started by this file**, not the shared global-setup
database: the first two cases need a database with *no* migrations applied at all, and the shared one
is migrated once per run by `freshDb()`. `@testcontainers/postgresql` is already a dependency in
this workspace, and the file stops its own container in `afterAll`.

1. **A fresh database lists every journal entry as pending and nothing as applied** — the count
   equals the journal's entry count, and the order is the journal's.
2. **Applying moves them all across.** Run the migrate entry's applying path; `migrationStatus` then
   reports every tag applied and nothing pending.
3. **A second run applies nothing.** Idempotence, and the assertion is the *rule* — `pending` is
   empty and the table's row count is unchanged — never an exact write count
   ([HANDBOOK.md](../../HANDBOOK.md) §5).
4. **`--check` applies nothing and lists correctly.** On a fresh database it reports the full pending
   list and leaves `to_regclass('drizzle.__drizzle_migrations')` null; after an apply it reports
   nothing pending. Exit code 0 in both cases.
5. **The listing agrees with the migrator's own rule** — a row in `__drizzle_migrations` whose
   `created_at` equals the second journal entry's `when` makes entries 0 and 1 applied and the rest
   pending, which is the maximum-based rule of §5.1 and not a set difference.
6. **An unknown argument exits 2** and prints the usage line; **`DATABASE_URL` absent** fails with
   the same message `loadConfig` already gives.

### 11.2 The boot switch — `src/server/test/config.test.ts` and the server boot suite

7. **Default true.** `loadConfig({ DATABASE_URL: … })` gives `migrateOnBoot: true`; `"true"` and
   `"false"` (in any case, with surrounding whitespace) parse to the obvious values.
8. **Anything else throws** — `"0"`, `"no"`, `""`, `"yes"` — with the variable name in the message.
9. **`false` with migrations pending refuses to start**, with the message of §5.3 naming the count
   and the pending tags, and the process exits non-zero. Against a database migrated to an earlier
   point than the journal (the row-insert trick of case 5).
10. **`false` with nothing pending starts normally** and serves a request — the case that proves the
    refusal is not simply "false never boots".
11. **`true` is unchanged**: a server booted against an unmigrated database migrates it and serves,
    exactly as today.

### 11.3 The MCP guard — `src/server/test/mcp.test.ts`

12. **Session-less `GET /mcp?agent=<key>` answers 400 `{ code: "validation" }`** — with a valid agent
    key, and with `Accept: text/event-stream`, because that is the request the real connector sends.
13. **Session-less `DELETE /mcp` answers 400** the same way.
14. **A session-less `GET` with a revoked key is still 400, not 401** — the guard runs before any
    credential resolution (§5.4).
15. **A bogus `mcp-session-id` is still 404 `not_found`** — the existing case, unchanged.
16. **A full `initialize` over `POST` still works**, and the two concurrent session-less `PUT`
    requests of `mcp.test.ts:95` still get two connect attempts and two 405s — the coverage the
    guard's method list exists to preserve.

### 11.4 The truncate guard — `src/core/test/db-guard.test.ts`

17. **Refused:** a URL whose database is `loom`; one whose database is `spool`; one whose database is
    `loom_live`; one whose database is `postgres`; and an unparseable URL.
18. **Allowed:** `loom_test`; any other `<name>_test`; and the **named testcontainer URL** of §6
    (`.../loom_test`) — replacing the old case that asserted a bare `test` database was allowed.
19. **Not fooled by the name elsewhere in the URL** — `postgres://loom:loom@loom:5432/loom_test` is
    allowed. The existing case, kept.
20. **`fallbackTestUrl` is unchanged** — both existing cases stand.
21. **The whole suite still runs.** Not a test but a verification step the plan must name: after
    `.withDatabase("loom_test")`, `pnpm --workspace-concurrency=1 -r test` passes on the normal
    Testcontainers path *and* on the fallback path. Case 18 would pass while every other test in the
    repository refused to start, which is precisely the failure §6 exists to prevent.

### 11.5 What no unit test covers, said plainly

**`deploy/docker-compose.yml`, `deploy/loom.caddy`, `deploy/live-update.sh` and the two wrappers are
verified by the first deployment (§9) and by nothing else.** There is no compose harness in this
repository, no Caddy fixture and no shell-test framework, and inventing one for five files that run
once per merge against one specific server would be a larger and less honest change than reading
them. What stands in for automation:

- Every §9 step has a "done when" that checks the thing the previous step claimed to do, and step 5
  runs the **real** `live-update.sh` rather than its steps by hand.
- The failure paths that matter are structural rather than tested: `--ff-only` cannot merge,
  `set -euo pipefail` plus `docker compose run --rm`'s exit code cannot skip a failed migration,
  `cmp` makes the Caddy install idempotent, `${LOOM_DB_PASSWORD:?…}` cannot default, and the health
  check reads a route that touches the database.
- The **second** time the script runs — the first real merge after this slice — is when idempotence
  is actually observed. That run is recorded in v2-notes as a dogfood note, whatever it shows.

## 12. Security notes

Short, and each one a property a reviewer can check.

- **`deploy/.env` is `chmod 600`, root-only, server-local and git-ignored.** It holds two values, the
  database password and the keeper token, and nothing in the repository or in any script prints
  either. The root `.gitignore` already covers `.env`.
- **No secret is in the repository.** `deploy/.env.example` holds empty keys and two `node -e`
  generator lines. The keeper token is generated **on the server**; agent keys are generated **by the
  live instance** and only ever hashed in its database
  ([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Naming and value rules").
- **Postgres publishes nothing.** It is reachable from `migrate` and `loom` on the project's default
  network and from `docker compose exec`, and from nowhere else. It is deliberately **not** on the
  `web` network, so nothing that Caddy can reach can reach the database.
- **Port 3100 is loopback-only and is for the server-local CLI.** It exists because §9 has to mint
  keys and create a Weave before a certificate exists, and because the health check must not depend
  on DNS or TLS. Its flip side is the one DOGFOOD already states of the dev server: any process on
  that box that can reach the port can use a key pasted into a URL. The box has one user, root, and
  it already holds the shop's Stripe-decrypting key ring.
- **The same-host trust between Spool's Caddy and Loom is the `web` network and nothing more.**
  Caddy reaches `loom:3000` over plain HTTP inside Docker; Loom terminates no TLS and checks no
  scheme, `Host`, `Origin` or `X-Forwarded-Proto`, exactly as it does today. What that buys is the
  posture stated honestly: **anything on the `web` network is trusted to be Caddy.** Today that is
  Spool's Caddy and Loom, because those are the only two services attached. The rule the network
  therefore carries: a service is attached to `web` only when it is a front door or a thing a front
  door proxies — never a database, never a worker.
- **HSTS on `loom.3dbox.dk` is Loom's own, one year, no `includeSubDomains`, no `preload`** — §4.3,
  for the reason in §3 point 1. What it implies: until a browser has seen one HTTPS response from
  `loom.3dbox.dk`, a plain-HTTP request to that host is not pinned, and Caddy's automatic HTTP-to-
  HTTPS redirect is what catches it. After the first visit the browser will not send plain HTTP to
  that host for a year. Since `shop.3dbox.dk`'s policy never applied here, this line is the only
  thing standing between a credential-in-URL and an `http://` typo.
- **Agent keys ride in the URL, over TLS, exactly as today.** `?agent=<key>` exists because some
  connectors can only be given a URL, and a URL's query is inside the TLS record. What changes with
  this slice is that the referrer policy of §4.3 now stops that query leaving the origin in a
  `Referer`, and that the host is stable so a key does not have to be re-pasted per session. What
  does not change: the key appears in Caddy's access log for `loom.3dbox.dk`, as it does in the dev
  server's. Loom's own `redact()` blanks a 43-character base64url run in its logs
  ([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Logging"); **Caddy's log is not redacted**, and that
  is a known property of the URL-credential design, not something this slice introduces or fixes.
- **Backups are secret-bearing**, on the same reasoning Spool's ROLLOUT.md gives for its dumps: a
  Loom dump contains `agents.key_hash`, `keepers`, every Weave secret and every participant token.
  They live under `~/backups/loom`, root-only, on the server, and are never copied off it by
  anything in this slice. Retention, rotation and encrypted off-server copies are §13.

## 13. What this does not promise

Each with the reason it is out, so that a later slice can pick it up without re-litigating.

- **No scheduled backups, no retention and no rotation.** `live-update.sh` takes one dump
  immediately before it migrates, which is the moment a dump is actually wanted. Nothing takes a
  daily one, nothing prunes `~/backups/loom`, and nothing copies a dump off the box. A dump is
  secret-bearing (§12), so an off-server copy needs encryption to a key that is not in the dump, and
  that is a decision with a key-custody question in it — a slice of its own, next to Spool's, whose
  ROLLOUT.md already states the shape.
- **No monitoring and no alerting.** Nothing watches the instance, nothing pages anyone, and a Loom
  that has been down since Tuesday is discovered by someone trying to use it. `restart:
  unless-stopped` brings it back after a crash or a reboot, and that is the whole of the
  availability story.
- **No tested restore.** The dumps are taken; nothing has ever been restored from one. Spool's
  ROLLOUT.md is right that an untested restore is a guess, and proving Loom's is its own step.
- **Loom's root `docker-compose.yml`, its `prod` profile and its `Caddyfile` are unchanged**, and
  they remain the standalone install for a box where Loom owns 80 and 443. The gap list in DOGFOOD
  §2 wanted them parameterised for a second instance; `deploy/` makes that unnecessary rather than
  doing it, and they keep their literal ports.
- **`run.ps1` / `run.cmd` / `run.sh` are unchanged**, and still bring up the dev stack on 3000.
  There is no `--port` and no attach-to-an-existing-database. They are development scripts and the
  live instance is not started from Paw's PC.
- **`.claude/launch.json` stays pinned to 3000**, deliberately (§10). It is the development preview
  harness; the live instance is not a thing it starts.
- **`start_cloudflare_tunnel.cmd` is unchanged and is not deleted.** It is still the way to give a
  cloud-hosted client a URL for the **dev** server on Paw's PC, which is a different need from the
  live instance's stable hostname, and its quick-tunnel caveats stay where DOGFOOD records them.
- **No Content-Security-Policy** on `loom.3dbox.dk` — §4.3's last row: the client has not been
  audited for what it emits, and a wrong policy breaks it silently.
- **No GitHub-side automation of any kind.** Nothing mirrors a Thread to a pull request or back,
  nothing posts from a webhook, no Action deploys on merge. The update is a command a session or Paw
  runs, on purpose: the merge gate is Paw's word, and a deploy that fires without it would route
  around the one rule the project has.
- **No second instance and no staging.** One live instance, one database. A staging Loom would need
  a second hostname, a second certificate and a second keeper, and nothing has asked for one.
- **Nothing about Spool beyond the one hook of §7** — one `import` line, one read-only mount, one
  network. Its headers, its redirect block, its `api`, its database and its rollout are untouched.
- **The reviewer's poll cadence is not ours.** It is a ChatGPT-side schedule, it was one minute and
  then five, and Loom sees nothing of it and cannot. This slice makes the *hostname* stable; it makes
  no promise at all about pickup latency, and DOGFOOD §8's "pickup is not completion" stands.
- **No IPv6.** The A record is the only DNS this slice asks for; no AAAA, and nothing in the compose
  files or the site block configures one.
- **No `docker compose down` path and no rollback script.** Rolling back is `git -C ~/git/Loom
  checkout <sha>` followed by a build and an `up -d` by hand, and a rollback **across** a migration
  needs the dump — restoring it is a hand-run operation with a human deciding, not a script. Saying
  so is more useful than a script nobody has run.

## 14. Deliberate risks, named

Three, because each one is a thing that could go wrong on the day and each has an answer that is
better written down now than discovered then.

1. **Loom shares the shop's front door.** A Loom site block that Caddy refuses would, on a reload,
   be rejected as a whole configuration — Caddy keeps the previous one — so the shop stays up; but a
   reload is a reload, and it restarts certificate management for every host in the file. That is
   why §4.5 step 6 reloads **only when the file changed**, why §9 step 1 runs `caddy validate`
   before anything is installed, and why `loom.caddy` contains no variable that could substitute
   empty.
2. **Loom shares the shop's box.** 4 vCPU and 7.7 GB, against a shop taking about 50 visitors a day
   and a Loom whose load is one reviewer polling every five minutes. A build, though, is the
   expensive part: `docker compose build` compiles five TypeScript packages and a web bundle on the
   same CPUs that serve the shop, for the minute or two it takes. Accepted, because the update runs
   when a human chooses and not on a schedule — and if it ever matters, the answer is to build the
   image on Paw's PC and push it, which is a later slice and not this one.
3. **Two Postgres containers on 29 GB free.** Loom's volume starts empty and grows with an event
   log. Nothing prunes it, nothing watches the disk, and a full disk on this box takes the shop down
   with it. This is the strongest argument in §13's monitoring bullet, and the honest statement for
   now is: the event log of one project's review conversation is small, and nobody is measuring it.
