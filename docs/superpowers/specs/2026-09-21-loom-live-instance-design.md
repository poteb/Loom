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
| Paw does two things by hand: the **DNS A record**, and **re-adding the connector once**, together with the one paste that gets the reviewer into the Weave | They are in panels and an application the session cannot reach, and they happen once |
| Out: Loom's own Caddy/prod profile, scheduled backups, monitoring, GitHub automation | The slice is "the room is always there and one command updates it". Everything else is a later slice with its own decision |

Server facts, from a read-only `ssh SpoolServer` on 2026-09-21 and used throughout below:
Hetzner `ubuntu-8gb-hel1-1` at **89.167.47.120**, root login, Ubuntu, Docker 29.6 with compose
v5.3, git 2.53. Spool runs as compose project **`spool`**: `spool-postgres-1` (Postgres 16),
`spool-api-1`, `spool-caddy-1` publishing 80 and 443, on network `spool_default`. Its checkout is
`~/git/Spool`.

**And the reason that project is called `spool` at all**, which matters because compose otherwise
takes the project name from the directory and Spool's directory is `deploy`: the server-local
`~/git/Spool/deploy/.env` sets `COMPOSE_PROJECT_NAME=spool`. Its key names were read over SSH on
2026-09-21 (`COMPOSE_PROJECT_NAME` among them; no value was printed). That file is not in git, so
the name is a property of the server, not of the repository — §7 therefore requires the hook pull
request to leave it in place, and §9 step 1 verifies it before touching anything. Loom does **not**
copy that trick; it carries its project name in the compose file itself (§4.2), because a name that
lives in an ignored file is a name that can go missing.

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

Six files, and not one of them is generated: they are read by a human deciding whether to trust the
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
| The compose project | `loom`, from the **top-level `name: loom` in `deploy/docker-compose.yml`** — *not* from the directory, which is `deploy` and would otherwise name the project `deploy`. So containers are `loom-postgres-1`, `loom-migrate-1`, `loom-loom-1` and the volume is `loom_pgdata` wherever the command is run from |
| The environment file | `~/git/Loom/deploy/.env`, **`chmod 600`**, created by hand on the server in §9, never in git (`.env` is already in [`.gitignore`](../../../.gitignore)) |
| Database backups | `~/backups/loom/loom-pre-update-<UTC timestamp>.sql.gz`, created by `live-update.sh` in a directory it creates with `install -d -m 700`. Root-only, like Spool's dumps |
| The update lock | `/run/lock/loom-live-update.lock`, held for the whole of one `live-update.sh` run (§4.5 step 1). `/run/lock` is a tmpfs on Ubuntu, so the file is not persistent state and a lock held by a killed shell is released by the kernel when the descriptor closes |
| The previous site block | `/root/caddy-sites/loom.caddy.prev`, written by `live-update.sh` before it replaces `loom.caddy`, and read back only if the reload fails (§4.5). It has no `.caddy` extension, so Spool's `import /etc/caddy/sites/*.caddy` glob does not pick it up — which is the whole reason for that spelling |
| The shared Caddy sites folder | `/root/caddy-sites` on the host, mounted into `spool-caddy-1` at `/etc/caddy/sites:ro`. Created once, by the session over SSH, in §9 step 1 |
| The shared network | `web`, `docker network create web`, once, by the session over SSH in §9 step 1. Declared `external: true` by both projects, so neither owns it and neither `down` removes it |

**Why `~/git/Loom` and not a path under Spool.** The two projects are independent and their
checkouts must be too: a `git pull` in one must not be able to touch the other's tree, and Spool's
origin is a local bundle by policy while Loom's is GitHub. `~/git/` already holds `~/git/Spool`, so
the convention exists.

### 4.2 `deploy/docker-compose.yml`

Three services and one external network. The shape follows Spool's file on purpose — a postgres, a
one-shot migrate gating the app, `restart: unless-stopped` on what must come back after a reboot —
so that someone who has read one has read both.

```yaml
name: loom

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

- **`name: loom` at the top, and this is a correction.** An earlier draft of this spec said the
  project name came from the working directory. It does — and the directory is `deploy`, so every
  command would have run in a project called `deploy`, with containers `deploy-postgres-1` and a
  volume `deploy_pgdata`, none of the names this spec states and none of the names `live-update.sh`
  and §9's done-checks look for. Worse, the name would then depend on who ran the command and from
  where, and an ambient `COMPOSE_PROJECT_NAME` in the root shell's environment could move the live
  database out from under the script. The top-level `name:` key settles it inside the file, in git,
  where a reader can check it: compose's precedence is `-p` over `COMPOSE_PROJECT_NAME` over the
  file's `name:` over the directory, so the only thing that can still override it is an explicit
  flag or variable, and neither appears anywhere in this slice. §9 step 1 proves both project names
  with `docker compose ls` before anything is created.
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
§9 step 12 — the connector actually listing Loom's tools — is what would surface it.

### 4.4 `deploy/.env.example`

Committed; `deploy/.env` is not, and is already covered by the root `.gitignore`'s `.env` line.

```
# Copy to .env on the server, chmod 600. Never commit the result.

# The live Postgres password. One value: docker-compose.yml substitutes it into both
# POSTGRES_PASSWORD and the DATABASE_URL the migrate and loom services get.
# Generate:  openssl rand -base64 24 | tr '+/' '-_' | tr -d '='
LOOM_DB_PASSWORD=

# Instance keeper tokens, comma-separated, each 43 characters of base64url (32 random bytes).
# Seeded ONLY into an empty keepers table: a token added here later does nothing at all and the
# server says so at boot. Rotate with `loom admin keepers add` from an existing keeper instead.
# Generate:  openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
LOOM_KEEPER_TOKENS=

# Not here on purpose:
#   DATABASE_URL         composed in docker-compose.yml from LOOM_DB_PASSWORD, so it cannot drift
#   LOOM_MIGRATE_ON_BOOT fixed to "false" in docker-compose.yml: on this deployment the migration
#                        is the `migrate` service's job and live-update.sh's gate, not the server's
#   PORT / LOOM_HOST     fixed in docker-compose.yml and in the image; the published port is
#                        127.0.0.1:3100 and only the server-local CLI uses it
```

24 bytes for the database password and 32 for a keeper token, because the keeper token's length is a
validated contract (`KEEPER_TOKEN_RE`, 43 characters) and the database password's is not.

**`openssl` and not the `node -e` recipe the README's production paragraph gives, and this is a
correction.** An earlier draft reused the README's `node -e
"console.log(require('crypto').randomBytes(32).toString('base64url'))"` so that an operator would
not have to hold two recipes. But **there is no host Node on this server and this slice does not
install one** (§9 step 0): every piece of Loom that runs there runs in a container built from the
image, and adding a host toolchain to generate two strings would be the only reason it existed.
`openssl` is present on Ubuntu, so the recipe is `openssl rand -base64 <n>` with the two `tr`
filters that turn standard base64 into base64url — `+/` become `-_` and the `=` padding goes. For 32
bytes that yields exactly the 43 characters `KEEPER_TOKEN_RE` requires, which §9 step 3 checks
rather than assumes. The README's Node recipe stays correct for a developer who has the repository
checked out; it is simply not the recipe for this box.

### 4.5 `deploy/live-update.sh`

`#!/usr/bin/env bash` with `set -euo pipefail`, run on the server, **idempotent**: running it twice
with nothing merged in between pulls nothing, applies nothing, reloads nothing, and still ends on a
health check. It must be committed executable (`git update-index --chmod=+x`), because the server
checkout is created by `git clone` and nothing else will set the bit.

