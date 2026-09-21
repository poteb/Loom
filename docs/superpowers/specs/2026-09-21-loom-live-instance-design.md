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
it after a merge: guard, pull, build, stop, back up, migrate or roll back, start, reload Caddy,
check health, record what it proved.

Concretely, five pieces:

| Piece | Where |
| --- | --- |
| The deployment | `deploy/` in this repository — compose file, Caddy site block, `.env.example`, the update script, the local wrapper, the Weave guidelines and reviewer-brief texts, and two PowerShell helpers for the onboarding handoff |
| A standalone migrate entry | `src/server/src/migrate.ts`, plus `migrationStatus` in `@loom/core` |
| A switch for the boot migration | `LOOM_MIGRATE_ON_BOOT` in `src/server/src/config.ts`, honoured in `main.ts` |
| The session-less `GET`/`DELETE /mcp` fix | `src/server/src/mcp/index.ts` — the open KNOWN-ISSUES row |
| A truncate guard that generalises | `src/core/test/db-guard.ts` and the global setup beside it |

### Success scenario

1. A pull request is merged on Paw's word. The session runs `deploy\live-update.cmd` from this
   repository on Paw's PC. It prints the commit and the image tag it is deploying, the image build,
   a backup path, "nothing to apply" or the migrations it applied, the restart, and `health: ok`.
2. The Thread for the next pull request is created on the live instance. The review conversation
   from three weeks ago is still in it, because no branch has ever touched that database.
3. ChatGPT's connector — added **once**, at `https://loom.3dbox.dk/mcp?agent=<key>` — is still the
   same connector. Its five-minute `inbox` heartbeat picks the Thread up with no human prompt, and
   its reconnect polls no longer log a 500 apiece.
4. A merge whose branch carried a migration does the same thing, except that step 1 prints the
   migration it applied and the `pg_dump` taken immediately before it — after the build, so nothing
   posted while the image was compiling is outside the backup, and **with Loom stopped**, so nothing
   can be posted between the dump and the migration either. For those seconds — the dump, the
   migration and a container start, well under a minute — the hostname answers 502, which is the
   accepted price of a backup that means what it says (§4.5 banner 7, §13).
5. A migration that fails prints its error and then **asks the database what actually happened**
   rather than assuming: it re-reads the migration status and compares it with the pending set it
   recorded before the run (§4.5 banner 9). In the ordinary case the run's migrations rolled back as
   one transaction — drizzle applies a run in **one transaction**, and §5.1's
   `assertTransactionSafe` refuses any migration file that could break that from inside — so the
   schema is exactly as it was, the script **restarts the exact container it stopped**
   (`docker start loom-loom-1`, still holding the old image by id), and exits non-zero. The backup
   taken seconds earlier is on disk and nothing needs it: the instance is back to the code and the
   schema it had before the run, with no write lost, because nothing was accepted while it was
   stopped. In the rare case where the migration committed but the client never saw the commit, the
   script starts the **new** image against the schema the database really has. In the case it cannot
   tell, it leaves Loom **stopped** and prints what is applied, what is pending and where the dump
   is — because a wrong guess there is the one thing worse than a minute of downtime.
6. A merge that changed the **database's topology** — Postgres's volume, its mount, or the compose
   file's `volumes:` block — stops the script before it touches anything, with
   `database topology changed — deploy by hand (§9-style), not with live-update`. That deployment is
   a hand-run one, with a human deciding which volume holds the data (§4.5 banner 3, §13).

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
| The Loom repository is **public**, so the server clones `https://github.com/poteb/Loom.git` with **no credentials** | Unlike Spool, whose server checkout has the local bundle `/root/spool.bundle` as its origin because no GitHub credential is allowed on that box by policy — so a Spool change reaches the server by re-bundling and `scp`, which §9 step 1 spells out. Loom needs no credential, so the ordinary clone, and an ordinary `fetch` from GitHub, is fine |
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
copy that trick. It carries its project name in the compose file itself (§4.2), because a name that
lives in an ignored file is a name that can go missing — and, because `COMPOSE_PROJECT_NAME`
outranks that key, **every compose command in this spec names its project on the command line**:
`docker compose -p loom …` for Loom, and
`docker compose -p spool --env-file /root/git/Spool/deploy/.env -f /root/git/Spool/deploy/docker-compose.yml …`
for Spool, whichever directory they are run from and whatever the shell running them has exported.

**And `--env-file` beside `-p` on every Spool command, which is a correction.** `-f` says which
compose file to read; it does **not** say which environment file to read. Compose looks for `.env`
**in the caller's working directory** (strictly, in the project directory, which `-f` alone does not
move), so `docker compose -p spool -f ~/git/Spool/deploy/docker-compose.yml up -d caddy` run from
`/root` or from Loom's `deploy/` finds no `.env` at all and every `${…:-default}` in Spool's file
resolves to its default. The consequences are not cosmetic: Spool's `DB_PASSWORD` would fall back to
the development value, so the `migrate` service `api` depends on would attempt the live shop database
with the wrong password, and `SITE_ADDRESS` would fall back to `localhost`, so a recreated Caddy
would be configured for `localhost` instead of the shop's public host — while the root SSH holder,
who does own the real values, never sees that compose was not given them. Naming the file on the
command line is one flag and is independent of the shell's directory, which a `cd` before every
command is not. The path is written **absolute** (`/root/git/Spool/...`) rather than `~/…` for the
same reason: `--env-file` is read by compose, and a value that depends on the caller's shell
expanding a tilde is the class of thing this paragraph exists to remove. `-f` keeps the absolute
form too, so the two paths read the same.

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

Ten files, and not one of them is generated: they are read by a human deciding whether to trust the
update that is about to run.

    deploy/docker-compose.yml          compose project `loom` on the server
    deploy/loom.caddy                  the site block, installed into Spool's Caddy
    deploy/.env.example                every variable, with the command that generates the secrets
    deploy/live-update.sh              the one server-side command, idempotent
    deploy/live-update.ps1             the local wrapper: ssh, and nothing else
    deploy/live-update.cmd             a two-line shim so `deploy\live-update.cmd` works from cmd.exe
    deploy/weave-guidelines.md         the approved Weave guidelines text, read by §9 step 11
    deploy/reviewer-brief.md           the approved reviewer brief, read by the script below
    deploy/prepare-chatgpt-paste.ps1   brief + Weave secret -> the paste file, printing nothing (§9 step 12.1)
    deploy/connector-url-to-clipboard.ps1   the connector URL onto Paw's clipboard, never onto a screen (§9 step 12.2)

**Three files the server writes into this directory are not in that list and are not in git**, and
keeping them apart is the answer to review round 4's F2 — **two records, two facts**:

    deploy/.deployed-sha     the commit whose image AND schema are active. With migrations
                             pending, written the moment the migrator exits 0, before Loom is
                             started; with nothing pending, written only once the new image is
                             actually up (§4.5 banners 9 and 10).
    deploy/.verified-sha     the last commit that passed the public health check. Written last.
    deploy/.deployed-image   the image id of the running loom container, captured before the build.

`.deployed-sha` is what the topology guard compares against and what the recovery aims at;
`.verified-sha` is the public proof and nothing reads it as state. **An earlier draft had one file
doing both jobs, and that was the defect:** a run whose migration committed and whose *public*
check then failed — a slow DNS answer, a certificate mid-renewal — left the single record naming
the **pre-migration** commit while the post-migration image and schema were live. The next run's
recovery would then have aimed at that older image and started it against a schema it does not
understand. The two facts have different lifetimes, so they are two files, and the one the recovery
reads is the one that tracks the schema. All three are server state, so all three join `.env` in the
root [`.gitignore`](../../../.gitignore) — an untracked file inside the checkout would otherwise
trip the script's own clean-tree check — **and so do the two `.new` temporaries the atomic writers
use**, `deploy/.deployed-sha.new` and `deploy/.verified-sha.new`, because a run killed between the
`>` and the `mv` would leave one behind and stop the *next* run on its own cleanliness check
(§4.5 banner 1). Five lines, listed one at a time.

**Why the two approved texts and the two onboarding scripts are committed files, which is a
correction twice over.** The guidelines half was answered in round 1 and is below; the brief and the
scripts are round 3's answer and are §4.7. Both halves are the same rule: a text the runbook reads,
or a command it runs on a credential, belongs in git where it is reviewed once — not in an
operator's local folder where it may not exist, and not improvised at the moment it is needed.

An earlier draft had §9
step 11 pipe `C:\Users\paw\.loom\live-guidelines.md` into `create`, a file nothing in the runbook
ever wrote: on a fresh workstation the `Get-Content` fails and, depending on how PowerShell is
feeling about the pipeline, the Weave is either created with no guidelines at all or the command
dies after the agent key has already been selected. The approved text is not an operator's local
note — it is the text in [DOGFOOD.md](../../DOGFOOD.md) §3 step 2, decided on 2026-09-20 — so it
belongs in git, where it is reviewed once and then read the same way on every workstation.
`deploy/weave-guidelines.md` is **byte-identical to that block** (the blockquote's `> ` markers
stripped and nothing else changed); the implementation task copies it across rather than rewriting
it, and a later edit to either one is an edit to both.

### 4.1 Where everything lives on the server

Stated exactly, because every path below is hard-coded in a script and a reader must be able to
check them.

| Thing | Path, and how it gets there |
| --- | --- |
| The checkout | `~/git/Loom` (i.e. `/root/git/Loom`), `git clone https://github.com/poteb/Loom.git`, **`main` only**. Cloned once by hand in §9. It is never checked out to a branch, never committed to, and `live-update.sh` only ever fast-forwards it |
| The compose project | `loom`, named **explicitly on every command** (`docker compose -p loom …`) and **again in the file** (top-level `name: loom` in `deploy/docker-compose.yml`) — *not* taken from the directory, which is `deploy` and would otherwise name the project `deploy`. So containers are `loom-postgres-1`, `loom-migrate-1`, `loom-loom-1` and the volume is `loom_pgdata` wherever the command is run from and whatever the shell has exported (§4.2) |
| The environment file | `~/git/Loom/deploy/.env`, **`chmod 600`**, created by hand on the server in §9, never in git (`.env` is already in [`.gitignore`](../../../.gitignore)) |
| The deployed-commit record | `~/git/Loom/deploy/.deployed-sha`, one line holding the short SHA of **the commit whose image and schema are both active**. Written atomically (temporary file in the same directory, then `mv`) at one of exactly two moments, and this is review round 5's F3: when the update had migrations to apply, the instant the migrator exits 0 and **before** Loom is started (§4.5 banner 9); when it had none, **after** `docker compose -p loom up -d loom` has started the new image, because until then the commit whose image is serving is still the old one (§4.5 banner 10). It is **never** written at the quiesce. Read as the topology guard's base (§4.5 banner 3) and as the recovery's target (§4.5's recovery procedure, R3, R6 and R10). Git-ignored |
| The verified-commit record | `~/git/Loom/deploy/.verified-sha`, one line holding the short SHA of the last commit that answered the **public** health check. Written at the very end of a normal run (§4.5 banner 13) and by nothing else; a `--bootstrap` run never writes it. It is the public proof, for a human and for §9's done-checks — **no mechanism reads it**, deliberately, so a failing public check can never misdirect a recovery. Git-ignored |
| The previous image id | `~/git/Loom/deploy/.deployed-image`, one line holding `docker inspect --format '{{.Image}}' loom-loom-1` as captured in §4.5 banner 3, before the build. It is an immutable image id, not a tag, so it still names the old image after a same-commit rebuild has re-pointed `loom-live:<SHA>`. Read only by the recovery's last resort, when the stopped container itself is gone (§4.5's recovery procedure, R10). Git-ignored |
| The per-commit images | `loom-live:<short SHA>` in the host's image store, one per deployed commit, built by `live-update.sh` step 4 and never pruned by it — the previous one *is* the rollback (§13) |
| Database backups | `~/backups/loom/loom-pre-update-<UTC timestamp>.sql.gz`, created by `live-update.sh` in a directory it creates with `install -d -m 700`. Root-only, like Spool's dumps |
| The update lock | `/run/lock/loom-live-update.lock`, held for the whole of one `live-update.sh` run (§4.5 banner 2). `/run/lock` is a tmpfs on Ubuntu, so the file is not persistent state and a lock held by a killed shell is released by the kernel when the descriptor closes |
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
    image: loom-live:${LOOM_IMAGE_TAG:-latest}
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
    image: loom-live:${LOOM_IMAGE_TAG:-latest}
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
  where a reader can check it. **But the key is not sufficient, and this is the second correction.**
  Compose's precedence is `-p` over `COMPOSE_PROJECT_NAME` over the file's `name:` over the
  directory — so an ambient `COMPOSE_PROJECT_NAME` in the root shell *outranks* `name: loom`. With
  `COMPOSE_PROJECT_NAME=spool` exported, which is exactly the value a troubleshooting session in
  `~/git/Spool/deploy` may have picked up, a bare `docker compose up -d` in Loom's `deploy/`
  targets the project **`spool`**: the service names `postgres` and `migrate` collide with Spool's,
  `pgdata` resolves to `spool_pgdata`, and compose will happily recreate the shop's Postgres from
  Loom's Postgres-17 definition while `live-update.sh` goes on inspecting `loom_pgdata`. So three
  things hold together, in order of precedence: **every command in this spec passes `-p loom`**
  (highest precedence, nothing can outrank it); the `name: loom` key stays in the file as the second
  line of defence, for anyone who types a compose command this spec did not write; and
  `live-update.sh` **refuses to run at all** when `COMPOSE_PROJECT_NAME` is set in its environment
  (§4.5 banner 0), because a shell holding that variable is a shell in which every hand-run command
  beside the script is aimed at the wrong project. §9's done-checks read the **effective** project
  names from `docker compose ls` rather than trusting any of the three.
- **`postgres` publishes nothing.** The only things that need it are `migrate` and `loom`, both on
  the project's default network. A published port would put the live database on the host's
  interface list for no gain, and `live-update.sh` reaches it with `docker compose -p loom exec`
  instead.
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
- **`image: loom-live:${LOOM_IMAGE_TAG:-latest}` beside `build:` on both services, and this is new
  in answer to review round 3.** With `build:` alone, compose invents the image name from the
  project and service (`loom-loom`, `loom-migrate`) and rebuilds over it every time, so there is
  never more than one version of the code on disk under a name anything can refer to. The recovery
  of §4.5's recovery procedure needs exactly that: when the database has moved to the new schema it must be able
  to start *the new image by name*, and when it has not it must be able to name the old one. So the
  image is named here and tagged with the short SHA of the commit being deployed —
  `live-update.sh` exports `LOOM_IMAGE_TAG` from the commit it is deploying (§4.5 banner 3). Both
  services carry the same `image:` line for the same reason they share `build:`: one build, one
  image, two entry points. The `:-latest` default is for a hand-run
  `docker compose -p loom build` with nothing exported — it keeps that command working and names the
  result honestly, and it is never what the script uses. Nothing prunes old tags; §13 says so.
- **A no-change rerun reuses the same tag, by design, and that is safe — which is worth stating
  because review round 4's F5 asked.** Rerunning the update with nothing merged in between deploys
  the same commit, so step 4 builds `loom-live:<the same short SHA>` again and the tag is
  re-pointed at the freshly built image. That is the honest naming: same SHA, same source, same
  content. It cannot disturb the running container, because a container references its image by
  **id**, not by tag — `docker stop` followed by `docker start` brings back the exact image the
  container was created from whatever the tag now points at, which is why §4.5's recovery is a
  `docker start` of the stopped container and not a re-`up`. And the one path that cannot use the
  stopped container records the old image's **id** before the build (`deploy/.deployed-image`,
  §4.1), precisely so that a re-pointed tag cannot mislead it. What the per-commit tag rules out is
  the thing a single moving `latest` guaranteed: a build that leaves **no** name for the code that
  is currently serving.
- **`migrate` and `loom` are the same image**, built from the same context, so
  `docker compose -p loom build` builds once and both services use the result. `command:` and not
  `entrypoint:` — the image has no `ENTRYPOINT`, its `CMD` is `["node", "dist/main.js"]`, and `WORKDIR` is `/app/src/server`, so
  `["node", "dist/migrate.js"]` is the same shape one directory over.
  **And because it is a `command:` and not an `entrypoint:`, every status read must name the whole
  command — which is review round 5's F1.** `docker compose run <service> <args>` **replaces** the
  service's `command:`; it does not append to it. So
  `docker compose -p loom run --rm migrate --check` does not ask the migrate entry for its status:
  it tries to execute a program called `--check`, and the one-off fails before it has connected to
  anything. Every status read in this spec is therefore the full command,
  `docker compose -p loom run --rm -T --name loom-migrate-check migrate node dist/migrate.js --check`,
  and §4.5's listing writes it in exactly one place (`read_status`) so that its two callers cannot
  drift apart. Giving the `migrate` service an `entrypoint:` of `["node","dist/migrate.js"]` with an
  empty command was the alternative and is **not** taken: it would make the two services' image
  contract differ, and a changed Compose contract is a thing to specify and test rather than a way
  to save nine characters at a call site.
- **`restart: "no"` on `migrate`**, because a one-shot that Docker restarts on exit 0 is a loop.
- **`depends_on: migrate: condition: service_completed_successfully` on `loom`.** It makes a bare
  `docker compose -p loom up -d` correct for someone who is not using the script: the schema is at the
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

The one server-side command, **idempotent**: running it twice with nothing merged in between pulls
nothing, applies nothing, reloads nothing, and still ends on a health check. It must be committed
executable (`git update-index --chmod=+x`), because the server checkout is created by `git clone`
and nothing else will set the bit.

**This section is one listing followed by its commentary, and that shape is review round 5's main
change.** Four earlier rounds described the script as prose steps with fragments of shell inside
them, and each round found a defect that the fragments had hidden: a pipeline that dies on an empty
result, a status command that does not read status, a state variable read before it is set. A
fragment cannot be checked, because what a line does depends on what is in scope where it runs. So
the script is written out **whole, once**, below — this is the file the implementer transcribes and
the next reviewer reads — and every decision behind it is the numbered commentary that follows,
keyed to the `# --- N.` banners in the listing. Where the two disagree, the listing is the spec.

```bash
#!/usr/bin/env bash
# deploy/live-update.sh — the one command that updates the live Loom instance.
# Run as root on the server:  ~/git/Loom/deploy/live-update.sh [--bootstrap]
set -Eeuo pipefail

# --- 0. arguments, self-location, and the inherited-project-name refusal ------------
BOOTSTRAP="${LIVE_UPDATE_BOOTSTRAP:-0}"
if [ "$#" -gt 1 ]; then
  echo "usage: live-update.sh [--bootstrap]" >&2; exit 2
fi
case "${1:-}" in
  "")          ;;
  --bootstrap) BOOTSTRAP=1 ;;
  *)           echo "usage: live-update.sh [--bootstrap]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")"

if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
  echo "COMPOSE_PROJECT_NAME is set in this environment; unset it and run again" >&2
  exit 1
fi

# --- 1. every recovery input, set BEFORE the single exit handler is armed -----------
STARTED=0                        # 1 once the new image is up: disarms the recovery (R1)
QUIESCED=0                       # 1 only while Loom is deliberately stopped
MIGRATE_STATE=not-attempted      # not-attempted|not-needed|attempted|succeeded|failed
STATUS=unknown                   # R4's verdict: read|unavailable
STATUS_TEXT="not read"
FINAL=""                         # the dump's final path, once step 8 has taken one
FINAL_RC=0                       # the status the exit handler will exit with
OLD_CONTAINER=loom-loom-1        # the container the quiesce stops and the recovery starts
MIGRATE_CHECK=loom-migrate-check # the named one-off that reads migration status
MIGRATE_RUN=loom-migrate-run     # the named one-off that applies migrations
LOOM_IMAGE_TAG=""; export LOOM_IMAGE_TAG
STAGE=""; CADDYENV=""; TMP=""; PENDING_BEFORE=""; PENDING_AFTER=""
SPOOLENV=/root/git/Spool/deploy/.env
SITES=/root/caddy-sites
PUBLIC_URL=https://loom.3dbox.dk/api/guidelines
LOCAL_URL=http://127.0.0.1:3100/api/guidelines

record_deployed() {              # atomic; read by the topology guard and the recovery
  printf '%s\n' "$1" > ./.deployed-sha.new && mv ./.deployed-sha.new ./.deployed-sha
}

pending_tags() {                 # empty-safe: no `grep`, so an empty pending set is not a failure
  sed -n '/^pending:$/,$p' "$1" | sed '1d;s/^[[:space:]]*//;/^$/d' | LC_ALL=C sort
}

redact_logs() {                  # §8.1: the one filter every log this script prints goes through
  sed -E 's#/w/[A-Za-z0-9_-]{43}#/w/<redacted>#g; s#[A-Za-z0-9_-]{43}#<43-char-token>#g'
}

reap_oneoff() {                  # F3: a dead client does not stop the container it started
  local name="$1"
  docker inspect "$name" >/dev/null 2>&1 || return 0
  docker stop -t 10 "$name" >/dev/null 2>&1 || docker kill "$name" >/dev/null 2>&1 || true
  timeout 60 docker wait "$name" >/dev/null 2>&1 \
    || echo "WARNING: $name did not report an exit within 60s of being stopped" >&2
  docker logs --tail 50 "$name" 2>&1 | redact_logs >&2 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
}

read_status() {                  # the ONLY way status is read. $1=stdout file, $2=timeout seconds
  local out="$1" secs="$2" rc=0
  docker rm -f "$MIGRATE_CHECK" >/dev/null 2>&1 || true
  timeout "$secs" docker compose -p loom run --rm -T --name "$MIGRATE_CHECK" \
    migrate node dist/migrate.js --check > "$out" 2> "$out.err" || rc=$?
  [ "$rc" -eq 0 ] || reap_oneoff "$MIGRATE_CHECK"   # the client is dead; the container may not be
  return "$rc"
}

cleanup() {
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  [ -n "$CADDYENV" ] && rm -f "$CADDYENV"
  [ -n "$TMP" ] && rm -f "$TMP"
  [ -n "$PENDING_BEFORE" ] && rm -f "$PENDING_BEFORE" "$PENDING_BEFORE.set" "$PENDING_BEFORE.err"
  [ -n "$PENDING_AFTER" ] && rm -f "$PENDING_AFTER" "$PENDING_AFTER.set" "$PENDING_AFTER.err"
  rm -f ./.deployed-sha.new ./.verified-sha.new
  return 0
}

manual_recovery() {              # R9. Every command it prints is absolute and self-contained (F6)
  echo "MANUAL RECOVERY REQUIRED — loom is STOPPED and has not been restarted."
  echo "  /root/git/Loom/deploy/.deployed-sha (image+schema): $(cat ./.deployed-sha 2>/dev/null || echo none)"
  echo "  commit being deployed:                             $LOOM_IMAGE_TAG"
  echo "  pending before the migration:                      $(tr '\n' ' ' < "$PENDING_BEFORE.set" 2>/dev/null)"
  echo "  pending now:                                       $STATUS_TEXT"
  echo "  pre-migration dump:                                ${FINAL:-none taken}"
  echo "  decide which schema the database is at, then paste ONE of these two, whole:"
  echo "    cd /root/git/Loom/deploy && docker start $OLD_CONTAINER     # the pre-migration container"
  echo "  or"
  echo "    cd /root/git/Loom/deploy && LOOM_IMAGE_TAG=$LOOM_IMAGE_TAG \\"
  echo "      docker compose -p loom --env-file /root/git/Loom/deploy/.env up -d --no-build loom   # the new image"
  echo "  then record the commit you started, whole:"
  echo "    printf '%s\\n' $LOOM_IMAGE_TAG > /root/git/Loom/deploy/.deployed-sha   # only if you started the NEW image"
}

start_old() {                    # R2/R6, falling through to R10 if the container is gone
  if docker start "$OLD_CONTAINER" >/dev/null 2>&1; then return 0; fi
  local img sha
  img="$(cat ./.deployed-image 2>/dev/null || true)"
  sha="$(cat ./.deployed-sha 2>/dev/null || true)"
  if [ -z "$img" ] || [ -z "$sha" ]; then
    echo "no recorded image id — loom is DOWN, deploy by hand"; return 1
  fi
  if ! docker tag "$img" "loom-live:$sha" >/dev/null 2>&1; then
    echo "recorded image id $img is not on disk — loom is DOWN, deploy by hand"; return 1
  fi
  if ! LOOM_IMAGE_TAG="$sha" docker compose -p loom up -d --no-build loom; then
    echo "could not recreate loom from the recorded image id — loom is DOWN, deploy by hand"; return 1
  fi
  echo "WARNING: the stopped container is gone; loom was recreated from the recorded image id" \
       "through the NEW commit's compose definition — check its command, environment and" \
       "networks before trusting it"
  return 0
}

recover() {                      # R1-R10. Never runs under errexit: see on_exit
  [ "$QUIESCED" = 1 ] || return 0                  # nothing was stopped, nothing to recover
  [ "$STARTED" = 0 ] || return 0                   # R1
  [ "$FINAL_RC" -ne 0 ] || FINAL_RC=1

  case "$MIGRATE_STATE" in
    not-attempted|not-needed)                      # R2
      if start_old; then echo "no migration ran; restarted $OLD_CONTAINER"; fi
      return 0 ;;
    succeeded)                                     # R3
      echo "the record names $LOOM_IMAGE_TAG; starting the new image"
      docker compose -p loom up -d --no-build loom \
        || echo "could not start the new image — loom is DOWN, deploy by hand"
      return 0 ;;
  esac

  PENDING_AFTER="$(mktemp)"                        # R4: ask the database what happened
  if read_status "$PENDING_AFTER" 120; then
    pending_tags "$PENDING_AFTER" > "$PENDING_AFTER.set"
    STATUS=read
    STATUS_TEXT="$(tr '\n' ' ' < "$PENDING_AFTER.set")"
    [ -n "$STATUS_TEXT" ] || STATUS_TEXT="(nothing pending)"
  else
    STATUS=unavailable
    STATUS_TEXT="unavailable — migrate --check failed or did not finish within 120s"
    cat "$PENDING_AFTER" "$PENDING_AFTER.err" 2>/dev/null | redact_logs || true
  fi

  if [ "$STATUS" != read ]; then manual_recovery; return 0; fi   # R5 -> R9

  local gone still
  gone="$(comm -23 "$PENDING_BEFORE.set" "$PENDING_AFTER.set" | wc -l)"
  still="$(comm -12 "$PENDING_BEFORE.set" "$PENDING_AFTER.set" | wc -l)"

  if [ "$gone" -eq 0 ]; then                       # R6: the transaction rolled back
    if start_old; then
      echo "migration rolled back; restarted the previous container" \
           "(loom-live:$(cat ./.deployed-sha 2>/dev/null || echo unknown))"
    fi
  elif [ "$still" -eq 0 ]; then                    # R7: committed, unacknowledged
    record_deployed "$LOOM_IMAGE_TAG"
    if docker compose -p loom up -d --no-build loom; then
      echo "the migrator failed but every pending migration is applied: the database is at" \
           "$LOOM_IMAGE_TAG and the new image has been started; rerun" \
           "/root/git/Loom/deploy/live-update.sh to finish the remaining steps"
    else
      echo "every pending migration is applied and the database is at $LOOM_IMAGE_TAG, but the" \
           "new image could NOT be started — loom is DOWN, deploy by hand"
    fi
  else                                             # R8 -> R9: partially applied
    echo "the migration is PARTIALLY applied: $gone of the pending tags are gone and $still remain."
    manual_recovery
  fi
  return 0
}

on_exit() {                      # the one and only exit handler
  local rc=$?
  set +e
  trap - EXIT
  FINAL_RC="$rc"
  recover "$rc"
  cleanup
  exit "$FINAL_RC"
}
trap on_exit EXIT

# --- 2. the update lock -------------------------------------------------------------
exec 9>/run/lock/loom-live-update.lock
flock -n 9 || { echo "another live-update is running" >&2; exit 1; }

# --- 3. fetch, refuse a topology change, require a clean checkout, fast-forward -----
git -C .. fetch origin main

if [ -f ./.deployed-sha ]; then
  BASE="$(cat ./.deployed-sha)"
  git -C .. cat-file -e "$BASE^{commit}" 2>/dev/null || {
    echo "deploy/.deployed-sha names $BASE, which this checkout does not have — deploy by hand" >&2
    exit 1; }
else
  BASE="$(git -C .. rev-parse HEAD)"
fi

TOPO="$(git -C .. diff --no-color "$BASE..refs/remotes/origin/main" -- deploy/docker-compose.yml)"
if grep -Eq 'postgres|pgdata|volumes' <<<"$TOPO"; then   # here-string: no pipe, no SIGPIPE (F2)
  echo "database topology changed — deploy by hand (§9-style), not with live-update" >&2
  exit 1
fi

BRANCH="$(git -C .. symbolic-ref --short HEAD 2>/dev/null || echo '(detached)')"
[ "$BRANCH" = main ] || { echo "the checkout is on $BRANCH, not main — deploy by hand" >&2; exit 1; }
[ -z "$(git -C .. status --porcelain --untracked-files=all)" ] \
  || { echo "the checkout is not clean; refusing to deploy something that is not origin/main" >&2
       git -C .. status --porcelain --untracked-files=all >&2; exit 1; }
git -C .. merge --ff-only refs/remotes/origin/main
[ "$(git -C .. rev-parse HEAD)" = "$(git -C .. rev-parse refs/remotes/origin/main)" ] \
  || { echo "HEAD is not origin/main after the fast-forward — deploy by hand" >&2; exit 1; }

LOOM_IMAGE_TAG="$(git -C .. rev-parse --short HEAD)"
docker inspect --format '{{.Image}}' "$OLD_CONTAINER" > ./.deployed-image 2>/dev/null \
  || rm -f ./.deployed-image
echo "deploying $(git -C .. rev-parse HEAD) as loom-live:$LOOM_IMAGE_TAG"

# --- 4. validate the Caddy configuration this update proposes ----------------------
STAGE="$(mktemp -d)"
CADDYENV="$(mktemp)"; chmod 600 "$CADDYENV"
cp "$SITES"/*.caddy "$STAGE"/ 2>/dev/null || true
cp loom.caddy "$STAGE"/loom.caddy
[ -f "$SPOOLENV" ] \
  || { echo "missing $SPOOLENV — Spool's environment file must be on the box" >&2; exit 1; }
SA="$(sed -n 's/^SITE_ADDRESS=//p' "$SPOOLENV" | tail -1)"
RA="$(sed -n 's/^REDIRECT_ADDRESSES=//p' "$SPOOLENV" | tail -1)"
printf 'SITE_ADDRESS=%s\nREDIRECT_ADDRESSES=%s\n' \
  "${SA:-localhost}" "${RA:-redirect.localhost}" > "$CADDYENV"
docker run --rm \
  -v /root/git/Spool/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v "$STAGE":/etc/caddy/sites:ro \
  --env-file "$CADDYENV" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile

# --- 5. build, tagged with the commit being deployed ------------------------------
docker compose -p loom build

# --- 6. record the pending set, with the new image, before anything is stopped ----
PENDING_BEFORE="$(mktemp)"
read_status "$PENDING_BEFORE" 120 || {
  echo "migrate --check failed; not touching the live instance" >&2
  cat "$PENDING_BEFORE" "$PENDING_BEFORE.err" 2>/dev/null | redact_logs >&2 || true
  exit 1; }
pending_tags "$PENDING_BEFORE" > "$PENDING_BEFORE.set"
if [ -s "$PENDING_BEFORE.set" ]; then
  echo "pending: $(tr '\n' ' ' < "$PENDING_BEFORE.set")"
else
  echo "pending: nothing to apply"
fi

# --- 7. quiesce: the recovery is armed BEFORE the stop, not after it (F5) ---------
QUIESCED=1
if [ -s "$PENDING_BEFORE.set" ]; then MIGRATE_STATE=not-attempted
else                                  MIGRATE_STATE=not-needed; fi
if ! docker compose -p loom stop loom; then
  RUNNING="$(docker inspect --format '{{.State.Running}}' "$OLD_CONTAINER" 2>/dev/null || echo unknown)"
  if [ "$RUNNING" = true ]; then
    QUIESCED=0                     # positively still running: nothing was stopped, disarm
    echo "docker compose stop failed and $OLD_CONTAINER is still running; nothing was stopped" >&2
  else
    echo "docker compose stop reported failure and $OLD_CONTAINER is not running ($RUNNING);" \
         "the quiesce stands, so the recovery will start it" >&2
  fi
  exit 1
fi

# --- 8. back up, with Loom already stopped and immediately before the migration ---
if ! docker volume inspect loom_pgdata >/dev/null 2>&1; then
  echo "backup: no loom_pgdata volume — first deployment, nothing to dump"
else
  if [ "$(docker inspect --format '{{.State.Running}}' loom-postgres-1 2>/dev/null || echo false)" \
       != true ]; then
    docker compose -p loom up -d postgres
  fi
  st=unknown
  for _ in $(seq 1 60); do
    st="$(docker inspect --format '{{.State.Health.Status}}' loom-postgres-1 2>/dev/null || echo gone)"
    if [ "$st" = healthy ]; then break; fi
    case "$st" in
      unhealthy|gone)
        echo "postgres is $st; not migrating" >&2
        docker compose -p loom logs --tail 50 postgres 2>&1 | redact_logs >&2 || true
        exit 1 ;;
    esac
    sleep 1
  done
  [ "$st" = healthy ] || { echo "postgres did not become healthy within 60s" >&2
                           docker compose -p loom logs --tail 50 postgres 2>&1 | redact_logs >&2 || true
                           exit 1; }
  MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' loom-postgres-1)"
  case " $MOUNTS " in
    *" loom_pgdata "*) ;;
    *) echo "loom-postgres-1 is not bound to loom_pgdata — deploy by hand" >&2; exit 1 ;;
  esac
  umask 077
  install -d -m 700 "$HOME/backups/loom"
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  FINAL="$HOME/backups/loom/loom-pre-update-$TS.sql.gz"
  TMP="$(mktemp "$HOME/backups/loom/.loom-pre-update-$TS.XXXXXX")"
  docker compose -p loom exec -T postgres pg_dump -U loom loom | gzip > "$TMP"
  mv "$TMP" "$FINAL"; TMP=""
  echo "backup: $FINAL"
fi

# --- 9. migrate: a named one-off under a bounded timeout --------------------------
if [ "$MIGRATE_STATE" = not-needed ]; then
  echo "migrate: nothing pending — the schema already satisfies $LOOM_IMAGE_TAG's journal"
else
  MIGRATE_STATE=attempted
  docker rm -f "$MIGRATE_RUN" >/dev/null 2>&1 || true
  if timeout --signal=TERM --kill-after=30 600 \
       docker compose -p loom run --rm -T --name "$MIGRATE_RUN" migrate; then
    MIGRATE_STATE=succeeded
    record_deployed "$LOOM_IMAGE_TAG"
    echo "migrate: applied; /root/git/Loom/deploy/.deployed-sha is now $LOOM_IMAGE_TAG"
  else
    rc=$?
    MIGRATE_STATE=failed
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "the migrator did not finish within 600s; reaping its container" >&2
    else
      echo "the migrator client exited $rc; reaping its container before anything is read" >&2
    fi
    reap_oneoff "$MIGRATE_RUN"     # EVERY non-success, not only 124/137 (F3)
    echo "the migrator did not report success (exit $rc); reconciling before anything starts" >&2
    exit 1
  fi
fi

# --- 10. start Loom, which ends the quiesce --------------------------------------
docker compose -p loom up -d loom
if [ "$MIGRATE_STATE" = not-needed ]; then
  record_deployed "$LOOM_IMAGE_TAG"   # the gate's no-op migrate passed and the new image is up
  MIGRATE_STATE=succeeded             # from here the record names the new commit: R3, not R2
fi
STARTED=1
echo "started loom-live:$LOOM_IMAGE_TAG"

# --- 11. loopback health ---------------------------------------------------------
OK=0
for _ in $(seq 1 30); do
  if curl -fsS "$LOCAL_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
[ "$OK" = 1 ] || { echo "loom did not answer on 127.0.0.1:3100 within 30s" >&2
                   docker compose -p loom logs --tail 50 loom 2>&1 | redact_logs >&2 || true
                   exit 1; }
echo "loopback health: ok"

# --- 12. install the site block if it changed, then reload Caddy -----------------
if ! cmp -s loom.caddy "$SITES/loom.caddy"; then
  HAD_PREV=0
  if [ -f "$SITES/loom.caddy" ]; then
    cp -p "$SITES/loom.caddy" "$SITES/loom.caddy.prev"; HAD_PREV=1
  fi
  install -m 644 loom.caddy "$SITES/.loom.caddy.new"
  mv "$SITES/.loom.caddy.new" "$SITES/loom.caddy"
  if ! docker exec spool-caddy-1 caddy reload --config /etc/caddy/Caddyfile; then
    if [ "$HAD_PREV" = 1 ]; then mv "$SITES/loom.caddy.prev" "$SITES/loom.caddy"
    else rm -f "$SITES/loom.caddy"; fi
    echo "caddy reload failed; the previous site configuration was restored" >&2
    exit 1
  fi
  echo "caddy: installed $SITES/loom.caddy and reloaded"
else
  echo "caddy: site block unchanged, not reloaded"
fi

# --- 13. public health, and the record of what was proved publicly ---------------
if [ "$BOOTSTRAP" = 1 ]; then
  echo "--bootstrap: skipped the public health check; deploy/.verified-sha not written"
  exit 0
fi
OK=0
for _ in $(seq 1 10); do
  if curl -fsS "$PUBLIC_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 3
done
[ "$OK" = 1 ] || { echo "$PUBLIC_URL did not answer within 30s" >&2; exit 1; }
printf '%s\n' "$LOOM_IMAGE_TAG" > ./.verified-sha.new && mv ./.verified-sha.new ./.verified-sha
echo "health: ok"
```

#### The commentary, banner by banner

**0. Arguments, self-location, and the inherited project name.** One optional flag, `--bootstrap`
(equivalently `LIVE_UPDATE_BOOTSTRAP=1`), which skips **only** banner 13, the public check. Any
other argument, or more than one, prints `usage: live-update.sh [--bootstrap]` to stderr and exits
**2** — the same exit-code convention as the migrate entry (§5.2), so a mistyped invocation is never
mistaken for a deployment failure, and both exits happen before the lock is taken and before
anything is read.

**The refusal on `COMPOSE_PROJECT_NAME`, on top of `-p loom` on every command.** The flag already
makes the variable powerless over this script (§4.2), so the refusal is not there to protect the
script's own commands — it is there because a shell that has `COMPOSE_PROJECT_NAME` exported is a
shell in which every `docker compose` a human types *beside* the script is aimed at the wrong
project, and a root session that has just been troubleshooting the shop is the likeliest such shell.
Stopping with a one-line reason costs an `unset` and removes the whole class.

**Every compose command in the script is `docker compose -p loom …`**, and every Spool one is
`docker compose -p spool --env-file /root/git/Spool/deploy/.env -f /root/git/Spool/deploy/docker-compose.yml …`,
for the reasons in §4.2: `-p` is the only form of the project name that nothing in the caller's
environment can outrank, and `--env-file` is the only form of Spool's environment that does not
depend on which directory the caller happens to be in. This script runs from `~/git/Loom/deploy`,
where Spool's `.env` is not.

**1. The recovery inputs, and the single exit handler — review round 5's F4.** Every variable the
recovery reads is assigned **before** `trap on_exit EXIT` is installed, and the trap is installed
once, at the top, rather than armed part-way down. The previous draft armed
`trap 'recover; cleanup' EXIT` at the quiesce and set `MIGRATE_STATE` and `STARTED` only where they
first mattered — so a `pg_dump` that failed with a real pending migration ran a `recover` that read
an unset variable under `set -u`, which aborts the handler: the exact container the script had just
stopped stayed stopped, and every user got a 502 indefinitely while the spec claimed the trap
restarts Loom on that path. Three properties answer it:

- **Initialised first.** `STARTED=0`, `QUIESCED=0`, `MIGRATE_STATE=not-attempted`, `STATUS`,
  `STATUS_TEXT`, `FINAL=""`, `FINAL_RC=0`, `OLD_CONTAINER`, the two one-off container names, the
  temporary-file variables and `LOOM_IMAGE_TAG` all have values before the handler can fire. Under
  `set -u` there is nothing left for the handler to trip over, and R9's message prints
  `none taken` rather than failing when there is no dump yet.
- **One handler, and it cannot run under `errexit`.** `on_exit` captures `$?` in its first line,
  disables `errexit` with `set +e`, disarms itself (`trap - EXIT`, so the final `exit` cannot
  re-enter it), classifies, cleans up, and exits with `FINAL_RC`. Classification is a sequence of
  `docker` and `comm` calls of which several are *expected* to fail; running them under the same
  `set -e` that killed the script would abandon the recovery half-way. `FINAL_RC` starts as the
  status the script died with and is forced to a non-zero value by `recover` whenever the recovery
  ran at all, so a failed run can never exit 0.
- **`QUIESCED` is the gate, not the trap's position.** `recover` returns immediately while
  `QUIESCED=0`, which is every moment before banner 7 — so arming the trap at the top costs nothing
  and no failure in banners 2 to 6 touches a container. The old design used the trap's *position* to
  say the same thing, which is the thing an initialisation bug could not survive.

`cleanup` removes the staged Caddy directory, the two-variable env file, a partial dump, both
pending-set files with their `.err` companions, and the two `.new` record temporaries. `recover`
runs **before** `cleanup`, because R4, R6, R7 and R9 all read `$PENDING_BEFORE.set` and a cleanup
that went first would delete the evidence the classification is made from.