It takes **one optional flag, `--bootstrap`** (equivalently the environment variable
`LIVE_UPDATE_BOOTSTRAP=1`), which skips **only** step 10, the public check. Any other argument
prints the usage line `usage: live-update.sh [--bootstrap]` to stderr and exits **2** — the same
exit-code convention as the migrate entry (§5.2), so a mistyped invocation is never mistaken for a
deployment failure.

**The ordering is the design.** Everything that can be judged wrong *without* touching the live
system is judged first — the checkout, and the Caddy configuration this update proposes. Only then
is the database dumped, migrated and the application replaced. The persisted Caddy site file is
written **last**, after Loom is already answering, because the file is the one artefact that
outlives the run: a bad one sits on disk waiting for the next container restart to take the shop
down with it.

The ordered steps, each with what it prints and what makes it stop:

1. **Locate itself, and take the update lock.** `cd "$(dirname "$0")"`, then

       exec 9>/run/lock/loom-live-update.lock
       flock -n 9 || { echo "another live-update is running"; exit 1; }

   The lock is **non-blocking** and is held, through the open descriptor 9, until the script exits
   — the kernel releases it then, including on a kill or a dropped SSH connection, so there is
   nothing to clean up and no stale lock to break. It is taken **before the pull**, which is the
   first thing that changes anything, and covers every step after it. Why it must exist: §2 says
   both Paw and the merge session may run this command, both over root SSH. Two overlapping runs
   would write the same second-resolution backup path, run two migrators against the same journal,
   replace and reload each other's Caddy file between one another's checks, and recreate Loom from
   two different pulled heads — with one run able to report a failed migration after the other had
   already changed the schema and restarted the app. Being told "another live-update is running"
   and exiting non-zero is the whole of the answer. What the lock does **not** cover is someone
   running `docker compose` by hand beside it; §13 says so.
2. **Require a clean checkout that is exactly `origin/main`, then fast-forward it.** Four checks
   and a fetch, each of which stops the script with a printed reason:

       git -C .. symbolic-ref --short HEAD          # must be exactly "main"
       git -C .. status --porcelain --untracked-files=all   # must be empty
       git -C .. fetch origin main
       git -C .. merge --ff-only origin/main
       git -C .. rev-parse HEAD  ==  git -C .. rev-parse refs/remotes/origin/main

   Then it prints the head SHA. **This is a correction to an earlier draft**, which ran
   `git pull --ff-only origin main` alone and claimed that a stray commit or a hand edit would stop
   it. Neither claim holds. `--ff-only` refuses only when the remote is *not* an ancestor, so a
   local commit made on top of a `main` that origin has not since advanced past is happily "already
   up to date" and gets built and deployed as if it were reviewed code; and a dirty tracked edit to
   a file the pull does not touch survives a successful pull untouched. The whole value of this
   deployment is that what runs on the live instance is what was merged on Paw's word, so the
   checkout is required to *equal* `refs/remotes/origin/main` with nothing else in the tree, and
   that is asserted after the fast-forward rather than inferred from it. `--untracked-files=all`
   because an untracked `deploy/loom.caddy` or a stray `Dockerfile` is exactly as capable of
   changing what the build produces as a tracked edit. The one thing deliberately exempted is
   `deploy/.env`, which is git-ignored and must be on the server: `--untracked-files=all` does not
   report ignored files, so no exception has to be written.