**Two more helpers sit beside them, and both are round 6's.** `redact_logs` is the filter of §8.1,
defined once here and used everywhere this script prints something it did not write itself —
Postgres's log in banner 8 (twice), Loom's in banner 11, a reaped one-off's inside `reap_oneoff`, and
`migrate --check`'s own stdout and stderr in banner 6 and in R4. It is not decoration: `main.ts` prints the Lobby's `/w/<43-character secret>` link unredacted on
the boot that creates it, by design and as the README says, so a log this script hands to whoever ran
it is a log that can carry that secret into the controller's transcript — which
[HANDBOOK.md](../../HANDBOOK.md) §5 forbids (F1). The filter is Loom's own logging rule
([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Logging" blanks a 43-character base64url run) applied
at the **reader** instead of only at the writer, so it holds for a line no Loom code wrote. It
replaces the `/w/` form first, so a Lobby link reads `/w/<redacted>` rather than
`/w/<43-char-token>` and a human can still see *which* kind of value was removed.
`reap_oneoff <name>` is F3 and is described at banner 9; it is a function rather than two inline
blocks precisely because both callers — the migrator run and `read_status` — need the identical
lifecycle, and the previous draft had it in one of them only.

**And `.gitignore` gains five explicit lines, not three.** `deploy/.deployed-sha`,
`deploy/.verified-sha` and `deploy/.deployed-image` are server state written into the checkout, and
so are the two temporaries the atomic writers use, `deploy/.deployed-sha.new` and
`deploy/.verified-sha.new`: a run killed between the `>` and the `mv` would otherwise leave an
untracked file that trips the **next** run's `--untracked-files=all` check, which is exactly the
kind of self-inflicted refusal this script must not have. `cleanup` removes both anyway; the ignore
lines are for the run that never reaches `cleanup`. Five explicit lines rather than a
`deploy/.deployed-*` glob, because a reviewer should be able to read what is ignored and a glob
would silently cover a sixth file nobody decided on.

**2. The lock.** Non-blocking, and held through the open descriptor 9 until the script exits — the
kernel releases it then, including on a kill or a dropped SSH connection, so there is nothing to
clean up and no stale lock to break. It is taken **before the fetch**, which is the first thing that
changes anything. Why it must exist: §2 says both Paw and the merge session may run this command,
both over root SSH. Two overlapping runs would write the same second-resolution backup path, run two
migrators against the same journal, replace and reload each other's Caddy file between one another's
checks, and recreate Loom from two different pulled heads — with one run able to report a failed
migration after the other had already changed the schema and restarted the app. Being told
"another live-update is running" and exiting non-zero is the whole of the answer. What the lock does
**not** cover is someone running `docker compose` by hand beside it; §13 says so.

**3. Fetch, the topology guard, the clean checkout, the fast-forward.** The order is the design.
Everything that can be judged wrong *without* touching the live system is judged first: whether the
merge changed the database's topology (asked **before** the checkout moves, so a retry cannot slip
past the refusal), the checkout itself, and then the Caddy configuration this update proposes
(banner 4). Only then is the image built, which still changes nothing that is running, and only
after that does the script touch the live instance.

**The base of the comparison is the deployed commit, recorded outside the fast-forward.**
`deploy/.deployed-sha` holds one line: the **short** SHA of the commit whose image **and** schema are
active — the same string that is that image's tag, so the record and the tag are one value and cannot
drift, and git resolves an abbreviated SHA in `diff` and `cat-file` as happily as a full one. That is
the right base for a topology question, because the dump and the volume name the script is about to
rely on belong to the *running* containers, not to whatever the checkout happens to point at. The
fallback to `HEAD` covers exactly one case — nothing has been deployed yet, the first deployment
(§9 step 5) — and it is sound there because the guard runs before the fast-forward. A recorded SHA
the checkout does not contain is **not** quietly replaced by that fallback: it means history was
rewritten or the file was edited, and the script refuses rather than guessing which commit's
topology is live.

**Why the ordering is a correction, and what the previous one let a retry do.** An earlier draft
recorded `OLD`, fast-forwarded, and *then* compared `OLD..HEAD`. On a topology-changing merge the
first run printed its refusal and exited — with the checkout **already moved to the new commit**.
Run the same command again, as Paw or a merge session naturally would, and `OLD` is now the new
commit, the diff is empty, and the script proceeds through build, dump, migration and restart on
exactly the topology it had just declared unsafe. A guard that a retry silently disarms is worse
than no guard, because the refusal teaches the operator that the case is handled. So the fetch comes
first, the comparison is made against `refs/remotes/origin/main` **before** anything moves, and a
refusal leaves the checkout at the commit that is deployed.

**The guard matches a here-string, and there is no pipe anywhere in it — which is review round 6's
F2, and it is the second half of a correction round 5 only half made.** `git diff … | grep -Eq …`
under `pipefail` is not the check it looks like: `grep -q` exits the moment it matches, `git` then
writes into a closed pipe and dies of `SIGPIPE`, and `pipefail` reports the pipeline as **141** — so
the `&&` never fires and the topology change is waved through. Round 5 captured the diff into `TOPO`
and then wrote `printf '%s\n' "$TOPO" | grep -Eq …`, which is **the same defect with a different
producer**: `printf` dies of `SIGPIPE` exactly as `git` did, and a diff that puts `postgres` near its
beginning and carries more than a pipe buffer (64 KiB on Linux) after it reproduces it. Capturing the
output never was the fix; removing the pipe is. So the guard is `grep -Eq '…' <<<"$TOPO"` — a
here-string, which bash hands to `grep` on a temporary file descriptor with no second process to
kill, so the `if` sees `grep`'s own status and nothing else. §11.6 pins it with a diff deliberately
larger than the pipe buffer.

**And the whole listing was audited for that shape, because one instance is never the population.**
The rule: **no producer feeding a consumer that can exit early**. After this change the listing
contains no `… | grep -q` and no `… | grep -Eq` at all. The pipelines that remain all have consumers
that read their input to the end — `sed`, `sort`, `tail`, `wc`, `gzip`, `redact_logs` — so none can
close a pipe under its producer. Where the natural spelling *would* have been a quiet `grep`, the
listing uses something else and says so: the dump's mount assertion is a `case` over a collected
string (banner 8), the pending set is a `sed` that deletes blank lines rather than a `grep -v`
(banner 6), and the Caddy environment is extracted with `sed -n 's/^KEY=//p' … | tail -1`
(banner 4). A variable plus a `case` is the other acceptable answer and is equivalent; a quiet `grep`
at the end of a pipeline is not.

**The topology guard is a refusal rather than a cleverness.** `live-update.sh` hard-codes
`loom_pgdata` and the container `loom-postgres-1`, and it would dump through the compose file the
fast-forward is about to bring in. A merge that moved Postgres's mount, renamed the volume or added
a second one therefore breaks the dump's only guarantee: the script would see that `loom_pgdata`
still exists, start Postgres against whatever the **new** file says, dump a database that may be
empty, migrate it, and restart Loom with every conversation apparently gone while the real volume
sits untouched and undumped. There is no safe automatic answer to that, so the script does the one
thing it can be sure about, and **does nothing else** — no fast-forward, no dump, no build, no
migration, no restart. A grep on the diff over-triggers, deliberately: a comment edit near the
`postgres` service stops an update, and being stopped costs one hand deployment while being wrong
costs the event log. **A database topology change is an explicit manual deployment** — §9's shape,
with a human deciding which volume to dump and in what order — and §13 says so.

**The clean-tree and equality checks, and why they exist.** An earlier draft ran
`git pull --ff-only origin main` alone and claimed that a stray commit or a hand edit would stop it.
Neither claim holds. `--ff-only` refuses only when the remote is *not* an ancestor, so a local commit
made on top of a `main` that origin has not since advanced past is happily "already up to date" and
gets built and deployed as if it were reviewed code; and a dirty tracked edit to a file the pull does
not touch survives a successful pull untouched. The whole value of this deployment is that what runs
on the live instance is what was merged on Paw's word, so the checkout is required to *equal*
`refs/remotes/origin/main` with nothing else in the tree, and that is asserted after the
fast-forward rather than inferred from it. `--untracked-files=all` because an untracked
`deploy/loom.caddy` or a stray `Dockerfile` is exactly as capable of changing what the build
produces as a tracked edit; the failure prints the porcelain output, so the operator sees which file
stopped them. The one thing deliberately exempted is `deploy/.env`, which is git-ignored and must be
on the server: `--untracked-files=all` does not report ignored files, so no exception has to be
written.

**The last two lines of the banner.** `LOOM_IMAGE_TAG` is the short SHA of the commit being deployed
and is exported once, in banner 1, so the build, the two one-offs and the `up` all name
`loom-live:<short SHA>` (§4.2). Then `docker inspect --format '{{.Image}}' loom-loom-1` captures the
**immutable id** of the image the running container was created from — not a tag, so nothing can
re-point it, and in particular the same-commit rebuild of a no-change rerun cannot. It is read by
exactly one branch of the recovery: R10, the last resort, where the stopped container is gone. On the
first deployment there is no container, so the `docker inspect` fails and the stale file — if one is
there from a previous run — is removed rather than left to name an image that is no longer what is
deployed. A file that lies is worse than a file that is absent.

**4. The Caddy validation.** Staged in a temporary directory, checked by a disposable Caddy, given an
environment file holding two variables and nothing else, and nothing is installed yet. The stage is a
**copy of the live sites folder with `loom.caddy` replaced**, so what is validated is the whole
configuration that would be in force after the install — not Loom's block in isolation, which would
miss a duplicate site address or a clash with a future neighbour. The mounted Caddyfile is Spool's
real one, from Spool's checkout, because that is the file that does the `import`.

**Two variables, not Spool's whole environment.** An earlier draft passed
`--env-file /root/git/Spool/deploy/.env` straight to the container, on the reasoning that Spool's
Caddyfile is written in terms of **`SITE_ADDRESS`** and **`REDIRECT_ADDRESSES`** (§3) and substitutes
an empty site address without them — which is true, and is why some value for each must be present:
an empty `{$SITE_ADDRESS}` makes Caddy read the canonical block as global configuration and refuse
the whole file, failing the validation for a reason that has nothing to do with this update. What is
*not* true is that the container needs the rest of that file. It also carries Spool's `DB_PASSWORD`
and `COMPOSE_PROJECT_NAME` and, as the shop grows, whatever payment, shipping, mail or AI keys Spool
comes to hold — handed, for the second the check takes, to a mutable third-party image
(`caddy:2-alpine`) that has outbound network access and needs none of them. So the two values are
extracted into a **mode-600 temporary file**, created before the container and removed by `cleanup`
whichever way the script exits, and a missing or empty value falls back to **the same default
Spool's own compose file gives it** (`localhost`, `redirect.localhost`).

**The extraction is `sed -n 's/^KEY=//p' … | tail -1`, and not `grep -E … | cut`.** The fallbacks
`${SA:-localhost}` and `${RA:-redirect.localhost}` could never run under `pipefail` with a `grep`:
`grep` exits **1** when it matches nothing, `pipefail` promotes that to the pipeline's status, the
command substitution carries it to the assignment, and `set -e` kills the script one line before the
default is ever evaluated. An operator who deleted `REDIRECT_ADDRESSES` from Spool's `.env` would
find **every Loom update stopping at Caddy validation**, with a non-zero exit and no message, while
the effective Caddy configuration was perfectly valid. `sed -n` prints what it matched and **exits 0
either way**. The `s///p` form also removes the `cut -d= -f2-`: the substitution strips the key and
the `=` and leaves the rest of the line, including any `=` inside the value. What *is* still required
is the file itself — `[ -f "$SPOOLENV" ]`, on its own line with its own message — because a missing
`.env` means the box is not in the state this spec describes, and defaulting both values in that case
would validate a configuration nobody is running. A missing key is normal; a missing file is not.

A non-zero exit here stops the script with **nothing touched**: no dump, no build, no migration, the
old site file still on disk and the shop still up. This is the check that makes a malformed
`loom.caddy` a failed update rather than a half-deployed one. It comes **after** banner 3 because the
file it validates is the one the fast-forward brought in.

**5. The build.** `docker compose -p loom build` with `LOOM_IMAGE_TAG` exported, so the result is
`loom-live:<short SHA>` and **not** a moving `latest`. Both services share the image, so this is one
build. A build failure stops the script with Loom still serving the old image, nothing dumped,
nothing stopped and nothing migrated. The build is here, before the dump, because it is the slowest
step in the script and the last one that changes nothing outside the image store.

**Why the tag is per-commit.** A recovery that starts "the image the database's schema belongs to" is
only possible if both images have names. With a single `latest`, this build has already moved that
name to the new code, so a failed migration two steps later could only bring back the image it had
just replaced. So the compose file gives `loom` and `migrate`
`image: loom-live:${LOOM_IMAGE_TAG:-latest}` alongside their `build:` block (§4.2). Two named
images, both on disk; nothing prunes them, and §13 says so. **And the build cannot disturb what is
running:** the build writes a tag, the running container holds its image by **id**. On a no-change
rerun the new SHA *is* the deployed SHA, so the build re-points that one tag at a freshly built
image — deliberately, because it is the same commit and therefore the same content — and the running
container is still bound to the id it was created from. That is why the recovery's first choice is
`docker start` on the container this run stopped rather than a re-`up` through a tag, and why the old
image's id was recorded in banner 3 for the one branch that cannot use the container.

**6. The pending set, read with the new image, before anything is stopped.** The recovery cannot
classify a migrator failure unless it knows what was pending before the migrator ran, so the set is
recorded here — while Loom is still serving and nothing has been touched.

**The status command is the full command, and that is F1.** `read_status` runs
`docker compose -p loom run --rm -T --name loom-migrate-check migrate node dist/migrate.js --check`.
The previous draft wrote `docker compose -p loom run --rm migrate --check`, which does not do what it
reads like: `run <service> <args>` **replaces** the service's `command:`, it does not append to it.
The `migrate` service has `command: ["node", "dist/migrate.js"]` and the image has no `ENTRYPOINT`
(§4.2), so `--check` alone would be executed *as the command* — the container would try to run a
program called `--check` and fail. That defect was on the only path that reads status, so it broke
both this banner and R4: the first bootstrap would have stopped here, before `loom.caddy` was ever
installed, and a failed migration could never have been reconciled. The full command is therefore
named at **every** status read, and the only place it is written is `read_status`, so the two callers
cannot drift apart.

**`pending_tags` is empty-safe, and that is F2.** The extraction is
`sed -n '/^pending:$/,$p' "$1" | sed '1d;s/^[[:space:]]*//;/^$/d' | LC_ALL=C sort`. The previous
draft ended it with `grep -v '^$'`, and the normal case — a database that is fully migrated, which is
every rerun and the whole of the first bootstrap — produces **no** `pending:` line at all (§5.2). Both
`sed`s then print nothing, `grep -v` exits **1** because it matched nothing, `pipefail` promotes that
to the pipeline's status and `set -e` kills the script: the bootstrap would have stopped after the
build, before the quiesce and before the Caddy install, on a healthy database with nothing wrong. The
same pipeline could abort R4 at precisely the moment the after-set is empty, which is the state R7
exists to recognise. `sed '/^$/d'` deletes blank lines without an exit status to promote, so the empty
case yields an empty file and exit 0. §11.2's contract test pins both the empty and the non-empty
extraction.

**Three things this banner also buys**, each a reason it is here rather than folded into the
migration:

- **It runs `assertTransactionSafe` over every pending file before the live instance is touched**
  (§5.1, §5.2): a merged migration carrying a `COMMIT`, an `ABORT`, a `CREATE INDEX CONCURRENTLY` or
  any other statement that would break the one-transaction guarantee from inside makes this `--check`
  exit **1**, and the update stops here — no quiesce, no dump, no migration, Loom still serving.
- **It proves the migrator can connect**, so a wrong `DATABASE_URL` or an unreachable Postgres is a
  failure before the outage rather than during it.
- **It tells banner 7 whether this update has a schema change in it at all**, which is what decides
  whether banner 9 runs a migrator and when the new commit is recorded.

**And `read_status` reaps its own container on every failure, which is the second half of F3.** The
function captures the `timeout`'s status instead of letting it end the script, calls
`reap_oneoff "$MIGRATE_CHECK"` whenever that status is not 0, and only then returns it to its caller.
The bound was never the problem: `timeout` kills the **compose client**, and `docker compose run`
leaves the named container running when its client dies — so the previous draft's status read could
return "unavailable" while `loom-migrate-check` still held a connection, and the `docker rm -f` at the
top of the *next* read was the only thing that would ever have removed it. Reaping it here means the
container is gone before the caller decides anything: banner 6 exits with the live instance untouched,
and R4 reaches R9 with nothing of its own left behind. The `rm -f` at the top stays, because a run
killed between the `timeout` and the reap leaves a name for the next run to clear.

**Three mechanical details of `read_status`, all of which the listing made visible.** It passes `-T`,
because `docker compose run` allocates a pseudo-TTY when its stdin is a terminal — which it is
whenever Paw runs the script from an interactive SSH shell rather than a merge session's
`ssh SpoolServer …` — and a TTY turns every line ending into `\r\n`, so `/^pending:$/` would not
match and the pending set would silently come out **empty**: the update would then take the
"nothing pending" path over a database with migrations outstanding. And stderr goes to `"$out.err"`
rather than into `"$out"`, because the file is parsed: compose's own progress lines ("Container
loom-postgres-1 Running") must not be able to land after the `pending:` line and be read as a journal
tag. The `.err` file is printed on failure and removed by `cleanup`. It also `docker rm -f`s the
status container's name first, so a name left behind by a killed run cannot turn the next status read
into an unreadable one.

**7. The quiesce.** `QUIESCED=1` and a `MIGRATE_STATE` of `not-attempted` or `not-needed` according
to whether anything is pending, and **then** `docker compose -p loom stop loom`. **No record is
written here, and that is round 5's F3** (see banner 10).

**The recovery is armed before the command that can half-succeed, and that is review round 6's F5.**
The previous draft set `QUIESCED=1` only after `stop` reported success, which reads as caution and is
the opposite. `docker compose stop` can stop the container and still exit non-zero — the client loses
the daemon's acknowledgement, the SSH connection drops, the operator's `Ctrl-C` lands in the gap — and
under `set -e` the script then enters the exit handler with `QUIESCED=0`, so `recover` returns
immediately on its first line: **Loom stopped, nothing restarted, no message, every visitor and the
reviewer's connector on 502 until a human notices.** The spec claimed every post-quiesce exit was
classified, and that was the one exit that was not. Arming first inverts the failure: the default is
that the recovery runs, and only positive evidence takes it away.

**What "positive evidence" means, exactly.** On a failed `stop` the script asks
`docker inspect --format '{{.State.Running}}' loom-loom-1`, and **only** the literal answer `true`
clears `QUIESCED` — the container is demonstrably still serving, so nothing was stopped and there is
nothing to restart. Every other answer keeps `QUIESCED=1`: `false` (it did stop, the acknowledgement
was lost), `unknown` from a failed `inspect` (the daemon is not answering, so the container's state is
not knowable and R2 starting an already-running container is a harmless no-op), and anything a future
Docker prints that is neither. The asymmetry is deliberate — `docker start` on a running container
costs nothing, while not starting a stopped one costs the instance — and it is why the test is
`= true` rather than `!= false`. Either way the run **exits 1**: a quiesce that did not go as written
is not a state to migrate from. §11.6 rehearses the torn stop.

**`stop`, and not `down` or `up --scale`.** `docker compose -p loom stop loom` leaves the container
object `loom-loom-1` in place: it keeps its **image id**, its command, its environment, its published
port and its two network attachments exactly as they were created — from the *deployed* commit's
compose definition, not the one the fast-forward just brought in. That is precisely what the
recovery's first branch needs: `docker start loom-loom-1` brings the old deployment back as it was,
whereas a re-`up` would build the old **image** into the new commit's **definition** — a combination
nobody has ever run, and one that a commit which legitimately changed `command:` or `environment:`
without touching Postgres would make unbootable. The volume and the network are left alone too, and
banner 10 recreates the container from the new image when the run succeeds. Postgres is **not**
stopped — the dump and the migration need it.

**This is the bound the backup did not have, and it is a policy decision.** An earlier draft dumped
the database while the old Loom went on accepting writes, and then migrated while it still did. Two
things follow, and both were claimed not to happen. A reviewer or an agent holding a credential can
post **after** the dump's snapshot and **before or during** the migration; if the migration then
fails and the advertised dump is restored, that post is gone, so §1's "nothing accepted in between"
was simply false. And a migration that is not backward-compatible with the *previous* binary can
commit while that binary is still serving, so for the seconds until the restart every request
touching the changed schema fails or, worse, writes against a shape the old code does not understand.
Of the two policies the review offered — quiesce, or require every migration to be atomic *and*
backward-compatible with the immediately previous binary and then prescribe how the writes accepted
after the snapshot are salvaged — this spec **binds quiesce**. The other one is a standing rule on
every future migration, enforced by nothing, whose failure mode is silent data loss discovered later;
this one is a command, in one place, whose failure mode is a visible minute of downtime.

**What it costs, stated exactly.** Between this banner and banner 10, Loom is not running: Caddy has
nothing to reach on the `web` network and answers **502** to every request, the web client's stream
drops, and the reviewer's connector poll fails. The duration is the dump plus the migration plus the
container start — on this database, today, **well under a minute**, and the dump is the slow part.
The worst case is bounded rather than typical: the Postgres wait is at most 60 s, the migrator at
most 600 s plus a 30 s kill grace, each reap at most a 10 s stop plus a 60 s `docker wait` (F3), and
R4's status read at most a further 120 s — so the arithmetic ceiling of a quiesce is about **sixteen
minutes** before a human is either serving again or reading R9's message (§13, §14.7). Every term in
that sum is a constant a reader can find in the listing, which is the point of stating it. **Downtime of seconds per update is accepted; zero downtime is not
promised.** The build, which is the minute-or-two part of an update, is deliberately on the other
side of this line: it finishes while Loom is still serving.

**8. The backup.** With Loom already stopped and immediately before the migration, and precise about
what "nothing to back up" means. Three cases, decided in this order, because conflating the second
with the third is how a live database gets migrated with no dump:

- **`docker volume inspect loom_pgdata` fails** — there is no volume, so this is the first deployment
  and there is nothing to dump. **Skipped with a printed line**, and that is correct.
- **The volume exists but the `postgres` container is not running.** Then there *is* a live database
  and the dump is mandatory: `docker compose -p loom up -d postgres`, wait for the healthcheck within
  a bound, then dump. Never skipped. Compose may *recreate* that container rather than merely start
  it, if its service definition changed since it was created — and that is harmless, because `pgdata`
  is a named volume that outlives any container attached to it, and banner 3 has already refused any
  merge that could have moved it.
- **The volume exists and Postgres is running.** Dump.

**This is a correction to an earlier draft**, which skipped the backup whenever
`docker compose ps --status running -q postgres` was empty and called that "the first deployment". It
is not: a stopped container over a populated volume gives the same empty answer, and the migration
would then start Postgres through `depends_on` and migrate that populated volume with no dump behind
it. The volume, not the container, is the thing that tells you whether data exists.

**The wait is bounded.** Sixty polls a second apart: the healthcheck of §4.2 is `pg_isready` every
5 s with 20 retries, and a Postgres that starts over an existing volume is healthy in a few seconds,
so a minute is generous without being a hang. An `unhealthy` verdict, or a container that has exited
or is not there at all, **fails immediately** rather than waiting the minute out. A timeout exits
non-zero after printing the last fifty lines of Postgres's log **through `redact_logs`**, as every
log this script prints now goes (F1). On every one of those paths the
**migration is not attempted**: `MIGRATE_STATE` is still `not-attempted`, so the exit handler takes
R2 — the exact container this run stopped is started again, so Loom is serving — and the lock goes
with the process. Without the bound, a Postgres that can never come healthy (a damaged data
directory, a full disk, §14.3) would loop forever while holding
`/run/lock/loom-live-update.lock`, and every later update would report only that another update is
running.

**The dump itself.** Each line earns its place. The **mount assertion** answers "did I dump the right
database?" — it reads the mounts of the container that is running *now* and refuses unless
`loom_pgdata` is among them, so a dump can never be taken from a container compose attached to some
other volume; it is a `case` over a collected string rather than a `grep -qw` in a pipe, for the
`SIGPIPE` reason banner 3 gives. With banner 3's guard it makes the promise checkable from both ends.
`umask 077` and `install -d -m 700` **make** the modes §12 claims instead of hoping for them —
`mkdir -p` and a bare `>` inherit whatever the root shell's umask happens to be. The temporary file is
in the **same directory** so the `mv` is a rename within one filesystem and therefore atomic;
`pipefail` fails the script on a failed `pg_dump` or `gzip`, and because the redirection went to the
temporary name, `cleanup` removes the partial file — the earlier draft's redirection created the
final `.sql.gz` *before* the pipeline ran, so a failure left a truncated file whose name says
"backup" behind. The dot prefix keeps a partial file out of a `ls ~/backups/loom` glance, and
clearing `TMP` after the `mv` stops `cleanup` deleting the finished dump. The path is printed.

**9. The migration: a named one-off under a bounded timeout — and that is F5.** With nothing pending
the migrator is not run at all: the banner prints why and `MIGRATE_STATE` stays `not-needed`, so the
only migration in that update is the no-op the compose gate performs in banner 10. With something
pending:

- **`run --rm` rather than `up migrate`.** `docker compose up <service>` **returns 0 even when the
  service exited non-zero**, and the flag that fixes that (`--exit-code-from migrate`) implies
  `--abort-on-container-exit`, which would stop the live `postgres` alongside the finished one-shot.
  `run --rm` propagates the container's exit code, starts `postgres` via `depends_on` without
  stopping it afterwards, and removes the container.
- **`--name loom-migrate-run`, and every non-success reaps it — which is review round 6's F3.** Round
  5 bounded the client and reaped the container **only** when `timeout` had fired (exit 124, or 137
  after the `--kill-after=30` grace). That is the wrong condition, and the reason is the same one that
  makes the whole reconciliation necessary: the client's exit says nothing about the container. A
  `docker compose run` whose client loses its connection to the daemon, is interrupted, or dies for
  any of the dozen reasons that produce exit **1** leaves `loom-migrate-run` running with drizzle's
  transaction open. The script would then have skipped straight to R4, whose status read can honestly
  report every tag still pending — because the transaction has not committed **yet** — and R6 would
  restart the **old** image; the surviving migrator would afterwards commit the new schema underneath
  it. Nobody would have had to do anything wrong: the root process owns Docker and the container it
  forgot holds `DATABASE_URL`. So `reap_oneoff "$MIGRATE_RUN"` is called on **every** path out of a
  failed migrator run, before `exit 1` and therefore before the exit handler classifies anything, and
  the two timeout codes now change only the wording of the line above it. `reap_oneoff` is the
  lifecycle in one place: inspect, and if the container is there, `docker stop -t 10` (falling back to
  `docker kill`, so a container ignoring `SIGTERM` is still stopped), `docker wait` under a **60 s**
  bound so a daemon that never answers cannot hang the recovery, `docker logs --tail 50` through
  `redact_logs` for whoever reads the failure, and `docker rm -f`. It is a function because
  `read_status` needs exactly the same thing (banner 6) and the previous draft had it inline in one
  caller — which is how the other caller came to be missing it. `MIGRATE_STATE=failed` is set before
  the reap and the classification is entered only after it, so no branch of the recovery can run while
  a migrator is still alive. The name is also cleared with a `docker rm -f` **before** the run, so a
  leftover from a killed run cannot make the next update fail on a name conflict.
- **A timeout counts as a failure, not as a rollback.** Ten minutes is far longer than any migration
  this schema has, and the important part is what happens after it: killing a client does **not** tell
  you whether the server committed, so the reconciliation decides what the database actually
  contains rather than assuming the transaction went either way.
- **`record_deployed` is on the success line and nothing separates it from the migrator.** The moment
  the migrator exits 0 the schema *is* the new commit's, and the next thing anything should believe
  about this deployment is that. Writing the record here — atomically, and **before** `up -d loom` —
  means a failure in the start, the health check or the Caddy install can no longer send a recovery
  back to the pre-migration image: the record says the new commit, and R3 aims at the record.

**What the failure leaves behind, and why the schema really is unchanged.** Drizzle's postgres-js
migrator applies **every pending migration inside one transaction**: `PgDialect.migrate` in
`drizzle-orm@0.45.2` (`node_modules/.pnpm/drizzle-orm@0.45.2_postgres@3.4.9/node_modules/drizzle-orm/pg-core/dialect.js`,
the `migrate` method at line 44) wraps its whole loop over the journal's pending entries in
`await session.transaction(...)` at line 60, and the postgres-js session implements that as
`client.begin(...)` (`postgres-js/session.js:108`), i.e. one `BEGIN … COMMIT`. Postgres's DDL is
transactional, so a migration that throws — whether it is the first pending file or the third — rolls
back every statement of every file in that run, and the `insert` into `drizzle.__drizzle_migrations`
with it. Two caveats, stated because they are the edges of that guarantee: the
`CREATE SCHEMA IF NOT EXISTS drizzle` and the `CREATE TABLE IF NOT EXISTS
drizzle.__drizzle_migrations` happen **before** the transaction opens (lines 54–55), so after a
failure that table may exist while holding no new row — harmless, and §11.1's probe already treats
"table present, nothing applied" as a state; and a migration file that contains a statement Postgres
cannot run inside a transaction block would break the atomicity from inside the file. That second
caveat is not left as a caveat: `assertTransactionSafe` (§5.1) refuses such a file, `runMigrations`
calls it over the whole pending set before it applies a single statement, and banner 6's `--check`
therefore stops the update **before the quiesce** if such a file was ever merged. §13 records the
consequence: a migration that genuinely needs to be non-transactional is a guarded hand-run
deployment, never an input `live-update.sh` accepts.

**And the guarantee is still only a strong prior, not a proof, which is why there is a
reconciliation.** What neither drizzle nor the guard can rule out is PostgreSQL committing while the
**client never learns that it did** — the connection drops between the server's commit and the
client's acknowledgement, or the migrator finishes and then dies closing its pool. In both of those
the process exits non-zero over a database that is at the new schema. So the script stops asserting
and starts asking.

**10. The start, which ends the quiesce — and this is where F3 lands.** `docker compose -p loom up -d
loom` creates the container from `loom-live:<short SHA>` and runs the `migrate` gate again (§4.2).
Then, and only then, the "nothing pending" case records the new commit.

**Why the record moved off the quiesce.** The previous draft wrote `.deployed-sha` at the quiesce
whenever nothing was pending, on the reasoning that the database already satisfied the new journal.
The walk-through F3 gave is the defect: A is running and recorded, B has no migrations, the quiesce
stops A and immediately records B — and if the dump then fails because the disk filled, R2 correctly
restarts the exact **A** container while the record says **B**. The next run records A's image id in
`.deployed-image` while believing B is deployed, and if that container ever disappears R10 retags A's
image as `loom-live:B` and reconstructs it through a later compose definition; meanwhile agents and
participants go on writing through A against a record that names B. So with nothing pending the
record is written **after** the gate's no-op migrate has succeeded and `up -d loom` has started the
new image, which is the first instant at which B is genuinely what is serving. `MIGRATE_STATE` is set
to `succeeded` in the same breath — its meaning is "the record names the new commit, so the recovery
must aim at the new image", which is R3 — and `STARTED=1` follows, so in practice R1 returns first
and there is nothing left to do. The point of the ordering is what it rules out: at no moment does
`.deployed-sha` name a commit whose image is not running. **With migrations pending nothing changes:**
the record is still written the instant the migrator exits 0 (banner 9), because the schema then
requires B and R3 must aim at B from that moment on.

**11. The loopback health check.** `curl -fsS http://127.0.0.1:3100/api/guidelines`, retried up to 30
times at one second apart; exhausting the retries **fails the script** after printing the last fifty
lines of Loom's log. `/api/guidelines` rather than `/health`: `/health` answers `{"ok":true}` from the
HTTP layer alone and would go green on a server that cannot reach its database, whereas
`/api/guidelines` reads `settings` through core, so a 200 proves HTTP, the database connection and the
migrated schema in one request. It needs no credential
([`routes/guidelines.ts:8`](../../../src/server/src/routes/guidelines.ts)), so the check carries no
secret. 30 seconds because a cold container has to connect a pool, run `ensureLobby` and bind. This
check comes **before** the Caddy install so that the site file is never installed in front of an
application that is not answering.

**12. The site block, installed atomically, then the reload.** `cmp` first because that is what makes
the step idempotent, and because a reload restarts certificate management — cheap, but not something
to do on every update for no change. The write is `install` to a temporary name in the same directory
followed by `mv`, so Caddy — which is watching a glob in a folder it can read at any moment — never
sees a half-written file, and the temporary name has no `.caddy` extension so the glob cannot match
it mid-write.

**The restore on reload failure is the part that matters.** An earlier draft installed the file and
let a failing reload stop the script, reasoning that Caddy validates on reload and keeps its previous
configuration on error, so the shop stays up. That much is true — and it is exactly the trap: the
*running* configuration is fine while the *persisted* one is poisoned, so the shop stays up until the
next `docker compose up`, reboot or container restart, and then does not. Restoring
`loom.caddy.prev`, or removing the file when there was no previous one, leaves the folder in a state
Caddy can boot from, and the non-zero exit is what tells the caller to go and fix `loom.caddy`.
Banner 4 makes this path unlikely; it does not make it impossible, because banner 4 validated against
Spool's Caddyfile as it was at that moment and a reload happens against whatever is in the container
now. The persisted file is written **last**, after Loom is already answering, because the file is the
one artefact that outlives the run: a bad one sits on disk waiting for the next container restart to
take the shop down with it.

**13. The public check, and the record of what was proved.** `curl -fsS
https://loom.3dbox.dk/api/guidelines`, retried up to 10 times at three seconds apart; exhausting the
retries **fails the script**. Skipped, with a printed line, when `--bootstrap` was given.

**This writes `.verified-sha`, and it is the only thing that does.** `deploy/.verified-sha` means
"this commit's image was served and answered over the public hostname". It is the public proof: §9's
done-checks read it, a human reads it to see how far the last deployment got, and **no mechanism in
this spec reads it at all**. `deploy/.deployed-sha`, the record the topology guard and the recovery
use, was already written in banner 9 or banner 10 — the instant the new image and schema became the
live pair — so a public check that fails for a reason outside Loom can no longer leave the machinery
pointed at a pre-migration image. What a failing public check leaves is exactly right in both files:
`.deployed-sha` names the commit whose image and schema are live, because they are; `.verified-sha`
still names the last commit that answered publicly, because this one did not.

**Why the loopback check is not enough.** A site block can be syntactically perfect, reload cleanly
and still send every visitor to nothing: `reverse_proxy looom:3000` is a valid directive. Loom keeps
answering on `127.0.0.1:3100`, so banner 11 goes green while every human and the reviewer get a 502
from Caddy. The public check is the only one that exercises DNS, TLS, Caddy's routing, the `web`
network and the database in one call.

**Why `--bootstrap` exists, and what it costs.** §9 runs the script once before the DNS A record
exists and before a certificate has been issued, so the public check cannot pass then and the first
deployment would be unable to use the real script — which is the thing that makes §9 step 5 worth
doing at all. `--bootstrap` skips that one check and nothing else. Its price is that a bootstrap run
has *not* proved the public path, so §9 step 8 is a numbered step that **reruns the script in normal
mode** once the certificate exists, and that rerun is what completes the first deployment's
end-to-end check and first writes `deploy/.verified-sha`.

#### The recovery procedure, R1–R10

This is what `recover` implements, and it is written as a numbered decision procedure because every
branch of it ends in a different command and an implementer must be able to transcribe it without
interpreting it. It runs on **every** exit — the handler is installed once, at the top — and it does
nothing at all while `QUIESCED=0` or once `STARTED=1`.

  R1. **If `STARTED=1`, return immediately.** The new image is running, the schema is the new
      commit's, `.deployed-sha` says so, and the remaining failures (the health checks, the Caddy
      install) are not reasons to touch the container. Nothing else in R2–R10 runs, and the script
      exits with the status it died with.
  R2. **If `MIGRATE_STATE` is `not-attempted` or `not-needed`, start the exact container that was
      stopped** — `docker start loom-loom-1` — and return. No migration ran, `.deployed-sha` still
      names the deployed commit, so the schema is untouched and the container's own image is the
      right one by definition. This is the branch a failed dump, an unhealthy Postgres, a failed
      `up -d loom` on the nothing-pending path or a `set -e` death before banner 9 takes, and it is
      the cheapest correct answer because the container still holds the deployed commit's image id,
      command, environment and networks.
  R3. **If `MIGRATE_STATE` is `succeeded`, start the NEW image** —
      `docker compose -p loom up -d --no-build loom`, with `LOOM_IMAGE_TAG` still the new commit's
      short SHA — and return. `.deployed-sha` already names the new commit and the compose definition
      in the checkout is that same commit's, so image and definition agree. The old image must
      **not** come back here: either the schema has moved past it, or the record has, and in both
      cases the new image is what the record promises. This branch exists for a failure in
      `up -d loom` itself, which it retries in the only form that can be right.
  R4. **Otherwise `MIGRATE_STATE` is `failed`, and the database is asked what happened** — the same
      `read_status`, into a second temporary file, **under `timeout 120`**. `--check` applies nothing
      (§5.2), so this cannot make the situation worse, and it reconnects, which is the point: the
      question is about the server's state, not the dead client's. The bound is F5's other half: the
      previous draft's status read was unbounded, so a migrator's still-open transaction or an
      unresponsive database could hang the recovery forever with Loom stopped and the update lock
      held. 120 s is generous for a `select` over one small table and short enough that a human is
      reading R9's message inside three minutes. **R4 depends on banner 9's reap** (round 6's F3):
      the migrator's container is stopped, waited for and removed before this question is asked, so
      the answer describes a database nothing is still writing to. And `read_status` reaps **its own**
      container whenever its `timeout` fires or its client exits non-zero, so a failed status read
      leaves no connection behind for the next one to queue behind.
  R5. **If the status could not be read, go to R9.** A status that cannot be read is not a rollback.
      The read's own output and stderr are printed first — through `redact_logs`, like every other log
      this script prints (F1) — so the reason is on the record.
  R6. **If every tag that was pending is still pending** — `comm -23` of before against after is
      empty — **the transaction rolled back.** The schema is exactly what it was, so: leave
      `.deployed-sha` alone (it still names the deployed commit), `docker start loom-loom-1`, print
      `migration rolled back; restarted the previous container (loom-live:<deployed SHA>)`, and exit
      non-zero. This is the ordinary bad day, and the dump is on disk with nothing needing it.
  R7. **If none of the previously-pending tags is still pending** — `comm -12` is empty — **the
      migration committed and the client did not see it.** So: `record_deployed "$LOOM_IMAGE_TAG"`,
      `docker compose -p loom up -d --no-build loom`, print that the database is at the new SHA and
      the new image has been started and that a rerun finishes the remaining steps, and exit
      **non-zero**. Non-zero because the run did not complete — the health checks and the Caddy
      install never happened — and a rerun is the finish: it will fast-forward nothing, find nothing
      pending, and carry on to the checks. The instance is whole in the meantime, which is the part
      that matters.
  R8. **If some previously-pending tags are applied and others are still pending, go to R9**, after
      printing both counts. That is a partially-applied schema, which means the one-transaction
      guarantee did not hold, and there is no command a script can be trusted to choose.
  R9. **Leave Loom STOPPED and print the precise manual-recovery message** — the `manual_recovery`
      function in the listing — then exit non-zero. **Leaving Loom down is the decision, and it is
      deliberate.** R9 is reached only when the database's schema is genuinely unknown or genuinely
      partial; starting *either* binary against it risks writes against a shape the code does not
      understand, which is the failure mode that costs the event log rather than a minute of
      availability. A 502 that a human has to clear is recoverable; a Loom serving against a
      half-migrated schema is not. The message carries everything the recovery needs — both records,
      both candidate commands and the dump's path, or `none taken` when there is no dump — so the
      human does not have to reconstruct the run from this document.
      **Every command it prints is self-contained, and that is round 6's F6.** The draft printed
      `docker compose -p loom up -d --no-build loom` and "write the commit into `deploy/.deployed-sha`",
      both of which are only true in the directory the *script* was in. A normal update is invoked
      through `live-update.cmd`, so the person who reads R9's output opens a fresh SSH shell and lands
      in `/root`: compose would find no Loom compose file and no `.env` there, refuse for
      `LOOM_DB_PASSWORD`, and the advertised recovery would fail while Loom stayed down —
      and `deploy/.deployed-sha` would name `/root/deploy/.deployed-sha`, or, from `deploy/` itself,
      `deploy/deploy/.deployed-sha`. So each printed command begins
      `cd /root/git/Loom/deploy && `, the compose one also carries
      `--env-file /root/git/Loom/deploy/.env` because that file holds the password compose demands, and
      the record is named absolutely as `/root/git/Loom/deploy/.deployed-sha` with the `printf` that
      writes it. One shape, pasteable whole, from any directory. The same audit was run over every
      other line the listing prints: `start_old`'s and R3's failures say "loom is DOWN, deploy by hand"
      and name no command, R7 now names `/root/git/Loom/deploy/live-update.sh` for the rerun rather
      than a bare `live-update.sh`, and nothing else in the script prints an instruction at all.
  R10. **If `docker start loom-loom-1` fails because the container is gone** (someone ran
       `docker compose -p loom down`, or `rm`'d it, beside the script — the case §13's lock bullet
       already says nothing prevents), **reconstruct the old deployment from the recorded image id,
       with a printed warning.** `docker tag "$(cat ./.deployed-image)" "loom-live:$(cat
       ./.deployed-sha)"` puts the recorded **id** back under the deployed commit's tag — undoing any
       tag movement a same-commit rebuild caused — and
       `LOOM_IMAGE_TAG=<deployed SHA> docker compose -p loom up -d --no-build loom` recreates it. The
       warning is required and says why: this is the one path that combines an old image with a new
       definition, it is a last resort rather than the design, and its command, environment and
       networks must be checked before it is trusted. If `deploy/.deployed-image` is absent, or the
       id it names is no longer on disk, the script prints that loom is DOWN and must be deployed by
       hand, and stops there. R10 is reached through `start_old`, so both R2 and R6 get it.

**The handler runs the classification, not a restart, and that is the whole shape.** An older trap
read `.deployed-sha` and started that image whatever had happened; this one reaches a `docker start`,
an `up -d`, or nothing at all, and which one is decided by the two recorded facts and one bounded
question put to the database.

Nothing in the script prints a token, a secret or a `DATABASE_URL`, and nothing it prints can reach
the controller's transcript as a credential. That includes the recovery: R9's message carries two
short SHAs, two lists of journal tags, a dump path and three commands, and a journal tag is a
drizzle-generated name like `0004_furry_captain_stacy`. The one place a credential could still
surface is a compose error echoing `environment:` — which is why `.env` holds only two values and
neither is echoed by the script itself. Banner 4's `--env-file` used to be the second such place and
is not any more: it is a mode-600 temporary file holding `SITE_ADDRESS` and `REDIRECT_ADDRESSES` and
nothing else, removed by `cleanup`, so the disposable Caddy never sees Spool's `DB_PASSWORD` or any
other key that file has come to hold.

**And a container's log was the third such place, which is round 6's F1.** The script itself prints no
secret, but six of its reads hand on somebody else's output — Postgres's log twice, Loom's log, a
reaped one-off's log, and `migrate --check`'s own stdout and stderr in banner 6 and in R4 — and
Loom's log is not a log this spec controls. `main.ts` prints the Lobby's link, `/w/<43-character secret>`, in full on the boot that
creates the Lobby: deliberately, because that is how the first operator is told where the Lobby is,
and the README documents it. A `live-update.sh` failure on a first boot would therefore have handed
that secret to whoever ran the script, which on a merge is a Claude Code session, which makes it a
credential in the controller's transcript — the one thing [HANDBOOK.md](../../HANDBOOK.md) §5
forbids. So **every** log this script prints goes through `redact_logs` (banner 1), and §9's
done-checks that used to read a log for a shape now run the match on the server and print a fixed
string instead (§9 steps 4 and 5). Neither change touches what Loom logs; §10 carries the follow-up
note that gating that first-boot line behind an explicit flag is worth considering, and that it is not
this slice's change.

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

**And the first deployment runs through this wrapper rather than around it, which is round 4's F6.**
§9 step 8 — the normal-mode rerun that finishes the first deployment — is run **from Paw's PC** as
`deploy\live-update.cmd`, so the shim, the PowerShell wrapper, the `SpoolServer` alias, the
remote-shell `~` expansion and the exit-code forwarding are all exercised on day one, in the exact
form every later merge uses (§9 step 8, §11.6). An earlier draft ran both §9 steps 5 and 8 as the
server-side script directly and still claimed all ten files in `deploy/` were verified by the first
deployment; three of them were not.

### 4.7 The two onboarding helpers, and the committed brief they read

**Why these exist, which is the round-3 correction.** §8.1 promises that every command that writes a
credential-bearing file is given here *in the form it is actually run*, and §9 step 12 broke that
promise twice: it said the session "assembles" `live-chatgpt-paste.md` and that the connector URL
"comes from" `live-chatgpt.json`, with no command for either. Those two values — the Weave's secret
and ChatGPT's agent key — are the two most sensitive in the runbook, and an unwritten step leaves
only bad options: a session that improvises a one-liner substituting the secret into a command puts
the secret in the controller's transcript, which is the one thing §8.1 forbids, and a session that
refuses to touch the files leaves Paw with no command at all on the step he is meant to run himself.
Two committed scripts settle it. They are read once, in review, like everything else in `deploy/`.

**`deploy/prepare-chatgpt-paste.ps1`** — run by the **session** (it needs no human decision, and it
prints nothing a transcript could capture):

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# C:\Users\paw\.loom on Paw's PC: the profile folder whose ACL is the protection (§8.1).
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

Set-Content -LiteralPath $outFile -Value ($join + (Get-Content $briefFile -Raw)) -Encoding utf8
```

Every line has a reason. `$ErrorActionPreference = "Stop"` and `Set-StrictMode` because a typo in a
property name would otherwise interpolate an **empty** secret into a file that looks finished, and a
`join_weave` with an empty secret is a confusing failure in someone else's client an hour later.
The two `Test-Path` checks come before anything is read, so a missing prerequisite names itself
instead of surfacing as a null property. The secret is read from the file and written to a file: it
is never a command-line argument, never echoed, and the script's stdout stays **empty**, which is
what lets a session run it. `Set-Content` rather than `Out-File` with `-Encoding utf8` explicitly,
because the default encoding of a redirect is not the same thing on every PowerShell on that
machine and the file is pasted into another application. The output path is the one §8.1 inventories
and §9 step 12.4 deletes. The brief comes from `$PSScriptRoot`, so the script and its template are
one reviewed unit and cannot be pointed at something else by the caller's directory.

**`deploy/connector-url-to-clipboard.ps1`** — run by **Paw**, because it puts something on his
clipboard and he is the one about to paste it:

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$agentFile = Join-Path (Join-Path $env:USERPROFILE ".loom") "live-chatgpt.json"
if (-not (Test-Path $agentFile)) { throw "missing $agentFile - mint the ChatGPT agent key first" }

$a = Get-Content $agentFile -Raw | ConvertFrom-Json
if (-not $a.key) { throw "no key in $agentFile" }

Set-Clipboard -Value "https://loom.3dbox.dk/mcp?agent=$($a.key)"
Write-Output "connector URL is on the clipboard"
```

It prints **one line, and not the URL**: the whole point is that the agent key reaches ChatGPT's
connector dialog without being displayed, so a screen, a scrollback or a shared session never holds
it. `Set-Clipboard` is the same route §9 step 12 already uses for the paste text, and the same
clipboard is cleared in step 12.4.

**Both scripts are ASCII-only, including their messages, and that is deliberate.** Windows
PowerShell 5.1 reads a `.ps1` with no byte-order mark as the system's ANSI codepage, so a `§` or an
em dash in a committed script is a character that renders differently depending on which PowerShell
and which codepage ran it — in a file whose entire job is to be trusted at a glance. The prose that
needs those characters is here in the spec; the scripts say "create the live Weave first".

**`deploy/reviewer-brief.md`** is the "brief to paste" text of [DOGFOOD.md](../../DOGFOOD.md) §4,
**byte-identical** to that block, copied across by the implementation task rather than rewritten —
exactly the arrangement `deploy/weave-guidelines.md` has with DOGFOOD §3 step 2, and for the same
reason: a runbook that reads a file nobody committed is a runbook that works on one workstation. An
edit to either copy is an edit to both, and §10 says so.

## 5. Server code

Four small pieces. The layering rule applies unchanged: the rule goes in `core`, the entry point in
`server` is thin ([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Layering").

### 5.1 `migrationStatus` and `assertTransactionSafe` in `@loom/core`

New file `src/core/src/db/migrations.ts`, exported from the package. Two functions: one answers what
this database has had, the other refuses a migration file that would break the guarantee the whole
recovery design rests on.

```ts
export type MigrationStatus = {
  /** Journal tags already applied, oldest first. */
  readonly applied: readonly string[];
  /** Journal tags `runMigrations` would apply next, oldest first. */
  readonly pending: readonly string[];
};

export async function migrationStatus(db: Db): Promise<MigrationStatus>;

/**
 * Throws if `sql` contains a statement that would escape the single transaction `runMigrations`
 * applies a run inside. `file` is named in the message. A guard against accidents, not a SQL parser.
 */
export function assertTransactionSafe(sql: string, file: string): void;
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
  different folders. `runMigrations` gains it as an **optional second parameter** defaulting to that
  helper — `runMigrations(db, folder = migrationsFolder())` — which changes no existing call and is
  what lets §11.1 case 5 apply a folder of deliberately broken migrations.

**`assertTransactionSafe`, and why transaction-safe SQL is now a binding convention rather than a
caveat.** This is review round 4's F4, accepted in full. Every recovery decision in §4.5 rests on
one property: drizzle applies a whole run's pending migrations inside a single transaction, so a
failure rolls all of them back. That property can be broken from **inside a migration file** — a
bare `COMMIT` ends the transaction and everything after it is outside, a `CREATE INDEX
CONCURRENTLY` cannot run in a transaction block at all — and the previous draft only noted it,
observing that nothing in `src/core/drizzle/` did so *today*. A guarantee that any future merge can
silently void is not a guarantee. So:

- **`runMigrations` calls `assertTransactionSafe` over every pending file before it applies a single
  statement**, so the boot path (`main.ts` with `LOOM_MIGRATE_ON_BOOT=true`, `freshDb()` in the test
  suites) and the migrate entry (§5.2) get the same refusal from one implementation. It refuses
  before anything is applied rather than per file as it goes, because a refusal halfway through a
  run is the very outcome the guard exists to prevent.
- **`migrate.ts --check` calls it too** (§5.2), which is what makes it a *deployment* gate:
  `live-update.sh` step 5 runs `--check` before it stops Loom, so an offending file that was merged
  stops the update with the instance still serving, nothing dumped and nothing migrated.

**The rejected forms, each because PostgreSQL either ends the enclosing transaction or refuses to
run inside one.** Matched case-insensitively against the **leading keywords of a statement**, never
mid-statement:

| Rejected | Why |
| --- | --- |
| `BEGIN`, `BEGIN WORK`, `BEGIN TRANSACTION`, `START TRANSACTION` | Opens a nested transaction PostgreSQL will not give you; drizzle already holds one. The `WORK`/`TRANSACTION` noise words are PostgreSQL's own optional spellings of the same statement and are named here so the tests name them too |
| `COMMIT`, `COMMIT WORK`, `COMMIT TRANSACTION`, `END`, `END WORK`, `END TRANSACTION` | Ends drizzle's transaction. Everything after it is unprotected, and the `__drizzle_migrations` insert may then land or not land independently of the DDL |
| `ROLLBACK`, `ROLLBACK WORK`, `ROLLBACK TRANSACTION`, **`ABORT`** | Same, in the other direction, and silently discards the work of every earlier file in the run. **`ABORT` is review round 5's F6**: PostgreSQL treats it as an exact alias of `ROLLBACK`, and the previous list did not carry it — so a migration could `ABORT` drizzle's transaction, then `DROP TABLE events` as its own implicit transaction, then fail on a later statement before the journal row was inserted. The status read afterwards still reports the tag pending, so R6 would declare a rollback and restart the old image against a schema that had genuinely lost a table. One missing alias was the whole of that hole |
| `ROLLBACK TO`, `ROLLBACK TO SAVEPOINT` | Rewinds to a savepoint inside drizzle's transaction, which is the partial-apply shape R8 exists to refuse |
| `SAVEPOINT`, `RELEASE SAVEPOINT` | Not fatal by themselves, but they exist only to make a run partially recoverable, which is exactly the shape the one-transaction promise says migrations do not have |
| `PREPARE TRANSACTION`, `COMMIT PREPARED`, `ROLLBACK PREPARED` | Two-phase commit. `PREPARE TRANSACTION` dissociates the open transaction from the session and leaves it prepared on the server — so drizzle's later `COMMIT` has nothing to commit, the run's work survives as a prepared transaction no migration ever finishes, and the database holds a lock nobody can see in a migration file. The other two act on somebody else's prepared transaction, which a schema migration has no business doing |
| `SET TRANSACTION`, `SET TRANSACTION SNAPSHOT` | Changes the isolation level, read-only flag or snapshot of the transaction drizzle opened, from inside one of its files. Legal SQL, and a silent change to the guarantee every other migration in the run was written under |
| `DISCARD ALL` | PostgreSQL refuses it inside a transaction block, and it resets the session — prepared statements, temporary tables and all — which is not something one migration may do to the rest of a run |
| `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY` | PostgreSQL refuses these inside a transaction block |
| `VACUUM` | Refused inside a transaction block |
| `CREATE DATABASE`, `DROP DATABASE`, `CREATE TABLESPACE` | Refused inside a transaction block |
| `ALTER SYSTEM` | Refused inside a transaction block, and has no business in a schema migration |
| `DISCARD` in its other forms (`PLANS`, `SEQUENCES`, `TEMPORARY`) | Same statement, same refusal inside a transaction block; the guard matches on `DISCARD` as a leading keyword and therefore covers all of them |
| `ALTER TYPE … ADD VALUE` | **Decided: rejected.** PostgreSQL 12 and later *do* allow the statement inside a transaction block, so this is the one entry that is not a hard error — but the new label **cannot be used** in the same transaction, and drizzle puts the whole run in one transaction, so any later statement in that run (or a later file) that inserts the label, defaults to it or adds a check against it fails with `unsafe use of new value`. The guard cannot see whether a use follows, so it refuses the statement rather than shipping a rule nobody can check. The schema has no enums today (`CREATE TYPE` appears in none of the five migration files), so this costs nothing now; the day it does, the answer is §13's guarded hand-run deployment |

**Where that list comes from, said so that the next reviewer can check it against something other
than this document.** It is **PostgreSQL's own set of transaction-control statements** — the group
the SQL command reference lists as `BEGIN`, `START TRANSACTION`, `SAVEPOINT`, `RELEASE SAVEPOINT`,
`ROLLBACK TO SAVEPOINT`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`, `SET TRANSACTION`,
`PREPARE TRANSACTION`, `COMMIT PREPARED` and `ROLLBACK PREPARED` — taken **whole** rather than
sampled, together with the statements PostgreSQL documents as *not* runnable inside a transaction
block (`CREATE`/`DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `VACUUM`,
`CREATE`/`DROP DATABASE`, `CREATE TABLESPACE`, `ALTER SYSTEM`, `DISCARD`) and the one judgement call
this spec makes on its own (`ALTER TYPE … ADD VALUE`). Round 4 listed a sample of the first group and
round 5's F6 found the alias it had missed; taking the group whole is what stops that being a
recurring finding. The optional noise words (`WORK`, `TRANSACTION`) are covered because the match is
on leading keywords, but they are written out above and tested individually in §11.1 case 7, because
"covered because of how the matcher works" is a claim worth pinning to a test.

**How the scan works: one stateful pass, and that is review round 6's F4.** The previous draft
described the scan as a sequence of phases — *strip the comments, then blank the quoted forms, then
split, then match* — and said nothing about the comment stripper understanding quoting, because the
order implied it ran first. That order is the defect, and it is exploitable in one line:

    INSERT INTO t(c) VALUES ('--'); COMMIT; DROP TABLE events; SELECT nonexistent_function();

A conforming implementation of the old wording sees the `--` **inside the string literal**, treats
the rest of the line as a comment, and deletes the `COMMIT` and the `DROP` before the keyword scan
ever runs. PostgreSQL reads that `--` as two characters of string content, so it executes the
`COMMIT` — ending drizzle's transaction — then the `DROP TABLE events` as its own implicit
transaction, then fails on the last statement with the journal row never inserted. The status read
afterwards reports the tag still pending, R6 declares a rollback, and the old image comes back
against a schema that has genuinely lost the event log. The same trick works with `/*` in place of
`--`, and with a double-quoted identifier or a dollar-quoted body in place of the string. The
migration author needs no credential for any of it; the root migrator supplies one.

So the scan is specified as **one left-to-right pass over the file with a single state variable**, and
the phases are gone. The states, and the only transitions out of each:

| State | Entered by | Left by | What is recognised inside |
| --- | --- | --- | --- |
| **code** | the start of the file, and the end of every other state | — | comment openers, quote openers, and `;` as a statement end |
| **line comment** | `--` **in code** | a newline | nothing |
| **block comment** | `/*` **in code**, or `/*` while already in a block comment (depth + 1) | `*/`, at depth 1; deeper nestings only decrement | nothing but `/*` and `*/`, for the depth |
| **single-quoted string** | `'` **in code** | a `'` that is not doubled — `''` is an escaped quote and stays inside — and, in an `E'…'` literal, not a `'` preceded by an odd number of backslashes | nothing |
| **double-quoted identifier** | `"` **in code** | a `"` that is not doubled (`""`) | nothing |
| **dollar-quoted body** | `$tag$` **in code**, `tag` empty or an identifier | the **same** `$tag$`, tag-matched, so a `$$` inside a `$body$ … $body$` does not end it | nothing |

Three properties follow from the table, and they are the whole of the fix. **Comments are recognised
only in the code state**, so a `--` or a `/*` inside any quoted form is content and cannot remove
anything. **Statements are split on `;` only in the code state**, so a semicolon inside a string, an
identifier, a dollar body or a comment does not end a statement. And **the keyword check runs on each
split statement's leading tokens** — the text between the previous split and this `;`, with its
comments and quoted runs already accounted for by the pass, leading whitespace and leading comments
skipped, matched case-insensitively against the table. Drizzle's own `--> statement-breakpoint` needs
no rule of its own: it *is* a line comment, and the `;` before it has already ended the statement, so
the previous draft's "split on the marker and then on `;`" is one step the single pass removes rather
than a step it has to keep.

**The honesty note stands, unchanged and important: this is still not a PostgreSQL parser, and none
is promised.** The pass makes the guard immune to the *lexical* deceptions above — which is what it
was always claimed to be immune to — and it changes nothing about the limits below. Three
consequences, stated rather than discovered:

- **`CASE … END` is safe**, because `END` only matches as a statement's first keyword. So is a
  `DO $$ BEGIN … END $$;` block, because the pass is in the dollar-quoted state for the whole body —
  so neither its `BEGIN`, its `END` nor any `;` in it is in the code state — and the statement's first
  keyword is `DO`. So is a comment or a string that happens to contain the word `commit`.
- **It is defeatable on purpose.** A `DO` block that issues `COMMIT` through `EXECUTE`, a statement
  assembled from a table, an `\i` include — none of these are seen. **This is a guard against
  accidents, not a SQL parser**, and it is worth having for exactly that: the realistic failure is
  someone pasting a `CREATE INDEX CONCURRENTLY` out of a StackOverflow answer, not someone
  smuggling a commit past a reviewer.
- **It over-triggers rather than under-triggers.** A legitimate statement whose first keyword is on
  the list is refused even where PostgreSQL would have accepted it, and the escape is not a flag on
  the guard — it is §13's guarded hand-run deployment, which is a human deciding with the dump in
  reach. One refusal costs an afternoon; one silent escape costs the recovery's only guarantee.

The message names the file, the offending keyword and the first line of the offending statement, so
the author knows which of five files and which statement without reading the guard's source.

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
| **either form, a pending file that `assertTransactionSafe` rejects** | the refusal through `logError`, naming the file, the keyword and the statement's first line; **nothing is applied** | **1** |
| any argument that is not `--check` | prints the usage line to stderr | 2 |

**The exit-code convention, stated because a script depends on it.** `0` means "I did what you
asked", `1` means "I failed", `2` means "you asked wrongly". In particular **`--check` exits 0 even
with migrations pending**: it answers *what would you do*, not *is this database up to date*. A
caller that wants a gate does not use `--check` at all — it runs the applying form and reads its
exit code, which is what `live-update.sh` step 8 does, or it starts the server with
`LOOM_MIGRATE_ON_BOOT=false` and lets the refusal of §5.3 be the gate. `--check` is for a human who
wants to know what the next update will touch before running it.

**The one carve-out in that convention, and it is deliberate: a rejected file makes `--check` exit
1.** A transaction-unsafe migration is not a *pending-migration state* that `--check` is reporting
on — it is a defect in the repository, and `1` is this entry's code for "I failed". Making it exit 0
with a warning would leave `live-update.sh` step 5 with nothing to gate on, which is the whole
reason the check is run there: an offending file must stop the update **before** the quiesce, with
Loom still serving and nothing dumped. So the refusal is a failure in both forms of the command.

**And `--check`'s output shape is now a contract, because `live-update.sh` parses it** (§4.5's `pending_tags`
and R4). With something pending, stdout is: the `migrations: N applied` line, then a line that is
**exactly** `pending:`, then the pending tags, **one bare tag per line, nothing after them**. With
nothing pending, stdout is the single `migrations: N applied, nothing to apply` line and no
`pending:` line at all. That is what makes `sed -n '/^pending:$/,$p'` a sound extraction, and
§11.2 case 10 asserts the shape — and, since round 5's F2, the extraction itself over both an empty
and a non-empty result — rather than only the words, because the reconciliation of §4.5's recovery
procedure is only as good as this listing.

**And the deployment always invokes this entry as the service's whole command**, never as an
argument appended to it: `docker compose -p loom run --rm -T --name loom-migrate-check migrate node
dist/migrate.js --check`, for the reason §4.2's `command:` bullet gives (round 5's F1) — `run`
replaces the configured command, so the short form would try to execute `--check` as a program.

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
top-level `name:` that a reader might take for the operative one. Removing that variable would
rename every one of the shop's containers, its network and its volumes on the next `up`, and Spool's
own runbook is written in terms of commands that rely on it.

**And every Spool command in this spec names the project and the environment file anyway:**
`docker compose -p spool --env-file /root/git/Spool/deploy/.env -f /root/git/Spool/deploy/docker-compose.yml …`,
never the bare `-f` form an earlier draft used. `-p` outranks the env file, so the command is
correct whether or not the file still sets the variable, and it cannot be redirected by whatever the
root shell has exported — the same reasoning as `-p loom` on Loom's side (§4.2). `--env-file` is the
other half and it is a correction: `-f` moves the compose file but **not** the `.env` lookup, which
follows the caller's directory, so the same command run from `/root` or from Loom's `deploy/` hands
compose none of Spool's values and every `${…:-default}` in Spool's file silently takes its default
— the shop's `DB_PASSWORD` becoming the development one and `SITE_ADDRESS` becoming `localhost`
(§2). Every one of the three mechanisms is independent on purpose: the variable keeps Spool's own
tooling right, `-p` keeps *this* spec's project right, and `--env-file` keeps *this* spec's values
right. §9 step 1 still verifies the effective name with `docker compose ls` before it touches Caddy,
because the cost of being wrong is the shop's containers being recreated under a second project
name.

**How the merged hook actually reaches the server.** Not by `git pull` from GitHub: Spool's server
checkout has **no GitHub credential by policy** and its `origin` is the local bundle
`/root/spool.bundle`. So the merge is followed by a bundle refresh from Paw's PC, which is the
procedure Spool's own deployment tasks already use and which §9 step 1 spells out command by
command. Loom's checkout is the opposite case — `origin` is GitHub over plain HTTPS with no
credential, because the Loom repository is public (§2) — and that asymmetry is why the two
repositories are updated by different means on the same box.

**The two prerequisites, run by the session over SSH before Spool's compose is re-upped** (with
`-p spool --env-file /root/git/Spool/deploy/.env -f /root/git/Spool/deploy/docker-compose.yml`, as
every Spool command here is) — this ordering is the whole of the risk in §7:

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

**And one thing to remove while he is in the panel, which is round 4's F7: any `AAAA` or `CNAME`
record for `loom`, including one inherited from a wildcard.** The A record above must be the *only*
answer for that host. An `AAAA` left in place sends every IPv6-capable client — and Let's Encrypt's
validator, which prefers IPv6 when a host publishes it — to whatever that address is, so the
certificate never issues and the A-record check that said "DNS is done" was looking at the wrong
half of the answer. A `CNAME` beside an `A` for one name is invalid DNS outright. §9 step 6's
done-check is written as all three `dig` queries for exactly this reason, and it is what keeps
§13's "**No IPv6**" a true statement about the host rather than only about Loom's own configuration.

**Paw, item 2 — the connector and one paste, once.** Remove ChatGPT's existing Loom connector and
add `https://loom.3dbox.dk/mcp?agent=<key>` as a remote MCP server of type **Streamable HTTP** — not
STDIO, which fails silently with the client reporting only that the connector's tools are not
exposed (DOGFOOD §3 step 4). This is the last time it has to be done: the hostname is now stable, so
the connector survives every restart and every update. In the same sitting Paw pastes the prepared
onboarding text into the ChatGPT session (§9 step 12), which is what gets the reviewer into the
Weave without its secret ever entering the controller's transcript (§8.1).

### 8.1 Credentials: exactly where each one is generated, stored and read

**A credential never enters the controller's transcript** — the Claude Code conversation — **it
moves by file, by `scp` or on Paw's own clipboard.** That is the guarantee, in those words, and it is
the wording used in §9, §12 and §14 as well.

**Why it is worded that narrowly, which is a correction.** An earlier draft said "credentials never
pass through the conversation" and then, twelve steps later, had Paw paste the Weave's secret into
the ChatGPT session (§9 step 12) — so an operator following the broad rule could not finish the
runbook, and one following the runbook broke a stated security property. The rule that was actually
paid for on 2026-09-20 ([HANDBOOK.md](../../HANDBOOK.md) §5) is about the *controller's* transcript:
a secret rendered there is a secret in a conversation log, in a summary, and in whatever a later
session reads back. It says nothing about a clipboard or a local file, and it cannot, because the
reviewer has to be given something. So the guarantee is stated where it holds and §14.5 names the
residue: the Weave secret does exist in a clipboard, in one local file and in the ChatGPT
conversation, once, and the invitation route retires that after the first run.

**`redact_logs`, defined here once because both the script and the runbook read logs — and it is
review round 6's F1.** The
guarantee above is about what this spec's own commands *print*, and none of them prints a credential.
A container's log is not one of those commands: `main.ts` prints the Lobby's link — `/w/` followed by
the Weave's **43-character secret** — in full on the boot that creates the Lobby, deliberately,
because that is how the first operator is told where the Lobby is, and the README says so. So any
`docker … logs` run by a session, or by a script whose output a session reads, puts that secret in
the controller's transcript. Loom already blanks a 43-character base64url run in its **own**
structured logs ([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Logging"); this is the same rule
applied at the **reader**, so that it holds for a line that was printed on purpose:

    redact_logs() {
      sed -E 's#/w/[A-Za-z0-9_-]{43}#/w/<redacted>#g; s#[A-Za-z0-9_-]{43}#<43-char-token>#g'
    }

The `/w/` form is replaced first, so a Lobby link reads `/w/<redacted>` and a human can still see
*which kind* of value was removed; the second expression catches a bare agent key or keeper token
wherever a log happens to carry one. **Every log this slice reads goes through it**: the six reads in
`live-update.sh` — Postgres's log twice (§4.5 banner 8), Loom's log (banner 11), a reaped one-off's
log inside `reap_oneoff`, and `migrate --check`'s own output in banner 6 and in R4 — and the runbook's two, §9 step
5's first-deployment diagnostics and §9 step 7's certificate watch. The two logs that are **not read
at all** are §9 step 4's and §9 step 12's, where the done-check runs its match or its count on the
server and prints a fixed string, because a done-check wants a verdict and not a log.
What this does **not** do is change what Loom logs: §10 carries the follow-up note that the
first-boot line could be gated behind an explicit flag, and that deciding it is not this slice's
work. It is a `sed` and nothing else, so it is the same text in `live-update.sh` and in a hand-run
shell, and nothing has to be installed for it. In a hand-run shell it is a **function to paste once
per shell** — the three lines above, before the first log read — and §9's log reads are written in
terms of it rather than repeating the expression, so an edit to the filter is one edit.

The other half of the same correction is the inventory: the earlier draft called it "the five
files", listed six, and left out the two that matter most — the paste file that carries the secret,
and the CLI's own config file, into which `create` stores the new Weave's participant token. The
complete list is below. Every command that writes one of these files is given **in the form it is
actually run** — here, or in §4.7 for the two that are committed scripts — because an earlier draft
stated the rule and left those commands unwritten. That is not a stylistic gap: a
`node -e "console.log(…)"` in a root SSH session prints its result into the session's captured
output, and a session asked to "assemble" a file holding a secret with no command given will
improvise one that substitutes the secret on a command line. Both are the opposite of the promise,
which is why the last two unwritten ones — the prepared paste and the connector URL — became
`deploy/prepare-chatgpt-paste.ps1` and `deploy/connector-url-to-clipboard.ps1` in answer to review
round 3.

**Every file that holds a credential, what is in it, and who can read it.**

| File | Written by | Holds | Holder and protection |
| --- | --- | --- | --- |
| `~/git/Loom/deploy/.env` on the **server** | §9 step 3, generated in place | `LOOM_DB_PASSWORD`, `LOOM_KEEPER_TOKENS` | `root`, mode **600**, made by `umask 077`, checked with `stat -c %a` |
| `C:\Users\paw\.loom\live.env` | §9 step 3, `scp` of the above | the same two lines — the only copy off the server | Paw, by the profile ACL on `C:\Users\paw\.loom` (Paw and local administrators, nobody else) |
| `C:\Users\paw\.loom\live-keeper.json` | §9 step 3, derived locally | `{ "url": "https://loom.3dbox.dk", "token": "<43 chars>" }` | Paw, same profile ACL |
| `C:\Users\paw\.loom\live-claude-code.json`, `…\live-chatgpt.json` | §9 step 10, redirected `--json` | the `admin agents add` payload: `agent.id`, `agent.name`, `key` | Paw, same profile ACL |
| `C:\Users\paw\.loom\live-lobby.json` | §9 step 10, redirected `--json` | the Lobby's `weaveId` and its `secret` (only a keeper is told it) | Paw, same profile ACL |
| `C:\Users\paw\.loom\live-weave.json` | §9 step 11, redirected `--json` | the `create` payload: `weave.id`, `secret`, `token`, `participant` | Paw, same profile ACL |
| `C:\Users\paw\.loom\live-config.json` | the **CLI itself**, on `lobby join` in §9 step 10 and on `create` in §9 step 11 | the CLI's own store: the **Lobby participant token** — which is what makes `loom lobby` work at all (§9 step 10) — the live Weave's **participant token**, and which Weave is current | Paw, same profile ACL. Kept — it is what makes later `--weave`-less commands work against the live instance (below) |
| `C:\Users\paw\.loom\live-chatgpt-paste.md` | `deploy/prepare-chatgpt-paste.ps1` (§4.7), run by the session in §9 step 12.1 | the reviewer brief **plus the Weave's `secret`** in a `join_weave({ … })` call, ready to paste | Paw, same profile ACL. **Deleted** as a numbered sub-step of §9 step 12, with Paw's clipboard cleared in the same breath — it is the one file here whose whole purpose ends the moment it has been pasted |

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
CLI source rather than assumed. That file is itself credential-bearing — it is the last row of the
inventory above — and it is kept rather than cleaned up, because the participant token in it is how
every later live command speaks as the Claude-Code participant.

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

0. **Prerequisites, on the server and on Paw's PC.** Two halves, and **0.2 is new in answer to
   review round 4's F6**: it comes before every PowerShell command in this runbook, including the
   Spool bundle of step 1.

   **0.1 — on the server.** Everything this runbook and `live-update.sh` invoke, checked before
   anything is created:

       for c in docker git curl gzip flock openssl dig timeout; do command -v "$c" >/dev/null || echo "missing: $c"; done
       docker compose version

   `docker` and `git` were observed on 2026-09-21 (§2); the rest were not, and a "command not
   found" three steps into a deployment is the kind of stop this step exists to move earlier.
   `flock` and `timeout` come from `coreutils`/`util-linux` and `dig` from `dnsutils`; the missing
   ones are installed with
   `apt-get update && apt-get install -y util-linux dnsutils curl gzip openssl coreutils`.
   **Host Node is not required anywhere** on this server and is not installed: every secret is
   generated with `openssl` (§4.4), and every piece of Loom that runs there runs inside the image.
   *Done when:* the loop prints nothing and `docker compose version` answers with a version rather
   than an error — the compose v5.3 §2 recorded, or later.

   **0.2 — on Paw's PC, `D:\git\Loom` prepared and its helpers verified.** Steps 9 to 12 run the
   CLI and two committed PowerShell helpers **out of this checkout**, and the commit the server is
   about to clone has to be the commit this checkout holds. After the feature pull request is merged
   and its worktree is cleaned up, `D:\git\Loom` may still be an older `main` with stale build
   output and none of the new `deploy/` files — in which case step 11 cannot find
   `weave-guidelines.md` and step 12 cannot run the helpers, three-quarters of the way through a
   deployment:

       git -C D:\git\Loom status --porcelain --untracked-files=all   # must be empty
       git -C D:\git\Loom switch main
       git -C D:\git\Loom pull --ff-only
       $deploySha = (git -C D:\git\Loom rev-parse HEAD)              # the deployment SHA, used by step 2
       pnpm -C D:\git\Loom install --frozen-lockfile
       pnpm -C D:\git\Loom -r build
       foreach ($f in 'docker-compose.yml','loom.caddy','.env.example','live-update.sh',
                       'live-update.ps1','live-update.cmd','weave-guidelines.md','reviewer-brief.md',
                       'prepare-chatgpt-paste.ps1','connector-url-to-clipboard.ps1') {
         if (-not (Test-Path "D:\git\Loom\deploy\$f")) { throw "missing deploy\$f" }
       }

   Each line for a reason. The **clean-tree check comes first** because `switch` and `pull` behave
   differently depending on what is dirty, and because a deployment must be cut from the tree GitHub
   has — the same reasoning step 1 gives for the Spool bundle. `pull --ff-only` moves
   `refs/heads/main` itself rather than only the remote-tracking ref, and refuses instead of merging
   if the local branch has diverged. `$deploySha` is **the** deployment SHA for this whole runbook:
   step 2 requires the server's clone to equal it, so the server and Paw's PC are provably at the
   same commit rather than assumed to be. `install --frozen-lockfile` before `-r build` because the
   CLI is invoked as `node src\cli\bin\loom.js` against built output, and a stale `dist/` is the
   quietest way for step 9 to fail with something that looks like a server problem. The `Test-Path`
   loop checks all **ten** files of §4 by name, before anything on the server is created, because
   every one of them is either read or run from this checkout later in this runbook.
   *Done when:* the porcelain check printed nothing, `git -C D:\git\Loom rev-parse HEAD` equals
   `git -C D:\git\Loom rev-parse origin/main`, both `pnpm` commands exited 0, and the loop threw
   nothing.
1. **Spool's change is merged and applied.** Its pull request (§7) is merged on Paw's word; then,
   by the session, on the server, in this order:

   1. **Read the effective project names before touching anything** — `docker compose ls`, whose
      output is the *effective* name of every running project, not what any file claims. It must
      list `spool` as running and must **not** list `deploy` or `loom`. This is the check that
      catches a hook PR that dropped `COMPOSE_PROJECT_NAME=spool` from `~/git/Spool/deploy/.env`
      (§7); if `spool` is not there under that name, stop and fix the env file, because the shop's
      containers, network and volumes all hang off it. Every command below carries `-p spool` or
      `-p loom` regardless, and every Spool one carries
      `--env-file /root/git/Spool/deploy/.env` as well (§4.2), so this check is about the state of
      the box rather than about the commands that follow.
   2. **Get the merged hook onto the server, by bundle.** The server's Spool checkout has
      **`/root/spool.bundle` as its `origin`** — a file, not GitHub — because no GitHub credential
      is allowed on that box by policy; Loom's checkout, by contrast, has GitHub as its `origin`
      and needs no credential because the Loom repository is public (§2). So `git -C ~/git/Spool
      pull` **cannot see a commit that was merged on GitHub**, and an earlier draft of this step
      relied on exactly that: the pull would report "already up to date", the preflight would
      validate the old Caddyfile without the `import`, Caddy would never join `web`, and the
      prerequisite would look deployed while it was not. The procedure is the one Spool's own
      deployments already use (`Tasks/done/20260715-140446` and `…/20260717-133934` in that
      repository): re-bundle on Paw's PC, copy, replace atomically, reset.

      On Paw's PC, and the first three lines are the correction:

          git -C D:\git\Spool switch main
          git -C D:\git\Spool status --porcelain --untracked-files=all   # must be empty
          git -C D:\git\Spool pull --ff-only origin main
          git -C D:\git\Spool rev-parse HEAD                            # must equal the merged hook SHA
          git -C D:\git\Spool bundle create $env:TEMP\spool.bundle --all
          scp $env:TEMP\spool.bundle SpoolServer:/root/spool.bundle.new

      then on the server:

          mv /root/spool.bundle.new /root/spool.bundle
          git -C ~/git/Spool fetch origin
          git -C ~/git/Spool reset --hard origin/main
          git -C ~/git/Spool rev-parse HEAD        # must equal the merged hook SHA

      **Why the local `main` has to be moved first, and not merely fetched.** An earlier draft
      opened with `git -C D:\git\Spool fetch origin`, which advances `refs/remotes/origin/main` on
      Paw's PC and **leaves `refs/heads/main` exactly where it was**. The bundle then carries both
      refs, and the server's checkout — whose remote is that file — fetches the bundle's
      `refs/heads/main` into its own `origin/main`, because that is what a normal fetchspec
      (`+refs/heads/*:refs/remotes/origin/*`) says. So a workstation that had not pulled since
      before the hook merge would produce a bundle *containing* the merged commit while advertising
      the stale one, the `reset --hard origin/main` would land on the old tree, and the SHA check
      two lines later would stop the deployment for a reason nobody would guess from the message.
      The fix is to make the advertised ref unambiguous: be on `main`, require a clean tree, and
      fast-forward it — `pull --ff-only origin main`, which moves `refs/heads/main` itself and
      refuses rather than merging if the local branch has diverged. The clean-tree check is there
      because a dirty tree makes `switch` and `pull` behave in ways that depend on what is dirty,
      and because a bundle is a deployment artefact: the tree it is cut from should be the tree
      GitHub has. The local `rev-parse` is the same number the server checks, asserted on the side
      that can still fix it cheaply. Bundling `origin/main` instead was the other option offered by
      the review and is not taken: it would need a matching explicit fetchspec on the server, which
      is a second place to keep in step with Spool's own runbook, and Spool's deployment tasks are
      written in terms of a plain `fetch`.

      `--all` because that is what the provisioning and the TLS cutover both used, and a whole-
      history bundle is a few megabytes. The `scp` lands on **`spool.bundle.new`** and a local `mv`
      puts it in place, because `/root/spool.bundle` is the file `origin` points at: writing
      straight onto it would replace the checkout's only remote while the transfer is in flight, so
      an interrupted copy would leave a truncated bundle and a checkout that can no longer fetch
      anything. `reset --hard origin/main` and not `pull`: the server checkout is a deployment
      artefact that is never committed to, and a reset says so in one command instead of asking git
      to merge. Then the SHA is compared against the merge commit the pull request produced — the
      one number that proves the hook is actually on the box.
   3. `docker network create web` and `install -d -m 755 /root/caddy-sites`.
   4. **Preflight Spool's proposed Caddyfile in a disposable container, before Caddy is recreated**
      — the same shape as `live-update.sh` step 3, including the **two-variable mode-600 env file**
      of §4.5 banner 4 rather than Spool's whole `.env`, extracted the same `sed -n 's/^KEY=//p'` way
      and for the same reason (a `grep` that matches nothing stops the run under `pipefail`; a
      missing file is a separate, louder failure), and with an empty sites directory because that is
      the state the shop is about to run in:

          CADDYENV="$(mktemp)"; chmod 600 "$CADDYENV"; trap 'rm -f "$CADDYENV"' EXIT
          SPOOLENV=/root/git/Spool/deploy/.env
          [ -f "$SPOOLENV" ] || { echo "missing $SPOOLENV — Spool's environment file must be on the box"; exit 1; }
          SA="$(sed -n 's/^SITE_ADDRESS=//p' "$SPOOLENV" | tail -1)"
          RA="$(sed -n 's/^REDIRECT_ADDRESSES=//p' "$SPOOLENV" | tail -1)"
          printf 'SITE_ADDRESS=%s\nREDIRECT_ADDRESSES=%s\n' "${SA:-localhost}" "${RA:-redirect.localhost}" > "$CADDYENV"
          docker run --rm \
            -v /root/git/Spool/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
            -v /root/caddy-sites:/etc/caddy/sites:ro \
            --env-file "$CADDYENV" \
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
   5. `docker compose -p spool --env-file /root/git/Spool/deploy/.env -f /root/git/Spool/deploy/docker-compose.yml up -d caddy`
      — the `--env-file` is not optional here and it is the one command in this runbook where
      omitting it would be felt by a customer: without it compose recreates the shop's Caddy with
      `SITE_ADDRESS` defaulted to `localhost` (§2) — then the same
      `caddy validate` again via `docker exec spool-caddy-1` — kept as a **second** check, because
      it is the only one that reads the configuration as the container actually mounted it.

   *Done when:* `git -C ~/git/Spool rev-parse HEAD` equals the merged hook SHA, both validates
   print `Valid configuration`, `docker compose ls` still shows the effective project name `spool`
   and nothing called `deploy` or `loom`, `docker network inspect web` lists `spool-caddy-1`, and
   `https://shop.3dbox.dk` still serves the shop.
2. **Clone Loom.** `git clone https://github.com/poteb/Loom.git ~/git/Loom` — no credentials, the
   repository is public — the asymmetry with Spool's bundle origin is stated in step 1. *Done when:*
   `git -C ~/git/Loom rev-parse HEAD` equals **`$deploySha` from step 0.2** — the same commit Paw's
   PC is on, checked rather than assumed —
   `git -C ~/git/Loom status --porcelain --untracked-files=all` is empty, and
   `ls ~/git/Loom/deploy` lists all **ten** files (§4) — `weave-guidelines.md` among them, since
   step 11 reads it, and `reviewer-brief.md` with the two `.ps1` helpers, since §9 step 12 runs
   them from Paw's own checkout and a server that is missing them means the merge is not what the
   runbook expects — with `live-update.sh` executable.
3. **Generate the secrets on the server, then copy them once.** The exact commands are in §8.1 and
   are not repeated here: generate straight into `~/git/Loom/deploy/.env` with `umask 077` and
   `openssl`, check the shapes with `stat` and `awk`, `scp` the file to
   `C:\Users\paw\.loom\live.env`, and derive `C:\Users\paw\.loom\live-keeper.json` locally. Nothing
   prints a value at any point. `deploy/.env.example` is **not** copied first — writing the two
   lines directly is fewer steps and leaves no commented template to be half-filled.
   *Done when:* `stat -c %a ~/git/Loom/deploy/.env` is `600`, the two `awk` length checks print `32`
   and `43`, and `Test-Path C:\Users\paw\.loom\live-keeper.json` is `True`.
4. **Bring it up.** In `~/git/Loom/deploy`: `docker compose -p loom up -d`. Postgres starts,
   `migrate` runs to completion against an empty database and applies all five migrations, then
   `loom` starts.
   *Done when:* `docker compose ls` now lists the effective name `loom` beside `spool` (and nothing
   called `deploy`); `docker compose -p loom ps postgres loom` shows both **running**;
   the finished one-shot is checked **separately and with `--all`**, which is review round 5's F7 —
   `docker compose -p loom ps --all migrate` lists it at all (plain `ps` omits a stopped container,
   so the old wording could fail a perfectly correct startup and send the session diagnosing
   nothing) and `docker inspect --format '{{.State.ExitCode}}' loom-migrate-1` prints **`0`**;
   `docker volume inspect loom_pgdata` succeeds; and the three lines Loom's own log must carry are
   checked **without the log being read**, which is review round 6's F1 — each command runs on the
   server and prints one fixed string or nothing at all:

       docker compose -p loom logs loom 2>&1 | grep -Eq 'keepers: seeded 1 from LOOM_KEEPER_TOKENS' && echo 'keeper seeding log: ok'
       docker compose -p loom logs loom 2>&1 | grep -Eq 'lobby: created +/w/[A-Za-z0-9_-]{43}' && echo 'lobby creation log: ok'
       docker compose -p loom logs loom 2>&1 | grep -Eq 'loom server listening on http://0\.0\.0\.0:3000' && echo 'listening log: ok'

   **Why the done-check may not simply read the log.** This is the boot that creates the Lobby, and
   `main.ts` prints the Lobby's link — `/w/` followed by the Weave's **43-character secret** — in full
   on that one boot, deliberately, because that is how the first operator is told where the Lobby is,
   and the README documents it. The session running this step holds root SSH, so `docker compose logs`
   renders into the Claude Code conversation: a `docker compose -p loom logs loom` in a done-check
   would put the live Lobby's secret in the controller's transcript, which
   [HANDBOOK.md](../../HANDBOOK.md) §5 forbids and §8.1 promises against. So the **match happens on
   the server** and only the verdict crosses: three commands, three fixed strings, and the middle one
   asserts the *shape* — `/w/` and exactly 43 base64url characters — which is a stronger check than
   eyeballing `lobby: created /w/…` was, because it proves a whole secret was minted rather than that
   a prefix was printed. **The missing output is the failure**: `grep -Eq` exits 1, the `&&` does not
   fire, nothing is printed, and the step is not done. A quiet `grep` at the end of a pipeline is
   exactly what §4.5 banner 3 refuses inside the script, and the distinction is worth stating so the
   next reviewer does not have to re-derive it: these are interactive commands, where `pipefail` is
   **off**, so the pipeline's status is `grep`'s own and a `docker` killed by `SIGPIPE` cannot be
   mistaken for a failed match — and the consequence of being wrong here is a printed line missing
   from a done-check a human reads, not a guard silently permitting a deployment.
5. **Install the site block and reload Caddy** — by running the real script, so that the first
   deployment exercises it. This is the one run that stays **server-side**:
   `~/git/Loom/deploy/live-update.sh --bootstrap`, over SSH. It takes the lock,
   fetches, finds **no `deploy/.deployed-sha`** and so compares `HEAD` with `origin/main` for the
   topology guard — which is the documented fallback for exactly this run (§4.5 banner 3) and trips
   nothing, because the fetch brings nothing new — confirms the checkout equals `origin/main`,
   validates the proposed Caddy configuration, rebuilds the image as `loom-live:<short SHA>`,
   records the pending set (`--check` says nothing pending), **stops `loom`**, takes a dump (the
   volume exists and Postgres is up and bound to `loom_pgdata`), skips the migrator because nothing
   is pending, starts `loom` again — **and only then writes `deploy/.deployed-sha`**, because until
   the new image is up the commit whose image is serving is still the old one (§4.5 banner 10, review
   round 5's F3) — passes the loopback check, installs `loom.caddy` and reloads Caddy. `--bootstrap` is required here and **only** here: there
   is no A record yet, so the public check of §4.5 banner 13 cannot pass — and because that check is
   what writes `deploy/.verified-sha`, this run deliberately leaves **no** verified-SHA record and
   step 8's normal rerun is what first creates it.

   **Why this run stays on the server while step 8 goes through the wrapper, which round 4 asked
   about.** This is the run with no way back: there is no previous image on disk and, until the
   quiesce, no recorded SHA, so a failure here is diagnosed in the same shell that just failed, with
   `docker image ls` and with the logs read **through the redaction filter of §8.1** —

       docker compose -p loom logs --tail 200 loom 2>&1 | redact_logs
       docker compose -p loom logs --tail 200 postgres 2>&1 | redact_logs

   and never bare, for the reason step 4's done-check gives: this is the boot that prints the Lobby
   link with its 43-character secret in it, and the shell reading the log belongs to a session whose
   conversation is a record (F1). `redact_logs` is defined once, in §8.1, and is the same three-line
   function `live-update.sh` carries — pasted into this shell before the first log read. Every other
   log read anywhere in this runbook goes through it too, and §9 step 4's done-check does not read a
   log at all. A
   wrapper, an SSH round trip and
   PowerShell's exit-code forwarding between the operator and those logs buys nothing and adds three
   things that can themselves be wrong on their first use. So the bootstrap runs where the evidence
   is, and **step 8 — the shape every later merge actually uses — runs through
   `deploy\live-update.cmd` from Paw's PC**, which is what puts the wrapper, the alias and the
   exit-code path on the first day's record (§4.6, §11.6). The recovery for a failure here is
   `docker compose -p loom down -v` and step 4 again, which is acceptable because at this point the
   database holds nothing but an empty schema. *Done when:* it prints the skipped-public-check line,
   exits 0, `/root/caddy-sites/loom.caddy` exists with mode 644, a dump exists under `~/backups/loom`
   with no leftover dot-prefixed temporary file, `docker image ls loom-live` lists the head's short
   SHA as a tag, `cat ~/git/Loom/deploy/.deployed-sha` equals that short SHA, and
   `~/git/Loom/deploy/.verified-sha` does **not** exist yet.
6. **Paw adds the DNS A record** (§8 item 1), and removes any AAAA or CNAME that exists for that
   host. *Done when:* all three of these hold, from the server — and the second and third are new in
   answer to review round 4's F7:

       dig +short A     loom.3dbox.dk      # exactly 89.167.47.120, and nothing else
       dig +short AAAA  loom.3dbox.dk      # empty
       dig +short CNAME loom.3dbox.dk      # empty

   **Why an empty AAAA and an empty CNAME are part of "done", and not a detail.** An inherited,
   wildcard or stale `AAAA` record would leave `loom.3dbox.dk` resolving to somewhere else for every
   IPv6-capable client — and for Let's Encrypt's validator, which prefers IPv6 when a host publishes
   it. The A-record check would pass, Paw would report DNS complete, and step 7 would then sit
   watching a certificate that can never be issued, with the reason two records away from anything
   the runbook had looked at. A `CNAME` is checked for the same reason and one worse: a `CNAME`
   alongside an `A` for the same name is invalid DNS, and which answer a resolver gives is not
   something to find out during a cutover. The A answer must be **exactly** `89.167.47.120` —
   `dig +short A` prints one line per record, so a second line means a second host is in rotation
   and half the requests would miss Loom. This is also the check that keeps §13's "**No IPv6**"
   honest: that bullet is a decision not to *serve* IPv6, and it is only true if nothing publishes
   an AAAA for the host.
7. **Watch the certificate.**
   `docker compose -p spool --env-file /root/git/Spool/deploy/.env -f /root/git/Spool/deploy/docker-compose.yml logs -f caddy 2>&1 | redact_logs`
   — or re-reload Caddy to skip the accumulated ACME backoff, which is the trick Spool's own cutover
   runbook records. **Through `redact_logs` like every other log read** (§8.1, F1): this is the shop's
   Caddy, whose access log carries `loom.3dbox.dk` request lines including any `?agent=<key>` query,
   and §12 records that Caddy's own log is not redacted at the writer. If `sed`'s block buffering
   makes the follow look stalled, add `-u` to that one invocation — GNU `sed` is on this box — or read
   it as a `--tail 200` snapshot instead. *Done when:* the log carries a successful certificate obtain
   for `loom.3dbox.dk`, and `curl -fsS https://loom.3dbox.dk/api/guidelines` answers 200 with no
   certificate warning.
8. **Rerun the update in normal mode — from Paw's PC, through the wrapper**, which is what finishes
   the first deployment. This is the round-4 F6 change: the command is

       D:\git\Loom\deploy\live-update.cmd

   and **not** the server-side script. It pulls nothing, applies nothing, reloads nothing (`cmp` says
   the site file is unchanged) and runs the **public** check that step 5 was allowed to skip. It does
   stop and start `loom` again, because the quiesce is unconditional (§4.5 banner 7) — a few seconds of
   502 on an instance nobody is using yet.

   **Two things this step exists to prove, not one.** The first is the one it always had: a
   `--bootstrap` run has not proved the public path, and a deployment that has never proved it is not
   finished. The second is new and was the gap F6 named — this run is what exercises
   `deploy/live-update.cmd`, `deploy/live-update.ps1`, the `SpoolServer` SSH alias, the remote
   login shell's `~` expansion and **exit-code forwarding**, on the day the deployment happens
   rather than at the next merge, when a broken wrapper would be discovered by a merge session that
   thought it had deployed. Three of the ten files in `deploy/` have no other first-day exercise
   (§11.6). *Done when:* it prints `health: ok`, the local command's `$LASTEXITCODE` is **0**,
   `cat ~/git/Loom/deploy/.verified-sha` equals `git -C ~/git/Loom rev-parse --short HEAD` — the
   public proof — and `cat ~/git/Loom/deploy/.deployed-sha` equals the same value, which it already
   did from step 5. Then, once, to prove the *failure* direction of the wrapper without touching the
   instance: `D:\git\Loom\deploy\live-update.cmd --nonsense` must print the usage line and leave
   `$LASTEXITCODE` at **2** (§4.5's argument convention), which is argument and exit-code forwarding
   demonstrated in one command that reaches the script and stops before the lock.
9. **Keeper check over the public hostname**, the first credentialed call end to end. On Paw's PC,
   after the prelude above:

       node src\cli\bin\loom.js --url https://loom.3dbox.dk admin weaves

   *Done when:* it prints a list (the Lobby, at this point) rather than `invalid_token`. Note that
   the global `--url` comes **before** the command name.
10. **Mint the two agent keys and capture the Lobby secret**, each with `--json` redirected into its
    own file so no key is ever rendered into the controller's transcript (§8.1):

        node src\cli\bin\loom.js --json --url https://loom.3dbox.dk admin agents add Claude-Code > C:\Users\paw\.loom\live-claude-code.json
        node src\cli\bin\loom.js --json --url https://loom.3dbox.dk admin agents add ChatGPT     > C:\Users\paw\.loom\live-chatgpt.json

    A redirected `--json` invocation is exactly how the 2026-09-20 interim setup captured its keys,
    and it is the reason the key never appears anywhere else: `admin agents add` shows it **once**.

    **Then Claude-Code joins the live Lobby, and only after that is the Lobby read — which is a
    correction, and it is a runbook workaround for a deferred CLI defect, not a change to the
    CLI.** An earlier draft ran `loom lobby > live-lobby.json` with nothing but
    `LOOM_KEEPER_TOKEN` set. That cannot work, and [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) says so
    in the `commands/lobby.ts` row: `lobbyContext` takes its credential from
    `LOOM_AGENT_KEY ?? config.weaves[lobbyWeaveId].token` and throws
    **`no_lobby_token`** — *"No Lobby identity: run `loom lobby join --name <name>` first"* — when
    neither is there ([`commands/lobby.ts`](../../../src/cli/src/commands/lobby.ts)). A keeper token
    is how the CLI *learns where the Lobby is and what its secret is*; it is not a participant
    identity and the read is not authorised by it. The live instance has had no `lobby join` at
    this point, so `live-lobby.json` would never have been written and the first deployment would
    have stopped on the step that captures the Lobby's page link. **The CLI is not touched by this
    slice** — the row stays deferred, with its own suggested fix — and the runbook does the one
    thing it can: it establishes the identity first. Claude-Code standing in the live Lobby is
    wanted anyway; it is how Claude-Code will open requests and see invitations later (§9 step 12's
    invitation route), so this is a step the slice would have needed regardless.

        $env:LOOM_AGENT_KEY = (Get-Content C:\Users\paw\.loom\live-claude-code.json | ConvertFrom-Json).key
        $env:LOOM_KEEPER_TOKEN = $null
        node src\cli\bin\loom.js --url https://loom.3dbox.dk lobby join --name Claude-Code
        $env:LOOM_AGENT_KEY = $null
        $env:LOOM_KEEPER_TOKEN = (Get-Content C:\Users\paw\.loom\live-keeper.json | ConvertFrom-Json).token
        node src\cli\bin\loom.js --json --url https://loom.3dbox.dk lobby > C:\Users\paw\.loom\live-lobby.json

    **Why the join runs under the agent key with the keeper token cleared.** `lobby join` presents
    `LOOM_AGENT_KEY` and stores the token it gets back under the Lobby's weave id in
    `$LOOM_CONFIG` — the live store of §8.1. Presenting the **agent key** is what links that
    participant to the Claude-Code agent minted two commands earlier, exactly as §9 step 11's
    `create` does and for the same reason: a Lobby participant that is merely *named* `Claude-Code`
    would meet `name_taken` when the real agent later joined with its key. The keeper token is
    cleared for those two lines so the shell holds one identity at a time, which is the convention
    §9 step 11 already follows, and it is restored immediately afterwards.

    **And why the `lobby` read runs the other way round — keeper token restored, agent key cleared.
    This is a deviation from the review's suggested ordering, and the source is the reason.** The
    `lobby` command answers two questions with two credentials
    ([`commands/lobby.ts`](../../../src/cli/src/commands/lobby.ts)): *where is the Lobby* is asked
    by `whereTheLobbyIs`, which uses `LOOM_KEEPER_TOKEN` when the environment has one and falls back
    to an **anonymous** lookup when it does not — and an anonymous lookup is not told the Lobby's
    `secret`; *who is asking* is answered by `lobbyContext`, which now finds the **stored** token the
    join just wrote. So under the agent key alone the command would succeed and write a
    `live-lobby.json` with **no secret in it** — the one thing the file exists for. Restoring the
    keeper token first is what puts the secret in the payload, and clearing the agent key is
    harmless because the stored token has taken over as the identity. The order is: join as the
    agent, read as the keeper.

    `lobby join` is deliberately run **without** `--json`: its JSON payload carries the new
    participant's **token**, and this is the one command in the runbook whose output is not
    redirected to a file. Its human line — `Joined the Lobby as Claude-Code (weave …). Token stored
    in …` — names no credential, so it is safe in a transcript, and the token it is talking about
    goes straight into `live-config.json`, which §8.1 already inventories.

    *Done when:* `admin agents list` shows both agents, unrevoked; all three files exist;
    `(Get-Content C:\Users\paw\.loom\live-claude-code.json | ConvertFrom-Json).agent.id` prints a
    uuid; the join printed `Joined the Lobby as Claude-Code`; the participant in `live-lobby.json`
    whose `name` is `Claude-Code` has an `agentId` **equal to that same `agent.id`** — which is the
    proof that the stored Lobby identity is the agent's and not a look-alike — and
    `(Get-Content C:\Users\paw\.loom\live-lobby.json | ConvertFrom-Json).lobby.secret` is a
    non-empty string, which is the proof that the read was made as a keeper.
11. **Create the Weave as the Claude-Code agent.** The guidelines text is read from the
    **checkout** — `deploy/weave-guidelines.md` (§4) — and is checked before anything else happens;
    then the agent key is loaded from its file and the keeper token is **cleared for this one
    command**:

        $g = "D:\git\Loom\deploy\weave-guidelines.md"
        if (-not (Test-Path $g)) { throw "missing $g — the Weave is not created without the approved guidelines" }
        $text = (Get-Content $g -Raw)
        if ($text.Trim().Length -gt 4000) { throw "guidelines are $($text.Trim().Length) characters; the limit is 4000" }
        $env:LOOM_AGENT_KEY = (Get-Content C:\Users\paw\.loom\live-claude-code.json | ConvertFrom-Json).key
        $env:LOOM_KEEPER_TOKEN = $null
        $text | node src\cli\bin\loom.js --json --url https://loom.3dbox.dk create --title "Loom development" --name Claude-Code --kind agent --guidelines - > C:\Users\paw\.loom\live-weave.json
        $env:LOOM_AGENT_KEY = $null
        $env:LOOM_KEEPER_TOKEN = (Get-Content C:\Users\paw\.loom\live-keeper.json | ConvertFrom-Json).token

    The last two lines put the shell back the way step 9's prelude left it, so a later keeper
    command is not silently made as an agent — the same precedence that matters below, read the
    other way round.

    **The file is read from the repository, and the two checks come before `create`, which is a
    correction.** An earlier draft piped `C:\Users\paw\.loom\live-guidelines.md`, a file no step in
    this runbook ever wrote: on a fresh workstation `Get-Content` fails, and depending on how
    PowerShell treats the pipeline the Weave is either created with **no** guidelines — quietly
    wrong, and only noticed by the done-check after the fact — or the command dies with the agent
    key already sitting in the environment. So the text lives in git as
    `deploy/weave-guidelines.md`, byte-identical to the approved block in
    [DOGFOOD.md](../../DOGFOOD.md) §3 step 2, and this step **stops before `create`** if the file is
    absent or if its trimmed length exceeds **4000 characters**, which is the server's own bound on
    a guidelines layer. Both checks run before the agent key is loaded, so a stop here leaves the
    shell exactly as step 9's prelude left it.

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
12. **Paw re-adds the connector and pastes one prepared text** (§8 item 2), in four sub-steps,
    because the last of them is the cleanup and it is not optional:

    1. **The session writes the paste file** by running the committed script (§4.7), which prints
       nothing at all:

           powershell -NoProfile -ExecutionPolicy Bypass -File D:\git\Loom\deploy\prepare-chatgpt-paste.ps1

       It reads the committed reviewer brief (`deploy/reviewer-brief.md`, byte-identical to
       [DOGFOOD.md](../../DOGFOOD.md) §4) and the Weave's `secret` from `live-weave.json`, and
       writes `C:\Users\paw\.loom\live-chatgpt-paste.md` with the `join_weave({ "secret": …, "name":
       "ChatGPT" })` instruction prepended. The secret goes from one file to another and is never
       rendered into the controller's transcript (§8.1). *Checkable without reading the secret:*
       `Test-Path C:\Users\paw\.loom\live-chatgpt-paste.md` is `True` and
       `Select-String -Path … -Pattern 'join_weave' -Quiet` is `True`.
    2. **Paw puts the connector URL on his clipboard** with the other committed script (§4.7),
       which prints one line and not the URL:

           powershell -NoProfile -ExecutionPolicy Bypass -File D:\git\Loom\deploy\connector-url-to-clipboard.ps1

       then pastes it into ChatGPT's connector dialog as a **Streamable HTTP** remote MCP server.
       The URL is `https://loom.3dbox.dk/mcp?agent=<key>` with the key read from
       `live-chatgpt.json`; the agent key therefore never appears on a screen, in a scrollback or
       in any transcript.
    3. Paw copies the paste file's contents and pastes them into the ChatGPT session.
    4. **Paw deletes the paste file and clears his clipboard**:
       `Remove-Item C:\Users\paw\.loom\live-chatgpt-paste.md` and
       `Set-Clipboard -Value ' '`. The file's whole purpose ended when it was pasted, and it is the
       only file in the §8.1 inventory that is deleted rather than kept: everything else in
       `C:\Users\paw\.loom` is still needed by a later command, while this one is a copy of a
       secret sitting in a folder for no remaining reason. The clipboard goes with it for the same
       reason — a clipboard survives until something else replaces it, and "something else" is not
       a plan.

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
    guideline layers, **no** 500 from the reconnect polls is in the server's log — which is §5.4
    proved in the place the defect was found, and which is checked on the server as a count rather
    than by reading the log (§8.1, F1), because that log carries `/mcp?agent=<key>` request lines:

        docker compose -p loom logs --tail 500 loom 2>&1 \
          | grep -Ec '"status":500|internal' | sed 's/^/500s in the last 500 lines: /'

    — `grep -Ec` prints a count and nothing matched, `0` is the answer that means done, and the
    consumer reads its input to the end so there is no early-exit pipe here (§4.5 banner 3's rule) —
    and `Test-Path C:\Users\paw\.loom\live-chatgpt-paste.md` is `False`.
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
| [DOGFOOD.md](../../DOGFOOD.md) §3 step 2 | One line under the guidelines blockquote: the same text is committed as `deploy/weave-guidelines.md`, which is what §9 step 11 and every later `create` read, and the two must stay byte-identical |
| [DOGFOOD.md](../../DOGFOOD.md) §4 | One line under the "brief to paste" block: the same text is committed as `deploy/reviewer-brief.md`, which is what `deploy/prepare-chatgpt-paste.ps1` reads (§4.7), and the two must stay byte-identical |
| [HANDBOOK.md](../../HANDBOOK.md) §6 "current state" | The live instance, its hostname, and where its credentials' file paths are |
| [HANDBOOK.md](../../HANDBOOK.md) §3 step 13 | Merge gains its last action: run `deploy\live-update.cmd` and report what it printed — including, in one clause, that the update stops Loom for a few seconds while it dumps and migrates, so a reviewer mid-poll may see a 502 and that is expected (§4.5 banner 7) |
| [HANDBOOK.md](../../HANDBOOK.md) §5 traps | Thirty-seven new ones, all paid for in writing this spec and in answering its six review rounds: `docker compose up <service>` **returns 0 even when the service failed**, and `--exit-code-from` implies `--abort-on-container-exit`, which would stop the live database — use `docker compose run --rm`; **HSTS `includeSubDomains` does not cover a sibling host**, so `loom.3dbox.dk` needs its own; **a compose project is named after its directory unless the file says otherwise** — two `deploy/` directories are two projects called `deploy`, so put `name:` in the file; **and `name:` is not enough** — `COMPOSE_PROJECT_NAME` outranks it, so pass `-p <project>` on every command and refuse to run with that variable set; **`git pull --ff-only` does not mean "the checkout equals origin"** — it succeeds over a local commit the remote has not passed and leaves a dirty tracked file alone, so assert `HEAD == refs/remotes/origin/main` on a clean tree instead; **a stopped Postgres container is not an empty database** — ask the volume, or a migration runs with no dump behind it; **a checkout whose `origin` is a local bundle cannot see a commit merged on GitHub** — a `pull` says "already up to date" and the prerequisite is silently not deployed, so re-bundle and `scp` it; **a backup is worth only the window between it and the change it insures against** — dump immediately before the migration, not before a two-minute build; **"wait until it is healthy" with no bound is a hang holding a lock** — poll with a timeout, fail fast on `unhealthy`, and print the logs; **`--env-file` hands a container every line of the file**, so build a two-variable temporary file instead of passing a neighbour's whole environment; **`-f` does not move compose's `.env` lookup** — it follows the caller's directory, so a `-f`-only command run from elsewhere silently takes every default in the file, and `--env-file` belongs beside every `-p`; **a guard placed after the mutation it guards is disarmed by a retry** — compare against the deployed state *before* fast-forwarding, and persist what is deployed; **a dump taken while the application still accepts writes is a snapshot with a live tail** — stop the application, or stop claiming the restore loses nothing; **a single mutable image tag means there is no previous image** — tag per commit if a failure has to be able to go back; **`grep | cut` under `set -euo pipefail` defeats the `${VAR:-default}` on the next line** — `grep` exits 1 on no match, `pipefail` propagates it and `set -e` kills the script before the default is read, so use `sed -n 's/^KEY=//p'`, which exits 0; **`git fetch origin` does not move the local `main`** — a bundle cut afterwards advertises the stale branch while containing the new commit, so `switch` and `pull --ff-only` before bundling; **an instance keeper is not a Lobby participant** — `loom lobby` needs a stored Lobby token or an agent key, so join before reading, and read as the keeper because only a keeper is told the Lobby's secret; **a non-zero exit from a database client does not prove the transaction rolled back** — PostgreSQL can commit and the connection can drop before the client hears it, so record the pending set before migrating and *ask* afterwards instead of asserting; **one record cannot hold two facts** — "which commit's image and schema are active" and "which commit was proved over the public hostname" have different lifetimes, and a single file holding both will aim a recovery at an image the schema has moved past; **an old image inside a new compose definition is not the old deployment** — `stop` keeps the container with its image id, command, environment and networks, so `docker start` it rather than re-`up`-ing a tag through a file that has changed; **a guarantee a future merge can void from inside a file is not a guarantee** — one `COMMIT` or `CREATE INDEX CONCURRENTLY` in a migration ends the transaction everything else relies on, so enforce it in code and test it over the real files; **an A record that resolves is not a complete DNS answer** — a stale or wildcard `AAAA` sends ACME's validator and every IPv6 client elsewhere while the A check passes, and a `CNAME` beside an `A` is invalid outright; **a runbook that reads files out of a local checkout has to say which commit that checkout is on**, or it fails three-quarters of the way through on a missing helper; **running a deployment's steps by hand is not running the deployment** — exercise the wrapper the merge will actually use, on the first day, or its first real use is the test; **`docker compose run <service> <args>` replaces the service's `command:`** rather than appending to it, so a status flag on its own becomes the program the container tries to execute — name the whole command; **a shell pipeline that ends in `grep` fails on the empty result** — `grep -v '^$'` exits 1 with nothing to filter, and under `pipefail` the most ordinary outcome there is kills the script, so delete blank lines with `sed` instead; **`cmd | grep -q` under `pipefail` can report 141** — `grep -q` exits on the first match, the producer dies of `SIGPIPE`, and a guard written as `producer | grep -q … && refuse` therefore waves the very case through that it was written to catch, **and collecting the output into a variable is not the fix** — `printf '%s\n' "$VAR" | grep -q …` has the same defect with `printf` as the victim, so the pipe itself has to go: `grep -q … <<<"$VAR"`, or a variable and a `case`, and then the *whole* file audited for the shape, because one instance is never the population; **`docker compose run` allocates a pseudo-TTY when its stdin is a terminal**, so output a script parses arrives CR-terminated from an interactive SSH shell and matches nothing — pass `-T` on anything whose output is read, and keep its stderr out of the file being parsed; **a record written before the thing it records is live is a record that lies** — with no migration to apply, the new commit is only deployed once its container is actually up, so write the record after the start, not at the quiesce; **a trap armed half-way down a script reads variables the script may not have assigned yet** — under `set -u` the handler dies instead of recovering, so initialise every input first and install one handler at the top, and clear `errexit` before classifying inside it; **`timeout` bounds the client, not the container** — a killed `docker compose run` leaves the one-off running with its transaction open, so name the container, kill it, wait for it under a bound and reap it before asking the database anything, and bound that question too — **and reap on every non-success, not only on the timeout's exit codes**, because a client that loses its connection to the daemon exits 1 while the container keeps running, and a reconciliation run alongside a live migrator can restart the old image just in time for the migrator to commit the new schema under it; **`ABORT` is PostgreSQL's alias for `ROLLBACK`** — a guard that lists the transaction-control statements by sample rather than taking the group whole will miss one, and one is enough; **`docker compose ps` omits stopped containers** — a completed one-shot is invisible without `--all`, so a correct startup can fail a done-check written against plain `ps`; **a line an application prints on purpose is still a credential when somebody else reads the log** — Loom's first boot prints the Lobby's secret link by design, so a session running `docker compose logs` over SSH puts it in the controller's transcript: redact at the **reader** as well as at the writer, and let a done-check match on the server and print only its verdict; **arm a recovery before the command it recovers from, never after it** — `docker compose stop` can stop the container and still exit non-zero, and a flag set only on success leaves the handler disarmed over a stopped application, so set it first and clear it again only on positive evidence that nothing was stopped; **a comment stripper that does not understand quoting deletes the statement the guard exists to find** — `VALUES ('--')` turns the rest of the line into a comment for any scanner that strips comments as a phase, so a SQL guard must be one stateful pass in which a comment is only a comment in the code state; and **a printed recovery command is only a recovery if it works in the shell that reads it** — a `docker compose …` that relies on the script's own working directory fails in the `/root` shell the operator actually opens, so print `cd <absolute path> && …`, name the environment file, and name every record by its absolute path |
| [ARCHITECTURE.md](../../ARCHITECTURE.md) §10 | A third paragraph: the two root-level profiles are the **standalone** install, `deploy/` is the **beside another Caddy** install, and this is where the shared `web` network and the sites-folder hook are described. The sentence "Migrations run on every boot in `main.ts`" is corrected to name `LOOM_MIGRATE_ON_BOOT` |
| [README.md](../../../README.md) "Running locally" | A short **Deploying beside another Caddy** paragraph pointing at `deploy/` and naming the one command; the existing production paragraph keeps describing the standalone `--profile prod` install |
| [TESTING.md](../../TESTING.md) §1 | The generalised truncate guard (`_test` suffix), the testcontainer's database name, and the sentence about pointing `TEST_DATABASE_URL` somewhere safe (§6). One more sentence in the build-before-test paragraph: `src/server/test/migrate.test.ts` runs the built entry as a child process, so it is one of the suites that needs `pnpm -r build` first (§11.2). And one on the two **package-local** Testcontainers fixtures, `src/core/test/pg-container.ts` and `src/server/test/pg-container.ts`: the migration suites start a Postgres of their own rather than using the shared global-setup database, because they need one with no migrations applied (§11.1, §11.2) |
| [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) | **Rows deleted:** the `mcp/index.ts:111` session-less `GET` 500 (§5.4). **Rows added:** one, and only one — the first-boot Lobby link of the row below; §13 is scope, not defects, so nothing in it becomes a row. **Rows kept, and now depended on:** the `commands/lobby.ts` keeper-cannot-read-the-Lobby row stays deferred exactly as written; §9 step 10 works around it with a `lobby join` and points at it, so the row gains one clause noting that the live-instance runbook is a caller that has to do that |
| [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) and [v2-notes.md](v2-notes.md) — **the first-boot Lobby link** | **One row and one note added, and this is review round 6's F1 follow-up.** `main.ts` prints the Lobby's `/w/<43-character secret>` link unredacted on the boot that creates it — by design, documented in the README, and the only way a first operator learns where the Lobby is. It is also the reason every log read in this slice goes through `redact_logs` (§8.1) and the reason §9 step 4's done-check asserts a shape on the server instead of reading the log. The note records the alternative for a later slice: **gate that one line behind an explicit flag** (`LOOM_PRINT_LOBBY_LINK=1`, say) so the secret is printed only when someone asked for it, and have the unflagged boot print the Lobby's id alone. **It is not this slice's change** — it alters an interface the README documents and a first-run path nothing else has exercised, and redacting at the reader already closes the transcript hole this slice is responsible for. The KNOWN-ISSUES row is the defect statement, the v2-notes entry is the idea with this decision attached |
| [`.gitignore`](../../../.gitignore) | **Five** lines, beside the existing `.env`: `deploy/.deployed-sha`, `deploy/.verified-sha`, `deploy/.deployed-image` and the two atomic-write temporaries `deploy/.deployed-sha.new` and `deploy/.verified-sha.new`. All five are server state written by `live-update.sh`, and an untracked file in the checkout would trip the script's own clean-tree check — including one a killed run left behind, which is why the temporaries are named too (§4, §4.1, §4.5 banners 1 and 3). Five explicit lines rather than a glob, so a reviewer can read what is ignored |
| [v2-notes.md](v2-notes.md) | The "A live Loom instance …" entry becomes **built**, dated, with the hostname, the `deploy/` path and a one-line pointer to this spec; the 2026-09-20 dogfood finding about the session-less `GET` gains its "fixed in PR #N" note |
| [CONTRIBUTING.md](../../../CONTRIBUTING.md) | **A new short section, `## Migrations`, after `## Concurrency conventions`** — this is the one convention this slice does add, in answer to review round 4's F4. Three bullets: **a run is one transaction**, which is what makes a failed migration a no-op and the deployment's recovery possible (§4.5); **so a migration file may not contain a transaction-control statement or a statement PostgreSQL cannot run inside a transaction block** — the list of §5.1, enforced by `assertTransactionSafe`, which `runMigrations` and `migrate --check` both call, and which §11.1 runs over every real file; and **a migration that genuinely needs to be non-transactional is a guarded hand-run deployment**, never an input `live-update.sh` accepts (§13). It is in CONTRIBUTING and not only in the spec because it binds every future migration, and a rule that lives in one slice's design document is a rule the next author will not read |
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

### 11.1 `migrationStatus` and `assertTransactionSafe` — `src/core/test/migration-status.test.ts`

Against a **dedicated Testcontainers Postgres**, not the shared global-setup database: the first
cases need a database with *no* migrations applied at all, and the shared one is migrated once per
run by `freshDb()`. The container comes from **`src/core/test/pg-container.ts`**, this package's own
fixture (§11.2 for why there are two), and the file stops it in `afterAll`. It imports `@loom/core`
and nothing else from this repository; applying is done by core's own `runMigrations`, never by the
server entry. The `assertTransactionSafe` cases (6 and 7) need no database at all and are in this
file because they test the same module.

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
5. **A failing migration leaves the schema unchanged** — the case §4.5 banners 7 and 9 stand on, and
   new in answer to review round 3. Against the same dedicated container, on a **fresh database**,
   `runMigrations` is pointed at a **temporary migrations folder** written by the test: a journal
   with two entries and two `.sql` files, the first valid (`create table t_good (id int)`), the
   second not (`create table t_bad (id int); select nonexistent_function();`, or any statement
   Postgres rejects at execution). The call is expected to **reject**, and then:
   `to_regclass('public.t_good')` is **null** — the good file's table does not exist — and
   `__drizzle_migrations` holds **no row** for either entry. That is the whole claim: drizzle's
   postgres-js migrator runs a whole run's pending files in one transaction (verified in
   `drizzle-orm@0.45.2`'s `pg-core/dialect.js`, the `migrate` method at line 44, whose loop is
   wrapped in `session.transaction` at line 60, implemented as postgres-js `client.begin` in
   `postgres-js/session.js:108`), so the failure rolls the first file back with the second. The
   assertion is deliberately about **rows and tables, not about counts of statements**
   ([HANDBOOK.md](../../HANDBOOK.md) §5), and `to_regclass('drizzle.__drizzle_migrations')` is
   *allowed* to be non-null afterwards, because the migrator creates that schema and table **before**
   the transaction opens (`dialect.js:54-55`). If this case ever fails — a drizzle upgrade that
   moves the loop out of the transaction — then the quiesce still bounds the data loss but the
   rollback promise does not hold, and §4.5 banner 9 must change to require every migration file in
   `src/core/drizzle/` to be a single transaction of its own. The failing test is the signal to go
   and do that; that is why it is a test and not a comment. The *other* way that promise could
   break — a migration file carrying its own `commit` — is no longer left to this test to notice,
   because case 6 refuses it at the source.
6. **`assertTransactionSafe` accepts every real migration file — new in answer to review round 4's
   F4, and this is the case that makes the convention more than a sentence.** The test reads
   **every** file matching `*.sql` under the folder `migrationsFolder()` resolves (today
   `src/core/drizzle/`, five files) and calls `assertTransactionSafe(contents, name)` on each. All
   five pass today, verified by reading them: none contains `BEGIN`, `COMMIT`, `ROLLBACK`, `END` as a
   statement, a `CONCURRENTLY`, a `VACUUM`, an `ALTER SYSTEM` or a `CREATE TYPE`. The case is
   written to **discover** the files rather than to list them, so a migration merged next month is
   covered without anyone remembering to add it here — which is the entire point, since the failure
   this guards against is a future merge, not the present state. It also asserts the folder was
   found and is non-empty, so a resolution bug cannot make the case pass by testing nothing.

   **And the same case proves `runMigrations` actually calls it, and applies nothing when it
   refuses.** Against the dedicated container, on a fresh database, `runMigrations(db, folder)` is
   pointed at a temporary folder — the mechanism case 5 introduced — holding one file with a valid
   `create table t_first (id int)` and a second file carrying a bare `COMMIT;` between two valid
   statements. The call is expected to **reject with the guard's message**, and then
   `to_regclass('public.t_first')` is **null**: the refusal happened over the whole pending set
   *before* anything was applied, not part-way through it, which is the ordering §5.1 specifies and
   the only ordering that is any use. The process-level half of this needs no case of its own —
   `migrate.ts` reports a thrown error through `logError` and exits 1, which §11.2 case 12 already
   asserts as a process contract — and the deployment-level half is `live-update.sh` step 5 running
   `--check`, which §11.6 lists among the mechanisms that are structural rather than tested.
7. **`assertTransactionSafe` rejects each form, and is not fooled by the look-alikes.** Unit cases,
   no database: **one rejection per spelling in §5.1's table**, which is review round 5's F6 as a
   test list — `BEGIN;`, `BEGIN WORK;`, `BEGIN TRANSACTION;`, `START TRANSACTION;`, `COMMIT;`,
   `COMMIT WORK;`, `COMMIT TRANSACTION;`, `END;`, `END WORK;`, `END TRANSACTION;`, `ROLLBACK;`,
   `ROLLBACK WORK;`, `ROLLBACK TRANSACTION;`, **`ABORT;`**, `ROLLBACK TO s1;`,
   `ROLLBACK TO SAVEPOINT s1;`, `SAVEPOINT s1;`, `RELEASE SAVEPOINT s1;`,
   `PREPARE TRANSACTION 'gid';`, `COMMIT PREPARED 'gid';`, `ROLLBACK PREPARED 'gid';`,
   `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;`, `SET TRANSACTION SNAPSHOT '000003A1-1';`,
   `DISCARD ALL;`, `DISCARD PLANS;`, `CREATE INDEX CONCURRENTLY i ON t (c);`,
   `DROP INDEX CONCURRENTLY i;`, `REINDEX INDEX CONCURRENTLY i;`, `VACUUM;`,
   `CREATE DATABASE d;`, `DROP DATABASE d;`, `ALTER SYSTEM SET work_mem = '4MB';`,
   `CREATE TABLESPACE ts LOCATION '/x';` and `ALTER TYPE mood ADD VALUE 'ok';` — each asserted to
   throw with **the file name and the offending keyword in the message**, because that message is
   the whole user interface of this guard. The noise-word spellings are listed rather than assumed
   for the reason §5.1 gives: they pass today because the match is on leading keywords, and a test
   is how that stays true through a rewrite of the matcher. Each is also tried with different casing and with leading
   whitespace and a preceding comment, and once after a `--> statement-breakpoint` marker, since
   that is how a real file would carry it. And the accepted look-alikes, which are what stop the
   guard from being a nuisance: `SELECT CASE WHEN x THEN 1 ELSE 2 END FROM t;`;
   `DO $$ BEGIN RAISE NOTICE 'x'; END $$;`; `-- commit this later` and `/* BEGIN */` as comments;
   `INSERT INTO t (c) VALUES ('commit');` as a string literal; `CREATE INDEX i ON t (c);` without
   `CONCURRENTLY`; and a column or table actually named `"end"` or `"commit"` in double quotes. Each
   of those is asserted **not** to throw. §5.1 states what the scan cannot see; these cases pin what
   it must not falsely see.

   **And the comment-delimiter-inside-a-literal cases, which are review round 6's F4 as a test
   list.** These are the cases the previous phase-ordered scan would have failed, so each is written
   as its own rejection: a file whose statement ends in a quoted form containing a comment opener,
   **immediately followed by a forbidden statement**, must still be refused, naming the file and the
   keyword. Both openers (`--` and `/*`) crossed with all four quoted forms, eight cases:

       INSERT INTO t(c) VALUES ('--'); COMMIT; DROP TABLE events;
       INSERT INTO t(c) VALUES ('/*'); COMMIT; DROP TABLE events;
       ALTER TABLE t RENAME COLUMN "--" TO c; COMMIT; DROP TABLE events;
       ALTER TABLE t RENAME COLUMN "/*" TO c; COMMIT; DROP TABLE events;
       SELECT $$--$$; COMMIT; DROP TABLE events;
       SELECT $$/*$$; COMMIT; DROP TABLE events;
       SELECT $tag$--$tag$; COMMIT; DROP TABLE events;
       SELECT $tag$/*$tag$; COMMIT; DROP TABLE events;

   plus the quoting edges the states exist for, each also immediately before a `COMMIT;` and each
   asserted to be refused: a doubled quote inside a literal (`'it''s --'`), an `E''` literal whose
   backslash escapes a quote (`E'a\'b --'`), a doubled double quote in an identifier (`"a""b --"`),
   and a `$$` appearing **inside** a `$body$ … $body$` run, which must not end the dollar body.
   **Nested block comments get two cases of their own:** `/* outer /* inner */ COMMIT; */ BEGIN;` is
   refused for `BEGIN` and **not** for the `COMMIT`, which the inner `*/` leaves still inside the
   outer comment — a scanner that treated the first `*/` as the end of the comment would see the
   `COMMIT` in code and refuse the wrong keyword, and one that never left the comment would miss the
   `BEGIN`, so the case pins the depth counter in both directions — and `/* a */ COMMIT;` is refused for
   `COMMIT`, which proves a closed comment does not swallow what follows it. The accepted
   counterparts are listed too, so the guard does not simply refuse everything with a quote in it:
   `INSERT INTO t(c) VALUES ('-- commit');` and `SELECT $$ commit; $$;` alone, with no statement
   after them, must **not** throw.

   **And the honesty note is asserted as a comment on the test, not as a case:** these cases pin the
   *lexical* states of §5.1, and passing them does not make the guard a PostgreSQL parser. A `DO`
   block that issues `COMMIT` through `EXECUTE` is still invisible, and §5.1 says so; the test file
   says so too, where the next person to add a case will read it.

   **And one execution case, because the rejection list is only half of F6's ask.** Against the
   dedicated container, on a fresh database, `runMigrations(db, folder)` is pointed at a temporary
   folder — the mechanism case 5 introduced — holding **one** file whose **first** statement is valid
   DDL (`create table t_enclosed (id int);`) and whose **later** statement Postgres rejects at
   execution (`select nonexistent_function();`). The call is expected to **reject**, and then
   `to_regclass('public.t_enclosed')` is **null**: the enclosing transaction held, so the accepted
   file's earlier work went back with the failure. That is the property every recovery branch in
   §4.5 is built on, asserted over a file the guard *accepted* rather than only over one it refused.
   **Then the same file with `ABORT;` inserted between the two statements** is expected to be
   **refused by `assertTransactionSafe` before anything runs** — `to_regclass('public.t_enclosed')`
   is null again, and the rejection names the file and `ABORT` — which is the pair F6 asked for: the
   escape is impossible because the guard refuses it, and the enclosure is real when the guard
   accepts.
**And the one signature change case 5 needs, decided here rather than left to the plan.**
`runMigrations(db)` resolves its folder internally today, so a test cannot give it one. It becomes
`runMigrations(db, folder = migrationsFolder())` — the same helper §5.1 extracts, as the **default**,
so every existing caller (`main.ts`, the migrate entry, `freshDb()`) is unchanged and unaware, and a
test can pass a folder it wrote. The alternative, having the test call drizzle's `migrate()` itself,
would test drizzle rather than the function this repository actually deploys with, which is the
opposite of what case 5 is for.

### 11.2 The migrate entry as a process — `src/server/test/migrate.test.ts`

Also against a **dedicated Postgres**. Each case runs the built entry as a child process, because
the exit code, the stream each line goes to and the fact that the process ends at all are the
contract `live-update.sh` depends on and none of them can be observed by calling a function. The
suite therefore builds the package first, which [TESTING.md](../../TESTING.md) already requires of
the server tests.

**Two package-local fixtures, not one shared helper — and this is round 4's F1, accepted.** The
container setup is **`src/core/test/pg-container.ts`** for §11.1 and
**`src/server/test/pg-container.ts`** for this file. Each is a few lines and each is owned by the
package that uses it:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** A Postgres of this suite's own, with no migrations applied. Stopped by the caller. */
export async function startPgContainer(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer("postgres:17-alpine").withDatabase("loom_test").start();
}
```

**`@testcontainers/postgresql` is already declared where each is used** — checked rather than
assumed: `src/core/package.json` and `src/server/package.json` both list
`"@testcontainers/postgresql": "12.1.0"` in `devDependencies` today, so **neither package.json
needs a change**. `.withDatabase("loom_test")` is the same naming §6 requires of the global setup,
so a suite that reached `freshDb()`'s truncate through one of these containers would meet the same
allow-list rule rather than an exception.

**And the server suite does not import core's test tree, which is what the finding asked for.** An
earlier draft of this section said one helper lived in core and that server's test imported "the
container *recipe*, not a core test file" — a distinction with no mechanism behind it. An
implementer following it would have written `import … from "../../core/test/pg-container.js"`, which
is a second cross-package test dependency added for ten lines of code. To be honest about the
precedent: such an import already exists and works here —`src/server/test/helpers.ts` imports
`../../core/test/helpers.js`, and `src/server/tsconfig.test.json` carries `"rootDir": ".."` with a
comment saying that is why — so the review's structural objection is not a build failure in *this*
repository. It is accepted on the narrower and better ground: the existing cross-package import
earns its keep, because `freshDb()` is a substantial fixture with the truncate guard behind it,
while a `PostgreSqlContainer` constructor call does not. **A shared workspace package was considered
and declined for the same reason**: a `@loom/test-support` package for ten lines would mean a
`package.json`, a `tsconfig.json`, a build step, a `workspace:*` dependency in two packages and a
place for the next person to put things that do not belong there — real machinery, permanently, to
avoid duplicating one constructor call. Two four-line files that can drift apart harmlessly are the
cheaper answer, and if they ever need to agree on something that matters, *that* is the moment to
make a package.

8. **No flag, nothing pending:** prints `migrations: 5 applied, nothing to apply` on stdout,
   exit **0**.
9. **No flag, some pending:** prints the applied count, then `applying:` and each pending tag on its
   own line, applies them, then the `migrations: applied 2 (…)` summary; exit **0**, and the
   database is migrated afterwards.
10. **`--check` applies nothing, and its output has the shape `live-update.sh` parses.** With
   migrations pending it prints the same listing with `pending:` in place of `applying:`, leaves
   `to_regclass('drizzle.__drizzle_migrations')` as it found it, and exits **0** — the convention of
   §5.2, that `--check` answers *what would you do* and is not a gate. With nothing pending it
   prints the nothing-to-apply line and exits 0. **And the shape is asserted, not just the words**
   (new in answer to review round 4's F3): one line of stdout is exactly `pending:`, every line
   after it is a bare journal tag with no decoration, the set of those lines equals the expected
   pending tags, and **nothing follows them**. With nothing pending there is no `pending:` line at
   all. §4.5's `pending_tags` extracts the set with
   `sed -n '/^pending:$/,$p'`, and a reconciliation that misparses is a reconciliation that
   misclassifies, so the contract is pinned here rather than left to the prose of §5.2.

   **And the case pins the extraction itself, in both directions, which is review round 5's F2.**
   The test runs §4.5's `pending_tags` pipeline — those exact three commands, under
   `bash -o pipefail -e` — over the two captured outputs: over the **non-empty** one it must print
   the expected tags, one per line, sorted, and exit **0**; over the **nothing-pending** one it must
   print **nothing** and still exit **0**. The second half is the one that matters and is the reason
   this is a test rather than a reading: the previous pipeline ended in `grep -v '^$'`, which exits 1
   on empty input, and under `set -euo pipefail` that stopped the whole update on the most ordinary
   result there is — a fully migrated database, which is every rerun and the whole of the first
   bootstrap. An extraction whose failure mode is "the update stops after the build, before the
   quiesce, with nothing wrong" has to be pinned at both ends.
11. **An unknown argument exits 2** and prints the usage line to **stderr**, with nothing on stdout
   and no connection attempted — a mistyped invocation must be distinguishable from a failure.
12. **`DATABASE_URL` absent** fails with the same message `loadConfig` already gives, and exits
   **1**.
13. **The process ends on every path.** Each of the cases above is asserted to exit within the
    suite's timeout rather than being killed, which is what proves `closeDb` runs — a migrate
    container that never exits would hang `docker compose run --rm migrate` and therefore hang the
    update, with the lock of §4.5 banner 2 still held.

### 11.3 The boot switch — `src/server/test/config.test.ts` and the server boot suite

14. **Default true.** `loadConfig({ DATABASE_URL: … })` gives `migrateOnBoot: true`; `"true"` and
    `"false"` (in any case, with surrounding whitespace) parse to the obvious values.
15. **Anything else throws** — `"0"`, `"no"`, `""`, `"yes"` — with the variable name in the message.
16. **`false` with migrations pending refuses to start**, with the message of §5.3 naming the count
    and the pending tags, and the process exits non-zero. Against a database migrated to an earlier
    point than the journal (the row-insert trick of case 4).
17. **`false` with nothing pending starts normally** and serves a request — the case that proves the
    refusal is not simply "false never boots".
18. **`true` is unchanged**: a server booted against an unmigrated database migrates it and serves,
    exactly as today.

### 11.4 The MCP guard — `src/server/test/mcp.test.ts`

19. **Session-less `GET /mcp?agent=<key>` answers 400 `{ code: "validation" }`** — with a valid agent
    key, and with `Accept: text/event-stream`, because that is the request the real connector sends.
20. **Session-less `DELETE /mcp` answers 400** the same way.
21. **A session-less `GET` with a revoked key is still 400, not 401** — the guard runs before any
    credential resolution (§5.4).
22. **A bogus `mcp-session-id` is still 404 `not_found`** — the existing case, unchanged.
23. **A full `initialize` over `POST` still works**, and the two concurrent session-less `PUT`
    requests of `mcp.test.ts:95` still get two connect attempts and two 405s — the coverage the
    guard's method list exists to preserve.

### 11.5 The truncate guard — `src/core/test/db-guard.test.ts`

24. **Refused:** a URL whose database is `loom`; one whose database is `spool`; one whose database is
    `loom_live`; one whose database is `postgres`; and an unparseable URL.
25. **Allowed:** `loom_test`; any other `<name>_test`; and the **named testcontainer URL** of §6
    (`.../loom_test`) — replacing the old case that asserted a bare `test` database was allowed.
26. **Not fooled by the name elsewhere in the URL** — `postgres://loom:loom@loom:5432/loom_test` is
    allowed. The existing case, kept.
27. **`fallbackTestUrl` is unchanged** — both existing cases stand.
28. **The whole suite still runs.** Not a test but a verification step the plan must name: after
    `.withDatabase("loom_test")`, `pnpm --workspace-concurrency=1 -r test` passes on the normal
    Testcontainers path *and* on the fallback path. Case 25 would pass while every other test in the
    repository refused to start, which is precisely the failure §6 exists to prevent.

### 11.6 What no unit test covers, said plainly

**All ten files in `deploy/` are verified by the first deployment (§9), by two small shell contract
checks, and by nothing else** — `docker-compose.yml`, `loom.caddy`, `live-update.sh`, the two
wrappers, the two committed texts and the two PowerShell helpers. There is no compose harness in this
repository, no Caddy fixture and no shell-test framework, and inventing one for ten files that run
once per merge against one specific server would be a larger and less honest change than reading
them. The two checks that do exist are the exception that proves the rule: each pins **one line** of
`live-update.sh` whose failure mode is silent and whose behaviour a reading demonstrably missed —
`pending_tags` over an empty result (§11.2 case 10, round 5's F2) and the topology guard against a
diff larger than a pipe buffer (below, round 6's F2). A line that four rounds of reading got wrong is
a line worth six lines of `bash`. The two texts are the easy case —
§9 step 11 refuses to create the Weave if `weave-guidelines.md` is missing or over 4000 characters,
and `prepare-chatgpt-paste.ps1` refuses if `reviewer-brief.md` is missing, which is the only failure
either has. The two helpers are next easiest: each is a dozen lines, each stops on a missing input
before it writes anything, and each has a done-check in §9 step 12 that does not require reading the
secret it handled. What stands in for automation on the rest:

- Every §9 step has a "done when" that checks the thing the previous step claimed to do, and steps 5
  and 8 run the **real** `live-update.sh` rather than its steps by hand — step 5 with `--bootstrap`
  and step 8 without, so that both modes are exercised on the first day.
- **And step 8 runs it through the wrapper, from Paw's PC, which is round 4's F6.** An earlier draft
  ran both steps as the server-side script and still claimed all ten files were verified on the
  first day; `live-update.cmd`, `live-update.ps1`, the `SpoolServer` alias and the exit-code path
  were in fact untouched until the next merge. §9 step 8 is now
  `D:\git\Loom\deploy\live-update.cmd`, with `$LASTEXITCODE` checked, and it is followed by one
  deliberate `live-update.cmd --nonsense` that must print the usage line and leave `$LASTEXITCODE`
  at **2** — argument forwarding and non-zero exit-code forwarding proved in a command that stops
  before the lock and touches nothing. **What is still not exercised on day one:** `--bootstrap`
  *through the wrapper*, because step 5 is deliberately server-side (§9 step 5 gives the reason —
  it is the run with no way back and its evidence is in the server's own shell). That is a one-word
  difference on a path the `--nonsense` run has already proved forwards arguments, and it is named
  here rather than glossed.
- **The local prerequisite is what makes the runbook's own file reads safe** (§9 step 0.2): a clean
  `D:\git\Loom` on `main`, fast-forwarded, `pnpm install --frozen-lockfile && pnpm -r build`, and a
  `Test-Path` over all ten `deploy/` files — before the server is touched, and with that commit's
  SHA becoming the value step 2 requires the server's clone to equal. Nothing tests that the
  runbook's `Get-Content` calls will find their files; this step checks it instead.
- The failure paths that matter are structural rather than tested: `flock -n` on an open descriptor
  cannot let two runs overlap; the `HEAD == refs/remotes/origin/main` assertion cannot pass on a
  dirty or locally-committed tree; the topology guard runs **before** the fast-forward and against
  the recorded deployed SHA, so a refusal leaves the checkout where it was and a retry cannot find
  an empty diff; the guard's match cannot let a compose change that mentions `postgres`,
  `pgdata` or `volumes` reach the dump, the migration or the restart — **and cannot be defeated by
  the size of the diff either, because it is a here-string and not a pipeline** (§4.5 banner 3,
  round 6's F2), which is the one property of it that now has a test of its own below; the
  `docker inspect` mount
  check cannot let a dump be taken from a container that is not bound to `loom_pgdata`; the bounded
  health poll cannot loop forever holding the lock, and cannot reach the migration without a
  `healthy` verdict; a `caddy validate` that fails stops the run before the database is touched, and
  the mode-600 two-variable env file cannot hand that container a secret it does not need, while
  `sed -n`'s zero exit cannot turn a missing optional key into a stopped update; the dump's
  `mktemp` + `mv` cannot leave a partial file under a name that looks like a backup; **Loom is
  stopped across the dump and the migration, so there is no window in which a write can be accepted
  and then lost**; `set -Eeuo pipefail` plus `docker compose run --rm`'s exit code cannot skip a
  failed migration, and a hung migrator cannot hold the quiesce indefinitely, because the one-off
  runs under `timeout --signal=TERM --kill-after=30 600` **with a name**, so the script kills the
  container itself, waits for it under a bound and collects its logs rather than bounding only its
  own client (§4.5 banner 9), and because R4's status read is bounded at 120 s and routes to R9
  rather than hanging; **a surviving one-off cannot be behind the reconciliation, because
  `reap_oneoff` runs on *every* non-success of the migrator and inside `read_status` on every failed
  status read, not only on `timeout`'s 124 and 137** (round 6's F3); **the quiesce cannot be torn,
  because `QUIESCED=1` is set before `docker compose stop` and is cleared again only when
  `docker inspect` positively answers `true`** (round 6's F5); **no log this script prints can carry
  a credential into the controller's transcript, because every one of them goes through
  `redact_logs`** (round 6's F1); a migration file
  carrying a transaction-control statement cannot reach the quiesce at all, because step 5's
  `--check` runs `assertTransactionSafe` over the pending set while Loom is still serving; the one
  `EXIT` handler — installed at the **top** of the script, after every recovery input has been
  assigned, so no `set -u` read can abort it, and inert until `QUIESCED=1` — cannot leave Loom
  stopped **except** on the one branch that decides to (R9), because every path out of banners 7 to
  10 runs through it and `STARTED=1` is the only thing that disarms it; the classification inside it
  cannot be cut short by `errexit`, because the handler clears it before classifying; the recovery cannot *assume* a rollback, because it re-reads the
  migration status and compares it with the set recorded in step 5, and it cannot combine the old
  image with the new compose definition, because its first choice is `docker start` on the exact
  container `docker compose stop` left in place; the per-commit `image:` tag cannot be overwritten in
  a way that matters, because a container holds its image by id and the old id is recorded before
  the build; `deploy/.deployed-sha` is written atomically and only when the image **and** the schema are
  a fact — the instant the migrator exits 0, or, when nothing was pending, only after `up -d loom`
  has started the new image — so it cannot name a commit that is not what is serving, and
  `deploy/.verified-sha` is read by no mechanism,
  so a failing public check cannot misdirect anything; `cmp` makes the Caddy install idempotent; the
  `.prev` restore cannot leave an unbootable sites folder behind a failed reload;
  `${LOOM_DB_PASSWORD:?…}` cannot default; `-p loom` on every command cannot be outranked by the
  caller's directory or environment, and the script refuses to start at all if
  `COMPOSE_PROJECT_NAME` is set; `--env-file` on every Spool command cannot be defeated by the
  directory the caller is in; and both health checks read a route that touches the database.
- **What is structural but one-sided, said rather than implied.** The reconciliation of §4.5's
  recovery procedure is only as good as `migrate --check`'s output shape, which is why §11.2 case 10
  asserts that shape and not merely its words. And R7 and R9 — the "committed but unacknowledged"
  and "cannot tell" branches — are reachable only by a torn connection or a partial apply, so
  **neither is exercised by anything before the day it happens**. They are written as a numbered
  procedure, with the exact commands and the exact message, for precisely that reason: the first
  person to meet them will be reading, not reasoning.
- The **second** time the script runs — §9 step 8, and then the first real merge after this slice —
  is when idempotence is actually observed. That run is recorded in v2-notes as a dogfood note,
  whatever it shows.
- **The recovery's R2/R6 branch gets a deployment check of its own — a numbered step of the plan,
  run once on the first day — and round 4 changed what that check is.** §11.1 case 5 proves the
  *schema* half of §4.5 banner 9: a failed migration changes nothing. Nothing above proves the
  *container* half — that the container `docker compose stop` left behind really does come back with
  the code it was created from. It cannot be proved through the whole script without merging a
  broken migration to `main` (and a broken migration made *locally* on the server would be caught
  two steps earlier by the `HEAD == origin/main` check, which is the right behaviour and the reason
  this check is piecewise). So the two commands the recovery is actually made of are run by hand, on
  the server, in `~/git/Loom/deploy`, after §9 step 8:

      docker start loom-loom-1 >/dev/null && docker inspect -f '{{.Image}}' loom-loom-1   # note the id
      docker compose -p loom stop loom
      docker start loom-loom-1

  *Checked:* `curl -fsS http://127.0.0.1:3100/api/guidelines` answers 200 within a few seconds;
  `docker inspect -f '{{.Config.Image}}' loom-loom-1` prints
  `loom-live:<the content of .deployed-sha>`; and `docker inspect -f '{{.Image}}' loom-loom-1`
  prints **the same image id as before the stop**, which is the property F5 turns on — the container
  came back as itself, not as a reconstruction. It costs a deliberate 502 of a few seconds, which is
  why it is done once, on the first day, on an instance with one conversation in it — rather than
  discovered during a real failed migration. **The R10 last resort is deliberately not rehearsed**:
  proving it would mean deleting the container, and the only thing it adds over R2 is a `docker tag`
  and a warning. Its result is recorded in v2-notes with the other dogfood notes.
- **And the pending-migration-plus-failed-dump path is a by-hand check of its own, on the first
  day, which is review round 5's F4.** The rehearsal above proves the recovery's *commands*; it does
  not prove that the handler survives the path F4 broke — a real pending migration and a dump that
  then fails, where the old design read `MIGRATE_STATE` before anything had assigned it and the
  handler died under `set -u` with Loom stopped. It is staged in two reversible commands, after §9
  step 8 and before §9 step 10 mints any key, when the database holds nothing but the Lobby:

      # 1. note the newest journal row, then remove it, so one tag is genuinely pending
      docker compose -p loom exec -T postgres psql -U loom -d loom -Atc         "select hash||'|'||created_at from drizzle.__drizzle_migrations order by created_at desc limit 1"
      docker compose -p loom exec -T postgres psql -U loom -d loom -c         "delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)"
      # 2. make the dump fail: a file where the backup directory must be
      mv ~/backups/loom ~/backups/loom.bak && : > ~/backups/loom
      ~/git/Loom/deploy/live-update.sh --bootstrap ; echo "exit=$?"

  *Checked:* the run prints the pending tag, stops `loom`, fails at `install -d`, and then — from the
  handler, not from any step — prints `no migration ran; restarted loom-loom-1`; `exit=` is
  **non-zero**; `curl -fsS http://127.0.0.1:3100/api/guidelines` answers 200 within a few seconds;
  `cat ~/git/Loom/deploy/.deployed-sha` is **unchanged**; and no `MANUAL RECOVERY REQUIRED` line was
  printed, because R2 — not R4 — is the branch a dump failure takes. Then it is undone in two
  commands: `rm ~/backups/loom && mv ~/backups/loom.bak ~/backups/loom`, and the noted row is put
  back with `insert into drizzle.__drizzle_migrations (hash, created_at) values ('<hash>', <when>)`
  — re-inserting the row rather than letting the next run re-apply the file, because the file's
  `create table` is not written to be applied twice. If anything about it goes wrong, the first day's
  escape is the one §9 step 5 already licenses: `docker compose -p loom down -v` and §9 step 4 again.
  It is done **once**, on the first day, for the same reason the R2/R6 rehearsal is.
- **Two shell contract checks that need no server, no Docker and no deployment — review round 6's F2
  and the pattern §11.2 case 10 already set.** They belong to the plan task that writes
  `live-update.sh`, run in a local `bash`, and each is a few lines because each pins one line of the
  script.

  The first is the topology guard against a diff **larger than the pipe buffer**, which is the shape
  that made round 5's `printf … | grep -Eq` version unsafe:

      TOPO="$(printf '+  postgres:\n'; printf 'y\n%.0s' $(seq 1 600000))"   # 1.2 MB, match on line 1
      if grep -Eq 'postgres|pgdata|volumes' <<<"$TOPO"; then echo refused; else echo "WAVED THROUGH"; fi
      set +e; printf '%s\n' "$TOPO" | grep -Eq 'postgres|pgdata|volumes'; echo "pipeline status=$?"

  *Checked:* under `set -Eeuo pipefail`, the here-string form prints `refused`, and the pipeline form
  beside it reports **141** — `SIGPIPE` — on the very same input, which is what the `if` in round 5's
  draft would have treated as "no topology change". Both halves are run, because a check that only
  proves the new form works does not show what it replaced. The match is on the first line and more
  than a megabyte of input sits behind it, which is the shape that makes the difference: with a small
  diff both forms answer identically, which is why four rounds of reading did not catch it. The second
  check is §11.2 case 10's, already specified: `pending_tags` over an empty and a non-empty `--check`
  output.
- **The torn stop is rehearsed by hand on the first day — round 6's F5 — and both directions are, in
  two runs.** Neither can be staged by waiting for Docker to lose an acknowledgement, so the
  acknowledgement is what the rehearsal fakes: a stub earlier on `PATH` that forwards every `docker`
  command through and lies about exactly one of them. On the server, after the two rehearsals above
  and still before §9 step 10 mints any key, so that the database holds nothing but the Lobby — and `command -v docker` is checked to be `/usr/bin/docker` first, because that path is
  hard-coded in the stub and a stub that cannot find the real client would fail the run for the wrong
  reason:

      install -d -m 755 /tmp/stub
      printf '%s\n' '#!/bin/sh' \
        'case " $* " in' \
        '  *" compose -p loom stop loom "*) /usr/bin/docker "$@"; exit 1 ;;' \
        'esac' \
        'exec /usr/bin/docker "$@"' > /tmp/stub/docker
      chmod 755 /tmp/stub/docker
      PATH=/tmp/stub:$PATH ~/git/Loom/deploy/live-update.sh --bootstrap ; echo "exit=$?"

  The stub is written with `printf` rather than a heredoc on purpose: a heredoc pasted out of an
  indented block has its terminator indented too, and an unterminated heredoc in a root shell is a
  confusing way to start a rehearsal. The stub's one lie is on the third line — it runs the real
  `docker compose -p loom stop loom` and *then* exits 1 — and every other `docker` command the script
  makes is passed straight through.

  *Checked (the stop really happened):* the run prints that the stop reported failure and that
  `loom-loom-1` is not running so the quiesce stands, then — **from the handler** — `no migration
  ran; restarted loom-loom-1`; `exit=` is non-zero; `curl -fsS
  http://127.0.0.1:3100/api/guidelines` answers 200 within a few seconds; `.deployed-sha` is
  unchanged; and no `MANUAL RECOVERY REQUIRED` line was printed. That is the case the previous draft
  got wrong, where `QUIESCED=0` sent `recover` home on its first line and left Loom down with no
  message.

  Then the other direction, with the pass-through removed from that one line so the container is
  **not** stopped — `*" compose -p loom stop loom "*) exit 1 ;;` — and the script run again.
  *Checked:* the run says the stop failed and `loom-loom-1` is still running, `exit=` is non-zero,
  **no** restart line is printed because there was nothing to restart, and `curl` answers 200
  throughout, from the same container id as before the run — `docker inspect -f '{{.Image}}'
  loom-loom-1` unchanged. That is the only branch allowed to clear `QUIESCED`, and it is allowed to
  because the container is demonstrably still serving. Undone with `rm -rf /tmp/stub`, which is the
  whole of the cleanup: nothing else was touched, and the stub was never on root's own `PATH`.
- The one mechanism nothing at all exercises before the day is the **reload-failure restore** of
  §4.5 banner 12: it needs a `loom.caddy` that validates in the staged check and is then refused by the
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
  `~/.loom/config.json` already relies on for every per-Weave token the CLI stores. **Eight files,
  inventoried row by row in §8.1** with what each holds and who can read it — among them `live.env`,
  the only copy of the server's `.env` off the server, and `live-config.json`, which is the CLI's own
  store for the live Weave's participant token. One of the eight, `live-chatgpt-paste.md`, is
  **deleted** as a numbered sub-step of §9 step 12, with Paw's clipboard cleared in the same breath;
  the rest are kept because a later command needs them. No `icacls` call is needed and none is
  specified; if that folder ever moved outside the profile, this line would have to change with it.
  The two helpers of §4.7 resolve that folder as `$env:USERPROFILE\.loom`, which **is**
  `C:\Users\paw\.loom` on Paw's PC — derived rather than hard-coded, so a committed script does not
  carry one machine's user name, and the protection is still the profile's own ACL.
- **The credential guarantee, in the words it holds in:** a credential never enters the
  controller's transcript — the Claude Code conversation — it moves by file, by `scp` or on Paw's
  own clipboard (§8.1). It is stated that narrowly on purpose: §9 step 12 has Paw paste the Weave's
  secret into the ChatGPT session, so a broader claim would be one the runbook breaks, and §14.5
  names the residue and the route that retires it.
- **The live CLI has its own config file.** Every live command sets
  `LOOM_CONFIG=C:\Users\paw\.loom\live-config.json`, so the live instance's per-Weave tokens are
  stored apart from the dev server's `~/.loom/config.json` and a `--weave`-less command cannot
  address the wrong instance's Weave.
- **The disposable Caddy is given two strings, not Spool's environment.** `live-update.sh` step 3
  and §9 step 1 validate Caddy's configuration in a throwaway `caddy:2-alpine` container, and an
  earlier draft handed it `--env-file ~/git/Spool/deploy/.env` — the whole file, which carries
  Spool's `DB_PASSWORD` and `COMPOSE_PROJECT_NAME` today and whatever payment, shipping, mail or AI
  keys the shop comes to hold tomorrow. A mutable third-party image with outbound network access
  needs none of it. Both validations now write a **mode-600 temporary file holding `SITE_ADDRESS`
  and `REDIRECT_ADDRESSES` only**, extracted with `sed -n 's/^KEY=//p' … | tail -1` — which exits 0
  on no match, so the documented defaults can actually be applied under `set -euo pipefail`, where
  the earlier `grep -E` form would have stopped the run instead — defaulted to the same values
  Spool's compose file defaults them to, and removed by the cleanup trap however the script exits.
  Nothing in this slice reads or echoes Spool's `.env` beyond those two `sed`s, and their output
  goes into a file rather than onto a terminal. The file's *existence* is required separately, with
  its own message, because a missing `.env` is a box that is not in the state this spec describes.
- **Postgres publishes nothing.** It is reachable from `migrate` and `loom` on the project's default
  network and from `docker compose -p loom exec`, and from nowhere else. It is deliberately **not**
  on the `web` network, so nothing that Caddy can reach can reach the database.
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
- **Every log this slice reads is redacted at the reader, and one log is not read at all.** The
  writer-side redaction above covers Loom's own structured logs and nothing else: `main.ts` prints
  the Lobby's `/w/<43-character secret>` link in full on the boot that creates the Lobby (by design,
  and documented), and Caddy's access log carries `?agent=<key>` query strings. Both are read over
  root SSH by a session whose conversation is a record, so **every** log read in this slice goes
  through `redact_logs` — the `sed` of §8.1, the same three lines in `live-update.sh`'s six log reads
  (§4.5 banner 1) and in §9 steps 5 and 7. §9 step 4's done-check, which is the one that runs
  against the creating boot, does not read a log at all: it matches on the server and prints
  `lobby creation log: ok`. Nor does §9 step 12's, which counts 500s on the server. What this does not do is change what Loom prints — §10 carries that as a
  follow-up note with the reason it is a later decision.
- **Backups are secret-bearing**, on the same reasoning Spool's ROLLOUT.md gives for its dumps: a
  Loom dump contains `agents.key_hash`, `keepers`, every Weave secret and every participant token.
  They live under `~/backups/loom`, a directory created `install -d -m 700` and written under
  `umask 077`, root-only, on the server, and are never copied off it by anything in this slice.
  A dump is written to a dot-prefixed temporary name in that same directory and renamed into place
  only after the whole `pg_dump | gzip` pipeline succeeded, so a file named `loom-pre-update-*.sql.gz`
  is always a complete backup and a failed run leaves nothing behind (§4.5 banner 8). The dump is
  taken from a container the script has just asserted is bound to `loom_pgdata`, immediately before
  the migration rather than before the build, and **with Loom stopped** — so what a restore gives
  back is not merely the database as it was seconds before the change, it is the database as it was
  at the last moment anything could have written to it. That is the whole reason the quiesce is in
  the script (§4.5 banner 7): without it the dump is a snapshot with a live tail, and a restore
  silently discards whatever was accepted in the tail. Retention, rotation and encrypted off-server
  copies are §13.
- **The two onboarding helpers read secrets and print none.** `deploy/prepare-chatgpt-paste.ps1`
  moves the Weave secret from `live-weave.json` into `live-chatgpt-paste.md` with **empty stdout**,
  which is what makes it safe for the session to run; `deploy/connector-url-to-clipboard.ps1` puts
  the agent-key URL on Paw's clipboard and prints one fixed line that contains no credential (§4.7).
  Neither takes a secret as an argument, so neither can leave one in a shell history or a process
  list. Both are committed and reviewed, which is the point: the alternative was a session
  improvising a command around a secret at the moment it was needed.

## 13. What this does not promise

Each with the reason it is out, so that a later slice can pick it up without re-litigating.

- **No zero-downtime update. Downtime of seconds per update is accepted; zero downtime is not
  promised.** Every run stops Loom before the dump and starts it after the migration (§4.5 banner 7),
  so for the length of a dump, a migration and a container start — well under a minute on this
  database — `https://loom.3dbox.dk` answers 502 from Caddy, the web client's stream drops and the
  reviewer's next poll fails. **The worst case is bounded rather than typical, and the bound now
  includes the migrator's kill grace and the reaps:** 60 s for Postgres to come healthy, 600 s for
  the migrator plus the 30 s `--kill-after` grace, up to 70 s to reap its container (a 10 s stop and
  a 60 s `docker wait`), a further 120 s for the recovery's one status read, and up to 70 s to reap
  *that* container if it too had to be killed — so the arithmetic ceiling of an outage is about
  **sixteen minutes**, after which Loom is either serving again or R9 has printed why it is not
  (§4.5 banners 8, 9 and the recovery procedure, §14.7). Round 6's F3 added the two reap terms by
  making the reap unconditional; every term is a constant a reader can find in the listing. That is chosen, not tolerated: the alternative is a dump with a live
  tail, which makes the backup a lie and makes "the previous image is still serving" a promise about
  a database that has moved. A rolling update would need two Loom containers, a schema compatible
  with both binaries at once and something in front of them making the switch — three things this
  slice would have to invent for an instance whose users are one reviewer, one session and Paw. The
  reviewer's own poll cadence (five minutes, ChatGPT-side) is longer than the outage, which is the
  practical reason this costs nothing today.
- **Nothing prunes old images.** Every update builds `loom-live:<short SHA>` and leaves every
  earlier tag on disk, deliberately: the image the recovery may have to start *is* one of them
  (§4.5's recovery procedure), so deleting it as part of an update would delete the only thing that
  path can use. Nothing measures how much they take, either, and the disk is shared with the shop
  (§14.3) — so the first person who needs the space runs `docker image prune`, by hand, knowing
  that the tag named in `deploy/.deployed-sha` is the one that must survive, and that
  `docker image prune` without `-a` will not remove a tagged image at all. Automatic retention,
  here as for the dumps, is a later slice with a policy question in it.
- **Neither SHA record is a deployment ledger, and the two are not interchangeable.** Each holds one
  short SHA and keeps no history: there is no list of what was deployed when, and a deployment
  history is what the git log and the PR record already are. What each one means is exact and is the
  whole of round 4's F2. `deploy/.deployed-sha` is **the commit whose image and schema are active** —
  written atomically at one of two moments and **never at the quiesce**, which is round 5's F3: the
  instant the migrator exits 0, before Loom is started, when there was something to apply; and only
  after `up -d loom` has started the new image, when there was not — because until the new image is
  up the commit whose image is serving is still the old one, and a record that ran ahead of it would
  send the next run's recovery at an image the record only *expected* to be live. Read by the
  topology guard and the recovery. `deploy/.verified-sha`
  is **the last commit that answered the public health check** — written last, read by nobody but a
  human and §9's done-checks. So a run that fails after its migration committed leaves
  `.deployed-sha` on the new commit (correct: that is what is live) and `.verified-sha` on the old
  one (correct: this run never proved the public path), and neither file is lying. **What is not
  promised:** nothing reconciles the two if someone edits them, nothing warns when they disagree for
  a long time, and a `--bootstrap` run writes no `.verified-sha` at all.

- **No scheduled backups, no retention and no rotation.** `live-update.sh` takes one dump
  immediately before it migrates, which is the moment a dump is actually wanted. Nothing takes a
  daily one, nothing prunes `~/backups/loom`, and nothing copies a dump off the box. A dump is
  secret-bearing (§12), so an off-server copy needs encryption to a key that is not in the dump, and
  that is a decision with a key-custody question in it — a slice of its own, next to Spool's, whose
  ROLLOUT.md already states the shape.
- **`live-update.sh` does not deploy a database topology change.** If a merge touches Postgres's
  service definition or the compose file's `volumes:` block, the script stops at §4.5 banner 3 having
  done nothing — **including not having moved the checkout**, so the same refusal meets every retry
  rather than only the first attempt — and the deployment is **a hand-run one in §9's shape**: a human decides which volume
  holds the data, dumps it, brings the new definition up and migrates. The guard is a `grep` on the
  diff — against a **here-string**, so no amount of diff can make it miss a match through a broken
  pipe (§4.5 banner 3, round 6's F2) — and not a parser, so it also stops on a comment edit near the
  `postgres` service — over-
  triggering on purpose, because being stopped costs one manual deployment and being wrong costs the
  event log. Nothing automates the manual path, and nothing has rehearsed it (§14.6).
- **`live-update.sh` does not deploy a non-transactional migration, and will not be made to.** This
  is round 4's F4 stated as scope. A migration file that carries a transaction-control statement, or
  a statement PostgreSQL cannot run inside a transaction block, is refused by
  `assertTransactionSafe` (§5.1) — in `runMigrations`, so the boot path refuses it too, and in
  `migrate --check`, so step 5 of the update refuses it **while Loom is still serving**, before the
  quiesce and before the dump. There is no flag to override it and none will be added: the whole
  recovery design of §4.5 is built on a run being one transaction, and a switch that lets a caller
  turn that off is a switch that turns the recovery into a guess. **So a migration that genuinely
  needs to be non-transactional — a `CREATE INDEX CONCURRENTLY` on a table that has grown, say — is
  a guarded hand-run deployment**, in §9's shape: a human stops Loom, takes a dump, applies the
  statement themselves with the dump in reach, writes the commit they deployed into
  `/root/git/Loom/deploy/.deployed-sha`, and starts Loom. Nothing automates that path either, and nothing has rehearsed it — the
  same honest statement §14.6 makes about the topology guard, and for the same reason: it is a case
  nobody has met yet and automating a guess at it is worse than writing the refusal down.
- **The recovery can decide to leave Loom stopped, and that is a promise about correctness, not
  availability.** The classification of §4.5's recovery procedure reaches R9 — Loom **down**, a
  printed manual-recovery message, non-zero exit — whenever the migration status cannot be read or
  shows a partially-applied run. That is deliberate: starting either binary against a schema nobody
  can characterise risks writes against a shape the code does not understand, and that costs the
  event log rather than a minute of uptime. What this does *not* promise is that a human is told:
  nothing pages anyone, so an R9 outage lasts until whoever ran the update reads its output, or
  until someone tries to use Loom (§13's monitoring bullet).
- **The wait for Postgres is bounded and the bound is not tunable.** Sixty seconds, polled once a
  second (§4.5 banner 8). A database that needs longer than that to come healthy — a very large
  volume replaying WAL, say — fails the update rather than waiting, and the answer then is a hand
  deployment, not a flag. There is no `--timeout`, because one flag on one script invites a second
  and the honest bound is a number a reader can see.
- **The update lock excludes other `live-update.sh` runs and nothing else.**
  `/run/lock/loom-live-update.lock` is a host lock taken by that one script, so two overlapping
  updates cannot happen (§4.5 banner 2). Nothing stops someone with root SSH from running
  `docker compose build`, `docker compose run --rm migrate`, `docker compose up -d` or a `pg_dump`
  by hand *while* an update holds the lock — the lock is a convention between runs of one script,
  not a mechanism in Docker. It is also per-host: it says nothing about a second machine, and there
  is no second machine.
- **The public health check needs DNS, a certificate and the shop's Caddy to be up**, and it is
  therefore a check on more than Loom. A `curl https://loom.3dbox.dk/api/guidelines` that fails
  because DanDomain's DNS is answering slowly, or because Caddy is mid-reload for an unrelated host,
  fails the update — and that is the trade taken deliberately, because the alternative is an update
  that goes green while every visitor gets a 502 (§4.5 banner 13). The escape hatch is `--bootstrap`,
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
  ROLLOUT.md is right that an untested restore is a guess, and proving Loom's is its own step. What
  narrows the reliance on it: the ordinary bad day — a migration that fails — does **not** need the
  dump at all, because the run's migrations roll back as one transaction and the script restarts the
  container it stopped (§4.5's recovery procedure, R6, and §11.1 case 5). The dump is for the day something worse happens, and
  that day has not been rehearsed.
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
- **No IPv6, and §9 step 6 is what makes that statement true of the host rather than only of Loom.**
  The A record is the only DNS this slice asks for; no AAAA, and nothing in the compose files or the
  site block configures one. **So the host must not publish one either** — an inherited, wildcard or
  stale `AAAA` would send IPv6-capable clients and ACME's validator to an address nothing here
  serves, while the A-record check passed. §8 item 1 therefore tells Paw to remove any `AAAA` or
  `CNAME` for `loom`, and §9 step 6's done-check requires `dig +short A` to be exactly
  `89.167.47.120`, `dig +short AAAA` to be empty and `dig +short CNAME` to be empty. That is round
  4's F7, and it turns a decision into a check.
- **No `docker compose down` path, and no rollback script for a deployment that *succeeded*.** The
  only recovery the script performs is the narrow one after a failed migration, and it is now a
  classification rather than a fixed command: it restarts the exact container it stopped when the
  migration rolled back, starts the new image when the migration in fact committed, and leaves Loom
  down when it cannot tell (§4.5's recovery procedure). Undoing a deployment that **completed** is a
  different problem and stays manual, and the command is written the way §4.5's `manual_recovery`
  prints its own — absolute, with the environment file named, so it works in the shell the operator
  actually opens (round 6's F6):

      cd /root/git/Loom/deploy && LOOM_IMAGE_TAG=<older short SHA> \
        docker compose -p loom --env-file /root/git/Loom/deploy/.env up -d --no-build loom

  That puts an older image back — the per-commit tags make it one command — but if the update applied
  a migration, the older binary may not be able to read the schema, and going back **across** a
  migration needs the dump. Restoring a dump is a hand-run operation with a human deciding, not a
  script. Saying so is more useful than a script nobody has run. Whoever does it must also write the
  commit they landed on into `/root/git/Loom/deploy/.deployed-sha`, because that file is what the next
  run's topology guard and recovery believe.

## 14. Deliberate risks, named

Eight, because each one is a thing that could go wrong on the day and each has an answer that is
better written down now than discovered then.

1. **Loom shares the shop's front door.** A Loom site block that Caddy refuses would, on a reload,
   be rejected as a whole configuration — Caddy keeps the previous one — so the shop stays up; but a
   reload is a reload, and it restarts certificate management for every host in the file. That is
   why the proposed configuration is validated in a **disposable** container before anything is
   installed and before the database is touched (§4.5 banner 4, §9 step 1), why the install is
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
   local file (`live-chatgpt-paste.md`) and in the ChatGPT conversation. The guarantee §8.1 states
   is the one that holds — **a credential never enters the controller's transcript; it moves by
   file, by `scp` or on Paw's own clipboard** — and this is precisely its edge: "not in the
   controller's transcript" is not the same as "nowhere". Three things bound it. The paste file is
   **deleted and the clipboard cleared** as a numbered sub-step of step 12, with
   `Test-Path … live-chatgpt-paste.md` in the done-check, so the local copy's life is one sitting.
   It happens **once**: after ChatGPT stands in the live Lobby, the invitation route (Lobby join,
   keeper `invite-weave`, `join_weave({ inviteId })`) moves no secret at all, and it is the route
   every later Weave uses. And if the secret is ever believed to have leaked, the answer is a new
   Weave rather than a rotation, because a Weave's secret is its identity. What is *not* bounded is
   the ChatGPT conversation itself: the secret stays in that transcript for as long as the
   conversation does, which is the price of the shortest first run and the reason the invitation
   route takes over.
6. **The topology guard makes a rare merge into a manual deployment, and the manual path is
   unrehearsed.** §4.5 banner 3 stops the update whenever the compose diff mentions `postgres`,
   `pgdata` or `volumes` — which is the right refusal, because the script's dump is written in terms
   of `loom_pgdata` and `loom-postgres-1` and cannot reason about a volume it was not told about.
   Two costs follow, both accepted. The guard **over-triggers**: a comment edit or a bumped Postgres
   tag stops a deployment that would have been fine, and the operator's answer is to read the diff
   and deploy by hand, which is one afternoon's annoyance against the alternative of a dumped empty
   database. And the hand-run path itself has **never been run** — §9 is the only deployment shape
   anyone will have exercised, and a topology change would be someone reading §9 and §4.5 side by
   side at the moment they least want to. Writing the refusal down, with the message the script
   prints, is what makes that reading possible; automating a case nobody has met yet would be
   guessing at it. What *is* now certain is that the refusal survives a retry: the comparison is
   made before the checkout moves and against the recorded deployed SHA (§4.5 banner 3), so running
   the same command again gets the same refusal instead of proceeding on a topology the script had
   just called unsafe.
7. **The quiesce makes every update a short outage, and it puts the instance's availability in one
   `trap`.** From §4.5 banner 7 to banner 10 Loom is stopped: the public hostname answers 502, and
   anything that fails in between — Postgres not coming healthy, a failed `pg_dump`, a failed
   migration, a `set -e` death — would leave it stopped if nothing restarted it. The answer is the
   **single `EXIT` handler installed at the top of the script**, whose recovery does nothing until
   the quiesce sets `QUIESCED=1` and nothing again once `STARTED=1`; it runs the recovery procedure
   of §4.5 and reaches a `docker start` of the exact stopped container, a start of the new image, or
   a printed refusal — and it says **loom is DOWN** in as many words when it cannot recover. **Round
   5's F4 is why it is at the top rather than armed at the quiesce**: every variable it reads is
   assigned before it is installed, so `set -u` cannot abort the handler and leave Loom stopped with
   no message, and it clears `errexit` before classifying, so a `docker` call that is *expected* to
   fail cannot cut the recovery short. **And round 6's F5 is why `QUIESCED=1` is set *before*
   `docker compose stop` rather than after it**: the stop can succeed and the client still exit
   non-zero — a lost acknowledgement, a dropped connection, a `Ctrl-C` in the gap — and a flag armed
   only on success meant the handler returned on its first line over a stopped Loom, with no restart
   and no message. It is cleared again only when `docker inspect` positively answers that the
   container is still running, which is the one case where nothing needs starting; §11.6 rehearses
   both directions with a `docker` stub. Four things are accepted with it. The outage is real and is stated as a promise not made (§13): seconds per
   update, longer if the dump grows, and nobody is told about it except whoever is watching. The
   recovery depends on the stopped container still being there — which `docker compose stop`
   guarantees and `docker compose down` beside the script would not — and on its image still being
   on disk, which is why nothing prunes images and why §11.6 proves that exact restart once by hand
   on the first day, image id and all — and, since round 5, so is the pending-migration-plus-failed-
   dump path, which is the one F4 broke (§11.6) — and, since round 6, the **torn stop** in both its
   directions, with a stub that makes `docker compose stop` lie. **And the outage the handler can hold
   is bounded but not short:** 60 s of Postgres wait, 600 s of migrator plus a 30 s kill grace, up to
   70 s per reap for two reaps, and 120 s of status read — about **sixteen** minutes in the arithmetic
   worst case, which §13's first bullet now states rather than leaving to "well under a minute". And the very first deployment has no previous container at
   all, so a failure there leaves the instance down until someone runs §9 step 4 again — acceptable
   only because at that moment the database holds nothing but an empty schema, which is exactly the
   window §9 step 5's text says it is.
8. **A migrator failure is classified, not assumed — and the classification has its own failure
   mode, which is Loom left down on purpose.** This is the risk round 4's F3 introduced along with
   its fix, and it is worth naming rather than filing as solved. The script no longer says "the
   migrator failed, therefore nothing was applied"; it records the pending set before migrating
   (§4.5 banner 6) and re-reads the status afterwards, and it acts on the comparison (R4–R9). Four
   things are accepted with that. **The classification can itself fail to get an answer** — a
   Postgres that has gone away, or a still-open transaction from a migrator whose client was killed,
   takes R4's `--check` down with it — and the answer then is R9: Loom stays stopped with a message
   naming both records, both candidate commands and the dump's path — each of them, since round 6's
   F6, a command that works in the `/root` shell the reader actually opens rather than in the
   script's own directory. **That read is bounded at 120 s
   and the migrator's own container is killed and reaped before it runs, which is round 5's F5:**
   the previous design bounded only the local `docker compose run` client, so the one-off could keep
   its transaction open while an unbounded status read queued behind it — Loom stopped, the lock
   held, and every later operator told only that another update was running. **Round 6's F3 is the
   rest of that:** the reap ran only on `timeout`'s 124 and 137, so an ordinary client failure — a
   lost daemon connection, an interrupt — left the migrator alive *and* skipped straight to the
   classification, where a status read can honestly report every tag still pending because the
   transaction has not committed **yet**, R6 restarts the old image, and the surviving migrator
   commits the new schema underneath it. `reap_oneoff` now runs on every non-success of the migrator
   and inside every failed `read_status`, so nothing is classified while a migrator is alive.
   That is chosen over guessing, for the reason §13 states: a Loom serving against a schema nobody
   has characterised costs the event log, and a 502 costs an afternoon. **R7 and R9 are unexercised**
   before the day they happen (§11.6) — they need a torn connection or a partial apply, neither of
   which can be staged cheaply on this box — which is why they are written as numbered steps with
   their exact commands. **The comparison depends on `migrate --check`'s output shape**, which is
   therefore a contract in §5.2 and an assertion in §11.2 case 10 rather than a convention. And
   **R8's partial-apply case should now be unreachable**, because `assertTransactionSafe` refuses the
   files that could produce it (§5.1) — but it is implemented anyway, and it routes to R9, because
   "should be unreachable" is exactly the reasoning that produced this finding in the first place.