3. **Validate the Caddy configuration this update proposes — before anything is mutated.** Staged
   in a temporary directory, checked by a disposable Caddy, and nothing is installed yet:

       STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
       cp /root/caddy-sites/*.caddy "$STAGE"/ 2>/dev/null || true
       cp loom.caddy "$STAGE"/loom.caddy
       docker run --rm \
         -v /root/git/Spool/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
         -v "$STAGE":/etc/caddy/sites:ro \
         --env-file /root/git/Spool/deploy/.env \
         caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

   The stage is a **copy of the live sites folder with `loom.caddy` replaced**, so what is validated
   is the whole configuration that would be in force after the install — not Loom's block in
   isolation, which would miss a duplicate site address or a clash with a future neighbour. The
   mounted Caddyfile is Spool's real one, from Spool's checkout, because that is the file that does
   the `import`. The `--env-file` is Spool's real `.env` because Spool's Caddyfile is written in
   terms of **`SITE_ADDRESS`** and **`REDIRECT_ADDRESSES`** (§3): without them the canonical block's
   site address substitutes empty, Caddy reads the block as global configuration and refuses the
   whole file, and the validation would fail for a reason that has nothing to do with this update.
   That file also holds `COMPOSE_PROJECT_NAME` and Spool's `DB_PASSWORD`; they are handed to a
   container that runs `caddy validate` and exits, `caddy validate` prints neither, and nothing in
   this script reads or echoes the file — but it is worth knowing that the shop's database password
   is in that container's environment for the second the check takes. A non-zero exit here stops the
   script with **nothing touched**: no dump, no build, no migration, the old site file still on disk
   and the shop still up. This is the check that makes a malformed `loom.caddy` a failed update
   rather than a half-deployed one.
4. **Back up, and be precise about what "nothing to back up" means.** Three cases, decided in this
   order, because conflating the second with the third is how a live database gets migrated with no
   dump:

   - **`docker volume inspect loom_pgdata` fails** — there is no volume, so this is the first
     deployment and there is nothing to dump. **Skipped with a printed line**, and that is correct.
   - **The volume exists but the `postgres` container is not running.** Then there *is* a live
     database and the dump is mandatory: `docker compose up -d postgres`, wait for the healthcheck
     to report healthy, then dump. Never skipped. Compose may *recreate* that container rather than
     merely start it, if its service definition changed since it was created — and that is
     harmless, because `pgdata` is a named volume that outlives any container attached to it. What
     matters is that this happens **before** the migration, not that the same container object
     comes back.
   - **The volume exists and Postgres is running.** Dump.

   **This is a correction to an earlier draft**, which skipped the backup whenever
   `docker compose ps --status running -q postgres` was empty and called that "the first
   deployment". It is not: a stopped container over a populated volume gives the same empty answer,
   and the very next step (`docker compose run --rm migrate`) starts Postgres through `depends_on`
   and migrates that populated volume — a schema change on the live database with no dump behind
   it. The volume, not the container, is the thing that tells you whether data exists.

   The dump itself is written so that a file under `~/backups/loom` is never anything but a
   complete backup:

       umask 077
       install -d -m 700 ~/backups/loom
       TS="$(date -u +%Y%m%dT%H%M%SZ)"
       FINAL="$HOME/backups/loom/loom-pre-update-$TS.sql.gz"
       TMP="$(mktemp "$HOME/backups/loom/.loom-pre-update-$TS.XXXXXX")"
       trap 'rm -f "$TMP"' EXIT        # added to the stage's trap, not replacing it
       docker compose exec -T postgres pg_dump -U loom loom | gzip > "$TMP"
       mv "$TMP" "$FINAL"

   Each line earns its place. `umask 077` and `install -d -m 700` **make** the modes this spec
   claims instead of hoping for them — `mkdir -p` and a bare `>` inherit whatever the root shell's
   umask happens to be, and §12 states 700/600 as a property a reviewer can check. The temporary
   file is in the **same directory** so the `mv` is a rename within one filesystem and therefore
   atomic. `pipefail` fails the script on a failed `pg_dump` or `gzip`, and because the redirection
   went to the temporary name, the `trap` removes the partial file: the earlier draft's redirection
   created the final `.sql.gz` *before* the pipeline ran, so a failure left a truncated file whose
   name says "backup" behind. The dot prefix keeps a partial file out of a `ls ~/backups/loom`
   glance. Prints the final path. The backup is before the build and the migration, which is the
   only ordering worth having.
5. **Build.** `docker compose build`. Both services share the image, so this is one build. A build
   failure stops the script with Loom still serving the old image.
6. **Migrate, and stop on failure.**

       docker compose run --rm migrate

   `run --rm` rather than `up migrate`, deliberately and this is the one place the shape had to be
   chosen: `docker compose up <service>` **returns 0 even when the service exited non-zero**, and
   the flag that fixes that (`--exit-code-from migrate`) implies `--abort-on-container-exit`, which
   would stop the live `postgres` alongside the finished one-shot. `run --rm` propagates the
   container's exit code, starts `postgres` via `depends_on` without stopping it afterwards, and
   removes the container. With `set -e`, a non-zero exit **is** the stop: no restart happens, the
   old image keeps serving, the Caddy file on disk is still the one that was there, and the backup
   from step 4 is on disk.
7. **Restart Loom.** `docker compose up -d loom`. Compose recreates the container because the image
   id changed, and runs the `migrate` gate again — a no-op that prints "nothing to apply" (§4.2).
8. **Check health over the loopback port.** `curl -fsS http://127.0.0.1:3100/api/guidelines`,
   retried up to 30 times at one second apart; exhausting the retries **fails the script**.
   `/api/guidelines` rather than `/health`: `/health` answers `{"ok":true}` from the HTTP layer
   alone and would go green on a server that cannot reach its database, whereas
   `/api/guidelines` reads `settings` through core, so a 200 proves HTTP, the database connection
   and the migrated schema in one request. It needs no credential
   ([`routes/guidelines.ts:8`](../../../src/server/src/routes/guidelines.ts)), so the check carries
   no secret. 30 seconds because a cold container has to connect a pool, run `ensureLobby` and bind.
   This check comes **before** the Caddy install so that the site file is never installed in front
   of an application that is not answering.
9. **Install the site block if it changed, atomically, keeping the previous one — and only then
   reload Caddy.**

       cmp -s loom.caddy /root/caddy-sites/loom.caddy || {
         HAD_PREV=0
         [ -f /root/caddy-sites/loom.caddy ] && { cp -p /root/caddy-sites/loom.caddy /root/caddy-sites/loom.caddy.prev; HAD_PREV=1; }
         install -m 644 loom.caddy /root/caddy-sites/.loom.caddy.new
         mv /root/caddy-sites/.loom.caddy.new /root/caddy-sites/loom.caddy
         docker exec spool-caddy-1 caddy reload --config /etc/caddy/Caddyfile || {
           if [ "$HAD_PREV" = 1 ]; then mv /root/caddy-sites/loom.caddy.prev /root/caddy-sites/loom.caddy
           else rm -f /root/caddy-sites/loom.caddy; fi
           echo "caddy reload failed; the previous site configuration was restored"
           exit 1
         }
       }

   `cmp` first because that is what makes the step idempotent, and because a reload restarts
   certificate management — cheap, but not something to do on every update for no change. The write
   is `install` to a temporary name in the same directory followed by `mv`, so Caddy — which is
   watching a glob in a folder it can read at any moment — never sees a half-written file, and the
   temporary name has no `.caddy` extension so the glob cannot match it mid-write.

   **The restore on reload failure is the part that matters, and it is a correction.** An earlier
   draft installed the file and let a failing reload stop the script, reasoning that Caddy validates
   on reload and keeps its previous configuration on error, so the shop stays up. That much is true
   — and it is exactly the trap: the *running* configuration is fine while the *persisted* one is
   poisoned, so the shop stays up until the next `docker compose up`, reboot or container restart,
   and then does not. Restoring `loom.caddy.prev`, or removing the file when there was no previous
   one, leaves the folder in a state Caddy can boot from, and the non-zero exit is what tells the
   caller to go and fix `loom.caddy`. Step 3 makes this path unlikely; it does not make it
   impossible, because step 3 validated against Spool's Caddyfile as it was at that moment and a
   reload happens against whatever is in the container now.
10. **Check health over the public hostname** — `curl -fsS https://loom.3dbox.dk/api/guidelines`,
    retried up to 10 times at three seconds apart, then `echo "health: ok"`; exhausting the retries
    **fails the script**. Skipped, with a printed line, when `--bootstrap` was given.

    **Why the loopback check is not enough.** A site block can be syntactically perfect, reload
    cleanly and still send every visitor to nothing: `reverse_proxy looom:3000` is a valid
    directive. Loom keeps answering on `127.0.0.1:3100`, so step 8 goes green while every human and
    the reviewer get a 502 from Caddy. The public check is the only one that exercises DNS, TLS,
    Caddy's routing, the `web` network and the database in one call, and `/api/guidelines` needs no
    credential so it can be the one that does it.

    **Why `--bootstrap` exists, and what it costs.** §9 runs the script once before the DNS A
    record exists and before a certificate has been issued, so the public check cannot pass then
    and the first deployment would be unable to use the real script — which is the thing that makes
    §9 step 5 worth doing at all. `--bootstrap` skips that one check and nothing else. Its price is
    that a bootstrap run has *not* proved the public path, so §9 step 8 is a numbered step that
    **reruns the script in normal mode** once the certificate exists, and that rerun is what
    completes the first deployment's end-to-end check. Every update after that is a normal run.

Nothing in the script prints a token, a secret or a `DATABASE_URL`. The two places a credential
could surface are a compose error echoing `environment:` — which is why `.env` holds only two values
and neither is echoed by the script itself — and step 3's `--env-file`, which hands Spool's
environment to a container that prints only a validation verdict.

### 4.6 The local wrapper

`deploy/live-update.ps1`:

```powershell
$ErrorActionPreference = "Stop"
ssh SpoolServer "~/git/Loom/deploy/live-update.sh $($args -join ' ')"
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
to change if any of them does. The remote command is one double-quoted string so that `~` is
expanded by the **remote** login shell and not by PowerShell, and `$args` is appended so
`deploy\live-update.cmd --bootstrap` reaches the script — the only argument it takes (§4.5). The
exit code is forwarded, so a failed migration fails the local command — which is what makes this
usable as the last step of a merge.

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
it; it lands as its own small pull request there, and §9 step 1 will not proceed until Paw has given
his merge word for it. Three edits, one thing the PR must leave alone, and two server-side
prerequisites the session runs.

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

**And one thing the hook pull request must not do: change how Spool gets its project name.** Spool's
project is `spool` because the server-local, git-ignored `~/git/Spool/deploy/.env` sets
`COMPOSE_PROJECT_NAME=spool` (§3). Every container name, the `spool_default` network and Spool's own
volumes hang off that. So the hook PR adds the `import` line, the mount and the two networks and
**leaves that variable in place**; it does not remove it, does not rename it, and does not add a
top-level `name:` that a reader might take for the operative one. With it in place, no Spool command
in this spec needs `-p spool` — a plain
`docker compose -f ~/git/Spool/deploy/docker-compose.yml …` run from any directory picks the
project name out of the env file beside that compose file, which is where compose looks for it.
§9 step 1 verifies that before it touches Caddy, because the cost of being wrong is the shop's
containers being recreated under a second project name.

**The two prerequisites, run by the session over SSH before Spool's compose is re-upped** — this
ordering is the whole of the risk in §7:

    docker network create web
    install -d -m 755 /root/caddy-sites

An `external: true` network that does not exist makes `docker compose up` **refuse**, which would
take the shop down for as long as it took to notice. A missing bind-mount source would be created by
Docker as a root-owned empty directory, which is harmless, but creating it deliberately is one
command and removes the question. The folder is created empty and stays that way in git — there is
no `.gitkeep`, because the folder is not in either repository: it is a host path both projects
reference.

**An empty sites folder.** A glob `import` that matches no files is not a Caddyfile error, so
Spool can merge and re-up before Loom exists. That claim is **verified rather than assumed** in §9
step 1 — and verified in a **disposable** `caddy:2-alpine` container, before the shop's Caddy is
recreated, so that being wrong about it costs a failed command instead of the shop's front door.
The step carries its contingency: if Caddy refuses the empty glob, a `00-placeholder.caddy` holding
a single `#` comment line goes in the folder **before** the first recreation, and `live-update.sh`
never touches it.

Spool's canonical block, its redirect block, its headers, its `api`, its `postgres` and its volumes
are **not** touched. Nothing about the shop's behaviour changes.

## 8. What Paw does by hand, and what the session does over SSH

**Paw does exactly two things: §9 step 6 and §9 step 12.** Everything else — including §9 step 1,
the Spool hook applied on the server — is the session's, over `ssh SpoolServer`, which is how Spool
is already deployed. Step 1 waits on Paw's **merge word for the Spool pull request** and on nothing
else; the merge is Paw's decision, the multi-command root deployment that follows it is not Paw's
typing. Hand-run steps go to Paw **one at a time, with the real values already substituted**,
waiting for each result before the next is sent ([HANDBOOK.md](../../HANDBOOK.md) §4).

**This is a correction.** An earlier draft said here that Paw's two items were DNS and the
connector, and then said in §9 that steps 1 and 6 were Paw's — which handed him a batch of root
`docker` commands and left the one step the session genuinely cannot perform, the connector, marked
as the session's. A session reading §8 would have waited for Paw to do step 1; a session reading §9
would have sent him the batch. The rule is the one §8 already implied: a step is Paw's when it is in
a panel or an application the session cannot reach, and only then.

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

**Paw, item 2 — the connector and one paste, once.** Remove ChatGPT's existing Loom connector and
add `https://loom.3dbox.dk/mcp?agent=<key>` as a remote MCP server of type **Streamable HTTP** — not
STDIO, which fails silently with the client reporting only that the connector's tools are not
exposed (DOGFOOD §3 step 4). This is the last time it has to be done: the hostname is now stable, so
the connector survives every restart and every update. In the same sitting Paw pastes the prepared
onboarding text into the ChatGPT session (§9 step 12), which is what gets the reviewer into the
Weave without its secret ever appearing in a Claude conversation.

### 8.1 Credentials: exactly where each one is generated, stored and read

**Credentials never pass through the conversation.** This is a standing trap
([HANDBOOK.md](../../HANDBOOK.md) §5, from the 2026-09-20 run). An earlier draft of this spec stated
that rule and then left the commands that honour it unwritten — a `node -e "console.log(…)"` in a
root SSH session prints its result into the session's captured output, which is the opposite of the
promise. So every command is given here, in the form that is actually run.

**The five files, and what is in each.**

| File | Written by | Holds |
| --- | --- | --- |
| `~/git/Loom/deploy/.env` on the **server** | §9 step 3, generated in place | `LOOM_DB_PASSWORD`, `LOOM_KEEPER_TOKENS` |
| `C:\Users\paw\.loom\live.env` | §9 step 3, `scp` of the above | the same two lines — the only copy off the server |
| `C:\Users\paw\.loom\live-keeper.json` | §9 step 3, derived locally | `{ "url": "https://loom.3dbox.dk", "token": "<43 chars>" }` |
| `C:\Users\paw\.loom\live-claude-code.json`, `…\live-chatgpt.json` | §9 step 10, redirected `--json` | the `admin agents add` payload: `agent.id`, `agent.name`, `key` |
| `C:\Users\paw\.loom\live-weave.json` | §9 step 11, redirected `--json` | the `create` payload: `weave.id`, `secret`, `token`, `participant` |
| `C:\Users\paw\.loom\live-lobby.json` | §9 step 10, redirected `--json` | the Lobby's `weaveId` and its `secret` (only a keeper is told it) |

**Server side — generated straight into the file, nothing printed.** One command, run over SSH:

    umask 077
    { printf 'LOOM_DB_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
      printf 'LOOM_KEEPER_TOKENS=%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
    } > ~/git/Loom/deploy/.env

`openssl` rather than host Node, for the reason in §4.4. The command substitution's output goes into
`printf`'s argument and from there into the file; **no value reaches stdout**, so the session's
transcript records only that the command exited 0. `umask 077` gives the file mode 600 as it is
created, rather than creating it world-readable and narrowing it a moment later. The checks that
follow read *shapes*, never values:

    stat -c %a ~/git/Loom/deploy/.env                       # 600
    awk -F= '$1=="LOOM_KEEPER_TOKENS"{print length($2)}' ~/git/Loom/deploy/.env   # 43
    awk -F= '$1=="LOOM_DB_PASSWORD"{print length($2)}' ~/git/Loom/deploy/.env     # 32

43 is the length `KEEPER_TOKEN_RE` requires, and checking it here is cheaper than discovering at
boot that the seeding was refused.

**Transfer to Paw's PC — one `scp`, no display.**

    scp SpoolServer:~/git/Loom/deploy/.env C:\Users\paw\.loom\live.env

Then the keeper file is derived **locally**, by a Node one-liner that reads the file and writes JSON
and prints nothing (Node is on Paw's PC; it is the repository's toolchain):

    node -e "const fs=require('fs');const t=fs.readFileSync('C:/Users/paw/.loom/live.env','utf8').match(/^LOOM_KEEPER_TOKENS=(.+)$/m)[1].trim().split(',')[0];fs.writeFileSync('C:/Users/paw/.loom/live-keeper.json',JSON.stringify({url:'https://loom.3dbox.dk',token:t},null,2))"

Forward slashes in the paths, deliberately: Node accepts them on Windows, and a backslash path
inside a PowerShell double-quoted string invites the one escape rule that would break it silently.
Nothing is printed — the token goes from the file, through a variable, into the JSON.

**On Windows ACLs: nothing extra is needed, and that is a decision rather than an omission.**
`C:\Users\paw\.loom` is a folder inside Paw's own profile, which inherits an ACL granting Paw and
the local administrators full control and nobody else anything — the same protection
`~/.loom/config.json` already relies on for every per-Weave token the CLI stores. So no `icacls`
call appears in §9. If the folder ever moves outside the profile that changes, and the spec would
have to say so; it does not move in this slice.

**The live CLI must not reuse the development instance's state.** The CLI's config file is
`$LOOM_CONFIG` when that variable is set, and `~/.loom/config.json` otherwise
([`src/cli/src/config.ts:32-34`](../../../src/cli/src/config.ts)) — that file is where `create` and
`join` store per-Weave tokens and which Weave is "current". Every live command in §9 therefore sets

    $env:LOOM_CONFIG = "C:\Users\paw\.loom\live-config.json"

so the live instance's Weave tokens land in their own store and a `--weave`-less command can never
address the dev server's Weave by accident. `LOOM_CONFIG` is the variable's real name, read from the
CLI source rather than assumed.

## 9. The first deployment runbook

Fourteen steps, numbered 0 to 13, in order, each ending on something checkable. **Steps 6 and 12 are
Paw's** (§8); every other step is the session's, over SSH or over the public hostname. Step 1 waits
on Paw's merge word for the Spool pull request and is then run by the session.

Every command Paw's PC runs in this runbook is given in **PowerShell** form, and every one of them
sets `LOOM_CONFIG` first (§8.1). The prelude, run once per PowerShell session and assumed by steps 9
onward:

    $env:LOOM_CONFIG = "C:\Users\paw\.loom\live-config.json"
    $env:LOOM_KEEPER_TOKEN = (Get-Content C:\Users\paw\.loom\live-keeper.json | ConvertFrom-Json).token

There is no `loom` on `PATH`; the CLI is invoked from the repository as `node src\cli\bin\loom.js`,
which is the form the README already uses. `LOOM_KEEPER_TOKEN=<token> loom …` is shell syntax that
is valid in neither PowerShell nor `cmd.exe`, and an earlier draft used it — this is the correction.
In practice the session runs these itself in the worktree; Paw's own typing is steps 6 and 12.

0. **Prerequisites on the server.** Everything this runbook and `live-update.sh` invoke, checked
   before anything is created:

       for c in docker git curl gzip flock openssl dig; do command -v "$c" >/dev/null || echo "missing: $c"; done
       docker compose version

   `docker` and `git` were observed on 2026-09-21 (§2); the rest were not, and a "command not
   found" three steps into a deployment is the kind of stop this step exists to move earlier.
   `flock` comes from `util-linux` and `dig` from `dnsutils`; the missing ones are installed with
   `apt-get update && apt-get install -y util-linux dnsutils curl gzip openssl`. **Host Node is not
   required anywhere** on this server and is not installed: every secret is generated with
   `openssl` (§4.4), and every piece of Loom that runs there runs inside the image.
   *Done when:* the loop prints nothing and `docker compose version` answers with a version rather
   than an error — the compose v5.3 §2 recorded, or later.
1. **Spool's change is merged and applied.** Its pull request (§7) is merged on Paw's word; then,
   by the session, on the server, in this order:

   1. **Verify the two project names before touching anything** — `docker compose ls`, which must
      list `spool` as running and must **not** list `deploy` or `loom`. This is the check that
      catches a hook PR that dropped `COMPOSE_PROJECT_NAME=spool` from
      `~/git/Spool/deploy/.env` (§7); if `spool` is not there under that name, stop and fix the
      env file, because the next command would otherwise create a second project alongside the
      shop's running one.
   2. `docker network create web` and `install -d -m 755 /root/caddy-sites`, then
      `git -C ~/git/Spool pull`.
   3. **Preflight Spool's proposed Caddyfile in a disposable container, before Caddy is recreated**
      — the same shape as `live-update.sh` step 3, with an empty sites directory because that is
      the state the shop is about to run in:

          docker run --rm \
            -v /root/git/Spool/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
            -v /root/caddy-sites:/etc/caddy/sites:ro \
            --env-file /root/git/Spool/deploy/.env \
            caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

      **Why before and not after, which is a correction.** An earlier draft ran `up -d caddy` and
      *then* `docker exec spool-caddy-1 caddy validate`. By then the working Caddy container has
      already been replaced: if the `import` line is mistyped, or if the deployed Caddy build
      refuses an `import` glob that matches no files, the new container exits, `docker exec` has
      nothing to run in, and the shop is **down** while the contingency is being diagnosed. A
      disposable container validating the same file with the same mounts and the same environment
      costs one command and cannot affect the running shop. *If it refuses the empty glob:* write
      `/root/caddy-sites/00-placeholder.caddy` containing one `#` comment line and repeat — the
      placeholder is installed **before** the first recreation, not after it, and
      `live-update.sh` never touches that file.
   4. `docker compose -f ~/git/Spool/deploy/docker-compose.yml up -d caddy`, then the same
      `caddy validate` again via `docker exec spool-caddy-1` — kept as a **second** check, because
      it is the only one that reads the configuration as the container actually mounted it.

   *Done when:* both validates print `Valid configuration`, `docker compose ls` still shows exactly
   `spool` (no `deploy`), `docker network inspect web` lists `spool-caddy-1`, and
   `https://shop.3dbox.dk` still serves the shop.
2. **Clone Loom.** `git clone https://github.com/poteb/Loom.git ~/git/Loom` — no credentials, the
   repository is public. *Done when:* `git -C ~/git/Loom rev-parse HEAD` equals the `main` SHA the
   session expects, `git -C ~/git/Loom status --porcelain --untracked-files=all` is empty, and
   `ls ~/git/Loom/deploy` lists all six files with `live-update.sh` executable.
3. **Generate the secrets on the server, then copy them once.** The exact commands are in §8.1 and
   are not repeated here: generate straight into `~/git/Loom/deploy/.env` with `umask 077` and
   `openssl`, check the shapes with `stat` and `awk`, `scp` the file to
   `C:\Users\paw\.loom\live.env`, and derive `C:\Users\paw\.loom\live-keeper.json` locally. Nothing
   prints a value at any point. `deploy/.env.example` is **not** copied first — writing the two
   lines directly is fewer steps and leaves no commented template to be half-filled.
   *Done when:* `stat -c %a ~/git/Loom/deploy/.env` is `600`, the two `awk` length checks print `32`
   and `43`, and `Test-Path C:\Users\paw\.loom\live-keeper.json` is `True`.
4. **Bring it up.** In `~/git/Loom/deploy`: `docker compose up -d`. Postgres starts, `migrate` runs
   to completion against an empty database and applies all five migrations, then `loom` starts.
   *Done when:* `docker compose ls` now lists `loom` (and still no `deploy`), `docker compose ps`
   shows `postgres` and `loom` running and `migrate` exited 0, `docker volume inspect loom_pgdata`
   succeeds, and `docker compose logs loom` carries `keepers: seeded 1 from LOOM_KEEPER_TOKENS`,
   `lobby: created /w/…` and `loom server listening on http://0.0.0.0:3000`.
5. **Install the site block and reload Caddy** — by running the real script, so that the first
   deployment exercises it: `~/git/Loom/deploy/live-update.sh --bootstrap`. It takes the lock,
   confirms the checkout equals `origin/main` and pulls nothing new, validates the proposed Caddy
   configuration, takes a dump (the volume exists and Postgres is up), rebuilds, runs migrate
   (nothing to apply), restarts `loom`, passes the loopback check, installs `loom.caddy` and reloads
   Caddy. `--bootstrap` is required here and **only** here: there is no A record yet, so the public
   check of §4.5 step 10 cannot pass. *Done when:* it prints the skipped-public-check line,
   exits 0, `/root/caddy-sites/loom.caddy` exists with mode 644, and a dump exists under
   `~/backups/loom` with no leftover dot-prefixed temporary file.
6. **Paw adds the DNS A record** (§8 item 1). *Done when:* `dig +short loom.3dbox.dk` from the
   server answers `89.167.47.120`.
7. **Watch the certificate.** `docker compose -f ~/git/Spool/deploy/docker-compose.yml logs -f caddy`
   — or re-reload Caddy to skip the accumulated ACME backoff, which is the trick Spool's own cutover
   runbook records. *Done when:* the log carries a successful certificate obtain for
   `loom.3dbox.dk`, and `curl -fsS https://loom.3dbox.dk/api/guidelines` answers 200 with no
   certificate warning.
8. **Rerun the update in normal mode**, which is what finishes the first deployment:
   `~/git/Loom/deploy/live-update.sh` with no flag. It pulls nothing, applies nothing, reloads
   nothing (`cmp` says the site file is unchanged) and runs the **public** check that step 5 was
   allowed to skip. This step exists because a `--bootstrap` run has not proved the public path, and
   a deployment that has never proved it is not finished. *Done when:* it prints `health: ok` and
   exits 0.
9. **Keeper check over the public hostname**, the first credentialed call end to end. On Paw's PC,
   after the prelude above:

       node src\cli\bin\loom.js --url https://loom.3dbox.dk admin weaves

   *Done when:* it prints a list (the Lobby, at this point) rather than `invalid_token`. Note that
   the global `--url` comes **before** the command name.
10. **Mint the two agent keys and capture the Lobby secret**, each with `--json` redirected into its
    own file so no key is ever rendered into the conversation (§8.1):

        node src\cli\bin\loom.js --json --url https://loom.3dbox.dk admin agents add Claude-Code > C:\Users\paw\.loom\live-claude-code.json
        node src\cli\bin\loom.js --json --url https://loom.3dbox.dk admin agents add ChatGPT     > C:\Users\paw\.loom\live-chatgpt.json
        node src\cli\bin\loom.js --json --url https://loom.3dbox.dk lobby                        > C:\Users\paw\.loom\live-lobby.json

    A redirected `--json` invocation is exactly how the 2026-09-20 interim setup captured its keys,
    and it is the reason the key never appears anywhere else: `admin agents add` shows it **once**.
    The `lobby` command is told the Lobby's own secret only because `LOOM_KEEPER_TOKEN` is set
    ([`commands/lobby.ts`](../../../src/cli/src/commands/lobby.ts)), which is what makes
    `live-lobby.json` the home for the Lobby's `/w/<secret>` page link.
    *Done when:* `admin agents list` shows both, unrevoked; all three files exist; and
    `(Get-Content C:\Users\paw\.loom\live-claude-code.json | ConvertFrom-Json).agent.id` prints a
    uuid.
11. **Create the Weave as the Claude-Code agent.** The agent key is loaded from its file and the
    keeper token is **cleared for this one command**:

        $env:LOOM_AGENT_KEY = (Get-Content C:\Users\paw\.loom\live-claude-code.json | ConvertFrom-Json).key
        $env:LOOM_KEEPER_TOKEN = $null
        Get-Content -Raw C:\Users\paw\.loom\live-guidelines.md | node src\cli\bin\loom.js --json --url https://loom.3dbox.dk create --title "Loom development" --name Claude-Code --kind agent --guidelines - > C:\Users\paw\.loom\live-weave.json
        $env:LOOM_AGENT_KEY = $null
        $env:LOOM_KEEPER_TOKEN = (Get-Content C:\Users\paw\.loom\live-keeper.json | ConvertFrom-Json).token

    The last two lines put the shell back the way step 9's prelude left it, so a later keeper
    command is not silently made as an agent — the same precedence that matters below, read the
    other way round.

    `live-guidelines.md` is the guidelines text from [DOGFOOD.md](../../DOGFOOD.md) §3 step 2,
    copied verbatim into a local file — it is the approved text and this step copies it rather than
    rewriting it.

    **Why the agent key, and why the keeper token has to be out of the way.** `create` presents
    `LOOM_KEEPER_TOKEN ?? LOOM_AGENT_KEY`, in that order
    ([`commands/weave.ts`](../../../src/cli/src/commands/weave.ts)) — so with both set, the keeper
    token wins and the creator is an ordinary per-Weave participant that merely *happens* to be
    called `Claude-Code`, with no link to the agent identity minted in step 10. When the real
    Claude-Code agent later joins with its key it would then be a **different** identity, and would
    meet `name_taken` on the name it should already own: exactly the predecessor problem this whole
    setup exists to end. Presenting the agent key links the creating participant to the agent, the
    same way `join` does. *Done when:*
    `(Get-Content C:\Users\paw\.loom\live-weave.json | ConvertFrom-Json).participant.agentId`
    equals `(Get-Content C:\Users\paw\.loom\live-claude-code.json | ConvertFrom-Json).agent.id`,
    and `loom --url https://loom.3dbox.dk guidelines` prints the instance layer under
    `## Loom guidelines` and the DOGFOOD text under `## Guidelines for this Weave`.
12. **Paw re-adds the connector and pastes one prepared text** (§8 item 2). The session assembles
    that text into `C:\Users\paw\.loom\live-chatgpt-paste.md` beforehand: the reviewer brief
    ([DOGFOOD.md](../../DOGFOOD.md) §4) plus an instruction to call
    `join_weave({ secret: "<secret>", name: "ChatGPT" })`, with the secret read out of
    `live-weave.json`. Paw copies the file's contents and pastes them into the ChatGPT session; the
    connector URL comes the same way, from `live-chatgpt.json`.

    **The decision, and the route not taken.** The secret travels **Paw's clipboard, not a Claude
    conversation** — which is what §8.1 requires, and it is how ChatGPT was brought into a Weave on
    2026-09-20, so it is a route with a run behind it. The credential-free alternative is real and
    is the one to use **once ChatGPT stands in the live Lobby**: ChatGPT joins the Lobby with its
    agent key, a keeper of the development Weave runs
    `loom --weave <id> invite-weave <lobbyParticipantId> --thread <generalThreadId>`, ChatGPT sees
    the invitation id through `inbox` and redeems it with `join_weave({ inviteId })` — no secret
    moves at all. It is not the first-run route because it adds a second polling dependency on the
    one day nothing has been proved yet: it needs ChatGPT to have joined the Lobby, to be polling
    `inbox`, and to pick the invitation up, before anyone knows whether its connector works at all.
    First run proves the connector with the shortest path; the invitation route takes over
    afterwards and the Lobby-join is worth doing in the same sitting so that it can.

    *Done when:* the reviewer's client lists Loom's tools, `join_weave` returns an identity and both
    guideline layers, and the server's log shows **no** 500 from its reconnect polls — which is §5.4
    proved in the place the defect was found.
13. **Run one review round on the live instance**, by the protocol in
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
| [HANDBOOK.md](../../HANDBOOK.md) §5 traps | Five new ones, all paid for in writing this spec and in answering its first review round: `docker compose up <service>` **returns 0 even when the service failed**, and `--exit-code-from` implies `--abort-on-container-exit`, which would stop the live database — use `docker compose run --rm`; **HSTS `includeSubDomains` does not cover a sibling host**, so `loom.3dbox.dk` needs its own; **a compose project is named after its directory unless the file says otherwise** — two `deploy/` directories are two projects called `deploy`, so put `name:` in the file; **`git pull --ff-only` does not mean "the checkout equals origin"** — it succeeds over a local commit the remote has not passed and leaves a dirty tracked file alone, so assert `HEAD == refs/remotes/origin/main` on a clean tree instead; and **a stopped Postgres container is not an empty database** — ask the volume, or a migration runs with no dump behind it |
| [ARCHITECTURE.md](../../ARCHITECTURE.md) §10 | A third paragraph: the two root-level profiles are the **standalone** install, `deploy/` is the **beside another Caddy** install, and this is where the shared `web` network and the sites-folder hook are described. The sentence "Migrations run on every boot in `main.ts`" is corrected to name `LOOM_MIGRATE_ON_BOOT` |
| [README.md](../../../README.md) "Running locally" | A short **Deploying beside another Caddy** paragraph pointing at `deploy/` and naming the one command; the existing production paragraph keeps describing the standalone `--profile prod` install |
| [TESTING.md](../../TESTING.md) §1 | The generalised truncate guard (`_test` suffix), the testcontainer's database name, and the sentence about pointing `TEST_DATABASE_URL` somewhere safe (§6). One more sentence in the build-before-test paragraph: `src/server/test/migrate.test.ts` runs the built entry as a child process, so it is one of the suites that needs `pnpm -r build` first (§11.2) |
| [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) | **Rows deleted:** the `mcp/index.ts:111` session-less `GET` 500 (§5.4). **Rows added:** none — §13 is scope, not defects |
| [v2-notes.md](v2-notes.md) | The "A live Loom instance …" entry becomes **built**, dated, with the hostname, the `deploy/` path and a one-line pointer to this spec; the 2026-09-20 dogfood finding about the session-less `GET` gains its "fixed in PR #N" note |
| [CONTRIBUTING.md](../../../CONTRIBUTING.md) | Nothing. No convention changes |
| `.claude/launch.json` | **Unchanged, deliberately.** It stays pinned to port 3000: it is the *development* preview harness on Paw's PC, and the live instance is not something the harness starts. DOGFOOD's gap list said it "cannot start the live instance without editing it" — that row is not a gap any more, it is the right behaviour, and §13 says so |

## 11. Tests

Every test below is assigned to exactly one plan task
([HANDBOOK.md](../../HANDBOOK.md) §3 step 5). The six groups are honest about what is and is not
covered by an automated suite, and §11.6 is the one that says what no suite touches at all.

**The migration tests are two files, not one, and that is a correction.** An earlier draft put both
`migrationStatus` and the migrate entry's process behaviour — `--check`, the exit codes, the output,
the pool shutdown — in `src/core/test/migration-status.test.ts`. Neither way of writing that file is
allowed: importing `src/server/src/migrate.ts` into a core test inverts the dependency direction the
layering rule fixes (core never imports server, [CONTRIBUTING.md](../../../CONTRIBUTING.md)
§"Layering"), and spawning `src/server/dist/migrate.js` from a core test makes a package-local
`vitest` run depend on another package's build output — absent on a clean checkout, and stale
whenever it is not absent. So the rule about the database is tested in core and the entry point's
behaviour as a process is tested in server, each in the package that owns it.

### 11.1 `migrationStatus` — `src/core/test/migration-status.test.ts`

Against a **dedicated Testcontainers Postgres started by this file**, not the shared global-setup
database: the first cases need a database with *no* migrations applied at all, and the shared one is
migrated once per run by `freshDb()`. `@testcontainers/postgresql` is already a dependency in this
workspace, and the file stops its own container in `afterAll`. It imports `@loom/core` and nothing
else from this repository; applying is done by core's own `runMigrations`, never by the server entry.

1. **A fresh database lists every journal entry as pending and nothing as applied** — the count
   equals the journal's entry count, the order is the journal's, and
   `to_regclass('drizzle.__drizzle_migrations')` is null, which is the probe of §5.1 answering.
2. **Applying moves them all across.** After `runMigrations`, `migrationStatus` reports every tag
   applied and nothing pending.
3. **A second run applies nothing.** Idempotence, and the assertion is the *rule* — `pending` is
   empty and the table's row count is unchanged — never an exact write count
   ([HANDBOOK.md](../../HANDBOOK.md) §5).
4. **The listing agrees with the migrator's own rule** — a row in `__drizzle_migrations` whose
   `created_at` equals the second journal entry's `when` makes entries 0 and 1 applied and the rest
   pending, which is the maximum-based rule of §5.1 and not a set difference.

### 11.2 The migrate entry as a process — `src/server/test/migrate.test.ts`

Also against a **dedicated Postgres**, provisioned by the same code as 11.1: the container setup is
pulled into one small helper that both files import from their own package's test directory (core's
copy is the definition; server's test imports the container *recipe*, not a core test file). Each
case runs the built entry as a child process, because the exit code, the stream each line goes to
and the fact that the process ends at all are the contract `live-update.sh` depends on and none of
them can be observed by calling a function. The suite therefore builds the package first, which
[TESTING.md](../../TESTING.md) already requires of the server tests.

5. **No flag, nothing pending:** prints `migrations: 5 applied, nothing to apply` on stdout,
   exit **0**.
6. **No flag, some pending:** prints the applied count, then `applying:` and each pending tag on its
   own line, applies them, then the `migrations: applied 2 (…)` summary; exit **0**, and the
   database is migrated afterwards.
7. **`--check` applies nothing.** With migrations pending it prints the same listing with `pending:`
   in place of `applying:`, leaves `to_regclass('drizzle.__drizzle_migrations')` as it found it, and
   exits **0** — the convention of §5.2, that `--check` answers *what would you do* and is not a
   gate. With nothing pending it prints the nothing-to-apply line and exits 0.
8. **An unknown argument exits 2** and prints the usage line to **stderr**, with nothing on stdout
   and no connection attempted — a mistyped invocation must be distinguishable from a failure.
9. **`DATABASE_URL` absent** fails with the same message `loadConfig` already gives, and exits
   **1**.
10. **The process ends on every path.** Each of the cases above is asserted to exit within the
    suite's timeout rather than being killed, which is what proves `closeDb` runs — a migrate
    container that never exits would hang `docker compose run --rm migrate` and therefore hang the
    update, with the lock of §4.5 step 1 still held.

### 11.3 The boot switch — `src/server/test/config.test.ts` and the server boot suite

11. **Default true.** `loadConfig({ DATABASE_URL: … })` gives `migrateOnBoot: true`; `"true"` and
    `"false"` (in any case, with surrounding whitespace) parse to the obvious values.
12. **Anything else throws** — `"0"`, `"no"`, `""`, `"yes"` — with the variable name in the message.
13. **`false` with migrations pending refuses to start**, with the message of §5.3 naming the count
    and the pending tags, and the process exits non-zero. Against a database migrated to an earlier
    point than the journal (the row-insert trick of case 4).
14. **`false` with nothing pending starts normally** and serves a request — the case that proves the
    refusal is not simply "false never boots".
15. **`true` is unchanged**: a server booted against an unmigrated database migrates it and serves,
    exactly as today.

### 11.4 The MCP guard — `src/server/test/mcp.test.ts`

16. **Session-less `GET /mcp?agent=<key>` answers 400 `{ code: "validation" }`** — with a valid agent
    key, and with `Accept: text/event-stream`, because that is the request the real connector sends.
17. **Session-less `DELETE /mcp` answers 400** the same way.
18. **A session-less `GET` with a revoked key is still 400, not 401** — the guard runs before any
    credential resolution (§5.4).
19. **A bogus `mcp-session-id` is still 404 `not_found`** — the existing case, unchanged.
20. **A full `initialize` over `POST` still works**, and the two concurrent session-less `PUT`
    requests of `mcp.test.ts:95` still get two connect attempts and two 405s — the coverage the
    guard's method list exists to preserve.

### 11.5 The truncate guard — `src/core/test/db-guard.test.ts`

21. **Refused:** a URL whose database is `loom`; one whose database is `spool`; one whose database is
    `loom_live`; one whose database is `postgres`; and an unparseable URL.
22. **Allowed:** `loom_test`; any other `<name>_test`; and the **named testcontainer URL** of §6
    (`.../loom_test`) — replacing the old case that asserted a bare `test` database was allowed.
23. **Not fooled by the name elsewhere in the URL** — `postgres://loom:loom@loom:5432/loom_test` is
    allowed. The existing case, kept.
24. **`fallbackTestUrl` is unchanged** — both existing cases stand.
25. **The whole suite still runs.** Not a test but a verification step the plan must name: after
    `.withDatabase("loom_test")`, `pnpm --workspace-concurrency=1 -r test` passes on the normal
    Testcontainers path *and* on the fallback path. Case 22 would pass while every other test in the
    repository refused to start, which is precisely the failure §6 exists to prevent.

### 11.6 What no unit test covers, said plainly

**`deploy/docker-compose.yml`, `deploy/loom.caddy`, `deploy/live-update.sh` and the two wrappers are
verified by the first deployment (§9) and by nothing else.** There is no compose harness in this
repository, no Caddy fixture and no shell-test framework, and inventing one for five files that run
once per merge against one specific server would be a larger and less honest change than reading
them. What stands in for automation:

- Every §9 step has a "done when" that checks the thing the previous step claimed to do, and steps 5
  and 8 run the **real** `live-update.sh` rather than its steps by hand — step 5 with `--bootstrap`
  and step 8 without, so that both modes are exercised on the first day.
- The failure paths that matter are structural rather than tested: `flock -n` on an open descriptor
  cannot let two runs overlap; the `HEAD == refs/remotes/origin/main` assertion cannot pass on a
  dirty or locally-committed tree; a `caddy validate` that fails stops the run before the database
  is touched; the dump's `mktemp` + `mv` cannot leave a partial file under a name that looks like a
  backup; `set -euo pipefail` plus `docker compose run --rm`'s exit code cannot skip a failed
  migration; `cmp` makes the Caddy install idempotent; the `.prev` restore cannot leave an
  unbootable sites folder behind a failed reload; `${LOOM_DB_PASSWORD:?…}` cannot default; the
  top-level `name: loom` cannot be moved by the caller's directory; and both health checks read a
  route that touches the database.
- The **second** time the script runs — §9 step 8, and then the first real merge after this slice —
  is when idempotence is actually observed. That run is recorded in v2-notes as a dogfood note,
  whatever it shows.
- The one mechanism nothing at all exercises before the day is the **reload-failure restore** of
  §4.5 step 9: it needs a `loom.caddy` that validates in the staged check and is then refused by the
  running Caddy. It is written to be read, and §14 names it as a risk rather than pretending it is
  covered.

## 12. Security notes

Short, and each one a property a reviewer can check.

- **`deploy/.env` is mode 600, root-only, server-local and git-ignored.** It holds two values, the
  database password and the keeper token, and nothing in the repository or in any script prints
  either. The mode is **made** rather than hoped for: §8.1 creates the file under `umask 077`, and
  §9 step 3's done-check is `stat -c %a`. The root `.gitignore` already covers `.env`.
- **No secret is in the repository.** `deploy/.env.example` holds empty keys and two `openssl`
  generator lines. The keeper token is generated **on the server**, straight into the file, by a
  command whose stdout stays empty (§8.1); agent keys are generated **by the live instance** and only
  ever hashed in its database ([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Naming and value
  rules"), and reach a file by `--json` redirection rather than by being rendered anywhere.
- **The copies on Paw's PC live in `C:\Users\paw\.loom`**, inside his own profile, whose inherited
  ACL grants him and the local administrators access and nobody else — the same protection
  `~/.loom/config.json` already relies on for every per-Weave token the CLI stores. Six files
  (§8.1), one of which, `live.env`, is the only copy of the server's `.env` off the server. No
  `icacls` call is needed and none is specified; if that folder ever moved outside the profile, this
  line would have to change with it.
- **The live CLI has its own config file.** Every live command sets
  `LOOM_CONFIG=C:\Users\paw\.loom\live-config.json`, so the live instance's per-Weave tokens are
  stored apart from the dev server's `~/.loom/config.json` and a `--weave`-less command cannot
  address the wrong instance's Weave.
- **One disposable container sees Spool's environment.** `live-update.sh` step 3 and §9 step 1
  validate Caddy's configuration with `--env-file ~/git/Spool/deploy/.env`, which carries Spool's
  `DB_PASSWORD` as well as the two variables Caddy's file needs. The container runs
  `caddy validate` and exits, `caddy validate` prints neither value, and nothing in this slice reads
  or echoes that file. It is named here because "a container was handed the shop's database
  password for one second" is the kind of thing a reviewer should find written down rather than
  discover.
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
  They live under `~/backups/loom`, a directory created `install -d -m 700` and written under
  `umask 077`, root-only, on the server, and are never copied off it by anything in this slice.
  A dump is written to a dot-prefixed temporary name in that same directory and renamed into place
  only after the whole `pg_dump | gzip` pipeline succeeded, so a file named `loom-pre-update-*.sql.gz`
  is always a complete backup and a failed run leaves nothing behind (§4.5 step 4). Retention,
  rotation and encrypted off-server copies are §13.

## 13. What this does not promise

Each with the reason it is out, so that a later slice can pick it up without re-litigating.

- **No scheduled backups, no retention and no rotation.** `live-update.sh` takes one dump
  immediately before it migrates, which is the moment a dump is actually wanted. Nothing takes a
  daily one, nothing prunes `~/backups/loom`, and nothing copies a dump off the box. A dump is
  secret-bearing (§12), so an off-server copy needs encryption to a key that is not in the dump, and
  that is a decision with a key-custody question in it — a slice of its own, next to Spool's, whose
  ROLLOUT.md already states the shape.
- **The update lock excludes other `live-update.sh` runs and nothing else.**
  `/run/lock/loom-live-update.lock` is a host lock taken by that one script, so two overlapping
  updates cannot happen (§4.5 step 1). Nothing stops someone with root SSH from running
  `docker compose build`, `docker compose run --rm migrate`, `docker compose up -d` or a `pg_dump`
  by hand *while* an update holds the lock — the lock is a convention between runs of one script,
  not a mechanism in Docker. It is also per-host: it says nothing about a second machine, and there
  is no second machine.
- **The public health check needs DNS, a certificate and the shop's Caddy to be up**, and it is
  therefore a check on more than Loom. A `curl https://loom.3dbox.dk/api/guidelines` that fails
  because DanDomain's DNS is answering slowly, or because Caddy is mid-reload for an unrelated host,
  fails the update — and that is the trade taken deliberately, because the alternative is an update
  that goes green while every visitor gets a 502 (§4.5 step 10). The escape hatch is `--bootstrap`,
  which skips **only** that check, exists for the pre-DNS first run, and is not a flag to reach for
  when a normal run fails: a failing public check means something is actually wrong.
- **No automated test of anything in `deploy/`.** §11.6 says which mechanisms are structural rather
  than tested, and names the one — the reload-failure restore — that nothing exercises at all
  before the day it is needed.
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

Five, because each one is a thing that could go wrong on the day and each has an answer that is
better written down now than discovered then.

1. **Loom shares the shop's front door.** A Loom site block that Caddy refuses would, on a reload,
   be rejected as a whole configuration — Caddy keeps the previous one — so the shop stays up; but a
   reload is a reload, and it restarts certificate management for every host in the file. That is
   why the proposed configuration is validated in a **disposable** container before anything is
   installed and before the database is touched (§4.5 step 3, §9 step 1), why the install is
   `mv`-atomic and reloads **only when the file changed**, why a failed reload puts
   `loom.caddy.prev` back — or removes the file, if there was no previous one — so the folder Caddy
   would boot from next time is never the poisoned one, and why `loom.caddy` contains no variable
   that could substitute empty. What remains: the staged check validates against Spool's Caddyfile
   *as it was a moment earlier*, and the reload happens against whatever the running container has
   now. The restore path exists for exactly that gap, and it is the one mechanism in this spec that
   nothing exercises before the day it is needed (§11.6).
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
4. **The update lock assumes `/run/lock` and `flock`.** `/run/lock` is a tmpfs present on Ubuntu and
   `flock` ships in `util-linux`, which §9 step 0 checks for and installs — but if either were
   missing, the `exec 9>` would fail and, under `set -e`, the whole update would stop before doing
   anything. That is the right direction to fail in: refusing to update is recoverable, updating
   twice at once is not. The lock's own failure mode is benign because the descriptor is the lock:
   a killed script, a dropped SSH connection or a rebooted host releases it with no file to clean
   up, so there is no "break the stale lock" procedure to get wrong.
5. **The first-run route into the Weave puts a secret on Paw's clipboard.** §9 step 12 has Paw paste
   one prepared text into the ChatGPT session, and that text carries the development Weave's secret
   so `join_weave` can succeed on the first try. The secret therefore exists in a clipboard, in a
   local file (`live-chatgpt-paste.md`) and in the ChatGPT conversation — never in a Claude
   conversation, which is the rule §8.1 actually states, but "not in a Claude conversation" is not
   the same as "nowhere". The mitigation is that this happens **once**: after ChatGPT stands in the
   live Lobby, the invitation route (Lobby join, keeper `invite-weave`, `join_weave({ inviteId })`)
   moves no secret at all, and it is the route every later Weave uses. If the secret is ever
   believed to have leaked, the answer is a new Weave rather than a rotation, because a Weave's
   secret is its identity.
