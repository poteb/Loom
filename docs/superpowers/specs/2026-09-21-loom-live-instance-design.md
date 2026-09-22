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
   schema is exactly as it was, the script **restarts the exact container it stopped** —
   `docker start loom-loom-1`, after checking that its image **id** is the one recorded before the
   build, because that id is the only thing that proves the object is the previous deployment — and
   exits non-zero. The backup
   taken seconds earlier is on disk and nothing needs it: the instance is back to the code and the
   schema it had before the run, with no write lost, because nothing was accepted while it was
   stopped. In the rare case where the migration committed but the client never saw the commit, the
   script starts the **new** image against the schema the database really has. In the case it cannot
   tell, it leaves Loom **stopped** and prints what is applied, what is pending and where the dump
   is — because a wrong guess there is the one thing worse than a minute of downtime.
6. A merge whose image **starts but never serves** — a startup regression, no migration in it — is
   not mistaken for a deployment. The container being created proves nothing; only the loopback
   `/api/guidelines` answer does, and until that answer arrives the script's recovery is still armed
   (§4.5 banner 10). So the failed container is removed and the previous deployment is put back, and
   the run exits non-zero. If that same update *had* carried a migration, the schema has moved and
   the old image must not be started against it: the script says **Loom is DOWN** in as many words,
   prints the absolute commands to read the new container's log and to retry the same commit, and
   stops there (§4.5's recovery procedure, R4 and R5).
7. A run that is **killed outright** — the host loses power, the shell takes a `SIGKILL` — leaves no
   trap to run and one file on disk: `deploy/.update-state`, written before the quiesce. The next
   invocation of the command reads it before it fetches anything, asks the database what happened,
   and either puts the old container back or starts the target it can prove the schema now needs;
   then it stops, without deploying whatever has been merged since, so a human sees one outcome per
   run (§4.5 banner 2).
8. A merge that changed the **database's topology** — Postgres's volume, its mount, or the compose
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
| **One command** after each merge (`live-update`), run by the session as the last merge step, and by Paw on demand | The update is the step that will be done most often and is the one with a database in it. A script is the only form that can be idempotent, ordered and stoppable |
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

Ten files and one test harness beside them, and not one of them is generated: they are read by a
human deciding whether to trust the update that is about to run.

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

**And the harness that runs `live-update.sh` against stub commands** — review round 8's F5 and the
new §11.7. It is three kinds of file in one directory, committed like everything else here, and it
is the first automated test any of `deploy/` has ever had:

    deploy/test/run.sh                 the runner: one temp directory and one scenario per case, no framework
    deploy/test/stubs/                 docker, git, curl, timeout and flock, each driven by the scenario file
    deploy/test/cases/                 one file per case: the scenario, and what it asserts afterwards

**Five files the server writes into this directory are not in that list and are not in git**, and
keeping them apart is the answer to review round 4's F2 and to round 10's F2 — **one fact per
record**:

    deploy/.deployed-sha     the commit whose image AND schema are active. With migrations
                             pending, written the moment the migrator exits 0, before Loom is
                             started; with nothing pending, written only once the new image is
                             up AND has answered the loopback check (§4.5 banners 9 and 10).
    deploy/.verified-sha     the last commit that passed the public health check. Written last.
    deploy/.deployed-image   the image id of the running loom container, captured before the build.
    deploy/.update-state     the intent record of an update in flight: written before the quiesce,
                             removed only by the one helper that has proved a target healthy AND
                             recorded it, or by the restore that has proved the previous deployment
                             is serving again. Its presence means a run did not finish, and the next
                             run reconciles it before it fetches anything (§4.5 banners 2, 7 and 10,
                             review round 7's F2 and round 8's F2).
    deploy/.dump-in-progress a pre-update pg_dump that could NOT be proven gone inside the Postgres
                             container. Written by the timed-out dump, removed only when a later
                             invocation's in-container check answers `DUMP_GONE`. It outlives the run
                             that wrote it, and outlives the intent record that run's restore
                             removes, which is why it is a file of its own (§4.5 banners 2 and 8,
                             review round 10's F2).

`.deployed-sha` is what the topology guard compares against and what the recovery aims at;
`.verified-sha` is the public proof and nothing reads it as state. **An earlier draft had one file
doing both jobs, and that was the defect:** a run whose migration committed and whose *public*
check then failed — a slow DNS answer, a certificate mid-renewal — left the single record naming
the **pre-migration** commit while the post-migration image and schema were live. The next run's
recovery would then have aimed at that older image and started it against a schema it does not
understand. The two facts have different lifetimes, so they are two files, and the one the recovery
reads is the one that tracks the schema. All five are server state, so all five join `.env` in the
root [`.gitignore`](../../../.gitignore) — an untracked file inside the checkout would otherwise
trip the script's own clean-tree check — **and so do the three `.new` temporaries the atomic writers
use**, `deploy/.deployed-sha.new`, `deploy/.verified-sha.new` and `deploy/.update-state.new`, because
a run killed between the `>` and the `mv` would leave one behind and stop the *next* run on its own
cleanliness check (§4.5 banner 1). Eight lines, listed one at a time.

**And the fourth record is not a fourth fact about the deployment — it is a statement of intent**,
which is why it is the one of the four that is deliberately short-lived. `.deployed-sha` and
`.verified-sha` say what *is*; `.update-state` says what a run *set out to do* and had not finished
when it stopped existing. A trap can only recover a process that is still alive to run it, and
review round 7's F2 named the two windows where no trap runs at all: a host that loses power, and a
shell killed with `SIGKILL`. What survives those is a file, so the file is written **before** the
first irreversible step and removed **after** the last one, and every invocation begins by asking
whether one is lying there (§4.5 banner 2).

**And the fifth is neither a fact about the deployment nor a statement of intent — it is a hazard**,
which is round 10's F2 and is why it is not a key inside the fourth. `.dump-in-progress` says "a
`pg_dump` may still be running inside `loom-postgres-1`", and that is true of the **box**, not of
the update that discovered it. The update that discovers it is by construction one whose dump
failed, so its recovery is R6 — which restores the previous deployment and then removes
`.update-state`, correctly, because the update it described has been undone. A marker that lived
inside that record therefore died with it, and the next invocation walked straight into the dump
the marker existed to prevent. Two lifetimes, two files: the intent record is removed by whatever
proves the intent settled, and the hazard file is removed only by a check in which the container
itself says the process is gone (§4.5 banners 2 and 8).

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

Stated exactly, because every path below is what a script resolves to and a reader must be able to
check them. **Since review round 9's F1 the five operational paths are named constants at the top of
`live-update.sh`** — `LOOM_DEPLOY_DIR`, `SPOOL_DEPLOY_DIR`, `SITES_DIR`, `BACKUP_DIR` and
`LOCK_FILE`, with the checkout root and Spool's two files derived from them — carrying exactly the
production values in this table. They move in one circumstance only: `LIVE_UPDATE_TEST_ROOT` is set,
which is §11.7's explicit test mode and prints a `TEST MODE:` line. Nothing else in the environment
can move them, and there is no per-path override.

| Thing | Path, and how it gets there |
| --- | --- |
| The checkout | `~/git/Loom` (i.e. `/root/git/Loom`), `git clone https://github.com/poteb/Loom.git`, **`main` only**. Cloned once by hand in §9. It is never checked out to a branch, never committed to, and `live-update.sh` only ever fast-forwards it |
| The compose project | `loom`, named **explicitly on every command** (`docker compose -p loom …`) and **again in the file** (top-level `name: loom` in `deploy/docker-compose.yml`) — *not* taken from the directory, which is `deploy` and would otherwise name the project `deploy`. So containers are `loom-postgres-1`, `loom-migrate-1`, `loom-loom-1` and the volume is `loom_pgdata` wherever the command is run from and whatever the shell has exported (§4.2) |
| The environment file | `~/git/Loom/deploy/.env`, **`chmod 600`**, created by hand on the server in §9, never in git (`.env` is already in [`.gitignore`](../../../.gitignore)) |
| The deployed-commit record | `~/git/Loom/deploy/.deployed-sha`, one line holding the short SHA of **the commit whose image and schema are both active**. Written atomically (temporary file in the same directory, then `mv`) **and durably** (`sync -f` on the result, review round 7's F2) at one of exactly two moments: when the update had migrations to apply, the instant the migrator exits 0 and **before** Loom is started (§4.5 banner 9); when it had none, only **after** the new container has answered the loopback health check, because until then the new image is running but unproven and the recovery's answer for that window is to restore the previous deployment (§4.5 banner 10's helper, review round 7's F3). The second of those two writes now happens in exactly one function, `start_target_and_prove`, which is the only thing in the script that starts a target at all (round 8's F2). It is **never** written at the quiesce, and a write that fails is its own state (`record-failed`) rather than a silent continuation. Read as the topology guard's base (§4.5 banner 3), as the agreement check's expectation (§4.5 banner 2) and as the recovery's target (§4.5's recovery procedure, R7 and R11). Git-ignored |
| The verified-commit record | `~/git/Loom/deploy/.verified-sha`, one line holding the short SHA of the last commit that answered the **public** health check. Written at the very end of a normal run (§4.5 banner 13) and by nothing else; a `--bootstrap` run never writes it. It is the public proof, for a human and for §9's done-checks — **no mechanism reads it**, deliberately, so a failing public check can never misdirect a recovery. Git-ignored |
| The previous image id | `~/git/Loom/deploy/.deployed-image`, one line holding `docker inspect --format '{{.Image}}' loom-loom-1` as captured in §4.5 banner 3, before the build. It is an immutable image id, not a tag, so it still names the old image after a same-commit rebuild has re-pointed `loom-live:<SHA>`. The run itself holds that id in `PREV_IMAGE` and the intent record carries it across an interruption as `old_image=`, so **no mechanism reads this file any more** — it is the human's copy of which image the previous deployment was, and the value `.update-state` is written from. **And `PREV_IMAGE` is now the *only* thing that identifies the previous deployment**: `restore_prev` compares it with the running container's own `{{.Image}}` and reconstructs rather than `docker start`ing whenever the two differ, which is review round 8's F3. Git-ignored |
| The update-state record | `~/git/Loom/deploy/.update-state`, six `key=value` lines and no more — `old_sha`, `old_image`, `target_sha`, `target_tag`, `pending` (the journal tags outstanding when the run began, space-separated, empty when there were none) and `started_at` (a UTC timestamp). **Since round 10's F2 there is no seventh key**: the unresolved-dump marker is its own file, below, because it outlives this record. Written atomically and durably **before the quiesce** (§4.5 banner 7) and removed in exactly two places, both of which have proved something first: inside `start_target_and_prove`, once the target has answered the loopback check **and** `.deployed-sha` durably names it, and inside `restore_prev`, once the previous deployment has answered it (§4.5 banner 10, round 8's F2). Its presence is the only thing that says "a run did not finish", and it is read by exactly one thing: every invocation's reconciliation, right after the lock, the dump-marker check and before the fetch (§4.5 banner 2, review round 7's F2). `key=value` and not JSON, because this box has no `jq` and the script already reads `key=value` lines with `sed -n 's/^key=//p' … \| tail -1`, which exits 0 on a missing key — one idiom, used twice. Git-ignored |
| The unresolved-dump marker | `~/git/Loom/deploy/.dump-in-progress`, one line holding `1`, and its **presence** is the whole of its content. Written and `sync`ed by §4.5 banner 8 when a timed-out `pg_dump`'s in-container process could not be proven gone, and removed in exactly one place: banner 2 of a later invocation, when the bounded in-container check of `dump_verdict` — a `sh -c` wrapper that reads `pgrep`'s own exit status inside the container and prints `DUMP_RUNNING`, `DUMP_GONE` or a token naming why it could not tell — exits 0 with `DUMP_GONE` on stdout. Round 11's F1 is why the verdict is a **token the container prints** rather than `pgrep`'s exit status read through Docker: a Compose or daemon failure can exit 1 with empty stdout too, so the old "exit 1, empty output" rule cleared the hazard on a transport error. While it exists, every invocation refuses before the fetch — no dump, no migration, and **not even a reconciliation of an interrupted update** (§4.5 banner 2). It is a separate file rather than a key in `.update-state` because the run that writes it is on the R6 path, whose successful restore removes `.update-state` and would have taken the marker with it — round 10's F2. Git-ignored |
| The per-commit images | `loom-live:<short SHA>` in the host's image store, one per deployed commit, built by `live-update.sh` step 4 and never pruned by it — the previous one *is* the rollback (§13) |
| Database backups | `/root/backups/loom/loom-pre-update-<UTC timestamp>.sql.gz` — the constant `BACKUP_DIR`, not `$HOME`, since round 9's F1 — created by `live-update.sh` in a directory it creates with `install -d -m 700`. Root-only, like Spool's dumps |
| The update lock | `/run/lock/loom-live-update.lock`, the constant `LOCK_FILE`, held for the whole of one `live-update.sh` run (§4.5 banner 2). `/run/lock` is a tmpfs on Ubuntu, so the file is not persistent state and a lock held by a killed shell is released by the kernel when the descriptor closes |
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

# --- 0. arguments, the path constants, and the inherited-project-name refusal -------
BOOTSTRAP="${LIVE_UPDATE_BOOTSTRAP:-0}"
if [ "$#" -gt 1 ]; then
  echo "usage: live-update.sh [--bootstrap]" >&2; exit 2
fi
case "${1:-}" in
  "")          ;;
  --bootstrap) BOOTSTRAP=1 ;;
  *)           echo "usage: live-update.sh [--bootstrap]" >&2; exit 2 ;;
esac

if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
  echo "COMPOSE_PROJECT_NAME is set in this environment; unset it and run again" >&2
  exit 1
fi

# Round 9's F1: EVERY operational path is one of these five constants, and these five lines are
# the only absolute paths in the script. The values here are the production ones. They can be
# moved in exactly one circumstance — LIVE_UPDATE_TEST_ROOT is set, which is an explicit test
# mode and says so once, on stdout — so that §11.7's harness can run this file without being
# able to read or write anything the live server owns.
LOOM_DEPLOY_DIR=/root/git/Loom/deploy
SPOOL_DEPLOY_DIR=/root/git/Spool/deploy
SITES_DIR=/root/caddy-sites
BACKUP_DIR=/root/backups/loom
LOCK_FILE=/run/lock/loom-live-update.lock
if [ -n "${LIVE_UPDATE_TEST_ROOT:-}" ]; then
  echo "TEST MODE: LIVE_UPDATE_TEST_ROOT=$LIVE_UPDATE_TEST_ROOT — every operational path is" \
       "under it and no production path is read or written"
  LOOM_DEPLOY_DIR="$LIVE_UPDATE_TEST_ROOT/git/Loom/deploy"
  SPOOL_DEPLOY_DIR="$LIVE_UPDATE_TEST_ROOT/git/Spool/deploy"
  SITES_DIR="$LIVE_UPDATE_TEST_ROOT/caddy-sites"
  BACKUP_DIR="$LIVE_UPDATE_TEST_ROOT/backups/loom"
  LOCK_FILE="$LIVE_UPDATE_TEST_ROOT/run/lock/loom-live-update.lock"
fi
LOOM_REPO_DIR="$(dirname "$LOOM_DEPLOY_DIR")"   # the checkout the deploy directory sits in
SPOOLENV="$SPOOL_DEPLOY_DIR/.env"          # Spool's .env, compose file and Caddyfile all live in
SPOOL_CADDYFILE="$SPOOL_DEPLOY_DIR/Caddyfile"   # that one directory; this script reads two of them,
                                                # derived here so the two cannot drift apart

cd "$LOOM_DEPLOY_DIR"            # the constant IS the self-location: one answer, not two

# --- 1. every recovery input, set BEFORE the single exit handler is armed -----------
CREATED=0                        # 1 from the moment `up -d loom` is asked for the new container
HEALTHY=0                        # 1 ONLY once the loopback check passed: the one thing that disarms
QUIESCED=0                       # 1 only while Loom is deliberately stopped
MIGRATE_STATE=not-attempted      # not-attempted|not-needed|attempted|succeeded|failed|
                                 #   unreapable|record-failed
STATUS=unknown                   # R8's verdict: read|unavailable
STATUS_TEXT="not read"
FINAL=""                         # the dump's final path, once step 8 has taken one
FINAL_RC=0                       # the status the exit handler will exit with
SP=0                             # start_target_and_prove's verdict: 0 healthy, 1 no answer, 2 record
OLD_CONTAINER=loom-loom-1        # the only container name the project's loom service ever has
MIGRATE_CHECK=loom-migrate-check # the named one-off that reads migration status
MIGRATE_RUN=loom-migrate-run     # the named one-off that applies migrations
PREV_SHA=""                      # the deployed commit a restore aims at (banner 3, or the record)
PREV_IMAGE=""                    # that deployment's image id, captured before the build
LOOM_IMAGE_TAG=""; export LOOM_IMAGE_TAG
STAGE=""; CADDYENV=""; TMP=""; PENDING_BEFORE=""; PENDING_AFTER=""; PREVCOMPOSE=""
CLASSIFY_OUT=""                  # classify_inspect's stdout, read by its caller on a 0
CLASSIFY_ERR=""                  # classify_inspect's stderr, printed by whoever stops the run
INSPECT_ERR="$(mktemp)"          # the one stderr sink classify_inspect AND dump_verdict write to,
                                 #   removed by cleanup
DUMP_VERDICT=""                  # round 11's F1: the verdict TOKEN the Postgres container printed
DUMP_ERR=""                      #   dump_verdict's stderr, already through redact_logs
DUMP_RC=0                        #   the transport's own exit status, printed beside the token
PUBLIC_URL=https://loom.3dbox.dk/api/guidelines
LOCAL_URL=http://127.0.0.1:3100/api/guidelines
STATE=./.update-state            # the intent record: written before the quiesce, removed when HEALTHY
DUMPMARK=./.dump-in-progress     # round 10's F2: a HAZARD, not an intent — it outlives the run that
                                 #   wrote it and outlives the intent record a restore removed

record_deployed() {              # atomic AND durable; read by the topology guard and the recovery
  printf '%s\n' "$1" > ./.deployed-sha.new \
    && mv ./.deployed-sha.new ./.deployed-sha \
    && sync -f ./.deployed-sha
}

pending_tags() {                 # empty-safe: no `grep`, so an empty pending set is not a failure
  sed -n '/^pending:$/,$p' "$1" | sed '1d;s/^[[:space:]]*//;/^$/d' | LC_ALL=C sort
}

redact_logs() {                  # §8.1: the one filter every log this script prints goes through
  sed -E 's#/w/[A-Za-z0-9_-]{43}#/w/<redacted>#g; s#[A-Za-z0-9_-]{43}#<43-char-token>#g'
}

dk() {                           # round 8's F1: the default bound on a docker call. The exceptions
  timeout 60 docker "$@"         #   carry their own deadline and are named in the commentary; 60 s
}                                #   is two orders of magnitude more than any dk call needs

classify_inspect() {             # round 9's F3: the ONE way any inspect's result is read.
  local rc=0                     #   0 = present, and CLASSIFY_OUT holds what the format printed
  CLASSIFY_OUT=""                #   1 = the daemon ITSELF said the object does not exist
  CLASSIFY_ERR=""                #   2 = the question was NOT answered: nothing may be concluded
  CLASSIFY_OUT="$(dk "$@" 2>"$INSPECT_ERR")" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  CLASSIFY_ERR="$(tr '\n' ' ' < "$INSPECT_ERR" 2>/dev/null)"
  case "$CLASSIFY_ERR" in
    *"No such object"*|*"No such volume"*|*"No such container"*) return 1 ;;
  esac
  return 2                       # 124 from the timeout, a daemon error, a permission failure,
}                                #   an empty message, anything a future Docker invents

dump_verdict() {                 # round 11's F1: the ONE way "is a pg_dump still alive inside
  local rc=0                     #   loom-postgres-1" is asked. The CONTAINER prints the verdict,
  DUMP_VERDICT=""; DUMP_ERR=""   #   so "gone" is something it SAID and never something inferred
  DUMP_RC=0                      #   from an exit status the transport uses for its own failures.
  DUMP_VERDICT="$(dk compose -p loom exec -T postgres sh -c \
    'command -v pgrep >/dev/null 2>&1 || { echo DUMP_NO_PGREP; exit 0; }
     pgrep -x pg_dump >/dev/null 2>&1; p=$?
     case "$p" in 0) echo DUMP_RUNNING ;; 1) echo DUMP_GONE ;; *) echo "DUMP_PGREP_$p" ;; esac' \
    2>"$INSPECT_ERR")" || rc=$?    # round 12's F1: -x, NOT -f — this wrapper's OWN command line
  DUMP_ERR="$(tr '\n' ' ' < "$INSPECT_ERR" 2>/dev/null | redact_logs)" || DUMP_ERR=""
  DUMP_RC="$rc"                  #   contains "pg_dump": -f would match the sh running it (§11.6)
  [ "$rc" -eq 0 ] || return 2    # exec refused, daemon down, no such container, the 60 s bound:
  case "$DUMP_VERDICT" in        #   the wrapper never ran, so there is no verdict to read
    DUMP_GONE)    return 0 ;;    # 0 = GONE:      pgrep itself said "nothing matched"
    DUMP_RUNNING) return 1 ;;    # 1 = RUNNING:   pgrep itself found one
    *)            return 2 ;;    # 2 = UNANSWERED: DUMP_NO_PGREP, DUMP_PGREP_<n>, empty, anything
  esac                           #   else — it ran and did not answer the question
}

fail_and_restore() {             # round 9's F3: an unanswered question ends the run here. The one
  echo "$1 — stopping the run" >&2   # exit handler then recovers if anything had been quiesced,
  exit 1                             # and does nothing at all if nothing had been
}

prove_url() {                    # round 8's F1: $1 url, $2 the loop's absolute deadline in seconds,
  local deadline=$((SECONDS + $2))   # $3 seconds between tries. The ONLY curl in the script.
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -fsS --connect-timeout 5 --max-time 20 "$1" >/dev/null 2>&1 && return 0
    sleep "$3"
  done
  return 1
}

start_target_and_prove() {       # round 8's F2: the ONE way a target is started and then believed.
  local tag="$1"                 #   0 = up, answering and recorded; 1 = no answer; 2 = no record
  CREATED=1                      # armed before the command, exactly as QUIESCED is (round 6's F5)
  if ! timeout 120 docker compose -p loom up -d --no-build loom; then
    echo "docker compose up -d loom did not report success for loom-live:$tag; asking the port" >&2
  fi
  echo "created $OLD_CONTAINER from loom-live:$tag — not yet proven healthy"
  if ! prove_url "$LOCAL_URL" 60 1; then
    dk compose -p loom logs --tail 50 loom 2>&1 | redact_logs >&2 || true
    echo "loom-live:$tag did not answer $LOCAL_URL within 60s" >&2
    return 1
  fi
  echo "loopback health: ok"
  if ! record_deployed "$tag"; then
    MIGRATE_STATE=record-failed
    return 2
  fi
  HEALTHY=1                      # the one and only thing that disarms the recovery (R1)
  rm -f "$STATE"                 # up, answering AND recorded: the intent is fulfilled
  echo "started loom-live:$tag"
  return 0
}

reap_oneoff() {                  # F1: a VERIFIED transition. 0 = proven absent or proven exited;
  local name="$1" out rc=0       #      2 = not proven, and then nothing may be believed
  classify_inspect inspect "$name" || rc=$?
  case "$rc" in
    1) return 0 ;;                                   # absent, and the daemon said so: proven
    2) echo "WARNING: docker inspect $name failed without saying the object is absent:" \
            "$CLASSIFY_ERR — the container's state is UNKNOWN" >&2
       return 2 ;;
  esac
  dk stop -t 10 "$name" >/dev/null 2>&1 || dk kill "$name" >/dev/null 2>&1 || true
  dk wait "$name" >/dev/null 2>&1 \
    || echo "WARNING: $name did not report an exit within 60s of being stopped" >&2
  dk logs --tail 50 "$name" 2>&1 | redact_logs >&2 || true
  rc=0
  classify_inspect inspect --format '{{.State.Status}}' "$name" || rc=$?
  case "$rc" in
    1) return 0 ;;                                   # gone between the wait and the question: proven
    2) echo "WARNING: $name could not be inspected after the stop: $CLASSIFY_ERR" >&2; return 2 ;;
  esac
  out="$CLASSIFY_OUT"
  case "$out" in
    exited|dead) ;;                                  # proven not running
    *) echo "WARNING: $name is '$out', neither exited nor dead — it is NOT proven stopped" >&2
       return 2 ;;
  esac
  dk rm -f "$name" >/dev/null 2>&1 \
    || echo "NOTE: $name has provably exited but could not be removed; the next run clears" \
            "the name" >&2
  return 0
}

read_status() {                  # the ONLY way status is read. $1=stdout file, $2=timeout seconds
  local out="$1" secs="$2" rc=0
  dk rm -f "$MIGRATE_CHECK" >/dev/null 2>&1 || true
  timeout "$secs" docker compose -p loom run --rm -T --name "$MIGRATE_CHECK" \
    migrate node dist/migrate.js --check > "$out" 2> "$out.err" || rc=$?
  if [ "$rc" -ne 0 ]; then       # the client is dead; the container may not be — F1's lifecycle
    reap_oneoff "$MIGRATE_CHECK" \
      || echo "WARNING: $MIGRATE_CHECK was not proven stopped; a read connection may still be" \
              "open, and the name is cleared by the next status read" >&2
  fi
  return "$rc"
}

cleanup() {
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  [ -n "$CADDYENV" ] && rm -f "$CADDYENV"
  [ -n "$TMP" ] && rm -f "$TMP"
  [ -n "$PREVCOMPOSE" ] && rm -f "$PREVCOMPOSE"
  [ -n "$PENDING_BEFORE" ] && rm -f "$PENDING_BEFORE" "$PENDING_BEFORE.set" "$PENDING_BEFORE.err"
  [ -n "$PENDING_AFTER" ] && rm -f "$PENDING_AFTER" "$PENDING_AFTER.set" "$PENDING_AFTER.err"
  [ -n "$INSPECT_ERR" ] && rm -f "$INSPECT_ERR"
  rm -f ./.deployed-sha.new ./.verified-sha.new ./.update-state.new
  return 0
}

manual_recovery() {              # R13. Every command it prints is absolute and self-contained (F6)
  local img irc=0                # round 8's F3: the id decides which of the two commands is printed
  classify_inspect inspect --format '{{.Image}}' "$OLD_CONTAINER" || irc=$?
  case "$irc" in                 # round 9's F3: three answers, and only the first is an id
    0) img="$CLASSIFY_OUT" ;;
    1) img=absent ;;
    *) img="UNKNOWN — not answered: $CLASSIFY_ERR" ;;
  esac
  echo "MANUAL RECOVERY REQUIRED — loom is STOPPED and has not been restarted."
  echo "  $LOOM_DEPLOY_DIR/.deployed-sha (image+schema): $(cat ./.deployed-sha 2>/dev/null || echo none)"
  echo "  commit being deployed:                             $LOOM_IMAGE_TAG"
  echo "  previous deployment's recorded image id:           ${PREV_IMAGE:-none}"
  echo "  $OLD_CONTAINER's image id right now:               $img"
  echo "  pending before the migration:                      $(tr '\n' ' ' < "$PENDING_BEFORE.set" 2>/dev/null)"
  echo "  pending now:                                       $STATUS_TEXT"
  echo "  pre-migration dump:                                ${FINAL:-none taken}"
  echo "  decide which schema the database is at, then paste ONE of these two, whole:"
  if [ "$irc" -eq 0 ] && [ -n "$img" ] && [ "$img" = "${PREV_IMAGE:-}" ]; then
    echo "    cd $LOOM_DEPLOY_DIR && docker start $OLD_CONTAINER     # the pre-migration container:"
    echo "    # its image id IS the recorded previous one, so this really is the old deployment"
  else
    case "$irc" in
      2) echo "    # $OLD_CONTAINER's image id could NOT be read — the daemon did not answer — so a"
         echo "    # docker start of it might start something else and is deliberately not offered;" ;;
      *) echo "    # $OLD_CONTAINER does NOT hold the recorded previous image id, so a docker start"
         echo "    # of it would start something else;" ;;
    esac
    echo "    # reconstruct the previous deployment instead, whole:"
    echo "    cd $LOOM_DEPLOY_DIR && docker rm -f $OLD_CONTAINER ; \\"
    echo "      docker tag ${PREV_IMAGE:-<none recorded>} loom-live:${PREV_SHA:-<none recorded>} \\"
    echo "      && git -C $LOOM_REPO_DIR show ${PREV_SHA:-<none recorded>}:deploy/docker-compose.yml \\"
    echo "           > /tmp/loom-prev-compose.yml \\"
    echo "      && LOOM_IMAGE_TAG=${PREV_SHA:-<none recorded>} docker compose -p loom \\"
    echo "           --project-directory $LOOM_DEPLOY_DIR \\"
    echo "           --env-file $LOOM_DEPLOY_DIR/.env -f /tmp/loom-prev-compose.yml \\"
    echo "           up -d --no-build loom"
  fi
  echo "  or"
  echo "    cd $LOOM_DEPLOY_DIR && LOOM_IMAGE_TAG=$LOOM_IMAGE_TAG \\"
  echo "      docker compose -p loom --env-file $LOOM_DEPLOY_DIR/.env up -d --no-build loom   # the new image"
  echo "  if you started the NEW image, record it, whole (if you started the pre-migration"
  echo "  container instead, the record already names it and must not be touched):"
  echo "    printf '%s\\n' $LOOM_IMAGE_TAG > $LOOM_DEPLOY_DIR/.deployed-sha \\"
  echo "      && sync -f $LOOM_DEPLOY_DIR/.deployed-sha"
  echo "  and only when the record and the container you started agree, clear the interrupted"
  echo "  update so the next run deploys instead of reconciling, whole:"
  echo "    rm -f $LOOM_DEPLOY_DIR/.update-state"
}

record_failed_message() {        # R2 (F2): the record could not be written, so nothing may be believed
  local run img irc=0            # round 9's F3: an unread inspection prints UNKNOWN, never a guess
  classify_inspect inspect --format '{{.State.Running}}' "$OLD_CONTAINER" || irc=$?
  case "$irc" in 0) run="$CLASSIFY_OUT" ;; 1) run=absent ;; *) run="UNKNOWN: $CLASSIFY_ERR" ;; esac
  irc=0
  classify_inspect inspect --format '{{.Config.Image}}' "$OLD_CONTAINER" || irc=$?
  case "$irc" in 0) img="$CLASSIFY_OUT" ;; 1) img=absent ;; *) img="UNKNOWN: $CLASSIFY_ERR" ;; esac
  echo "MANUAL RECOVERY REQUIRED — $LOOM_DEPLOY_DIR/.deployed-sha could NOT be written."
  echo "  the image on disk and the database's schema are $LOOM_IMAGE_TAG; the record still says" \
       "$(cat ./.deployed-sha 2>/dev/null || echo none)."
  echo "  the two DISAGREE, the next run's topology guard and recovery both believe that file, and"
  echo "  no automatic action is taken here."
  echo "  $OLD_CONTAINER running: $run"
  echo "  $OLD_CONTAINER image:   $img"
  echo "  make room, then set the record by hand, whole:"
  echo "    df -h $LOOM_DEPLOY_DIR && ls -la $LOOM_DEPLOY_DIR"
  echo "    printf '%s\\n' $LOOM_IMAGE_TAG > $LOOM_DEPLOY_DIR/.deployed-sha"
  echo "    sync -f $LOOM_DEPLOY_DIR/.deployed-sha"
  echo "  then, if loom is not running, start the commit the record now names, whole:"
  echo "    cd $LOOM_DEPLOY_DIR && LOOM_IMAGE_TAG=$LOOM_IMAGE_TAG \\"
  echo "      docker compose -p loom --env-file $LOOM_DEPLOY_DIR/.env up -d --no-build loom"
  echo "  the interrupted update's record is left in place; clear it last, whole:"
  echo "    rm -f $LOOM_DEPLOY_DIR/.update-state"
}

failed_start_after_migration() { # R5 (F3): the schema has moved and the new image will not serve
  echo "LOOM IS DOWN — the migration for $LOOM_IMAGE_TAG committed, so the database is at that"
  echo "  commit's schema and the previous image must NOT be started against it. Its container was"
  echo "  created and never answered $LOCAL_URL."
  echo "  $LOOM_DEPLOY_DIR/.deployed-sha (image+schema): $(cat ./.deployed-sha 2>/dev/null || echo none)"
  echo "  pre-migration dump:                                ${FINAL:-none taken}"
  echo "  read the new container's log first, redacted, whole:"
  echo "    cd $LOOM_DEPLOY_DIR && docker compose -p loom --env-file $LOOM_DEPLOY_DIR/.env \\"
  echo "      logs --tail 200 loom 2>&1 | sed -E 's#/w/[A-Za-z0-9_-]{43}#/w/<redacted>#g; s#[A-Za-z0-9_-]{43}#<43-char-token>#g'"
  echo "  then retry the SAME commit — it is the only valid target — whole:"
  echo "    $LOOM_DEPLOY_DIR/live-update.sh"
  echo "  going back across the migration needs the dump (${FINAL:-none taken}) and a human (§13)."
  echo "  the container is left as compose created it, under restart: unless-stopped, so it may yet"
  echo "  come up by itself; the interrupted update's record is left for the next run to reconcile."
}

restore_prev() {                 # R4/R6/R10, falling through to R14. Round 8's F3: the previous
  local img irc=0                #   deployment is the recorded IMAGE ID and nothing else
  if [ -z "$PREV_SHA" ] || [ -z "$PREV_IMAGE" ]; then
    echo "no recorded previous deployment — loom is DOWN, deploy by hand"; return 1
  fi
  classify_inspect inspect --format '{{.Image}}' "$OLD_CONTAINER" || irc=$?
  if [ "$irc" -eq 2 ]; then      # round 9's F3: no answer, so no removal and no reconstruction
    echo "$OLD_CONTAINER could not be inspected ($CLASSIFY_ERR) — inspection unanswered, so"
    echo "nothing is removed and nothing is recreated; loom is DOWN, deploy by hand and the"
    echo "interrupted update's record is left in place"
    return 1
  fi
  img=""; [ "$irc" -eq 0 ] && img="$CLASSIFY_OUT"  # a 1 is the daemon saying the object is absent
  if [ "$img" = "$PREV_IMAGE" ]; then              # proved: this object IS the old deployment
    if dk start "$OLD_CONTAINER" >/dev/null 2>&1 && prove_url "$LOCAL_URL" 60 1; then
      rm -f "$STATE"
      return 0
    fi
    dk compose -p loom logs --tail 50 loom 2>&1 | redact_logs >&2 || true
    echo "$OLD_CONTAINER holds the recorded image $PREV_IMAGE but did not answer $LOCAL_URL —"
    echo "loom is DOWN, deploy by hand; the interrupted update's record is left in place"
    return 1
  fi
  if [ -n "$img" ]; then                           # a different id, whatever the tag or the SHA says
    echo "$OLD_CONTAINER holds image $img, which is NOT the recorded previous image $PREV_IMAGE;"
    echo "removing it and reconstructing the previous deployment from the recorded id"
    dk rm -f "$OLD_CONTAINER" >/dev/null 2>&1 || true
  fi
  if ! dk tag "$PREV_IMAGE" "loom-live:$PREV_SHA" >/dev/null 2>&1; then
    echo "recorded image id $PREV_IMAGE is not on disk — loom is DOWN, deploy by hand"; return 1
  fi
  PREVCOMPOSE="$(mktemp)"
  if ! git -C "$LOOM_REPO_DIR" show "$PREV_SHA:deploy/docker-compose.yml" > "$PREVCOMPOSE" 2>/dev/null; then
    echo "$PREV_SHA's own compose file could not be read — loom is DOWN, deploy by hand"; return 1
  fi
  if ! LOOM_IMAGE_TAG="$PREV_SHA" timeout 120 docker compose -p loom \
         --project-directory "$LOOM_DEPLOY_DIR" \
         --env-file "$LOOM_DEPLOY_DIR/.env" \
         -f "$PREVCOMPOSE" up -d --no-build loom; then
    echo "could not recreate loom from the recorded image id — loom is DOWN, deploy by hand"
    return 1
  fi
  if ! prove_url "$LOCAL_URL" 60 1; then
    dk compose -p loom logs --tail 50 loom 2>&1 | redact_logs >&2 || true
    echo "loom was recreated from image $PREV_IMAGE through $PREV_SHA's own compose file and did"
    echo "NOT answer $LOCAL_URL — loom is DOWN, deploy by hand; the record is left in place"
    return 1
  fi
  rm -f "$STATE"
  echo "WARNING: $OLD_CONTAINER did not hold the recorded image id, so loom was recreated from" \
       "image $PREV_IMAGE through $PREV_SHA's OWN compose definition — same image, same" \
       "definition, a new container object — and it is answering $LOCAL_URL"
  return 0
}

reconcile_update_state() {       # F2: an interrupted update is settled before any new commit is read
  local old_sha old_image target pending started cfg gone still t sp=0 irc=0 rrc=0
  old_sha="$(sed -n 's/^old_sha=//p' "$STATE" | tail -1)"
  old_image="$(sed -n 's/^old_image=//p' "$STATE" | tail -1)"
  target="$(sed -n 's/^target_sha=//p' "$STATE" | tail -1)"
  pending="$(sed -n 's/^pending=//p' "$STATE" | tail -1)"
  started="$(sed -n 's/^started_at=//p' "$STATE" | tail -1)"
  echo "an interrupted update is on record (started $started): ${old_sha:-none} -> ${target:-none}"
  echo "  pending when it started: ${pending:-(nothing)}"
  if [ -z "$target" ]; then
    echo "the update-state record is unreadable; settle it by hand and remove"
    echo "$LOOM_DEPLOY_DIR/.update-state"
    return 1
  fi
  LOOM_IMAGE_TAG="$target"
  PREV_SHA="$old_sha"; [ "$PREV_SHA" != none ] || PREV_SHA=""
  PREV_IMAGE="$old_image"; [ "$PREV_IMAGE" != none ] || PREV_IMAGE=""

  # Round 10's F1: the interrupted run's applying container may still be alive, and NOTHING below
  # may be believed while it is — not the cheap "target already healthy" probe, not the status
  # read, not the comparison either of them feeds. So the migrator is reaped FIRST, with exactly
  # the verified semantics banner 9 uses: 0 is proven absent or proven exited, 2 is not proven.
  reap_oneoff "$MIGRATE_RUN" || rrc=$?
  if [ "$rrc" -eq 2 ]; then      # unproven: refuse, start nothing, read nothing, keep the record
    echo "REFUSING TO RECONCILE — the interrupted update's migrator container $MIGRATE_RUN was"
    echo "  NOT proven stopped, so it may still hold an open transaction on the live database."
    echo "  No migration status has been read, nothing has been started, nothing has been"
    echo "  restored, and $LOOM_DEPLOY_DIR/.update-state is left exactly as it was."
    echo "  look at it, whole:"
    echo "    docker inspect --format '{{.State.Status}}' $MIGRATE_RUN"
    echo "    docker logs --tail 200 $MIGRATE_RUN 2>&1 \\"
    echo "      | sed -E 's#/w/[A-Za-z0-9_-]{43}#/w/<redacted>#g; s#[A-Za-z0-9_-]{43}#<43-char-token>#g'"
    echo "  when it has genuinely stopped, remove it and run this command again, whole:"
    echo "    docker rm -f $MIGRATE_RUN && $LOOM_DEPLOY_DIR/live-update.sh"
    return 1
  fi
  reap_oneoff "$MIGRATE_CHECK" \
    || echo "WARNING: $MIGRATE_CHECK was not proven stopped; a read connection may still be open," \
            "and the name is cleared by the next status read" >&2

  classify_inspect inspect --format '{{.Config.Image}}' "$OLD_CONTAINER" || irc=$?
  if [ "$irc" -eq 2 ]; then      # round 9's F3: an unanswered inspection settles nothing
    echo "$OLD_CONTAINER could not be inspected ($CLASSIFY_ERR) — inspection unanswered; the"
    echo "interrupted update is left on record and nothing is started. Settle it by hand."
    return 1
  fi
  cfg=""; [ "$irc" -eq 0 ] && cfg="$CLASSIFY_OUT"
  if [ "$cfg" = "loom-live:$target" ] && prove_url "$LOCAL_URL" 20 1; then
    if ! record_deployed "$target"; then record_failed_message; return 1; fi
    rm -f "$STATE"
    echo "the target was already up and answering: its records are complete and the interrupted"
    echo "update is closed. Run $LOOM_DEPLOY_DIR/live-update.sh again to deploy anything newer."
    return 1
  fi

  PENDING_BEFORE="$(mktemp)"   # rebuild the recorded set FIRST, so R13's message can print it
  for t in $pending; do printf '%s\n' "$t"; done | LC_ALL=C sort > "$PENDING_BEFORE.set"
  PENDING_AFTER="$(mktemp)"
  if ! read_status "$PENDING_AFTER" 120; then
    STATUS_TEXT="unavailable — migrate --check failed or did not finish within 120s"
    cat "$PENDING_AFTER" "$PENDING_AFTER.err" 2>/dev/null | redact_logs || true
    manual_recovery; return 1                                          # (c) cannot tell
  fi
  pending_tags "$PENDING_AFTER" > "$PENDING_AFTER.set"
  STATUS_TEXT="$(tr '\n' ' ' < "$PENDING_AFTER.set")"
  [ -n "$STATUS_TEXT" ] || STATUS_TEXT="(nothing pending)"
  gone="$(comm -23 "$PENDING_BEFORE.set" "$PENDING_AFTER.set" | wc -l)"
  still="$(comm -12 "$PENDING_BEFORE.set" "$PENDING_AFTER.set" | wc -l)"

  if [ ! -s "$PENDING_BEFORE.set" ] || [ "$gone" -eq 0 ]; then         # (a) nothing was committed
    if restore_prev; then
      echo "the interrupted update changed no schema; ${PREV_SHA:-the previous deployment} is"
      echo "serving again and the record is cleared. Run live-update.sh again to deploy."
      return 1
    fi
    echo "the interrupted update changed no schema, but the previous deployment could NOT be"
    echo "restored; $LOOM_DEPLOY_DIR/.update-state is left in place"
    return 1
  fi
  if [ "$still" -eq 0 ]; then                                          # (b) it committed
    if [ "$(git -C "$LOOM_REPO_DIR" rev-parse --short HEAD)" != "$target" ]; then
      echo "every recorded migration is applied, so the database is at $target — but this checkout"
      echo "is not at $target, so its compose definition must not be used to start it"
      manual_recovery; return 1
    fi
    if ! record_deployed "$target"; then record_failed_message; return 1; fi
    start_target_and_prove "$target" || sp=$?     # F2: the same helper as the normal path
    case "$sp" in
      0) echo "the interrupted update's migration had committed: the database is at $target, the"
         echo "target image is up, answering and recorded, and the record is cleared. Run"
         echo "$LOOM_DEPLOY_DIR/live-update.sh again to finish."
         return 1 ;;
      2) record_failed_message; return 1 ;;
      *) MIGRATE_STATE=succeeded                  # the schema is $target's: R5, and the record stays
         failed_start_after_migration; return 1 ;;
    esac
  fi
  echo "the interrupted update is PARTIALLY applied: $gone of the recorded tags are gone and"
  echo "$still remain."
  manual_recovery                                                      # (c) cannot tell
  return 1
}

recover() {                      # R1-R14. Never runs under errexit: see on_exit
  [ "$QUIESCED" = 1 ] || return 0                  # nothing was stopped, nothing to recover
  [ "$HEALTHY" = 0 ] || return 0                   # R1: only a passed loopback check disarms
  [ "$FINAL_RC" -ne 0 ] || FINAL_RC=1

  case "$MIGRATE_STATE" in
    record-failed)                                 # R2
      record_failed_message
      return 0 ;;
    unreapable)                                    # R3 -> R13: no proven reap, so no question asked
      echo "the migrator's container $MIGRATE_RUN was NOT proven stopped, so it may still hold an"
      echo "open transaction: nothing has been started and no migration status has been read."
      manual_recovery
      return 0 ;;
  esac

  if [ "$CREATED" = 1 ]; then                      # the new container never answered the loopback
    case "$MIGRATE_STATE" in
      not-needed|not-attempted)                    # R4: no schema change, so the old image is valid
        echo "the new container never answered $LOCAL_URL and no migration ran; removing it and"
        echo "restoring the previous deployment"
        if restore_prev; then
          echo "restored the previous deployment (loom-live:${PREV_SHA:-unknown})"
        fi
        return 0 ;;
      succeeded)                                   # R5: the schema moved; the target is the only one
        failed_start_after_migration
        return 0 ;;
      *)                                           # unreachable by construction; never guess here
        echo "the new container was created with MIGRATE_STATE=$MIGRATE_STATE, which cannot happen"
        manual_recovery
        return 0 ;;
    esac
  fi

  case "$MIGRATE_STATE" in
    not-attempted|not-needed)                      # R6
      if restore_prev; then echo "no migration ran; the previous deployment is serving again"; fi
      return 0 ;;
    succeeded)                                     # R7
      echo "the record names $LOOM_IMAGE_TAG; starting the new image and proving it"
      SP=0; start_target_and_prove "$LOOM_IMAGE_TAG" || SP=$?
      case "$SP" in
        0) : ;;                                    # up, answering, recorded — nothing left to say
        2) record_failed_message ;;
        *) failed_start_after_migration ;;         # R5: the schema has moved and it will not serve
      esac
      return 0 ;;
  esac

  PENDING_AFTER="$(mktemp)"                        # R8: ask the database what happened
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

  if [ "$STATUS" != read ]; then manual_recovery; return 0; fi   # R9 -> R13

  local gone still
  gone="$(comm -23 "$PENDING_BEFORE.set" "$PENDING_AFTER.set" | wc -l)"
  still="$(comm -12 "$PENDING_BEFORE.set" "$PENDING_AFTER.set" | wc -l)"

  if [ "$gone" -eq 0 ]; then                       # R10: the transaction rolled back
    if restore_prev; then
      echo "migration rolled back; the previous deployment is serving again" \
           "(loom-live:${PREV_SHA:-unknown})"
    fi
  elif [ "$still" -eq 0 ]; then                    # R11: committed, unacknowledged
    if ! record_deployed "$LOOM_IMAGE_TAG"; then
      MIGRATE_STATE=record-failed; record_failed_message; return 0
    fi
    MIGRATE_STATE=succeeded                        # the schema is the target's from this line on
    SP=0; start_target_and_prove "$LOOM_IMAGE_TAG" || SP=$?
    case "$SP" in
      0) echo "the migrator failed but every pending migration is applied: the database is at" \
              "$LOOM_IMAGE_TAG and the new image is up, answering and recorded; rerun" \
              "$LOOM_DEPLOY_DIR/live-update.sh to finish the remaining steps" ;;
      2) record_failed_message ;;
      *) failed_start_after_migration ;;           # R5, reached from R11: the record stays
    esac
  else                                             # R12 -> R13: partially applied
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

# --- 2. the lock, an unresolved dump, an interrupted update, and the agreement check -
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another live-update is running" >&2; exit 1; }

if [ -f "$DUMPMARK" ]; then      # round 10's F2: the hazard is asked about FIRST, and it is asked
  DV=0                           #   about whether or not an intent record survived beside it
  dump_verdict || DV=$?          # round 11's F1: a verdict, not an exit status read as one
  if [ "$DV" -eq 0 ]; then
    rm -f "$DUMPMARK"            # the container's own DUMP_GONE: the ONLY thing that clears it
    echo "a previous run's pg_dump was never proven gone; loom-postgres-1 answers DUMP_GONE now,"
    echo "so $LOOM_DEPLOY_DIR/.dump-in-progress is cleared and this run continues"
  else
    if [ "$DV" -eq 1 ]; then
      WHY="loom-postgres-1 answered DUMP_RUNNING"
    else
      WHY="the check was NOT answered (exit $DUMP_RC, stdout '${DUMP_VERDICT:-none}')"
    fi
    echo "REFUSING TO RUN — a previous update's pg_dump was NOT proven to have stopped inside" >&2
    echo "  loom-postgres-1: $WHY, so it may still hold" >&2
    echo "  a snapshot and locks on the live database. Nothing is dumped, nothing is migrated," >&2
    echo "  and no interrupted update is reconciled until this is settled." >&2
    if [ "$DV" -eq 2 ] && [ -n "$DUMP_ERR" ]; then
      echo "  what the check itself said, redacted: $DUMP_ERR" >&2
    fi
    echo "  look for it, whole:" >&2
    echo "    cd $LOOM_DEPLOY_DIR && docker compose -p loom --env-file $LOOM_DEPLOY_DIR/.env \\" >&2
    echo "      exec -T postgres pgrep -af pg_dump" >&2
    echo "  when that prints nothing, just run this command again — it clears the marker itself." >&2
    echo "  only if the container is gone and cannot be asked, clear it by hand, whole:" >&2
    echo "    rm -f $LOOM_DEPLOY_DIR/.dump-in-progress" >&2
    exit 1
  fi
fi

if [ -f "$STATE" ]; then         # F2: reconcile first, deploy nothing, and always exit non-zero
  reconcile_update_state || true
  exit 1
fi

if [ -f ./.deployed-sha ]; then  # F2: the record and the running image must agree before an update
  RECORDED="$(cat ./.deployed-sha)"
  IRC=0
  classify_inspect inspect --format '{{.Config.Image}}' "$OLD_CONTAINER" || IRC=$?
  if [ "$IRC" -eq 2 ]; then      # round 9's F3: a record to check and no answer is not agreement
    fail_and_restore "$OLD_CONTAINER not inspectable: $CLASSIFY_ERR — inspection unanswered"
  fi
  CONFIGURED=""; [ "$IRC" -eq 0 ] && CONFIGURED="$CLASSIFY_OUT"
  if [ -n "$CONFIGURED" ] && [ "$CONFIGURED" != "loom-live:$RECORDED" ]; then
    echo "the running container and the deployed record DISAGREE; reconcile by hand:" >&2
    echo "  $OLD_CONTAINER's configured image:   $CONFIGURED" >&2
    echo "  $LOOM_DEPLOY_DIR/.deployed-sha: $RECORDED" >&2
    echo "write the short SHA of the commit whose image is actually serving into" >&2
    echo "$LOOM_DEPLOY_DIR/.deployed-sha, sync it, and run this again" >&2
    exit 1
  fi
fi

# --- 3. fetch, refuse a topology change, require a clean checkout, fast-forward -----
git -C "$LOOM_REPO_DIR" fetch origin main

if [ -f ./.deployed-sha ]; then
  BASE="$(cat ./.deployed-sha)"
  git -C "$LOOM_REPO_DIR" cat-file -e "$BASE^{commit}" 2>/dev/null || {
    echo "deploy/.deployed-sha names $BASE, which this checkout does not have — deploy by hand" >&2
    exit 1; }
else
  BASE="$(git -C "$LOOM_REPO_DIR" rev-parse HEAD)"
fi

TOPO="$(git -C "$LOOM_REPO_DIR" diff --no-color "$BASE..refs/remotes/origin/main" \
          -- deploy/docker-compose.yml)"
if grep -Eq 'postgres|pgdata|volumes' <<<"$TOPO"; then   # here-string: no pipe, no SIGPIPE (F2)
  echo "database topology changed — deploy by hand (§9-style), not with live-update" >&2
  exit 1
fi

BRANCH="$(git -C "$LOOM_REPO_DIR" symbolic-ref --short HEAD 2>/dev/null || echo '(detached)')"
[ "$BRANCH" = main ] || { echo "the checkout is on $BRANCH, not main — deploy by hand" >&2; exit 1; }
[ -z "$(git -C "$LOOM_REPO_DIR" status --porcelain --untracked-files=all)" ] \
  || { echo "the checkout is not clean; refusing to deploy something that is not origin/main" >&2
       git -C "$LOOM_REPO_DIR" status --porcelain --untracked-files=all >&2; exit 1; }
git -C "$LOOM_REPO_DIR" merge --ff-only refs/remotes/origin/main
[ "$(git -C "$LOOM_REPO_DIR" rev-parse HEAD)" \
    = "$(git -C "$LOOM_REPO_DIR" rev-parse refs/remotes/origin/main)" ] \
  || { echo "HEAD is not origin/main after the fast-forward — deploy by hand" >&2; exit 1; }

LOOM_IMAGE_TAG="$(git -C "$LOOM_REPO_DIR" rev-parse --short HEAD)"
if [ -f ./.deployed-sha ]; then PREV_SHA="$(cat ./.deployed-sha)"; fi
IRC=0                            # round 9's F3: with a record present this read MUST succeed, and
classify_inspect inspect --format '{{.Image}}' "$OLD_CONTAINER" || IRC=$?   # it is never `|| true`
case "$IRC" in
  0) PREV_IMAGE="$CLASSIFY_OUT" ;;
  1) if [ -n "$PREV_SHA" ]; then                 # a record, and the daemon says there is no
       echo "$LOOM_DEPLOY_DIR/.deployed-sha names $PREV_SHA but $OLD_CONTAINER does not" >&2
       echo "exist, so this update would have nothing to restore to — deploy by hand" >&2
       exit 1                                    #   container: nothing to fall back to, so stop
     fi
     PREV_IMAGE="" ;;                            # no record either: the first deployment
  *) fail_and_restore "$OLD_CONTAINER not inspectable: $CLASSIFY_ERR — inspection unanswered" ;;
esac
if [ -n "$PREV_IMAGE" ]; then printf '%s\n' "$PREV_IMAGE" > ./.deployed-image
else                          rm -f ./.deployed-image; fi
echo "deploying $(git -C "$LOOM_REPO_DIR" rev-parse HEAD) as loom-live:$LOOM_IMAGE_TAG"

# --- 4. validate the Caddy configuration this update proposes ----------------------
STAGE="$(mktemp -d)"
CADDYENV="$(mktemp)"; chmod 600 "$CADDYENV"
cp "$SITES_DIR"/*.caddy "$STAGE"/ 2>/dev/null || true
cp loom.caddy "$STAGE"/loom.caddy
[ -f "$SPOOLENV" ] \
  || { echo "missing $SPOOLENV — Spool's environment file must be on the box" >&2; exit 1; }
SA="$(sed -n 's/^SITE_ADDRESS=//p' "$SPOOLENV" | tail -1)"
RA="$(sed -n 's/^REDIRECT_ADDRESSES=//p' "$SPOOLENV" | tail -1)"
printf 'SITE_ADDRESS=%s\nREDIRECT_ADDRESSES=%s\n' \
  "${SA:-localhost}" "${RA:-redirect.localhost}" > "$CADDYENV"
docker run --rm \
  -v "$SPOOL_CADDYFILE":/etc/caddy/Caddyfile:ro \
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

# --- 7. the intent record, then the quiesce — both armed BEFORE the stop (F2, F5) --
printf 'old_sha=%s\nold_image=%s\ntarget_sha=%s\ntarget_tag=%s\npending=%s\nstarted_at=%s\n' \
  "${PREV_SHA:-none}" "${PREV_IMAGE:-none}" "$LOOM_IMAGE_TAG" "loom-live:$LOOM_IMAGE_TAG" \
  "$(tr '\n' ' ' < "$PENDING_BEFORE.set")" "$(date -u +%Y%m%dT%H%M%SZ)" > ./.update-state.new
mv ./.update-state.new "$STATE"
sync -f "$STATE"
echo "update-state: $STATE written; ${PREV_SHA:-none} -> $LOOM_IMAGE_TAG"

QUIESCED=1
if [ -s "$PENDING_BEFORE.set" ]; then MIGRATE_STATE=not-attempted
else                                  MIGRATE_STATE=not-needed; fi
if ! dk compose -p loom stop loom; then
  IRC=0                            # the ONE place an unanswered inspection does not stop the run:
  classify_inspect inspect --format '{{.State.Running}}' "$OLD_CONTAINER" || IRC=$?
  case "$IRC" in                   #   the run is already exiting 1, and the safe answer is to
    0) RUNNING="$CLASSIFY_OUT" ;;  #   leave the quiesce ARMED so the recovery starts loom (F3)
    1) RUNNING="absent" ;;
    *) RUNNING="unknown: $CLASSIFY_ERR" ;;
  esac
  if [ "$RUNNING" = true ]; then
    QUIESCED=0                     # positively still running: nothing was stopped, disarm
    rm -f "$STATE"                 # and nothing is interrupted, so leave no record behind
    echo "docker compose stop failed and $OLD_CONTAINER is still running; nothing was stopped" >&2
  else
    echo "docker compose stop reported failure and $OLD_CONTAINER is not running ($RUNNING);" \
         "the quiesce stands, so the recovery will start it" >&2
  fi
  exit 1
fi

# --- 8. back up, with Loom already stopped and immediately before the migration ---
VOL=0                            # round 9's F3: three answers, and only ONE of them is "absent"
classify_inspect volume inspect loom_pgdata || VOL=$?
case "$VOL" in
  1) echo "backup: docker says there is NO loom_pgdata volume — first deployment, nothing to dump" ;;
  2) fail_and_restore "loom_pgdata not inspectable: $CLASSIFY_ERR — inspection unanswered" ;;
esac
if [ "$VOL" -eq 0 ]; then        # the volume is there, so a dump is mandatory
  IRC=0
  classify_inspect inspect --format '{{.State.Running}}' loom-postgres-1 || IRC=$?
  case "$IRC" in
    0) [ "$CLASSIFY_OUT" = true ] || dk compose -p loom up -d postgres ;;
    1) dk compose -p loom up -d postgres ;;
    *) fail_and_restore "loom-postgres-1 not inspectable: $CLASSIFY_ERR — inspection unanswered" ;;
  esac
  st=unknown
  PG_DEADLINE=$((SECONDS + 60))    # F1: an absolute deadline, not a count of iterations
  while [ "$SECONDS" -lt "$PG_DEADLINE" ]; do
    IRC=0
    classify_inspect inspect --format '{{.State.Health.Status}}' loom-postgres-1 || IRC=$?
    case "$IRC" in
      0) st="$CLASSIFY_OUT" ;;
      1) st=gone ;;                # the daemon says the container is not there: an answer
      *) fail_and_restore "loom-postgres-1 not inspectable: $CLASSIFY_ERR — inspection unanswered" ;;
    esac
    if [ "$st" = healthy ]; then break; fi
    case "$st" in
      unhealthy|gone)
        echo "postgres is $st; not migrating" >&2
        dk compose -p loom logs --tail 50 postgres 2>&1 | redact_logs >&2 || true
        exit 1 ;;
    esac
    sleep 1
  done
  [ "$st" = healthy ] || { echo "postgres did not become healthy within 60s" >&2
                           dk compose -p loom logs --tail 50 postgres 2>&1 | redact_logs >&2 || true
                           exit 1; }
  IRC=0
  classify_inspect inspect -f '{{range .Mounts}}{{.Name}} {{end}}' loom-postgres-1 || IRC=$?
  [ "$IRC" -eq 0 ] \
    || fail_and_restore "loom-postgres-1's mounts could not be read: $CLASSIFY_ERR"
  MOUNTS="$CLASSIFY_OUT"
  case " $MOUNTS " in
    *" loom_pgdata "*) ;;
    *) echo "loom-postgres-1 is not bound to loom_pgdata — deploy by hand" >&2; exit 1 ;;
  esac
  umask 077
  install -d -m 700 "$BACKUP_DIR"
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  FINAL="$BACKUP_DIR/loom-pre-update-$TS.sql.gz"
  TMP="$(mktemp "$BACKUP_DIR/.loom-pre-update-$TS.XXXXXX")"
  DUMP_RC=0
  # round 9's F2: the WHOLE pipeline runs under ONE deadline, in a subshell, so a gzip that never
  # returns is bounded exactly as the pg_dump client is. `set -o pipefail` inside makes the
  # subshell's status the pipeline's, so a failed pg_dump is still a failed dump.
  timeout --signal=TERM --kill-after=15 330 bash -c '
    set -o pipefail
    docker compose -p loom exec -T postgres pg_dump -U loom loom | gzip > "$1"' _ "$TMP" \
    || DUMP_RC=$?
  if [ "$DUMP_RC" -ne 0 ]; then
    if [ "$DUMP_RC" -eq 124 ] || [ "$DUMP_RC" -eq 137 ]; then
      echo "the dump did not finish within 330s — a conflicting lock, a stalled read or a stalled" \
           "write; the client is gone, so the server-side pg_dump is signalled and then LOOKED FOR" >&2
      dk compose -p loom exec -T postgres pkill -TERM -f pg_dump >/dev/null 2>&1 \
        || echo "NOTE: no server-side pg_dump answered the signal; it may already be gone" >&2
      DV=0                         # round 9's F2: a signal sent is not a process gone — and round
      dump_verdict || DV=$?        #   11's F1: only the container's OWN "gone" may skip the marker
      if [ "$DV" -eq 0 ]; then
        echo "the server-side pg_dump is gone: loom-postgres-1 answered DUMP_GONE" >&2
      else                         # DUMP_RUNNING, or a check that was never answered at all:
        if [ "$DV" -eq 1 ]; then
          echo "WARNING: the in-container pg_dump is STILL RUNNING — loom-postgres-1 answered" \
               "DUMP_RUNNING; it holds a snapshot and locks on the database this run was about" \
               "to migrate" >&2
        else
          echo "WARNING: the in-container pg_dump was NOT proven gone — the check itself was not" \
               "answered (exit $DUMP_RC, stdout '${DUMP_VERDICT:-none}', stderr" \
               "'${DUMP_ERR:-none}'); it may still hold a snapshot and locks" >&2
        fi
        printf '1\n' > "$DUMPMARK" && sync -f "$DUMPMARK" \
          && echo "WARNING: $LOOM_DEPLOY_DIR/.dump-in-progress is now on disk, so the NEXT" \
                  "invocation refuses to dump, migrate or reconcile until the container itself" \
                  "answers DUMP_GONE — and it outlives the restore that is about to remove" \
                  "$STATE" >&2 \
          || echo "WARNING: $LOOM_DEPLOY_DIR/.dump-in-progress could not be written; tell the" \
                  "next operator by hand" >&2
      fi
    fi
    echo "backup: pg_dump failed (exit $DUMP_RC); not migrating" >&2
    exit 1
  fi
  mv "$TMP" "$FINAL"; TMP=""
  echo "backup: $FINAL"
fi

# --- 9. migrate: a named one-off under a bounded timeout, reaped and VERIFIED ------
if [ "$MIGRATE_STATE" = not-needed ]; then
  echo "migrate: nothing pending — the schema already satisfies $LOOM_IMAGE_TAG's journal"
else
  MIGRATE_STATE=attempted
  dk rm -f "$MIGRATE_RUN" >/dev/null 2>&1 || true
  if timeout --signal=TERM --kill-after=30 600 \
       docker compose -p loom run --rm -T --name "$MIGRATE_RUN" migrate; then
    if record_deployed "$LOOM_IMAGE_TAG"; then
      MIGRATE_STATE=succeeded
      echo "migrate: applied; $LOOM_DEPLOY_DIR/.deployed-sha is now $LOOM_IMAGE_TAG"
    else
      MIGRATE_STATE=record-failed    # F2: a committed migration the record does not know about
      echo "migrate: applied, but $LOOM_DEPLOY_DIR/.deployed-sha could NOT be written" >&2
      exit 1
    fi
  else
    rc=$?
    MIGRATE_STATE=failed
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "the migrator did not finish within 600s; reaping its container" >&2
    else
      echo "the migrator client exited $rc; reaping its container before anything is read" >&2
    fi
    if ! reap_oneoff "$MIGRATE_RUN"; then
      MIGRATE_STATE=unreapable       # F1: unproven reap — no classification, no start, straight to R13
    fi
    echo "the migrator did not report success (exit $rc); reconciling before anything starts" >&2
    exit 1
  fi
fi

# --- 10. create the new container and prove it, through the one shared helper (F2) -
start_target_and_prove "$LOOM_IMAGE_TAG" || SP=$?

# --- 11. only a proven AND recorded target disarms the recovery -------------------
if [ "$SP" -eq 2 ]; then
  echo "loom-live:$LOOM_IMAGE_TAG is answering, but" \
       "$LOOM_DEPLOY_DIR/.deployed-sha could NOT be written" >&2
  exit 1
fi
[ "$SP" -eq 0 ] || exit 1        # created and never answered: the recovery is still armed (R4/R5)

# --- 12. install the site block if it changed, then reload Caddy -----------------
if ! cmp -s loom.caddy "$SITES_DIR/loom.caddy"; then
  HAD_PREV=0
  if [ -f "$SITES_DIR/loom.caddy" ]; then
    cp -p "$SITES_DIR/loom.caddy" "$SITES_DIR/loom.caddy.prev"; HAD_PREV=1
  fi
  install -m 644 loom.caddy "$SITES_DIR/.loom.caddy.new"
  mv "$SITES_DIR/.loom.caddy.new" "$SITES_DIR/loom.caddy"
  if ! dk exec spool-caddy-1 caddy reload --config /etc/caddy/Caddyfile; then
    if [ "$HAD_PREV" = 1 ]; then mv "$SITES_DIR/loom.caddy.prev" "$SITES_DIR/loom.caddy"
    else rm -f "$SITES_DIR/loom.caddy"; fi
    echo "caddy reload failed; the previous site configuration was restored" >&2
    exit 1
  fi
  echo "caddy: installed $SITES_DIR/loom.caddy and reloaded"
else
  echo "caddy: site block unchanged, not reloaded"
fi

# --- 13. public health, and the record of what was proved publicly ---------------
if [ "$BOOTSTRAP" = 1 ]; then
  echo "--bootstrap: skipped the public health check; deploy/.verified-sha not written"
  exit 0
fi
prove_url "$PUBLIC_URL" 120 3 || { echo "$PUBLIC_URL did not answer within 120s" >&2; exit 1; }
printf '%s\n' "$LOOM_IMAGE_TAG" > ./.verified-sha.new && mv ./.verified-sha.new ./.verified-sha
echo "health: ok"
```

#### The commentary, banner by banner

**0. Arguments, the path constants, and the inherited project name.** One optional flag, `--bootstrap`
(equivalently `LIVE_UPDATE_BOOTSTRAP=1`), which skips **only** banner 13, the public check. Any
other argument, or more than one, prints `usage: live-update.sh [--bootstrap]` to stderr and exits
**2** — the same exit-code convention as the migrate entry (§5.2), so a mistyped invocation is never
mistaken for a deployment failure, and both exits happen before the lock is taken and before
anything is read.

**Every operational path is a constant, and the five constants are the only absolute paths in the
file — review round 9's F1.** The previous draft spelled `/root/git/Spool/deploy/.env`,
`/root/caddy-sites`, `/run/lock/loom-live-update.lock`, `$HOME/backups/loom` and
`/root/git/Loom/deploy` wherever each was needed, and F1's observation is that a harness cannot run
such a file safely anywhere: on a developer's laptop the run dies at banner 4 because Spool's `.env`
is not there, and on the **server** — which is the one box where the harness would otherwise work,
because it is the box that has both checkouts — a Caddy-install or reload-failure case would copy
from and write to the real `/root/caddy-sites/loom.caddy` while `docker` was stubbed, which is a
test that edits production configuration without validating or reloading it. So the paths are now
five constants at the top of banner 0, with their production values, plus two derived from them
(`LOOM_REPO_DIR`, and Spool's `.env` and `Caddyfile` under `SPOOL_DEPLOY_DIR` — the third thing in
that directory is Spool's compose file, which this script never reads). Three properties matter and
each is deliberate:

- **They move in exactly one circumstance, and it announces itself.** `LIVE_UPDATE_TEST_ROOT` set
  and non-empty is an explicit **test mode**: every constant is re-pointed under that root and the
  script prints one `TEST MODE:` line naming it. There is no per-path override and no flag — one
  variable, one meaning, and a run that is in test mode says so on its first line of output, so an
  operator can never read a test run's log as a deployment's. Unset, every constant is its
  production value and nothing in the environment can change it.
- **`restore_prev`, `manual_recovery`, `record_failed_message`, `failed_start_after_migration`, the
  reconciliation and R14's reconstruction all use the constants**, which is the half of F1 that is
  about correctness rather than about testing: a recovery that reconstructed through a literal
  `/root/git/Loom/deploy` while the rest of the run used a constant would be two answers to one
  question. The printed manual commands still print **absolute production paths**, and the mechanism
  is simply that they print the constant's value: in production `$LOOM_DEPLOY_DIR` *is*
  `/root/git/Loom/deploy`, so R13's message is byte-identical to the previous draft's, and under the
  harness it names the temporary root — which is what makes those messages assertable at all.
- **The constant is also the self-location.** The previous draft's `cd "$(dirname "$0")"` is gone:
  a script that locates itself *and* hard-codes absolute paths has two answers to "where am I", and
  the one that governs everything else should govern this too. `cd "$LOOM_DEPLOY_DIR"` is the first
  thing after the constants, so `./.deployed-sha`, `./.update-state`, `loom.caddy` and
  `git -C "$LOOM_REPO_DIR"` all resolve against it.

**What test mode does not do.** It does not stub anything, weaken a check, skip a step or change a
deadline: the branch under test is the branch production takes. The stubs are §11.7's, on `PATH`,
outside this file. And the script has no way to tell that it is under a harness beyond the variable
it was given — which is the point: the thing being tested is the real file.

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

- **Initialised first.** `CREATED=0`, `HEALTHY=0`, `QUIESCED=0`, `MIGRATE_STATE=not-attempted`,
  `STATUS`, `STATUS_TEXT`, `FINAL=""`, `FINAL_RC=0`, `OLD_CONTAINER`, the two one-off container
  names, `PREV_SHA` and `PREV_IMAGE`, the temporary-file variables, `CLASSIFY_OUT`, `CLASSIFY_ERR`,
  `INSPECT_ERR`, `STATE` and `LOOM_IMAGE_TAG` all
  have values before the handler can fire — and the five path constants are assigned a banner
  earlier still, because the handler's own messages print them. Under `set -u` there is nothing left for the handler to
  trip over, and R13's message prints `none taken` rather than failing when there is no dump yet.
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

**And the two flags that end the recovery are now two, not one — review round 7's F3.** The previous
draft had a single `STARTED`, set the instant `docker compose -p loom up -d loom` returned, and R1
returned on it. That is a claim the command cannot support: `up -d` returns 0 when the container has
been **created and started by Docker**, which says nothing about whether the Node process inside it
went on to bind a port or connect a pool. A commit with a startup regression therefore disarmed the
recovery, the loopback check then failed and printed logs, and the run exited with Caddy serving 502
over a container that was never going to answer — with the old image sitting unused on disk and, on
the nothing-pending path, a schema that had never changed. So the state is split. `CREATED=1` means
"the new container exists, or may exist" and is armed **before** the `up`, for the same reason
`QUIESCED` is armed before the `stop` (round 6's F5): the command can half-succeed. `HEALTHY=1` means
"the loopback `/api/guidelines` answered", and it is set inside `start_target_and_prove` and nowhere else. **Only
`HEALTHY=1` disarms the recovery.** Between the two flags the recovery is not merely still armed, it
has its own branches: R4 for a failed start with no schema change, R5 for one with a committed
migration.

`cleanup` removes the staged Caddy directory, the two-variable env file, a partial dump, the
extracted previous compose file, both pending-set files with their `.err` companions,
`classify_inspect`'s one stderr sink, and the three
`.new` record temporaries. It does **not** remove `.update-state`, and since round 10's F2 it does
not remove `.dump-in-progress` either: those two are the artefacts meant to outlive a failed run,
and the branches that have settled them remove them themselves.
`recover` runs **before** `cleanup`, because R8, R10, R11 and R13 all read `$PENDING_BEFORE.set` and
a cleanup that went first would delete the evidence the classification is made from.

**Two more helpers sit beside them, and both are round 6's.** `redact_logs` is the filter of §8.1,
defined once here and used everywhere this script prints something it did not write itself —
Postgres's log in banner 8 (twice), Loom's in banner 10's helper, a reaped one-off's inside `reap_oneoff`, and
`migrate --check`'s own stdout and stderr in banner 6, in R8 and in banner 2's reconciliation — and
it is the filter R5 prints **as a literal `sed`** for the operator to paste, because the person
reading that message has no shell in which this function is defined. It is not decoration:
`main.ts` prints the Lobby's `/w/<43-character secret>` link unredacted on
the boot that creates it, by design and as the README says, so a log this script hands to whoever ran
it is a log that can carry that secret into the controller's transcript — which
[HANDBOOK.md](../../HANDBOOK.md) §5 forbids (F1). The filter is Loom's own logging rule
([CONTRIBUTING.md](../../../CONTRIBUTING.md) §"Logging" blanks a 43-character base64url run) applied
at the **reader** instead of only at the writer, so it holds for a line no Loom code wrote. It
replaces the `/w/` form first, so a Lobby link reads `/w/<redacted>` rather than
`/w/<43-char-token>` and a human can still see *which* kind of value was removed.
`reap_oneoff <name>` is round 6's F3 made into a **verified** transition by round 7's F1, and is
described at banner 9; it is a function rather than two inline blocks precisely because both callers
— the migrator run and `read_status` — need the identical lifecycle, and the previous draft had it in
one of them only.

**Four more helpers are round 7's, and each exists because a state the script can reach had no
command written for it.** `restore_prev` is the whole of "put the previous deployment back" in one
place, called by R4, R6 and R10 and falling through to R14; `record_failed_message` is the message
for a `.deployed-sha` that could not be written (F2); `failed_start_after_migration` is the message
for a committed migration whose image will not serve (F3); and `reconcile_update_state` is the
reconciliation every invocation runs before it fetches (F2, banner 2). They are functions for the
reason `reap_oneoff` is: each is reachable from more than one place, and a message written twice is a
message that will differ.

**And three helpers are round 8's, and between them they are the whole of F1 and F2.**

- **`dk` is `timeout 60 docker`, and after this round every `docker` call in the script is
  bounded.** Round 8's F1 is that a ceiling the script does not enforce is not a
  ceiling, and the ceiling was stated as a sum of the deadlines of *some* of the steps while the
  rest — the dump, the probes, and every ordinary `docker inspect`, `stop`, `start`, `rm`, `logs`
  and `up` — could each hang forever. A Docker daemon that accepts a connection and never answers
  is not exotic; it is the same daemon outage that produces round 7's F1, and one hung `inspect`
  inside the exit handler is an outage with no end and the update lock still held. So the rule is
  now mechanical and auditable, and the whole of it is: **`dk` everywhere, five call sites with
  their own longer deadline, two deliberately unbounded.** The five are the two
  `timeout 120 docker compose … up -d --no-build loom` (the helper's and `restore_prev`'s, 120
  rather than 60 because the `up` runs the compose `migrate` gate, which boots a container),
  `read_status`'s `timeout "$secs"` (120 at both its call sites), the dump's 300 and the migrator's
  600. The two unbounded ones are the **build** and the **Caddy validation** (banners 5 and 4), and
  they are unbounded on purpose: Loom is still serving while they run, so no outage ceiling depends
  on them, and a build that takes eleven minutes on a busy box must not be killed at ten. 60 s is
  two orders of magnitude more than any `dk` call needs, which is the point: it is not a performance
  bound, it is the difference between a failure and a hang.
- **`prove_url` is the only `curl` in the script**, and it is bounded twice. Each call carries
  `--connect-timeout 5 --max-time 20`, because F1's other half is that a server which *accepts* the
  connection and then blocks on Postgres makes a bare `curl` wait for ever — and counting
  iterations bounds nothing when the first iteration never returns. And the loop is bounded by an
  **absolute deadline** computed from bash's own `SECONDS`, not by a count of tries, so the wall
  clock a reader adds up is the wall clock the loop actually takes. Two call sites use it for the
  loopback (60 s, one second apart) and one for the public check (120 s, three seconds apart), and
  the reconciliation's cheap "is the target already answering" probe uses it with a 20 s deadline.
  **A deadline-bounded loop can overrun its deadline by at most one iteration**, which is one 20 s
  call plus one sleep, and §13's arithmetic says so rather than pretending otherwise.
- **`start_target_and_prove` is the one and only way this script starts a commit's image and then
  believes it — round 8's F2.** It arms `CREATED`, runs `docker compose -p loom up -d --no-build
  loom` under a 120 s bound, proves the loopback answer, writes `.deployed-sha`, sets `HEALTHY=1`
  and removes `.update-state`, in that order, and returns **0** (up, answering and recorded), **1**
  (no answer) or **2** (answering but the record could not be written). Four places used to start a
  target: banner 10, R7, R11 and the reconciliation's case (b) — and **two of them removed the
  intent record the moment compose returned**, which is F2's finding: a commit with a startup
  regression would have had the only record of an unfinished update deleted on the strength of a
  container's existence, while every request got a 502. Now the record is removed in one function,
  after one proof, and a target that does not answer leaves `.deployed-sha` and `.update-state`
  exactly as they were for the next run and for R5's message. The finding named three call sites;
  R7 is the fourth and gets the helper too, because it was the same mistake in the same words.

**And two helpers are round 9's, and between them they are the whole of F3.**

- **`classify_inspect` is the only way any inspection's result is read, and it has three answers,
  not two.** `docker inspect` and `docker volume inspect` are questions, and a question can fail to
  be *asked*. So the helper runs the call through `dk` — so it is bounded like everything else —
  captures its stdout into `CLASSIFY_OUT` and its stderr into `CLASSIFY_ERR`, and returns **0**
  (present: the format's output is in `CLASSIFY_OUT`), **1** (the daemon itself said `No such
  object`, `No such volume` or `No such container` — an answer, and the only kind of absence this
  script believes), or **2** (**not answered**: `timeout`'s 124, a daemon error, a permission
  failure, an empty message, or anything a future Docker prints). Round 7's F1 made `reap_oneoff`
  classify its own two inspections this way; round 9's F3 is that *every* other inspection in the
  file was still reading a failure as an absence, and the fix is one function rather than nine
  `case` blocks, so a tenth call site cannot be written the old way by accident. The error text is
  matched with a `case` over a captured string, never a `grep` in a pipe, for the `SIGPIPE` reason
  banner 3 gives; `CLASSIFY_ERR` has its newlines squeezed to spaces so it prints on one line.
- **`fail_and_restore` is what a `2` costs.** It prints the reason with `— stopping the run` and
  exits 1, which lands in the one exit handler: if the quiesce had happened, the recovery runs and
  Loom is restored or R13 is printed; if it had not, nothing has been touched and the run simply
  stops. **The rule it enforces is that an unanswered inspection never lets the script proceed** —
  not into a build, not into a quiesce, not into a dump, not into a migration. It is called only
  from the main path. The functions that run *inside* the handler (`restore_prev`,
  `reconcile_update_state`, `manual_recovery`, `record_failed_message`) must not exit, so they take
  the same decision in their own words: they refuse to act on the object, print `inspection
  unanswered` or `UNKNOWN`, and leave the records in place.

**And `record_deployed` now ends in `sync -f`, which is what makes "durably written" a fact.** The
`printf` + `mv` pair was already atomic — a reader sees the old content or the new one, never half a
line — but atomic is not durable: the rename can sit in the page cache while the update goes on to
stop containers, and a host that loses power in that window comes back with the *old* record over
the *new* schema. `sync -f ./.deployed-sha` flushes the filesystem holding it before the function
returns, so the record is on disk before anything is believed about it. It is `sync -f` and not
`sync`, because flushing every filesystem on a box that also runs the shop's database is a
side effect this script has no business having. `sync` ships in coreutils on Ubuntu; if it were
missing, `record_deployed` would fail and the run would take the `record-failed` branch — the safe
direction, because that branch touches nothing and prints what disagrees with what.

**And `.gitignore` gains eight explicit lines, not seven.** `deploy/.deployed-sha`,
`deploy/.verified-sha`, `deploy/.deployed-image`, `deploy/.update-state` and — since round 10's F2
— `deploy/.dump-in-progress` are server state written into the checkout, and so are the three
temporaries the atomic writers use,
`deploy/.deployed-sha.new`, `deploy/.verified-sha.new` and `deploy/.update-state.new`: a run killed
between the `>` and the `mv` would otherwise leave an untracked file that trips the **next** run's
`--untracked-files=all` check, which is exactly the kind of self-inflicted refusal this script must
not have. `cleanup` removes the three temporaries anyway; the ignore lines are for the run that never
reaches `cleanup`. **`cleanup` deliberately removes neither `.update-state` nor
`.dump-in-progress`**: both are meant to outlive a failed run, and each is removed only by the
branch that has disproved it. Eight explicit lines rather than a `deploy/.deployed-*` glob, because
a reviewer should be able to read what is ignored and a glob would silently cover a ninth file
nobody decided on — and because neither `.update-state` nor `.dump-in-progress` would have matched
that glob at all.

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

**Then, before the fetch, three questions about the state the box is actually in. The middle one and
the last are review round 7's F2; the first is round 10's F2, and it is asked before both.**

**The first is an unresolved dump, and since round 10's F2 it is its own file rather than a key in
somebody else's record.** If `deploy/.dump-in-progress` exists, a previous run's pre-update
`pg_dump` timed out and could not be proven gone inside the Postgres container (banner 8), so a
process may still hold a snapshot and locks that a new dump would queue behind and a migration
would fight. The script therefore asks, before anything else: one bounded, in-container
`dump_verdict`, classified exactly as banner 8 classifies it — **the container must say `DUMP_GONE`
itself, and nothing else counts.** On that answer the marker is removed, one line says so, and the
run carries on into the two questions below. On `DUMP_RUNNING`, and on every answer that is not an
answer at all, it prints and stops:

    REFUSING TO RUN — a previous update's pg_dump was NOT proven to have stopped inside
      loom-postgres-1: loom-postgres-1 answered DUMP_RUNNING, so it may still hold
      a snapshot and locks on the live database. Nothing is dumped, nothing is migrated,
      and no interrupted update is reconciled until this is settled.
      look for it, whole:
        cd /root/git/Loom/deploy && docker compose -p loom --env-file /root/git/Loom/deploy/.env \
          exec -T postgres pgrep -af pg_dump
      when that prints nothing, just run this command again — it clears the marker itself.
      only if the container is gone and cannot be asked, clear it by hand, whole:
        rm -f /root/git/Loom/deploy/.dump-in-progress

**Why the container prints a verdict instead of the script reading `pgrep`'s exit status, which is
round 11's F1.** The previous draft ran `dk compose -p loom exec -T postgres pgrep -f pg_dump` and
took **exit 1 with empty output** for `pgrep`'s own "nothing matched". That inference is wrong,
because the exit status the script sees is not `pgrep`'s — it is whatever came back through
`timeout`, `docker` and Compose, and **a Compose or daemon failure exits 1 with empty stdout too**,
putting its diagnosis on stderr, which that command threw away. So a transient exec failure — the
container restarting, the daemon busy, a permission error — deleted the hazard marker and announced
that `pgrep` had found nothing, during exactly the outage in which a `pg_dump` is most likely to be
alive. F1 reproduced it against a Docker stub that exits 1 with stderr only.

The fix is that the **container itself** answers, in words of its own:

    dk compose -p loom exec -T postgres sh -c \
      'command -v pgrep >/dev/null 2>&1 || { echo DUMP_NO_PGREP; exit 0; }
       pgrep -x pg_dump >/dev/null 2>&1; p=$?
       case "$p" in 0) echo DUMP_RUNNING ;; 1) echo DUMP_GONE ;; *) echo "DUMP_PGREP_$p" ;; esac'

The wrapper **always exits 0 when it ran at all**, so a non-zero status now means exactly one
thing — the check never happened — and the verdict is carried by a token on stdout rather than by a
number two different layers can both produce. `dump_verdict` classifies that into three, the same
shape `classify_inspect` gives an inspection, and for the same reason:

| The answer | The verdict | What happens |
| --- | --- | --- |
| exit 0, stdout exactly `DUMP_GONE` | **gone** | banner 2 clears the marker and the run continues; banner 8 does not write one |
| exit 0, stdout exactly `DUMP_RUNNING` | **still running** | the marker is kept or written, and banner 2 refuses |
| anything else — non-zero exit, empty stdout, `DUMP_NO_PGREP`, `DUMP_PGREP_<n>`, any other stdout, the 60 s bound | **unanswered** | treated exactly as "still running": the marker is kept or written, banner 2 refuses, and the check's own stderr is printed through `redact_logs` so the operator can see what actually failed |

**Why the wrapper is three lines and not the obvious one.**
`if pgrep -f pg_dump >/dev/null; then echo DUMP_RUNNING; else echo DUMP_GONE; fi` reads every
non-zero exit as "nothing matched" — which reintroduces round 9's F2 one layer further in. An image
without `pgrep` makes `sh` fail the condition with 127 and the `else` branch then prints
**`DUMP_GONE`**: a confident, false acquittal, and precisely the class of mistake this finding is
about. So the wrapper asks whether `pgrep` exists before it trusts it, and reads `pgrep`'s exit
status by number rather than by truthiness — inside the container, where that status really *is*
`pgrep`'s, which is the whole difference from the command it replaces. `DUMP_NO_PGREP` and
`DUMP_PGREP_<n>` are not extra verdicts; they fall into "unanswered" like everything else, and
exist only so the printed message names the thing the operator has to fix. `postgres:17-alpine`
does ship busybox's `pgrep`, so neither is expected — but "expected" is what the previous two
findings were also about.

**Why the match is `pgrep -x` and not `pgrep -f`, which is round 12's F1 and is the fix that round
11's own fix made necessary.** `-f` matches against each process's **whole command line**, and the
whole command line of the `sh` this wrapper is running *is* the wrapper text, and the wrapper text
contains the pattern it is searching for. `pgrep` excludes only its own process, never its parent,
so the shell that is about to print the verdict is itself a match, and `pgrep -f pg_dump` inside
that shell therefore answers **`DUMP_RUNNING` unconditionally**: with a dump, without a dump, on an
empty container. That is not a false alarm anyone would have noticed once, either — it is
permanent. Banner 8 would write `deploy/.dump-in-progress` after every timed-out dump whether or
not anything was still running, banner 2 would then refuse every later invocation, and the marker's
**only** documented way of being cleared is a `DUMP_GONE` this wrapper could never produce. The
hazard gate would have latched shut for good, and the operator's printed escape (`rm -f`) would be
the only way out of a deployment path that is supposed to clear itself. The defect did not exist
before round 11 because the old command ran `pgrep` as the container's argv directly, with no shell
around it.

`-x` is the right match and not merely a different one: it matches against the process **name**
alone and requires the whole name to be equal. PostgreSQL's dump client's process name is exactly
`pg_dump`, so a real dump matches; the wrapper's own process is `sh`, which does not; and
`pgrep`'s own process is excluded as before. The name is also the thing the container controls and
the command line is not — a dump invoked as `/usr/local/bin/pg_dump`, with a long argument list, or
through Compose's `exec`, is `pg_dump` by name in every one of those spellings. **The two
operator-facing commands nearby keep `-f` on purpose and are not the same case**: the refusal
message's `docker compose … exec -T postgres pgrep -af pg_dump` and banner 8's
`exec -T postgres pkill -TERM -f pg_dump` are each the container's argv directly, with **no wrapper
shell to match**, and `pgrep`/`pkill` never match themselves. `-f` is what a human wants there — it
prints the arguments, which is how an operator tells one dump from another — and `-f` is what the
`pkill` wants, because it is aimed at a process that may have been started with a path.

**And this one was not settled by reading.** Round 11's wrapper was read by two reviewers and by
this document's own commentary table without the self-match being seen, so the corrected wrapper
was run as written, in disposable containers, against both a container with no dump in it and a
container with a real blocked `pg_dump`: §11.6 records the exact two commands and their exact
outputs.

The stderr is worth the two lines it costs: "exit 1, nothing on stdout" is the same picture for a
container that is not running, a daemon that is not answering and a socket the operator has no
permission on, and the message that names which one is the difference between a two-minute fix and
an hour. It goes through `redact_logs` because everything this script prints does (§8.1). And the
rule that makes the whole marker worth having is unchanged and is now enforceable: **only a
definite `DUMP_GONE` clears the hazard; a question that was not answered is not an answer.**

**Why a separate file, which is round 10's F2 accepted with the simpler of the two shapes it
offered.** The previous draft appended `dump_in_progress=1` as a seventh key to
`deploy/.update-state`, and that put a fact with one lifetime inside a record with another. The
run that writes the marker is, by construction, a run whose dump failed — which is **R6**, the
branch that restores the previous deployment and, on success, removes `.update-state` because the
update it described has been undone. So the marker went with it: the next invocation found no
record, ran no reconciliation, and proceeded straight into a fetch, a build, a quiesce and a dump
that would queue behind a `pg_dump` nobody had ever proved gone — which is exactly the two-run
refusal §11.7 asserts, failing. The other shape F2 offered, making R6 preserve that one key while
removing the rest, would work and is **not** taken: it makes `.update-state` a file whose lifetime
depends on which of its keys is present, and every reader of it would then have to know that. The
invariant is cleaner said in two files — **`.update-state` is the intent of one run, and
`.dump-in-progress` is a hazard that outlives runs** — and each is then removed by the one thing
that has disproved it: the intent by a proved target or a proved restore, the hazard by a container
that answered `DUMP_GONE`. It is written where banner 8 wrote the key, atomically enough (a
41-byte `printf` and a `sync -f`; a torn write still leaves the file, and the file is the marker)
and it is checked here, at the top of banner 2, **whether or not an intent record survived beside
it** — which is the whole point.

**The second is the interrupted update.** If `deploy/.update-state` exists, a previous run wrote it
before quiescing and never reached the point where it is removed, so the box is in the middle of an
update that nothing is still driving. The script therefore **reconciles that record and exits
without deploying anything new**, every time, before `git fetch` is allowed to bring in another
commit. Why it must come before the fetch: the two sequences F2 named have no trap in them at all
— a host that loses power and a shell killed with `SIGKILL` — so the only thing that can act on
them is the *next* invocation, and the next invocation is exactly the moment when a merge session
is about to pull a newer commit on top of a half-applied one. `reconcile_update_state` reads the
five keys, then:

- **Before it asks the box anything, it reaps the interrupted run's migrator — round 10's F1, and
  it is the first thing the function does.** The killed run's `loom-migrate-run` is the container
  that was *applying*, and a client's death says nothing about it (banner 9). If it is still alive
  its transaction has not committed **yet**, so every question below has an honest answer that is
  about to stop being true: the cheap `{{.Config.Image}}` probe, the status read, and the
  before/after comparison would all report a database that nothing had changed, case (a) would
  conclude "nothing committed", `restore_prev` would start the **old** image and clear the record —
  and the surviving migrator would commit the new schema underneath it, with the only record that
  anything was ever unfinished already deleted. That is §1's interrupted-update guarantee and its
  schema/image guarantee broken in one sequence, by a run whose every step was correct. So
  `reap_oneoff "$MIGRATE_RUN"` runs first, with the **same verified semantics** banner 9 gets: a
  classified inspection, a bounded stop/kill/wait, a re-inspection that must answer `exited` or
  `dead`, and a `2` for anything else. On a `2` the reconciliation **refuses**: it reads no status,
  starts nothing, restores nothing, **keeps `deploy/.update-state`**, prints which container is in
  the way, the `docker inspect` and the redacted `docker logs` to look at it with, the
  `docker rm -f` plus a rerun to settle it, and returns non-zero. It is R3's rule
  (`MIGRATE_STATE=unreapable` → R13) applied to the one path that had no way to reach R3, because
  the run that is reconciling is not the run that started the migrator. `loom-migrate-check` is
  reaped immediately afterwards **for symmetry** and with the same asymmetry `read_status` already
  has: it can only be holding a read connection, so an unproven reap there is a warning rather than
  a refusal.
- **Then it asks whether the target is already up and answering.** `docker inspect --format
  '{{.Config.Image}}' loom-loom-1` naming `loom-live:<target>` **and** the loopback URL answering
  means the interrupted run got as far as a healthy target and died before removing its own record —
  so the record is completed (`record_deployed <target>`, `rm` the state file) and that is all. This
  probe is first because it is the cheapest and because it is the one case where the interruption
  changed nothing that needs undoing. **The inspection is `classify_inspect`'s** (round 9's F3): an
  unanswered one settles nothing, so the reconciliation prints `inspection unanswered`, starts
  nothing, leaves the record in place and asks for a hand.
- **Otherwise it reads the migration status afresh, under the same 120 s bound as R8, and compares it
  with the recorded pending set** — the set written before the quiesce, which is why that set is in
  the record and not recomputed: the point of the comparison is what has changed since, and a set
  read now cannot tell you that. Three answers, and they are the same three the recovery makes,
  which is deliberate: **(a)** every recorded tag is still pending, or nothing was pending at all, so
  nothing committed — `restore_prev` puts the recorded old deployment back, by its image id and only
  once it answers, and the record is cleared;
  **(b)** none of them is pending, so the migration committed — `.deployed-sha` is set to the target
  and the target is started **through `start_target_and_prove`**, after asserting that this checkout
  is still at the target, since its compose definition is what would start it; a target that does
  not answer there leaves the record in place and prints R5's `LOOM IS DOWN`, which is round 8's F2;
  **(c)** the status could not be read, or some tags
  are applied and others are not — the manual-recovery message of R13, and the record is **left in
  place** so the next invocation asks again rather than deploying over an unknown schema.

Every one of those paths exits **non-zero**, including the successful ones, because no new commit was
deployed: a merge session must not read a reconciliation as a deployment, and the fix in every case
is to run the command again once the outcome has been read.

**The third question is whether the record and the running container agree.** `.deployed-sha` says
which commit's image is serving; `docker inspect --format '{{.Config.Image}}' loom-loom-1` says which
one actually is. If both exist and they disagree, this script will not start an update: it prints
**both values** and stops. The reason is that everything downstream believes that file — the topology
guard uses it as the diff's base, and the recovery starts the image it names — so a disagreement is
not a warning, it is the statement that one of the two is wrong and that no script can decide which.
Reconciliation is a human writing the short SHA of the commit whose image is genuinely serving into
`/root/git/Loom/deploy/.deployed-sha` and running the command again. The check is skipped, correctly,
in the two cases where there is nothing to compare: no record yet (the first deployment) and no
container yet — **and since round 9's F3 "no container" means the daemon said `No such object`, not
that the question failed.** The inspection goes through `classify_inspect`, and a `2` calls
`fail_and_restore`: a record exists, so there is something to check, and a check that could not be
made is not agreement. Nothing has been quiesced at that point, so the run simply stops with the
daemon's own message on stderr.

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

**The last lines of the banner.** `LOOM_IMAGE_TAG` is the short SHA of the commit being deployed
and is exported once, in banner 1, so the build, the two one-offs and the `up` all name
`loom-live:<short SHA>` (§4.2). Then the run captures the two facts a restore is made of, and it
captures them **into variables** rather than reading them back from files later: `PREV_SHA` from
`deploy/.deployed-sha`, and `PREV_IMAGE` from `docker inspect --format '{{.Image}}' loom-loom-1` —
the **immutable id** of the image the running container was created from, not a tag, so nothing can
re-point it, and in particular the same-commit rebuild of a no-change rerun cannot. The pair is
captured once, in one place, and that is what makes the dangerous mistake unavailable: a restore
built from the two *files* could pick up `.deployed-sha` **after** banner 9 had moved it to the new
commit and then tag the **old** image as the new commit's — the old binary under the new schema's
name, permanently. `PREV_SHA` and `PREV_IMAGE` cannot drift apart, because they are assigned
together, before anything is built or migrated.

**And that capture is no longer `|| true`, which is round 9's F3's second half.** The previous draft
wrote `PREV_IMAGE="$(docker inspect … || true)"`, so a daemon that was briefly unreachable — or
slow enough for `dk`'s 60 s to fire — produced an **empty** `PREV_IMAGE` and the run carried on into
the build and the quiesce. If the dump or the migration then failed, `restore_prev` refused for want
of a recorded image while the exact stopped previous container was very likely still sitting there,
and Loom stayed down for no reason at all. So the read goes through `classify_inspect` and the three
answers are three different things:

- **0** — the id, which is what `PREV_IMAGE` is for.
- **1**, the daemon saying there is no such container: with **no** `.deployed-sha` this is the first
  deployment and is normal, `PREV_IMAGE` stays empty and the stale `.deployed-image` file, if one is
  there from a previous run, is removed rather than left to name an image that is no longer what is
  deployed — a file that lies is worse than a file that is absent. With a `.deployed-sha` **present**
  it is a contradiction: the record names a deployment and nothing holds it, so this update would
  quiesce with nothing to fall back to. The script prints both facts and stops, **before** the build,
  and the operator reconciles the same way banner 2's disagreement is reconciled.
- **2** — `fail_and_restore`. The question was not answered, so the run stops before the build and
  before the quiesce, which is the state F3 asks for in as many words.

`PREV_IMAGE` is also written to `deploy/.deployed-image`, which is now the human's copy and the value
`.update-state`'s `old_image=` is taken from; no branch of the script reads that file any more.

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
is the file itself — `[ -f "$SPOOLENV" ]`, on its own line with its own message, and since round 9's
F1 both that file and the Caddyfile the disposable container mounts are derived from
`SPOOL_DEPLOY_DIR`, so a harness moves them with everything else and no case of §11.7 can read the
shop's real environment — because a missing
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
both this banner and R8: the first bootstrap would have stopped here, before `loom.caddy` was ever
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
same pipeline could abort R8 at precisely the moment the after-set is empty, which is the state R11
exists to recognise. `sed '/^$/d'` deletes blank lines without an exit status to promote, so the empty
case yields an empty file and exit 0. §11.2's contract test pins both the empty and the non-empty
extraction.

**Four things this banner also buys**, each a reason it is here rather than folded into the
migration:

- **It refuses a drifted journal while Loom is still serving — round 8's F4.** `migrationStatus`
  validates that the journal's `when` values are strictly increasing and that the database's rows
  are an exact `(created_at, hash)` prefix of it, and **throws** otherwise (§5.1), so a backdated
  migration that merged after a newer one — the one shape that used to be reported as "applied" and
  silently skipped — makes this `--check` exit **1** and stops the update here: no quiesce, no dump,
  no migration, and a message naming the first mismatch for whoever has to regenerate the file.
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
and R8 reaches R13 with nothing of its own left behind. The `rm -f` at the top stays, because a run
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

**7. The intent record, then the quiesce.** `deploy/.update-state` is written first, then
`QUIESCED=1` and a `MIGRATE_STATE` of `not-attempted` or `not-needed` according to whether anything
is pending, and **then** `docker compose -p loom stop loom`. **No `.deployed-sha` is written here, and
that is round 5's F3** (see banners 9 and 10).

**Why the intent record is written here, and why here is the only place it can be — round 7's F2.**
This is the last line before the first irreversible act. Everything above it can be abandoned with
nothing to undo; everything below it leaves the box in a state that has to be reasoned about. The
`EXIT` handler covers every *exit*, but two interruptions are not exits: a power loss and a
`SIGKILL`. Against those the only carrier is a file, so the file is written before the stop and
carries exactly what a later run cannot recompute:

- **`old_sha` and `old_image`** — the deployment that was serving. `old_image` is an image id, so a
  reconstruction can be exact even after the tag has moved.
- **`target_sha` and `target_tag`** — what this run was deploying. The target's image is already
  built when this line runs (banner 5), which is a second reason the record belongs here and not
  earlier: a record naming an image that was never built would send a reconciliation at nothing.
- **`pending`** — the journal tags outstanding a moment ago. This is the irreplaceable one. A later
  run can read the pending set *now*, but "which tags were outstanding before the migrator ran" is
  the only thing that turns that reading into an answer, and once the run is dead it exists nowhere
  else.
- **`started_at`** — so whoever reads the reconciliation knows whether they are looking at four
  minutes ago or last Tuesday.

The write is atomic and `sync`ed for the same reason `record_deployed` is: a record still in the page
cache when the lights go out is not a record. A failure to write it stops the run under `set -e`
**before** `QUIESCED=1`, so nothing has been stopped and there is nothing to recover — the right
direction to fail in, and the reason the write is above the flag rather than below it.

**And since round 8's F2 it is removed in exactly two places, both of which have proved something
first.** `start_target_and_prove` removes it once the target has answered the loopback check **and**
`.deployed-sha` durably names it — which covers banner 10, R7, R11 and the reconciliation's case (b)
in one function, because all four go through the helper. `restore_prev` removes it once the previous
deployment has answered that same check — which settles the same record in the other direction, by
undoing the update rather than finishing it, and is why F2's "only inside that helper" is read here
as "only after a proof": a restore that left the record behind would send every later invocation
into a reconciliation of an update that has already been undone. One exception, and it is
deliberate: on the torn-stop branch where `docker inspect` positively answers that the container is
**still running**, the record is removed too, because nothing was stopped and there is therefore no
interrupted update for the next run to reconcile.

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
not knowable and R6 starting an already-running container is a harmless no-op), and anything a future
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

**What it costs, stated exactly.** Between this banner and the moment banner 10's helper gets its
loopback answer, Loom is not running: Caddy has nothing to reach on the `web` network and answers
**502** to every request, the web client's stream drops, and the reviewer's connector poll fails.
The duration is the dump plus the migration plus the container start and its first answer — on this
database, today, **well under a minute**, and the dump is the slow part.

**Every Docker and network operation after the quiesce carries a deadline, which is review round
8's F1 — and there is still no ceiling on the outage as a whole, which is review round 9's F2.**
Round 8 fixed a real defect: the `pg_dump` ran with no timeout at all, both `curl` polls counted
iterations without bounding a single call, and every ordinary `docker` call was unbounded. Round 8's
answer then over-claimed, and this round removes the over-claim. The deadlines are these, and every
one of them is a constant in the listing:

| Phase, after the quiesce | Deadline, as the listing enforces it |
| --- | --- |
| The stop | `dk compose stop loom` = **60** |
| The backup | volume inspect 60 + running inspect 60 + `up -d postgres` 60 + the health loop's absolute 60 (plus at most one 60 s inspect in flight) + mounts inspect 60 + the dump pipeline's `timeout --signal=TERM --kill-after=15 330` = **705**, and on a dump that times out a further **120** for the `pkill` and the `dump_verdict` check that looks for what the `pkill` was aimed at |
| The migration | name-clearing `rm -f` 60 + `timeout --signal=TERM --kill-after=30 600` = **690**, and on any non-success a reap of at most **420** (seven `dk` calls: inspect, stop, kill, wait, logs, inspect, rm) |
| R8's status read | `rm -f` 60 + `timeout 120` = **180**, and **600** if that read itself fails and its container has to be reaped |
| Starting and proving a target | `timeout 120` on the `up` + the loopback loop's 60 (plus at most one 20 s `curl` in flight) = **200** |
| Restoring the previous deployment | inspect 60 + start 60 + prove 80 = **200** on the recorded image id, or inspect 60 + rm 60 + tag 60 + `up` 120 + prove 80 = **380** when it has to be reconstructed |
| R13's message | one `dk inspect` for the image-id check = **60** |

Summed per branch — **and these sums bound the Docker and network work on each branch, nothing
more; they are not a bound on the outage**: a happy update with nothing pending is 60 + 705 + 200 =
**965 s**; one with a migration is 60 + 705 + 690 + 200 = **1655 s**; a dump that hits its deadline
is 60 + 825 + 200 = **1085 s** of Docker and network time before the previous deployment is serving
again; and the longest such branch is a migrator that fails, a reap that succeeds and a status read
that then does not — 60 + 705 + 1110 + 600 + 60 = **2535 s**. Every one of those is every deadline
hitting its limit at once, which nobody expects to see. What they are *for* is that a reader can
check them against the listing, line by line; what they are **not** is a promise about how long
Loom can be down.

**Because two things after the quiesce are not bounded by anything, and this is round 9's F2 stated
plainly.**

- **Local storage that stalls.** The dump pipeline now runs *whole* under one
  `timeout --signal=TERM --kill-after=15 330`, so a `gzip` that blocks is bounded exactly as the
  `pg_dump` client is — **as long as the kernel will deliver the signal**. A process blocked in
  uninterruptible I/O on a stalled or full filesystem ignores `TERM` and `KILL` alike, and `timeout`
  waits for a child it cannot kill, so the 330 becomes a wait with no end. `record_deployed`'s
  `sync -f` and banner 7's `sync -f` of the intent record are not under a `timeout` at all: putting
  one there would leave a 41-byte write in an unknown state, which is worse than waiting.
- **An in-container `pg_dump` in the same state.** The host-side `timeout` kills the *client*; the
  `pkill -TERM -f pg_dump` inside the container reaches a process the kernel will signal and not one
  that is wedged in I/O. The script asks afterwards (below) and says what it found, but it cannot
  end such a process.

**What happens then, exactly, because a spec that names an unbounded wait owes the reader that.**
The script has not exited, so **no trap runs**: Loom stays stopped, `/run/lock/loom-live-update.lock`
stays held, `deploy/.update-state` stays on disk, `https://loom.3dbox.dk` answers 502 to everyone,
and every later invocation reports only that another live-update is running. Nothing pages anyone
(§13). It ends when an operator intervenes, and what they do is §13's manual-rollback bullet: kill
the stuck run, deal with the storage (`df -h`, the disk risk of §14.3), and bring Loom back with the
absolute `cd /root/git/Loom/deploy && LOOM_IMAGE_TAG=<short SHA> docker compose -p loom --env-file
/root/git/Loom/deploy/.env up -d --no-build loom` — then settle `.deployed-sha` and remove
`.update-state` last, exactly as R13's message says.

**The rest of what is unbounded is short and is here for completeness.** The local filesystem and
`git` work — `mktemp`, `install -d`, `cmp` and `restore_prev`'s
`git show "$PREV_SHA:deploy/docker-compose.yml"` — is a few kilobytes on a local disk, and a box
where those hang is the box the bullet above describes. And the whole of the
pre-quiesce phase — the fetch, the Caddy validation, the build — is deliberately unbounded, because
Loom is serving throughout it and no outage ceiling depends on it. **Downtime of seconds per update
is accepted; zero downtime is not promised, and neither is a maximum.** The build, which is the
minute-or-two part of an update, is on the other side of this line on purpose: it finishes while
Loom is still serving.

**8. The backup.** With Loom already stopped and immediately before the migration, and precise about
what "nothing to back up" means. Three cases, decided in this order, because conflating the second
with the third is how a live database gets migrated with no dump:

- **`docker volume inspect loom_pgdata` answers `No such volume`** — there is no volume, so this is
  the first deployment and there is nothing to dump. **Skipped with a printed line**, and that is
  correct. **It is the daemon's own answer that decides this, and nothing else — review round 9's
  F3.** The previous draft wrote `if ! dk volume inspect loom_pgdata >/dev/null 2>&1`, which reads
  *any* failure as "no volume": a daemon that is briefly unresponsive, a `dk` that hits its 60 s and
  returns **124**, a permission error — each of them, after Loom has already been stopped, would
  have taken the "first deployment, nothing to dump" branch and gone on to migrate the live volume
  **with no backup behind it**, while the script's own text said an absent volume was the only
  backup-skip condition. So the call goes through `classify_inspect`, and only a **1** — the daemon
  saying `No such volume` — is first deployment. A **2** is `fail_and_restore "loom_pgdata not
  inspectable … inspection unanswered"`: the run stops, and because the quiesce has already
  happened the exit handler runs the recovery, which restores the previous deployment (R6). The
  migrator is never reached.
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

**And the other three inspections in this banner are classified too.** Whether `loom-postgres-1` is
running, its health status inside the wait loop, and its mounts all go through `classify_inspect`:
an absence the daemon states is an answer the banner already had a branch for (`up -d postgres`,
`gone`), while a **2** is `fail_and_restore` in every one of the three. The health loop is where
that matters most: the previous draft's `|| echo gone` turned an unanswered inspection into the
statement "postgres has exited", which is a wrong reason printed with confidence — the run stopped
either way, and now it stops saying what actually happened.

**The wait is bounded, and since round 8's F1 it is bounded by a clock rather than by a count.**
`PG_DEADLINE=$((SECONDS + 60))` and a `while` on `SECONDS`, where the previous draft counted sixty
iterations of a poll whose own `docker inspect` had no deadline — sixty unbounded calls are not a
minute. The healthcheck of §4.2 is `pg_isready` every 5 s with 20 retries, and a Postgres that
starts over an existing volume is healthy in a few seconds, so a minute is generous without being a
hang. An `unhealthy` verdict, or a container that has exited
or is not there at all, **fails immediately** rather than waiting the minute out. A timeout exits
non-zero after printing the last fifty lines of Postgres's log **through `redact_logs`**, as every
log this script prints now goes (F1). On every one of those paths the
**migration is not attempted**: `MIGRATE_STATE` is still `not-attempted` and `CREATED` is still 0, so
the exit handler takes
R6 — the exact container this run stopped is started again, so Loom is serving — and the lock goes
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
`mkdir -p` and a bare `>` inherit whatever the root shell's umask happens to be — and the directory
is `BACKUP_DIR`, a constant since round 9's F1, rather than `$HOME/backups/loom`, so a harness cannot
write into a real backup folder by exporting `HOME` and no production run depends on which `HOME`
root's shell happens to have. The temporary file is
in the **same directory** so the `mv` is a rename within one filesystem and therefore atomic; the
subshell's `pipefail` makes a failed `pg_dump` or `gzip` a non-zero `DUMP_RC` and the script exits,
and because the redirection went to the
temporary name, `cleanup` removes the partial file — the earlier draft's redirection created the
final `.sql.gz` *before* the pipeline ran, so a failure left a truncated file whose name says
"backup" behind. The dot prefix keeps a partial file out of a `ls ~/backups/loom` glance, and
clearing `TMP` after the `mv` stops `cleanup` deleting the finished dump. The path is printed.

**And the dump is a managed lifecycle under a deadline, which is round 8's F1 at its sharpest.**
The previous draft ran `docker compose -p loom exec -T postgres pg_dump …` with no bound at all,
and F1 walked the consequence: another session holding a conflicting lock, or an accepted connection
that then stalls on I/O, and the command never returns. **The `EXIT` handler is not a timeout** — it
only runs when the script exits, and a script blocked in `pg_dump` has not exited, so Loom stays
stopped, `/run/lock/loom-live-update.lock` stays held, every request is a 502 and every later update
is told only that another update is running. There is no trap for that, because there is no exit.
Three lines answer it:

- **`timeout --signal=TERM --kill-after=15 330` around the WHOLE PIPELINE, which is round 9's F2.**
  Round 8 put the deadline on `docker compose … pg_dump` alone and left `| gzip > "$TMP"` outside
  it, so a storage layer that accepted the temporary file and then blocked the write left the shell
  in the pipeline with Loom stopped, the lock held and no exit for the trap to fire on. The listing
  now runs the pipeline in a subshell — `timeout … 330 bash -c 'set -o pipefail; docker compose -p
  loom exec -T postgres pg_dump -U loom loom | gzip > "$1"' _ "$TMP"` — so one deadline covers both
  processes and the redirection. `set -o pipefail` **inside** the subshell keeps the property the
  outer shell had: a `pg_dump` that fails is still a failed dump even though `gzip` succeeds. 330
  rather than 300 because the pipeline now includes the compression that was previously outside the
  bound, and it is still many times this database's dump. `TERM` first so the client can close its
  connection, `KILL` 15 s later so a process that ignores it still goes — **unless the kernel will
  not deliver either, which is the unbounded case banner 7 names.**
- **Killing the client is not killing the dump, so the server side is killed — and then LOOKED
  FOR.** `docker compose exec` runs `pg_dump` **inside the Postgres container**; killing the local
  client leaves that process running, holding a transaction and a snapshot on the live database
  while the script goes on to migrate it. So on 124 or 137 the script runs `dk compose -p loom exec
  -T postgres pkill -TERM -f pg_dump` — itself bounded, like every other `dk` — before it does
  anything else. The `pkill` is **busybox's**, which is what `postgres:17-alpine` ships; the
  `|| echo NOTE` is there so that an image without it produces a note rather than a second failure
  mode. **But a signal sent is not a process gone, which is the second half of round 9's F2**, so
  the script then asks — through `dump_verdict`, the one helper banner 2 also asks with, because
  the two call sites have to classify identically or the marker means different things at the two
  ends of its life. **Only a definite `DUMP_GONE` skips the marker.** `DUMP_RUNNING` writes it, and
  so does every answer that is not an answer: a non-zero exit, empty stdout, stdout the script does
  not recognise, an image with no `pgrep` (`DUMP_NO_PGREP`), a `pgrep` that failed for some other
  reason (`DUMP_PGREP_<n>`), the 60 s bound, a daemon error. **That is round 11's F1 on this side
  of the marker's life**: the previous draft read exit 1
  with empty output as proof of absence here too, so a Compose failure in the middle of a timed-out
  dump would have *skipped writing the marker* — the worst of the two directions, because the next
  run then has nothing to refuse on. Banner 2 states the classification in full and the reason for
  each of its three cases.
- **When it is not proven gone, the next invocation is told, durably — and in a file of its own,
  which is round 10's F2.** The run writes `deploy/.dump-in-progress` and `sync -f`s it, and prints
  that it has done so. Banner 2 of the **next** invocation reads that file before anything else,
  asks the container once more, and either clears it because the answer was `DUMP_GONE` or refuses
  the whole run: no fetch, no dump, no migration, and not even a reconciliation of an interrupted
  update. That is the answer to "if pg_dump cannot be proved gone, leave a marker that makes the
  next update refuse rather than proceed". **Why it is not a seventh key in `deploy/.update-state`,
  which is what the previous draft wrote:** this marker is written on a path where Loom is already
  being restored by **R6**, and a successful R6 removes `.update-state` — correctly, because the
  update it described has been undone. The marker went with it, and the next invocation proceeded
  into exactly the dump the marker existed to prevent. The two facts have different lifetimes, so
  they are two files (banner 2). The cost of a false positive is unchanged: one operator running
  one `pgrep`, against the cost of a second dump queueing behind a snapshot nobody knew was open,
  or a migration deadlocking on it — and since round 11's F1 that false positive is *paid for
  honestly*, because an unanswered check is now marked as such and says so, instead of being
  mistaken for a clean one.
- **A failed dump is the existing recovery and nothing new.** The `exit 1` lands in the one exit
  handler with `MIGRATE_STATE` still `not-attempted` and `CREATED` still 0, which is **R6**: the
  previous deployment is restored — by the recorded image id, and proved by the loopback check
  (round 8's F3) — and the run exits non-zero. §11.7 has a case for exactly this: a dump that blocks
  on a lock, the `pkill`, and the handler restoring Loom.

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
  transaction open. The script would then have skipped straight to R8, whose status read can honestly
  report every tag still pending — because the transaction has not committed **yet** — and R10 would
  restart the **old** image; the surviving migrator would afterwards commit the new schema underneath
  it. Nobody would have had to do anything wrong: the root process owns Docker and the container it
  forgot holds `DATABASE_URL`. So `reap_oneoff "$MIGRATE_RUN"` is called on **every** path out of a
  failed migrator run, before `exit 1` and therefore before the exit handler classifies anything, and
  the two timeout codes now change only the wording of the line above it. It is a function because
  `read_status` needs exactly the same thing (banner 6) and the previous draft had it inline in one
  caller — which is how the other caller came to be missing it. `MIGRATE_STATE=failed` is set before
  the reap and the classification is entered only after it, so no branch of the recovery can run while
  a migrator is still alive. The name is also cleared with a `docker rm -f` **before** the run, so a
  leftover from a killed run cannot make the next update fail on a name conflict.
- **And the reap is a VERIFIED state transition, not a best-effort stop — which is review round 7's
  F1, and it is the half of round 6's F3 that calling the function everywhere did not buy.** The
  previous `reap_oneoff` began `docker inspect "$name" >/dev/null 2>&1 || return 0` and then ignored
  the status of everything it did afterwards. Both halves of that are wrong in the same way: they
  read a **failure to ask** as an **answer**. Run the update while the Docker daemon is briefly
  unreachable — the very outage that made `docker compose run` exit 1 with the migrator still alive —
  and that `docker inspect` fails too, the function returns **success**, and the script goes on to
  classify a database that a live migrator is still writing to. So the function now distinguishes
  the two failures and proves the end state:
  - **Classified inspection.** `docker inspect` is run with its stderr captured, and only the
    daemon's own `No such object` answer counts as "not there" — `return 0`. Any other failure means
    the question was not answered, and the container's state is therefore **unknown**: `return 2`
    with the daemon's message printed. The message is matched with a `case` over a captured string
    rather than a `grep` in a pipe, for the `SIGPIPE` reason banner 3 gives.
  - **Bounded stop, then a second question.** `docker stop -t 10`, falling back to `docker kill` so a
    container ignoring `SIGTERM` is still stopped, then `docker wait` under a **60 s** bound so a
    daemon that never answers cannot hang the recovery, then `docker logs --tail 50` through
    `redact_logs` for whoever reads the failure. None of those four is trusted: the function then
    asks `docker inspect --format '{{.State.Status}}'` and requires the answer to be **`exited`** or
    **`dead`**, or the object to be gone. Anything else — `running`, `restarting`, `removing`, a
    status a future Docker invents, or another unanswerable inspection — is `return 2`.
  - **`docker rm -f` may fail, and that is tolerated.** By the time it runs, the container has been
    *proved* not to be running, so it can no longer write to the database, which is the only thing
    the reap exists to establish. A leftover name is a nuisance rather than a hazard, and the
    `docker rm -f` at the top of the next run and of the next `read_status` clears it; the function
    prints a note and returns 0.
  - **A `return 2` is a state, not a warning: `MIGRATE_STATE=unreapable`.** The recovery then goes
    **straight to the manual-recovery message (R3 → R13)**: no status is read, nothing is started,
    and Loom is left stopped. That is the point of the finding — R8's status read and R9/R10/R11's
    verdicts are only meaningful if nothing is still writing, so **R8, R10 and R11 never run without
    a proven reap.** A status read beside a live migrator can honestly report every tag still
    pending, because the transaction has not committed *yet*, and the old image would then be
    restarted just in time for the migrator to commit the new schema underneath it.
  - **`read_status` gets the same verified lifecycle, and one deliberate asymmetry.** Its failed
    containers go through the identical `reap_oneoff`, and an unproven reap there prints a warning
    rather than becoming `unreapable`. The reason is what the two containers hold: `migrate --check`
    applies nothing (§5.2) and can only be holding a read connection, while the migrator holds an
    open write transaction. And both of `read_status`'s callers are already safe on that path — banner
    6 exits with the live instance untouched and nothing stopped, and R8's classification is only
    made when the read **succeeded**, in which case the container exited and `--rm` removed it. The
    name is cleared by the `docker rm -f` at the top of the next read.
- **A timeout counts as a failure, not as a rollback.** Ten minutes is far longer than any migration
  this schema has, and the important part is what happens after it: killing a client does **not** tell
  you whether the server committed, so the reconciliation decides what the database actually
  contains rather than assuming the transaction went either way.
- **`record_deployed` is on the success line and nothing separates it from the migrator.** The moment
  the migrator exits 0 the schema *is* the new commit's, and the next thing anything should believe
  about this deployment is that. Writing the record here — atomically, durably, and **before**
  `up -d loom` — means a failure in the start, the health check or the Caddy install can no longer
  send a recovery back to the pre-migration image: the record says the new commit, and R5 and R7 aim
  at the record.
- **And its failure is its own state, `record-failed` — review round 7's F2.** The previous draft
  ran `record_deployed` as a statement and carried on. Under `set -e` a failed write does stop the
  run, but it stopped it into a classification that had no branch for it: the schema had moved to the
  new commit while the record still named the old one, and the handler would have read that record
  and acted on it. A full disk is the ordinary way to reach it, and the dump two banners earlier is
  the ordinary way to fill the disk. So the write is tested, and a failure sets `MIGRATE_STATE`
  to `record-failed`, which the recovery answers with **R2**: touch nothing, and print the precise
  message — the schema and the image are the new commit's, the record still says the old one, the two
  therefore **disagree**, and here are the absolute commands to look at the disk, write the record by
  hand, `sync` it, start the image the record then names, and only afterwards clear the interrupted
  update's record. Not starting anything is the decision: with the record wrong, every later run's
  topology guard and recovery would be wrong too, and that is worse than a stopped instance.

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

**10. The target is started and proved by one helper, and these two banners are now one operation
in two halves — round 7's F3 and round 8's F2.** The banner is a single call,
`start_target_and_prove "$LOOM_IMAGE_TAG"`, which arms `CREATED`, runs
`docker compose -p loom up -d --no-build loom` under a 120 s bound (the image was built in banner 5,
so there is nothing to build; the `migrate` gate of §4.2 still runs, which is the 120 rather than
the 60 every other `dk` call gets), waits for the loopback answer, writes the record, sets `HEALTHY`
and removes the intent record. The same helper is what R7, R11 and the reconciliation's case (b)
call, so the four paths that start a target cannot disagree about what "started" means. Banner 11 is
then nothing but the verdict.

**Why one helper and not four call sites — F2, in one walk-through.** Start with A stopped during an
update to B. B's migration commits, the acknowledgement is lost or the host loses power, and the
next invocation reconciles: status proves every recorded migration applied, so case (b) runs. In the
previous draft case (b) and R11 each ran `up -d --no-build loom` and **removed `.update-state` the
moment compose returned 0**. If B has a startup regression, compose returns 0 having created a
container whose Node process then exits, and the script printed that B was started and deleted the
only record that an update was ever unfinished — while every human and the reviewer's connector got
a 502, and the old image could not safely be started either, because the schema is B's. The record
is the only thing that would have told the *next* run to look. So the removal moved inside the
helper, behind two facts: the loopback answer, and a durable `.deployed-sha`. And when the target
does not answer after a committed migration, the helper returns 1 with the record **kept** and the
caller prints R5's `LOOM IS DOWN`, which is the one honest thing to say there.

**`CREATED=1` before the command, for the same reason `QUIESCED=1` is.** `up -d` can create the
container and still exit non-zero, and a flag set only on success would leave the recovery believing
no new container exists while one does. It is armed inside the helper, on the line above the `up`.
Armed first, the recovery's answer is the same either way, because `restore_prev` **asks** rather
than assumes — and since round 8's F3 what it asks is the only question with a certain answer:
`docker inspect --format '{{.Image}}' loom-loom-1`, compared with the recorded image **id**. The
previous draft compared `{{.Config.Image}}` with `loom-live:<commit being deployed>` and additionally
required the two SHAs to differ, which is a tag and a name deciding the identity of an object. F3's
walk-through: commit S is serving from image id I1; before a no-change rerun root pulls a newer
`node:24-alpine`, so building S again produces **I2** under the same `loom-live:S` tag; banner 10
replaces the container with one built from I2, which never serves; and `restore_prev` — seeing
`LOOM_IMAGE_TAG == PREV_SHA` — declined to treat the name as the target's, ran `docker start
loom-loom-1`, started **I2** again, removed the intent record and printed that the previous
deployment was restored. Both records said S and neither was wrong; the running code was never I1.
Comparing ids has no such gap: equal means this object *is* the previous deployment, and anything
else — a different id, or no container at all — means it must be reconstructed from `PREV_IMAGE`.

**`up -d loom` REPLACES `loom-loom-1`, and that is the fact the restore is built around.** Compose
identifies its service's container by the project and service **labels**, not by name: when the
service's configuration hash has changed it stops that container, renames it aside and then
**removes** it, and creates the new one under the canonical name. So from this banner onwards the
container object the quiesce stopped no longer exists, and `docker start loom-loom-1` would start the
**new** image. Two consequences, both written into the listing:

- **A `docker rename loom-loom-1 loom-loom-prev` before the `up` would not save it, and is
  deliberately not taken.** It is the shape review round 7's F3 suggested, and the reason it is not
  used is mechanical: the rename does not change the labels compose looks the container up by, so
  compose finds it exactly as before and removes it anyway — while the script has gained a flag, a
  rename-back step and a window in which the canonical name is missing for no benefit. A deviation
  from the finding's letter, with its reason; the property F3 asked for is delivered by the next
  bullet instead.
- **So the restore is a faithful reconstruction, from the two facts banner 3 captured plus the
  deployed commit's own compose file.** `restore_prev` removes whatever container holds the
  canonical name when its image id is not the recorded one, retags the recorded image **id** as
  `loom-live:$PREV_SHA` — undoing any tag movement a same-commit rebuild caused — extracts that
  commit's compose definition with
  `git show "$PREV_SHA:deploy/docker-compose.yml"`, and brings `loom` up from **that** file with
  `--project-directory /root/git/Loom/deploy` and `--env-file /root/git/Loom/deploy/.env`, because
  `-f` alone moves neither the project directory the file's relative paths resolve against nor
  compose's `.env` lookup (§2). The result is the same image and the same definition as the
  deployment that was running — a new container object, which the printed warning says in as many
  words. That is strictly better than the previous last resort, which combined the old image with the
  **new** commit's definition, and it is why that warning no longer has to tell the operator to check
  whether the command and environment are even right. **And since round 8's F3 the reconstruction
  proves itself before it clears anything**: it runs the same bounded loopback probe the normal path
  does, and only an answering container gets `.update-state` removed and the "restored" line
  printed. A reconstruction that does not answer prints that Loom is DOWN and leaves the record for
  the next run, because "I recreated a container" is the same empty claim about the old image that
  F2 refused about the new one.

**Why no record is written here.** The previous draft wrote `.deployed-sha` the instant `up -d loom`
returned, on the nothing-pending path, and called that "the first instant at which B is genuinely
what is serving". It is not: `up -d` proves the container was created, and F3's walk-through is what
that buys — B has a startup regression, the container is created, the record says B, the loopback
check fails, and the recovery had already been disarmed. So on the nothing-pending path the record
moves into banner 10's helper, **after** the loopback answer, and the invariant it keeps is the stronger one:
at no moment does `.deployed-sha` name a commit that has not answered a request. The window between
the `up` and the loopback answer is covered twice — by the recovery, whose answer there is R4's
restore, and,
against an untrappable kill, by `.update-state` (banner 7). **With migrations pending nothing
changes:** the record is still written the instant the migrator exits 0 (banner 9), because the schema
then requires B and R5 and R7 must aim at B from that moment on.

**11. The verdict, and the records only a healthy target may write.** The check itself is inside the
helper: `prove_url "$LOCAL_URL" 60 1`, which is `curl -fsS --connect-timeout 5 --max-time 20
http://127.0.0.1:3100/api/guidelines` once a second until an absolute 60-second deadline —
**round 8's F1 changed both halves of that**. The bound was 30 iterations with no per-call deadline,
so a server that accepts the connection and then blocks on Postgres hung the first iteration and
every "30 s" with it; and 60 s rather than 30 because the per-call `--max-time 20` can now spend
part of the budget on a call that goes nowhere. Exhausting the deadline **fails the script** after
printing the last fifty lines of Loom's log. `/api/guidelines` rather than `/health`: `/health` answers `{"ok":true}` from the
HTTP layer alone and would go green on a server that cannot reach its database, whereas
`/api/guidelines` reads `settings` through core, so a 200 proves HTTP, the database connection and the
migrated schema in one request. It needs no credential
([`routes/guidelines.ts:8`](../../../src/server/src/routes/guidelines.ts)), so the check carries no
secret. A minute because a cold container has to connect a pool, run `ensureLobby` and bind. This
check comes **before** the Caddy install so that the site file is never installed in front of an
application that is not answering.

**And this is where the deployment becomes a fact — round 7's F3, now inside the helper.** Three
things happen in this order, once the check has passed and never before it:
`record_deployed "$tag"` writes the commit (a failure there is `record-failed`, exactly as in
banner 9); then `HEALTHY=1`, which is **the only thing in the script that disarms the recovery**;
then `rm -f "$STATE"` removes the intent record, because the target is up, answering and recorded
and there is nothing left for a later run to reconcile. The order matters in one direction only: the
record must be durable before the recovery is disarmed, so that a crash after the disarm cannot
leave a healthy target that nothing names. The record is written on **every** path through the
helper and not only the nothing-pending one, which is a simplification round 8's F2 allows: with a
migration the value was already written in banner 9 and is the same short SHA, so writing it again
is a rewrite of identical bytes, and one unconditional write is easier to check than a conditional
one. What this banner no longer does is set `MIGRATE_STATE=succeeded`: that assignment existed only
to steer a recovery that `HEALTHY=1` now ends outright, and a state variable kept for a branch that
can no longer be reached is a state variable that will mislead somebody.

**What banner 11 itself contains is the verdict, and the reason it is separate.** The helper's three
return values are three different failures and the caller has to distinguish them: **2** means the
target is answering but `.deployed-sha` could not be written, which is `record-failed` and R2's
message from the handler; **1** means created and never answering, which is R4 or R5 according to
whether a migration committed; **0** is the deployment. So the banner prints the `record-failed`
line for 2 and exits 1 in either failure, and the classification is left where it belongs, in the
one exit handler.

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

**13. The public check, and the record of what was proved.** `prove_url "$PUBLIC_URL" 120 3` — the
same one `curl` as everywhere else, `--connect-timeout 5 --max-time 20` a call, three seconds apart,
under an absolute 120-second deadline; exhausting it **fails the script**. 120 rather than the
previous draft's nominal 30 because this call crosses DNS, TLS and the shop's Caddy, each of which
can be slow for reasons that have nothing to do with Loom, and because round 8's F1 made the
per-call bound real: a public hostname that accepts a connection and stalls no longer hangs the run.
Skipped, with a printed line, when `--bootstrap` was given.

**This writes `.verified-sha`, and it is the only thing that does.** `deploy/.verified-sha` means
"this commit's image was served and answered over the public hostname". It is the public proof: §9's
done-checks read it, a human reads it to see how far the last deployment got, and **no mechanism in
this spec reads it at all**. `deploy/.deployed-sha`, the record the topology guard and the recovery
use, was already written in banner 9 or banner 10's helper — the instant the new image and schema became the
live pair, proved by the migrator's exit and by the loopback answer respectively — so a public check
that fails for a reason outside Loom can no longer leave the machinery pointed at a pre-migration
image. `deploy/.update-state` is gone by then too, removed by that helper, so a failing public check
does not send the next run into a reconciliation either: the deployment is finished, and only its
public proof is missing. What a failing public check leaves is exactly right in both files:
`.deployed-sha` names the commit whose image and schema are live, because they are; `.verified-sha`
still names the last commit that answered publicly, because this one did not.

**Why the loopback check is not enough.** A site block can be syntactically perfect, reload cleanly
and still send every visitor to nothing: `reverse_proxy looom:3000` is a valid directive. Loom keeps
answering on `127.0.0.1:3100`, so the loopback check goes green while every human and the reviewer get a 502
from Caddy. The public check is the only one that exercises DNS, TLS, Caddy's routing, the `web`
network and the database in one call.

**Why `--bootstrap` exists, and what it costs.** §9 runs the script once before the DNS A record
exists and before a certificate has been issued, so the public check cannot pass then and the first
deployment would be unable to use the real script — which is the thing that makes §9 step 5 worth
doing at all. `--bootstrap` skips that one check and nothing else. Its price is that a bootstrap run
has *not* proved the public path, so §9 step 8 is a numbered step that **reruns the script in normal
mode** once the certificate exists, and that rerun is what completes the first deployment's
end-to-end check and first writes `deploy/.verified-sha`.

#### The recovery procedure, R1–R14

This is what `recover` implements, and it is written as a numbered decision procedure because every
branch of it ends in a different command and an implementer must be able to transcribe it without
interpreting it. It runs on **every** exit — the handler is installed once, at the top — and it does
nothing at all while `QUIESCED=0` or once `HEALTHY=1`. **It is four rules longer than round 6's, and
the four are round 7's three findings plus the split of the old R2:** R2 is a `.deployed-sha` that
could not be written (F2), R3 is a migrator container that could not be proven stopped (F1), and R4
and R5 are the two halves of a container that was created and never answered (F3). Everything below
R5 is round 6's procedure with its numbers moved.

  R1. **If `HEALTHY=1`, return immediately.** The new image is running *and has answered*
      `/api/guidelines` on the loopback port, the schema is the new commit's, `.deployed-sha` says
      so, and `.update-state` is gone. The remaining failures (the Caddy install, the public check)
      are not reasons to touch the container. Nothing else in R2–R14 runs, and the script exits with
      the status it died with. **`CREATED=1` does not get here, and that is round 7's F3:** a created
      container is not a serving one. Since round 8's F2 the flag is set in exactly one place,
      inside `start_target_and_prove`, after both the loopback answer and the durable record.
  R2. **If `MIGRATE_STATE` is `record-failed`, touch nothing and print why** — the
      `record_failed_message` function in the listing — then return. `.deployed-sha` could not be
      written, so the schema and the image on disk are the new commit's while the record still names
      the old one. Nothing may be started on that basis: the record is what every later run's
      topology guard and recovery believe, and starting a container would only add a third
      disagreeing fact. The message prints both values, whether the container is running and which
      image it is configured from — both through `classify_inspect`, so a question the daemon did
      not answer prints `UNKNOWN` with its message rather than one word covering every kind of
      failure (round 9's F3) — the commands to look at the disk, to write and `sync` the record
      by hand, to start the commit the record then names, and — last — to clear `.update-state`.
  R3. **If `MIGRATE_STATE` is `unreapable`, read nothing and start nothing: go to R13.**
      `reap_oneoff` could not prove the migrator's container had stopped (round 7's F1), so a process
      holding `DATABASE_URL` may still be inside an open transaction. Every verdict from R8 down
      depends on the database not being written to while it is questioned, so no question is asked:
      Loom stays stopped and R13's message is printed. This is the branch that makes "**R8, R10 and
      R11 never run without a proven reap**" true by construction rather than by argument.
      **And since round 10's F1 the reconciliation of §4.5 banner 2 carries the same rule in its own
      words**, because it is a *different run* asking the same question about a migrator it did not
      start: it reaps `loom-migrate-run` before its first probe and refuses — record kept, nothing
      restored, nothing read — when that reap returns 2. R3 is the in-run case; that refusal is the
      across-runs case, and neither exists without the other.
  R4. **If `CREATED=1` and no migration ran** (`MIGRATE_STATE` is `not-needed`, or `not-attempted`) —
      **remove the new container and restore the previous deployment**, then return. This is F3's
      first half: `up -d loom` created a container from the new image, the loopback check never
      answered, and because the schema was never touched the previous image is a valid thing to
      serve. `restore_prev` does it, and since round 8's F3 it asks exactly one question: is
      `loom-loom-1`'s `{{.Image}}` the recorded `PREV_IMAGE`? If it is, that object **is** the
      previous deployment and `docker start` brings it back; if the daemon says the object is
      absent, or names a different id, the
      name is removed and the deployment is reconstructed from `PREV_IMAGE` (R14). Either way the
      restore is believed only once the loopback check has answered. **And since round 9's F3 there
      is a third answer**: an inspection that was not answered at all. `restore_prev` then removes
      nothing and recreates nothing — it prints `inspection unanswered`, says Loom is DOWN, leaves
      `.update-state` in place and returns 1. Removing a container on the strength of a question the
      daemon did not answer is how the *right* container gets destroyed. The run exits non-zero.
  R5. **If `CREATED=1` and the migration committed** (`MIGRATE_STATE` is `succeeded`) — **leave the
      container as it is and print that Loom is DOWN**, then return. This is F3's second half and the
      one place the script refuses to restore anything: the schema is the new commit's, so the
      previous image must not be started against it, and the new image has not answered. The new
      commit therefore stays the only valid target. `failed_start_after_migration` prints that Loom
      is down, both records, the dump's path, the absolute command to read the new container's log
      **through the literal `sed` of `redact_logs`** — the reader has no shell where that function
      exists — and the absolute command to retry the same commit. It also says what it is not doing:
      the container is left as compose created it, under `restart: unless-stopped`, so it may yet
      come up by itself, and `.update-state` is left for the next run to reconcile. The run exits
      non-zero. Going back *across* the migration needs the dump and a human, which is §13.
  R6. **If `MIGRATE_STATE` is `not-attempted` or `not-needed` and no container was created, restore
      the previous deployment** — `docker start loom-loom-1` when its image id is the recorded one,
      which is the exact container the quiesce stopped — and return. No migration ran,
      `.deployed-sha` still names the deployed commit, so the schema
      is untouched and the container's own image is the right one by definition — **and since round
      8's F3 that "by definition" is checked rather than assumed**, because the id is the only thing
      that can distinguish the object the quiesce stopped from one a rebuild produced. This is the
      branch a
      failed dump, an unhealthy Postgres, a failed `up -d loom` that created nothing or a `set -e`
      death before banner 9 takes, and it is the cheapest correct answer because the container still
      holds the deployed commit's image id, command, environment and networks.
  R7. **If `MIGRATE_STATE` is `succeeded` and no container was created, start the NEW image and
      prove it** — `start_target_and_prove "$LOOM_IMAGE_TAG"`, with `LOOM_IMAGE_TAG` still the new
      commit's short SHA — and return. `.deployed-sha` already names the new commit and the compose
      definition in the checkout is that same commit's, so image and definition agree. The old image
      must **not** come back here: the schema has moved past it. This branch exists for a failure in
      `up -d loom` itself, which it retries in the only form that can be right. **It goes through
      F2's helper, which is a deviation from round 8's letter and not from its reasoning:** the
      finding named the normal path, R11 and the reconciliation's case (b) as the three places that
      equated compose's exit with a serving application, and R7 was the fourth, written the same way
      by the same hand. Through the helper it either reaches `HEALTHY=1` with a durable record, or
      falls to R5's `LOOM IS DOWN`, or to R2's message if the record cannot be written.
  R8. **Otherwise `MIGRATE_STATE` is `failed`, and the database is asked what happened** — the same
      `read_status`, into a second temporary file, **under `timeout 120`**. `--check` applies nothing
      (§5.2), so this cannot make the situation worse, and it reconnects, which is the point: the
      question is about the server's state, not the dead client's. The bound is round 5's F5's other
      half: the previous draft's status read was unbounded, so a migrator's still-open transaction or
      an unresponsive database could hang the recovery forever with Loom stopped and the update lock
      held. 120 s is generous for a `select` over one small table and short enough that a human is
      reading R13's message inside three minutes. **R8 is reachable only past a proven reap** (R3,
      round 7's F1): the migrator's container is stopped, waited for, *re-inspected* and removed
      before this question is asked, so the answer describes a database nothing is still writing to.
      And `read_status` reaps **its own** container whenever its `timeout` fires or its client exits
      non-zero, so a failed status read leaves no connection behind for the next one to queue behind.
  R9. **If the status could not be read, go to R13.** A status that cannot be read is not a rollback.
      The read's own output and stderr are printed first — through `redact_logs`, like every other
      log this script prints (round 6's F1) — so the reason is on the record.
  R10. **If every tag that was pending is still pending** — `comm -23` of before against after is
       empty — **the transaction rolled back.** The schema is exactly what it was, so: leave
       `.deployed-sha` alone (it still names the deployed commit), restore the previous deployment
       through `restore_prev`, print `migration rolled back; the previous deployment is serving again
       (loom-live:<deployed SHA>)`, and exit non-zero. This is the ordinary bad day, and the dump is
       on disk with nothing needing it.
  R11. **If none of the previously-pending tags is still pending** — `comm -12` is empty — **the
       migration committed and the client did not see it.** So: `record_deployed "$LOOM_IMAGE_TAG"` —
       and if *that* fails, R2's message, because the same reasoning applies — then
       `MIGRATE_STATE=succeeded`, because from that line the schema is the target's and R5 is the
       only fallback left, and then **`start_target_and_prove "$LOOM_IMAGE_TAG"`**. On 0 it prints
       that the database is at the new SHA and the new image is up, answering and recorded, and that
       a rerun finishes the remaining steps; on 1 it prints R5's `LOOM IS DOWN` and **leaves
       `.update-state` in place**; on 2, R2's message. Either way it exits **non-zero**: the run did
       not complete — the health checks and the Caddy install never happened — and a rerun is the
       finish, which will fast-forward nothing, find nothing pending, and carry on to the checks.
       **The removal of `.update-state` moved into the helper, which is round 8's F2:** the previous
       draft removed it the moment `up -d` returned, so a target that was created and never served
       took the only record of an unfinished update with it.
  R12. **If some previously-pending tags are applied and others are still pending, go to R13**, after
       printing both counts. That is a partially-applied schema, which means the one-transaction
       guarantee did not hold, and there is no command a script can be trusted to choose.
  R13. **Leave Loom STOPPED and print the precise manual-recovery message** — the `manual_recovery`
       function in the listing — then exit non-zero. **Leaving Loom down is the decision, and it is
       deliberate.** R13 is reached when the database's schema is genuinely unknown or genuinely
       partial, or when a migrator could not be proven dead; starting *either* binary against that
       risks writes against a shape the code does not understand, which is the failure mode that
       costs the event log rather than a minute of availability. A 502 that a human has to clear is
       recoverable; a Loom serving against a half-migrated schema is not. The message carries
       everything the recovery needs — both records, both candidate commands and the dump's path, or
       `none taken` when there is no dump — so the human does not have to reconstruct the run from
       this document. **And which of the two candidate commands it prints is decided by the image id,
       which is round 8's F3.** The draft always printed `docker start loom-loom-1` and always called
       it "the pre-migration container", which is false from banner 10 onwards and false after any
       same-SHA rebuild: the message compares `docker inspect --format '{{.Image}}' loom-loom-1` with
       the recorded `PREV_IMAGE` and prints the simple `docker start` **only** when they are equal,
       saying so in the same breath; otherwise it prints the full reconstruction — remove the name,
       retag the recorded id, `git show` that commit's compose file, bring `loom` up from it — and
       says why the short command would have started something else. **Since round 9's F3 that
       inspection has three answers and the message has three shapes**: the id, the daemon's
       `No such object`, or `UNKNOWN — not answered: <the daemon's message>`, and on the third the
       message prints the reconstruction and says in as many words that the short `docker start` is
       *not offered* because the id could not be read. A recovery message that guesses is worse than
       one that admits what it does not know, because the person reading it is about to paste it. It ends with the one instruction
       round 7 added: clear
       `/root/git/Loom/deploy/.update-state` **last**, once the record and the running container
       agree, because until it is gone the next invocation reconciles instead of deploying.
       **Every command it prints is self-contained, and that is round 6's F6.** The draft printed
       `docker compose -p loom up -d --no-build loom` and "write the commit into
       `deploy/.deployed-sha`", both of which are only true in the directory the *script* was in. A
       normal update is invoked through `live-update.cmd`, so the person who reads R13's output opens
       a fresh SSH shell and lands in `/root`: compose would find no Loom compose file and no `.env`
       there, refuse for `LOOM_DB_PASSWORD`, and the advertised recovery would fail while Loom stayed
       down — and `deploy/.deployed-sha` would name `/root/deploy/.deployed-sha`, or, from `deploy/`
       itself, `deploy/deploy/.deployed-sha`. So each printed command begins
       `cd /root/git/Loom/deploy && `, the compose one also carries
       `--env-file /root/git/Loom/deploy/.env` because that file holds the password compose demands,
       and the record is named absolutely as `/root/git/Loom/deploy/.deployed-sha` with the `printf`
       and the `sync -f` that write it. One shape, pasteable whole, from any directory. The same
       audit was run over every other line the listing prints: `restore_prev`'s and R7's failures say
       "loom is DOWN, deploy by hand" and name no command, R11 names
       `/root/git/Loom/deploy/live-update.sh` for the rerun rather than a bare `live-update.sh`, R5
       names both its log command and its retry absolutely, and nothing else in the script prints an
       instruction at all.
  R14. **If the canonical container does not hold the recorded image id** — because banner 10's
       `up -d loom` replaced it, which is the ordinary case from R4 onwards; because a same-SHA
       rebuild produced a *different* image under the same tag and compose then recreated the
       container from it, which is round 8's F3 and the case the previous draft got wrong; or because
       someone ran `docker compose -p loom down` beside
       the script (the case §13's lock bullet already says nothing prevents) — **reconstruct the
       previous deployment from the recorded image id and that commit's own compose definition, with
       a printed warning.** `docker tag "$PREV_IMAGE" "loom-live:$PREV_SHA"` puts the recorded **id**
       back under the deployed commit's tag — undoing any tag movement a same-commit rebuild caused —
       `git show "$PREV_SHA:deploy/docker-compose.yml"` writes out the definition that deployment was
       created from, and `LOOM_IMAGE_TAG=$PREV_SHA docker compose -p loom --project-directory
       /root/git/Loom/deploy --env-file /root/git/Loom/deploy/.env -f <that file> up -d --no-build
       loom` recreates it. **This is round 7's replacement for the old R10**, which combined the old
       image with the **new** commit's definition — a combination nobody had ever run, and one that a
       commit which legitimately changed `command:` or `environment:` would make unbootable. Same
       image, same definition, a new container object: the warning says exactly that, and no longer
       has to ask the operator to check whether the command and the environment are even right. **And
       the reconstruction proves itself before anything is cleared** (round 8's F3): the same bounded
       loopback probe, and only an answering container gets `.update-state` removed. If
       `PREV_SHA` or `PREV_IMAGE` is empty (the first deployment), if the id is no longer on disk, if
       that commit's compose file cannot be read, or if the recreated container does not answer, the
       script prints that loom is DOWN and must be
       deployed by hand, and stops there. R14 is reached through `restore_prev`, so R4, R6 and R10 all
       get it.

**The handler runs the classification, not a restart, and that is the whole shape.** An older trap
read `.deployed-sha` and started that image whatever had happened; this one reaches a `docker start`,
an `up -d`, a reconstruction, or nothing at all, and which one is decided by the facts captured
before the build, the two flags `CREATED` and `HEALTHY`, and one bounded question put to the
database. **And the handler is no longer the only recovery**, which is the shape round 7's F2 added:
a trap covers exits, and a file — `deploy/.update-state`, read by banner 2 of the *next* invocation —
covers the interruptions that are not exits.

Nothing in the script prints a token, a secret or a `DATABASE_URL`, and nothing it prints can reach
the controller's transcript as a credential. That includes the recovery and the reconciliation: R13's
message carries two short SHAs, two lists of journal tags, a dump path and three commands; the
update-state record holds two short SHAs, an image id, a tag, a list of journal tags and a timestamp,
and R5's message adds a `sed` expression. A journal tag is a
drizzle-generated name like `0004_furry_captain_stacy`. The one place a credential could still
surface is a compose error echoing `environment:` — which is why `.env` holds only two values and
neither is echoed by the script itself. Banner 4's `--env-file` used to be the second such place and
is not any more: it is a mode-600 temporary file holding `SITE_ADDRESS` and `REDIRECT_ADDRESSES` and
nothing else, removed by `cleanup`, so the disposable Caddy never sees Spool's `DB_PASSWORD` or any
other key that file has come to hold.

**And a container's log was the third such place, which is round 6's F1.** The script itself prints no
secret, but every one of its reads hands on somebody else's output — Postgres's log twice, Loom's
log wherever a container fails to answer (banner 10's helper and both of `restore_prev`'s failure
paths), a
reaped one-off's log, and `migrate --check`'s own stdout and stderr in banner 6, in R8 and in banner
2's reconciliation — and
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
refuses to touch the files leaves Paw with no command at all on the step that is Paw's own to run.
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

**`deploy/connector-url-to-clipboard.ps1`** — run by **Paw**, because it puts something on
Paw's clipboard and Paw is the one about to paste it:

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

/**
 * What this database has had, validated against the journal. Throws when the two DISAGREE — a
 * journal whose `when` values are not strictly increasing, or a `__drizzle_migrations` table that
 * is not an exact prefix of the journal — naming the first mismatch. There is no status to report
 * in that case, only drift to fix.
 */
export async function migrationStatus(db: Db, folder?: string): Promise<MigrationStatus>;

/**
 * Throws if `sql` contains a statement that would escape the single transaction `runMigrations`
 * applies a run inside. `file` is named in the message. A guard against accidents, not a SQL parser.
 */
export function assertTransactionSafe(sql: string, file: string): void;
```

**Why in core and not in the server entry point.** It is a rule about the database — "which of these
migrations has this database had?" — and two callers need the same answer: the migrate entry and the
server's boot refusal (§5.3). One implementation, tested once, in the package that owns the schema.

**How it decides, and why it is no longer drizzle's own rule — review round 8's F4, accepted in
full.** The journal
[`src/core/drizzle/meta/_journal.json`](../../../src/core/drizzle/meta/_journal.json) lists entries
with a `tag` and a `when` (epoch milliseconds); drizzle's postgres-js migrator records what it has
applied in the `drizzle` schema's `__drizzle_migrations` table, whose `created_at` column holds that
same `when` and whose `hash` column holds the hash drizzle computed over the migration file.
The migrator's own rule is **"apply every journal entry whose `when` is greater than
the maximum `created_at` in the table"**, and the previous draft used exactly that rule on the
reasoning that agreeing with the migrator is the whole value of the function.

**That reasoning is wrong for a repository with long-lived branches, and F4 walked the cost.** A
branch generates migration X at time 150. Meanwhile Y is generated at time 200, merged and deployed,
so the table's maximum `created_at` is 200. X merges **after** Y and keeps its older stamp —
`drizzle-kit generate` stamps `Date.now()` at generation, not at merge, and a branch that lives a
week is a stamp that is a week old. Under the maximum rule X's `when` of 150 is *not* greater than
200, so it is reported **applied** when it has never run: `live-update.sh` finds nothing pending and
skips the migrator (§4.5 banner 6), the boot guard of §5.3 sees nothing pending either,
`/api/guidelines` passes because it touches `settings` and not X's table, the deployment is recorded
healthy — and the first request that exercises X fails against a schema that does not have it. The
author of X needed no credential for any of it; root's update process supplied the database one and
was never told there was anything to tell. The previous draft *noted* this case and called it "the
migrator's behaviour, not something this function may paper over". Reporting it as applied **is** the
papering over.

So `migrationStatus` validates instead, and the validation is three properties — the third added by
PR #27's plan review round 1 F2, and numbered last so that the two the rest of this document already
names keep their numbers, though it is the one checked **first**:

1. **The journal's `when` values are strictly increasing in file order.** Equal or decreasing is
   drift, and it is caught with no database read at all: it is a property of the repository, so it
   is the same answer on every machine and it names the two entries that are out of order.
2. **The table's rows, ordered by `created_at`, are an exact prefix of the journal by
   `(created_at, hash)`.** There must be no more rows than journal entries, and the row at position
   *i* must match the journal entry at position *i* in both columns. The applied tags are then the
   journal's first *k* by position and the pending tags are the rest — **by position, not by
   comparing timestamps** — and on a clean prefix that is the same set the migrator's own rule
   selects, because a strictly increasing journal makes "greater than the maximum `created_at`"
   and "after the prefix" the same line.
3. **The folder's `*.sql` files and the journal's tags are the same set.** Read the directory, take
   every name ending in `.sql`, strip the suffix and compare it with the journal's tags: a file with
   no entry and an entry with no file are both drift, both named in the message. Like property 1 it
   needs no database, so it is checked first and on every machine; unlike property 1 it cannot be
   delegated to drizzle's reader, which loops over the journal and therefore cannot see a file the
   journal does not mention. The second detail of the read below is why.

**Anything else is a drift state, and a drift state has no status.** `migrationStatus` **throws**,
naming the first mismatch — the position, the journal entry's tag and `when`, and what the row at
that position actually held. Six shapes reach it: a backdated entry appended after an applied newer
one (property 1), a missing row so that the rows are not a prefix, a duplicate `when` (property 1
again, since equality is not increasing), a row whose `hash` is not the journal file's, an **orphan
`.sql` file** with no journal entry, and a **journal entry with no `.sql` file** — the last two
being the folder inventory of the second detail below, which is checked before any row is read. Both
forms of the migrate entry exit **1** on it (§5.2), so `live-update.sh` stops at banner 6 —
**before the quiesce, with Loom still serving, nothing dumped and nothing migrated** — which is the
same gate `assertTransactionSafe` already has and for the same reason: a repository defect must not
become an outage.

**And `runMigrations` refuses on drift too, which F4 asks and this spec answers yes.** It calls
`migrationStatus` over the same folder before it calls drizzle's `migrate()`, exactly as it already
calls `assertTransactionSafe` over the pending set first. Without that, the honest note below would
be the whole story: **drizzle's own migrator still applies by its own rule**, so a drifted journal
handed straight to `migrate()` would skip X silently whatever this function thinks. Loom's callers
never hand it straight to `migrate()` — `runMigrations` is the only caller in this repository
(`main.ts`, the migrate entry, `freshDb()`), and it now refuses first. What that does not buy, and
the note stands: a developer running `drizzle-kit migrate` or `migrate()` by hand bypasses it, and
nothing in this slice can stop that.

**What the developer does on drift, because a refusal with no remedy is a trap.** The fix is to
**regenerate the migration so that its `when` is the newest in the journal**, and that takes
**three** deletions, not two — which is review round 10's F3 and is the half of this remedy the
previous draft left out. Delete, for the unmerged migration only:

1. its `.sql` file under `src/core/drizzle/`;
2. its entry in `src/core/drizzle/meta/_journal.json`;
3. **its `src/core/drizzle/meta/<NNNN>_snapshot.json`**, so that `meta/` is back at the
   merged-`main` baseline.

Then re-run `drizzle-kit generate` on the merged schema and commit the result — a new `.sql`, a new
journal entry with a fresh `when`, and a new snapshot.

**Why the third deletion is not optional.** `drizzle-kit generate` does not diff against the
journal; it diffs against **the newest snapshot file in `meta/`**, chosen by name and nothing else.
Verified against the installed `drizzle-kit@0.31.10` rather than asserted:
`prepareOutFolder` builds its snapshot list with
`readdirSync(meta).filter(it => !it.startsWith("_")).map(…)` and then `snapshots.sort()`
(`node_modules/.pnpm/drizzle-kit@0.31.10/node_modules/drizzle-kit/bin.cjs:8135-8136`, the same code
at `utils.js:6210-6211`) — so `_journal.json` is filtered out by its underscore and the list is the
`meta/*_snapshot.json` files in lexicographic order. `preparePrevSnapshot` then takes
`snapshots[snapshots.length - 1]` and parses **that** file as the previous schema
(`bin.cjs:19862-19870`), and the postgresql `generate` path hands it straight into
`applyPgSnapshotsDiff` as `prev` (`bin.cjs:32165-32205`). Leave `0005_snapshot.json` behind and it
is still the lexicographic maximum, so the "previous" schema drizzle-kit diffs against is one that
**already contains** the unmerged migration's change: the diff is empty, `writeResult` prints
`No schema changes, nothing to migrate` and returns without writing anything
(`bin.cjs:32921-32924`), and the developer is left with a deleted migration, no replacement, and a
`migrationStatus` that still refuses. Deleting the snapshot is what restores the baseline the diff
has to be taken from.

**How to do the third deletion, and the one case where the short form is wrong.** When the only
unmerged migration is yours, the whole of it is

    git fetch origin
    git restore --source=origin/main --staged --worktree -- src/core/drizzle/meta

which puts `meta/` back to exactly what merged `main` has — journal and snapshots together, so
deletion 2 comes with it. When it is not — a second unmerged migration is in the tree, or `main`
has moved on — that command would throw away somebody else's work, so **remove that one snapshot
file by hand** (`rm src/core/drizzle/meta/<NNNN>_snapshot.json`) and edit the journal entry out.

**Why `git restore` and not `git checkout`, which is review round 11's F2.** The previous draft
wrote `git checkout origin/main -- src/core/drizzle/meta`, and that command **does not restore a
directory; it overlays one.** `git checkout <tree-ish> -- <path>` is overlay mode: it writes the
files the tree-ish has and **leaves every file the tree-ish does not have exactly where it is**. So
on a branch that added `meta/0002_snapshot.json`, the command rewrites `_journal.json` and
`0001_snapshot.json` from `main` and `0002_snapshot.json` **survives** — still tracked, still the
lexicographic maximum, still the file `preparePrevSnapshot` will pick as the previous schema. The
draft therefore advertised the third deletion while performing two, and the regeneration failed in
exactly the way the paragraph above describes: `No schema changes, nothing to migrate`.
`git restore --source=<ref> --staged --worktree -- <path>` is **non-overlay by default** — that
asymmetry is the whole reason `git restore` was split out of `git checkout` — so it deletes the
branch-only snapshot from the worktree and stages the deletion in one command. Verified in a
throwaway repository against exactly the shape above: a baseline commit holding
`meta/0001_snapshot.json`, a branch commit adding `meta/0002_snapshot.json`, and after the command
`0002_snapshot.json` gone from the worktree, staged as `D`, and `0001_snapshot.json` and
`_journal.json` back at the baseline's contents. The same throwaway repository reproduces the
finding: after `git checkout origin/main -- src/core/drizzle/meta`, `0002_snapshot.json` is still
there.

Two notes on the command. **`git fetch origin` comes first** because `origin/main` is a remote
tracking ref and a stale one restores a stale baseline — the same trap §9 pays for with the
deployment's bundle. And **`git restore` needs Git 2.23 or newer** (2019); on anything older the
equivalent is the three-step

    git rm -r --quiet --cached src/core/drizzle/meta
    rm -rf src/core/drizzle/meta
    git checkout origin/main -- src/core/drizzle/meta

which is verified to produce the identical result, and is not the recommended form only because it
is three commands with a window in the middle where `meta/` does not exist at all.

**And migrations that are already deployed are never touched.** The three deletions apply to the
unmerged migration and to nothing else: an applied file's `.sql`, its journal entry and its
snapshot all stay exactly as they are, because the live database's `__drizzle_migrations` rows are
matched against them by `(created_at, hash)` and removing any of the three turns a healthy database
into drift (§5.1's property 2). The remedy is a *regeneration of one unmerged file*, which is why
it makes the journal strictly increasing again without touching any database.

A hand-edited `when` is the other way and is not recommended: the file's hash is recorded with the
stamp, so editing the journal after a deployment has applied the file produces the hash-mismatch
drift instead. §10 puts all of this in CONTRIBUTING's `## Migrations` section, beside the
transaction rule, because it binds every future migration and a rule that lives only in this
document is a rule the next author will not read.

Four details of the read:

- **The hash comes from drizzle's own reader, not from a digest reimplemented here.** The journal
  file carries `tag` and `when` but no hash; drizzle computes the hash when it reads the migration
  files. So `migrationStatus` takes the hashes from **`readMigrationFiles` in
  `drizzle-orm/migrator`** — the same helper `migrate()` is given the output of — matching each
  entry by its `folderMillis` to the journal's `when`, so the hash this check compares is by
  construction the hash the migrator would have inserted. The implementation task confirms that
  export's shape against `drizzle-orm@0.45.2` and, if it differs there, computes the digest the way
  that version's migrator does — and either way §11.1 case 4 pins the agreement empirically, by
  applying the real migrations and reading the rows back rather than by trusting this paragraph.

- **The folder's `*.sql` files are inventoried independently of the journal, and that is PR #27's
  plan review round 1 F2.** "A journal entry with no file, or a file with no journal entry, is
  itself drift" was already this section's rule, and the previous draft left it to
  `readMigrationFiles` to notice — which it cannot, in one direction, by construction.
  `readMigrationFiles` **loops over the journal's entries** and reads one file per entry
  (`drizzle-orm@0.45.2`'s `migrator.js:12-28`, read rather than assumed), so the list it returns is
  always exactly as long as the journal and an **orphan** `.sql` file — one drizzle-kit wrote whose
  journal entry a merge conflict or a hand-edit dropped — is invisible to it. That is the shape this
  section calls drift and the one that costs the most: the file is in the repository, no journal
  entry means no pending tag, `migrate --check` reports nothing to apply, §4.5 banner 6 skips the
  migrator, and the deployment is recorded healthy against a schema the branch's code expects to
  have changed. So `migrationStatus` **reads the directory itself** — every `*.sql` in the
  migrations folder, non-recursively — and compares that set with the journal's tags **before** it
  asks drizzle for anything: a file with no entry and an entry with no file are both refused, both
  named in the message, and both are drift with no status to report. The other direction is refused
  here too rather than left to drizzle, whose own message for it (`No file <path> found in <folder>
  folder`) says nothing about the journal, the prefix or the remedy. §11.1 case 12 is the test, in
  both directions.

- The table may not exist on a fresh database. `migrationStatus` asks
  `select to_regclass('drizzle.__drizzle_migrations')` first and treats a null answer as "nothing
  applied", rather than catching SQLSTATE `42P01` from a failed select — a probe that answers is
  clearer than an exception that has to be classified. A null answer is **not** drift: an empty
  prefix is a prefix.
- The migrations folder is resolved by **one** exported helper shared with `runMigrations`
  (`migrationsFolder()` in [`src/core/src/db/index.ts`](../../../src/core/src/db/index.ts), pulled
  out of the body it is inlined in today), so the status and the application can never read
  different folders. Both functions take it as an **optional parameter** defaulting to that
  helper — `runMigrations(db, folder = migrationsFolder())` and
  `migrationStatus(db, folder = migrationsFolder())` — which changes no existing call and is what
  lets §11.1 cases 5 to 8 point them at a folder the test wrote.

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
| `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `REFRESH MATERIALIZED VIEW CONCURRENTLY`, `ALTER TABLE … DETACH PARTITION CONCURRENTLY` | PostgreSQL refuses these inside a transaction block. The last two are the whole-branch review's P3 #5: they are in the same PostgreSQL set, this table listed only the first three, and the guard was faithful to the table. The guard now gates `CONCURRENTLY` on `CREATE`, `DROP`, `REINDEX`, `REFRESH` and `ALTER`, and their `CONCURRENTLY`-less look-alikes (`REFRESH MATERIALIZED VIEW mv;`, `ALTER TABLE t DETACH PARTITION p;`) stay accepted |
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
block (`CREATE`/`DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`,
`REFRESH MATERIALIZED VIEW CONCURRENTLY`, `ALTER TABLE … DETACH PARTITION CONCURRENTLY`,
`VACUUM`, `CREATE`/`DROP DATABASE`, `CREATE TABLESPACE`, `ALTER SYSTEM`, `DISCARD`) and the one judgement call
this spec makes on its own (`ALTER TYPE … ADD VALUE`). Round 4 listed a sample of the first group and
round 5's F6 found the alias it had missed; taking the group whole is what stops that being a
recurring finding. The optional noise words (`WORK`, `TRANSACTION`) are covered because the match is
on leading keywords, but they are written out above and tested individually in §11.1 case 10, because
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
| **dollar-quoted body** | `$tag$` **in code at a token boundary** — never inside an unquoted identifier — `tag` empty or an identifier | the **same** `$tag$`, tag-matched, so a `$$` inside a `$body$ … $body$` does not end it | nothing |

**A dollar quote opens only at a token boundary, and that is PR #28's review round 1.** PostgreSQL
lets `$` continue an unquoted identifier after its first character, so `t$tag$` is one name. A scan
that meets that `$` as if it stood alone opens a `$tag$` body that nothing closes, skips the rest of
the file, and accepts `CREATE TABLE t$tag$ (id int); COMMIT; SELECT nonexistent_function();` — whose
`COMMIT` the server executes. So the code state reads an unquoted identifier — a letter, `_` or a
non-ASCII character, then letters, digits, `_` and `$` — as **one token**, and a `$` inside it is an
identifier character. A `$` the pass meets on its own is therefore always at a token boundary, and
only there does the dollar-body state open: `$$ … $$`, `$tag$ … $tag$`, `($$ … $$)` and
`DO $$ BEGIN … END $$;` read exactly as before. A double-quoted `"t$tag$"` needed no change: its `$`
is already inside the double-quoted state. §11.1 case 10 is the test.

Four properties follow from the table, and they are the whole of the fix. **Comments are recognised
only in the code state**, so a `--` or a `/*` inside any quoted form is content and cannot remove
anything. **A comment that is skipped leaves a separator behind** — see the paragraph below, which
is PR #27's plan review round 1 F1. **Statements are split on `;` only in the code state**, so a
semicolon inside a string, an identifier, a dollar body or a comment does not end a statement. And
**the keyword check runs on each
split statement's leading tokens** — the text between the previous split and this `;`, with its
comments and quoted runs already accounted for by the pass, leading whitespace and leading comments
skipped, matched case-insensitively against the table. Drizzle's own `--> statement-breakpoint` needs
no rule of its own: it *is* a line comment, and the `;` before it has already ended the statement, so
the previous draft's "split on the marker and then on `;`" is one step the single pass removes rather
than a step it has to keep.

**A skipped comment must leave a separator behind, and that is PR #27's plan review round 1 F1.**
PostgreSQL's lexer treats a comment as whitespace: `COMMIT/**/WORK;` is the ordinary
`COMMIT WORK;`, and the server executes it as a commit. A scan that *removes* the comment instead of
replacing it joins the tokens on either side — the statement's words become the single word
`COMMITWORK`, no leading-keyword sequence matches, and the file the guard exists to refuse is
accepted. The consequence is the whole of §4.5's recovery contract: that commit ends drizzle's
transaction, a later failure in the same run leaves the committed schema change behind, the journal
row is never inserted, the status read afterwards still reports the tag pending, and R6 declares a
rollback that did not happen. So the rule is stated as part of the pass: **skipping a line comment
or a block comment emits exactly one space into the statement's code text**, and a line comment
additionally leaves its terminating newline in the code text, because the scan stops *at* the
newline rather than past it. One space is enough — the words are extracted by a token regex, so a
separator of any width separates — and it is the minimum that cannot itself create a keyword.
The same rule is what refuses `ROLLBACK/* x */TO SAVEPOINT s;`, `END/**/TRANSACTION;`,
`ABORT--x` followed by `WORK;` on the next line, and `CREATE INDEX/**/CONCURRENTLY i ON t (c);`,
which the removing form accepted as `INDEXCONCURRENTLY`. It refuses nothing new that PostgreSQL
would have accepted: a comment inside a statement whose leading keyword is not on the table —
`ALTER TABLE t/* comment */RENAME COLUMN a TO b;` — is still accepted, because the separator changes
the word boundaries and nothing else. §11.1 case 11 is the test.

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
| **either form, the journal and the table disagree** (a `when` that is not strictly increasing, or rows that are not an exact `(created_at, hash)` prefix) | `migrationStatus`'s drift message through `logError`, naming the first mismatch; **nothing is applied, and no status is printed** | **1** |
| any argument that is not `--check` | prints the usage line to stderr | 2 |

**The exit-code convention, stated because a script depends on it.** `0` means "I did what you
asked", `1` means "I failed", `2` means "you asked wrongly". In particular **`--check` exits 0 even
with migrations pending**: it answers *what would you do*, not *is this database up to date*. A
caller that wants a gate does not use `--check` at all — it runs the applying form and reads its
exit code, which is what `live-update.sh` step 8 does, or it starts the server with
`LOOM_MIGRATE_ON_BOOT=false` and lets the refusal of §5.3 be the gate. `--check` is for a human who
wants to know what the next update will touch before running it.

**The two carve-outs in that convention, and both are deliberate: a rejected file and a drifted
journal make `--check` exit 1.** A transaction-unsafe migration is not a *pending-migration state*
that `--check` is reporting
on — it is a defect in the repository, and `1` is this entry's code for "I failed". Making it exit 0
with a warning would leave `live-update.sh` step 5 with nothing to gate on, which is the whole
reason the check is run there: an offending file must stop the update **before** the quiesce, with
Loom still serving and nothing dumped. So the refusal is a failure in both forms of the command.
**Drift is the second carve-out, and it is the same argument** (round 8's F4): a journal whose `when`
values are not strictly increasing, or a table that is not an exact prefix of it, is a defect in the
repository and not a status. There is nothing truthful to print — "5 applied, nothing to apply" would
be the lie the finding is about — so both forms print the first mismatch and exit 1, and banner 6
stops the update there.

**And `--check`'s output shape is now a contract, because `live-update.sh` parses it** (§4.5's `pending_tags`,
R8 and banner 2's reconciliation). With something pending, stdout is: the `migrations: N applied`
line, then a line that is
**exactly** `pending:`, then the pending tags, **one bare tag per line, nothing after them**. With
nothing pending, stdout is the single `migrations: N applied, nothing to apply` line and no
`pending:` line at all. That is what makes `sed -n '/^pending:$/,$p'` a sound extraction, and
§11.2 case 15 asserts the shape — and, since round 5's F2, the extraction itself over both an empty
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
**And a drifted journal refuses the boot through the same path**, because `migrationStatus` throws
rather than answering (§5.1, round 8's F4): the server does not start against a database whose
history it cannot characterise, whichever way `LOOM_MIGRATE_ON_BOOT` is set — with it `true`,
`runMigrations` performs the same check before it applies anything.

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
Paw's merge word for it. Three edits, one thing the PR must leave alone, and two server-side
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
connector, and then said in §9 that steps 1 and 6 were Paw's — which handed Paw a batch of root
`docker` commands and left the one step the session genuinely cannot perform, the connector, marked
as the session's. A session reading §8 would have waited for Paw to do step 1; a session reading §9
would have sent Paw the batch. The rule is the one §8 already implied: a step is Paw's when it is in
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

**And one thing to remove while that panel is open, which is round 4's F7: any `AAAA` or `CNAME`
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
wherever a log happens to carry one. **Every log this slice reads goes through it**: every read in
`live-update.sh` — Postgres's log twice (§4.5 banner 8), Loom's log wherever a container fails to
answer (banner 10's helper and `restore_prev`'s two failure paths), a reaped one-off's
log inside `reap_oneoff`, and `migrate --check`'s own output in banner 6, in R8 and in banner 2's
reconciliation — and the runbook's two, §9 step
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
                       'prepare-chatgpt-paste.ps1','connector-url-to-clipboard.ps1','test\run.sh') {
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
   loop checks all **ten** files of §4 by name, plus the harness's entry point `test\run.sh`, before
   anything on the server is created, because
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
   `ls ~/git/Loom/deploy` lists all **ten** files (§4) and the `test/` directory beside them —
   `weave-guidelines.md` among them, since
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
   is pending, creates the new container — **and writes `deploy/.deployed-sha` only after the
   loopback check has answered**, because a created container is not a serving one (§4.5 banner 10,
   review round 7's F3, over round 5's F3) — and then installs `loom.caddy` and reloads Caddy. It
   also writes `deploy/.update-state` before the quiesce and removes it again in the same breath as
   the record (§4.5 banners 7 and 10). `--bootstrap` is required here and **only** here: there
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
   SHA as a tag, `cat ~/git/Loom/deploy/.deployed-sha` equals that short SHA,
   `~/git/Loom/deploy/.update-state` does **not** exist (a run that finished removes it — its
   presence would mean the next run reconciles instead of deploying, §4.5 banner 2), and
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
   public proof — `cat ~/git/Loom/deploy/.deployed-sha` equals the same value, which it already
   did from step 5, `~/git/Loom/deploy/.update-state` does not exist, and
   `docker inspect --format '{{.Config.Image}}' loom-loom-1` prints `loom-live:<that same short
   SHA>`, which is the agreement the next run's banner 2 will check for itself.
   Then, once, to prove the *failure* direction of the wrapper without touching the
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
    2. **Paw puts the connector URL on the clipboard** with the other committed script (§4.7),
       which prints one line and not the URL:

           powershell -NoProfile -ExecutionPolicy Bypass -File D:\git\Loom\deploy\connector-url-to-clipboard.ps1

       then pastes it into ChatGPT's connector dialog as a **Streamable HTTP** remote MCP server.
       The URL is `https://loom.3dbox.dk/mcp?agent=<key>` with the key read from
       `live-chatgpt.json`; the agent key therefore never appears on a screen, in a scrollback or
       in any transcript.
    3. Paw copies the paste file's contents and pastes them into the ChatGPT session.
    4. **Paw deletes the paste file and clears the clipboard**:
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

**Then retire the interim — with the INTERIM credentials, which is review round 10's F4.** The
Threads being closed are on the **dev** server, in the **dev** Weave, and every command from step 9
onward has been pointed at the live instance: the prelude set
`LOOM_CONFIG=C:\Users\paw\.loom\live-config.json`, step 10 cleared `LOOM_AGENT_KEY` and step 11 put
`LOOM_KEEPER_TOKEN` back. Changing only `--url` and `--weave` is therefore not enough, and the
failure is not obvious from the command: `thread close` resolves its identity through
`resolveWeave()`, which takes `LOOM_AGENT_KEY` when the environment has one and otherwise the
**stored** participant token for that Weave in `$LOOM_CONFIG`
([`context.ts`](../../../src/cli/src/context.ts), and the config path is `$LOOM_CONFIG` or
`~/.loom/config.json`, [`config.ts`](../../../src/cli/src/config.ts)) — and the live store has no
entry for the dev Weave, so the command would die with **`no_weave`** ("No stored credentials for
Weave …; join it first"). `LOOM_KEEPER_TOKEN` does not rescue it: `thread close` is a keepers-only
operation on the **Weave**, authorised by the Weave keeper's participant token, and the keeper
environment variable is only ever presented by the `admin` commands' `keeperClient()`.

So the interim identity is selected explicitly, both halves of it, and then the live environment is
put back. The dev Weave is `924408e6-0af2-4912-b02a-aa041962a55b` — the Weave the interim's review
rounds ran in, and `lastWeave` in the dev store — and the dev Claude-Code agent key, which is that
Weave's keeper, is in `~/.loom/agent-claude-code.json`. From `D:\git\Loom`, in the same PowerShell
session:

    # 1 — point everything at the interim: its config store, its agent identity, its URL
    $env:LOOM_CONFIG      = "C:\Users\paw\.loom\config.json"
    $env:LOOM_AGENT_KEY   = (Get-Content C:\Users\paw\.loom\agent-claude-code.json | ConvertFrom-Json).key
    $env:LOOM_KEEPER_TOKEN = $null
    $env:LOOM_ALLOW_INSECURE = "1"
    $dev = "924408e6-0af2-4912-b02a-aa041962a55b"

    # 2 — list what is open, so the close list is read rather than remembered
    $info = node src\cli\bin\loom.js --json --url http://127.0.0.1:3000 --weave $dev info | ConvertFrom-Json
    $open = @($info.threads | Where-Object { -not $_.closedAt })
    $open | ForEach-Object { "$($_.id)  $($_.name)" }

    # 3 — close each one. $($t.id) and not $t.id: in argument position PowerShell expands the
    #     variable and leaves ".id" as literal text, which would send the CLI a bad thread id.
    foreach ($t in $open) {
      node src\cli\bin\loom.js --url http://127.0.0.1:3000 --weave $dev thread close $($t.id)
    }

    # 4 — put the live environment back, exactly as step 9's prelude left it
    $env:LOOM_AGENT_KEY   = $null
    $env:LOOM_ALLOW_INSECURE = $null
    $env:LOOM_CONFIG      = "C:\Users\paw\.loom\live-config.json"
    $env:LOOM_KEEPER_TOKEN = (Get-Content C:\Users\paw\.loom\live-keeper.json | ConvertFrom-Json).token

Four things about that, each a reason rather than a flourish. **`LOOM_CONFIG` goes back to the dev
store** so that nothing in these commands can read or write the live one — and although the agent
key plus an explicit `--weave` is enough on its own for `resolveWeave()` (an agent key stands in
for a stored token, which is that function's documented behaviour), a command pointed at the dev
server with the live store selected is a confusion waiting to be repeated by the next person who
copies these lines. **`LOOM_KEEPER_TOKEN` is cleared** for the same reason step 10 and step 11
clear one or the other: the shell holds one identity at a time. **`LOOM_ALLOW_INSECURE=1`** because
the dev server is plain `http://127.0.0.1:3000` and the client refuses a non-TLS URL without it.
And **`--weave` is given explicitly on every call** rather than relying on the dev store's
`lastWeave`, because that value is whatever the last dev command left behind.

The dev server is then stopped, and DOGFOOD §2's interim paragraph is replaced by the live runbook
(§10). The interim's dev database is **not** dropped — it is the development
database and the dev Lobby's 60 `seed-N` listeners live in it; only the Weave is done with.
*Done when:* DOGFOOD no longer describes an interim as the thing to use; re-running step 2 after
step 3 leaves `$open` **empty** (`$open.Count` is `0`), which is the dev server's own answer that
every Thread in that Weave now carries a `closedAt`; and
`$env:LOOM_CONFIG` is back to `C:\Users\paw\.loom\live-config.json` with `LOOM_AGENT_KEY` and
`LOOM_ALLOW_INSECURE` unset, so the next live command is made as a keeper against
`https://loom.3dbox.dk`.

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
| [HANDBOOK.md](../../HANDBOOK.md) §5 traps | Fifty-six new ones, all paid for in writing this spec and in answering its twelve review rounds: **`pgrep -f` matches the shell that runs it** — `-f` searches whole *command lines*, so a verdict wrapper written as `sh -c '… pgrep -f pg_dump …'` finds its own parent shell (`pgrep` excludes only itself, never the process that launched it) and answers "a dump is still running" on an empty container, every time and for good: a hazard marker cleared only by the opposite answer then latches shut permanently. Match the process **name** with `pgrep -x`, which is exact and is the thing a full path or a long argument list cannot change — and note that the bare `pgrep -af`/`pkill -f` a container runs *as its own argv*, with no wrapper shell, are not the same case and are still right. **And a one-word fix to a string a container executes is verified by executing it in a container**, in both of the states it must tell apart, because the defect was invisible to three readings; **a reaper that guards one run does not guard the next one** — the run that finds an interrupted update on disk is not the run that started the migrator, so the applying container can still be alive while the *new* process asks the database what happened: reap it, with the same proof the original run required, **before** the cheap "is it already healthy" probe and before any status is read, and refuse without restoring when the reap proves nothing; **a marker whose lifetime is the box's must not live inside a record whose lifetime is one run's** — the run that records "a `pg_dump` may still be running" is the run whose recovery then removes its own intent record, taking the marker with it, so the hazard goes in a file of its own and is cleared only by the check that disproves it; **`drizzle-kit generate` diffs against the newest snapshot file, not against the journal** — deleting a migration's `.sql` and its journal entry and leaving `meta/<NNNN>_snapshot.json` behind makes the regeneration see its own change as already present and emit nothing at all, so restore `meta/` to the merged baseline as well — **and `git checkout <ref> -- <dir>` does not restore a directory, it overlays one**, rewriting the files the ref has and leaving every branch-only file exactly where it was, so the snapshot survives the command written to remove it: use `git restore --source=<ref> --staged --worktree -- <dir>`, which is non-overlay by default; **an environment aimed at one instance stays aimed at it** — a runbook that ends by touching a *different* instance has to select that instance's config store, identity and URL explicitly and then put the first one back, because the CLI resolves its Weave and its token from `$LOOM_CONFIG` and `LOOM_AGENT_KEY` and will otherwise fail with `no_weave` on a Weave it has never heard of; **a `timeout` is not a bound when the kernel will not kill the child** — a process wedged in uninterruptible I/O on a stalled or full filesystem survives `TERM` and `KILL`, and `timeout` then waits for it, so a deadline on every command is still not a ceiling on the outage: sum the deadlines if you like, but say which waits sit outside the sum and who ends them; **a signal sent is not a process gone** — `pkill` inside a container proves only that a signal was delivered somewhere, so ask afterwards, treat anything but a definite "gone" as still running, and leave a durable marker that makes the *next* run refuse rather than queue behind it; **and a remote command's exit status is not the remote command's answer** — `docker compose exec … pgrep` returns 1 with empty stdout both when `pgrep` matched nothing and when Compose never ran it at all, so a gate that reads that as "nothing matched" clears its own hazard on a daemon error: make the container print a verdict token of its own, require a successful transport *and* that token, and treat every other shape — non-zero exit, empty stdout, unrecognised stdout, a timeout — as unanswered and therefore as the hazard; **a path spelled in a script is a path a test cannot avoid touching** — absolute literals make a harness either unrunnable on a laptop or dangerous on the server, so make every operational path a constant with its production default, move them only under one explicit test-mode variable that announces itself, and assert the defaults by *reading* the file rather than by running it; **a timeout on a client is not a timeout on the work** — `docker compose exec … pg_dump` under a killed client leaves `pg_dump` running inside the container, holding a snapshot of the database the script is about to migrate, so kill the server side too and bound that as well; **an exit handler is not a timeout** — a script blocked in a command has not exited, so no trap runs, the lock stays held and the outage has no end: put a deadline on every command that runs while the application is stopped, and state the ones that still have none; **a retry count is not a deadline** — `for _ in $(seq 1 30); do curl …` bounds nothing when one call can hang, so give the call `--connect-timeout`/`--max-time` and the loop an absolute clock; **a mutable tag and a canonical name do not identify a container** — the same commit rebuilt over a newer base image is a different image id under the same tag, so a recovery that starts "the previous deployment" by name starts the wrong binary while every record tells the truth: compare the recorded **image id**; **and a migrator's own rule is not a safety property** — drizzle applies what is newer than the newest applied row, so a migration generated on a long-lived branch and merged after a newer one is reported applied and silently skipped, which is a healthy deployment with a missing table in it: validate that the journal increases and that the rows are an exact prefix of it, and refuse instead of reporting; `docker compose up <service>` **returns 0 even when the service failed**, and `--exit-code-from` implies `--abort-on-container-exit`, which would stop the live database — use `docker compose run --rm`; **HSTS `includeSubDomains` does not cover a sibling host**, so `loom.3dbox.dk` needs its own; **a compose project is named after its directory unless the file says otherwise** — two `deploy/` directories are two projects called `deploy`, so put `name:` in the file; **and `name:` is not enough** — `COMPOSE_PROJECT_NAME` outranks it, so pass `-p <project>` on every command and refuse to run with that variable set; **`git pull --ff-only` does not mean "the checkout equals origin"** — it succeeds over a local commit the remote has not passed and leaves a dirty tracked file alone, so assert `HEAD == refs/remotes/origin/main` on a clean tree instead; **a stopped Postgres container is not an empty database** — ask the volume, or a migration runs with no dump behind it; **a checkout whose `origin` is a local bundle cannot see a commit merged on GitHub** — a `pull` says "already up to date" and the prerequisite is silently not deployed, so re-bundle and `scp` it; **a backup is worth only the window between it and the change it insures against** — dump immediately before the migration, not before a two-minute build; **"wait until it is healthy" with no bound is a hang holding a lock** — poll with a timeout, fail fast on `unhealthy`, and print the logs; **`--env-file` hands a container every line of the file**, so build a two-variable temporary file instead of passing a neighbour's whole environment; **`-f` does not move compose's `.env` lookup** — it follows the caller's directory, so a `-f`-only command run from elsewhere silently takes every default in the file, and `--env-file` belongs beside every `-p`; **a guard placed after the mutation it guards is disarmed by a retry** — compare against the deployed state *before* fast-forwarding, and persist what is deployed; **a dump taken while the application still accepts writes is a snapshot with a live tail** — stop the application, or stop claiming the restore loses nothing; **a single mutable image tag means there is no previous image** — tag per commit if a failure has to be able to go back; **`grep | cut` under `set -euo pipefail` defeats the `${VAR:-default}` on the next line** — `grep` exits 1 on no match, `pipefail` propagates it and `set -e` kills the script before the default is read, so use `sed -n 's/^KEY=//p'`, which exits 0; **`git fetch origin` does not move the local `main`** — a bundle cut afterwards advertises the stale branch while containing the new commit, so `switch` and `pull --ff-only` before bundling; **an instance keeper is not a Lobby participant** — `loom lobby` needs a stored Lobby token or an agent key, so join before reading, and read as the keeper because only a keeper is told the Lobby's secret; **a non-zero exit from a database client does not prove the transaction rolled back** — PostgreSQL can commit and the connection can drop before the client hears it, so record the pending set before migrating and *ask* afterwards instead of asserting; **one record cannot hold two facts** — "which commit's image and schema are active" and "which commit was proved over the public hostname" have different lifetimes, and a single file holding both will aim a recovery at an image the schema has moved past; **an old image inside a new compose definition is not the old deployment** — `stop` keeps the container with its image id, command, environment and networks, so `docker start` it rather than re-`up`-ing a tag through a file that has changed; **a guarantee a future merge can void from inside a file is not a guarantee** — one `COMMIT` or `CREATE INDEX CONCURRENTLY` in a migration ends the transaction everything else relies on, so enforce it in code and test it over the real files; **an A record that resolves is not a complete DNS answer** — a stale or wildcard `AAAA` sends ACME's validator and every IPv6 client elsewhere while the A check passes, and a `CNAME` beside an `A` is invalid outright; **a runbook that reads files out of a local checkout has to say which commit that checkout is on**, or it fails three-quarters of the way through on a missing helper; **running a deployment's steps by hand is not running the deployment** — exercise the wrapper the merge will actually use, on the first day, or its first real use is the test; **`docker compose run <service> <args>` replaces the service's `command:`** rather than appending to it, so a status flag on its own becomes the program the container tries to execute — name the whole command; **a shell pipeline that ends in `grep` fails on the empty result** — `grep -v '^$'` exits 1 with nothing to filter, and under `pipefail` the most ordinary outcome there is kills the script, so delete blank lines with `sed` instead; **`cmd | grep -q` under `pipefail` can report 141** — `grep -q` exits on the first match, the producer dies of `SIGPIPE`, and a guard written as `producer | grep -q … && refuse` therefore waves the very case through that it was written to catch, **and collecting the output into a variable is not the fix** — `printf '%s\n' "$VAR" | grep -q …` has the same defect with `printf` as the victim, so the pipe itself has to go: `grep -q … <<<"$VAR"`, or a variable and a `case`, and then the *whole* file audited for the shape, because one instance is never the population; **`docker compose run` allocates a pseudo-TTY when its stdin is a terminal**, so output a script parses arrives CR-terminated from an interactive SSH shell and matches nothing — pass `-T` on anything whose output is read, and keep its stderr out of the file being parsed; **a record written before the thing it records is live is a record that lies** — with no migration to apply, the new commit is only deployed once its container is actually up, so write the record after the start, not at the quiesce; **a trap armed half-way down a script reads variables the script may not have assigned yet** — under `set -u` the handler dies instead of recovering, so initialise every input first and install one handler at the top, and clear `errexit` before classifying inside it; **`timeout` bounds the client, not the container** — a killed `docker compose run` leaves the one-off running with its transaction open, so name the container, kill it, wait for it under a bound and reap it before asking the database anything, and bound that question too — **and reap on every non-success, not only on the timeout's exit codes**, because a client that loses its connection to the daemon exits 1 while the container keeps running, and a reconciliation run alongside a live migrator can restart the old image just in time for the migrator to commit the new schema under it; **`ABORT` is PostgreSQL's alias for `ROLLBACK`** — a guard that lists the transaction-control statements by sample rather than taking the group whole will miss one, and one is enough; **`docker compose ps` omits stopped containers** — a completed one-shot is invisible without `--all`, so a correct startup can fail a done-check written against plain `ps`; **a line an application prints on purpose is still a credential when somebody else reads the log** — Loom's first boot prints the Lobby's secret link by design, so a session running `docker compose logs` over SSH puts it in the controller's transcript: redact at the **reader** as well as at the writer, and let a done-check match on the server and print only its verdict; **arm a recovery before the command it recovers from, never after it** — `docker compose stop` can stop the container and still exit non-zero, and a flag set only on success leaves the handler disarmed over a stopped application, so set it first and clear it again only on positive evidence that nothing was stopped; **a comment stripper that does not understand quoting deletes the statement the guard exists to find** — `VALUES ('--')` turns the rest of the line into a comment for any scanner that strips comments as a phase, so a SQL guard must be one stateful pass in which a comment is only a comment in the code state; **a printed recovery command is only a recovery if it works in the shell that reads it** — a `docker compose …` that relies on the script's own working directory fails in the `/root` shell the operator actually opens, so print `cd <absolute path> && …`, name the environment file, and name every record by its absolute path; **a failure to ask is not an answer** — `docker inspect … || return 0` reads a daemon that is not answering as "the container is not there", which is precisely the outage that left the container running, so classify the error text and treat anything but "No such object" as unknown — **and one classified call site does not classify the file**, because the same `|| true` was still deciding whether a backup got taken and whether a previous deployment existed: put the three-way classification in one helper and route every inspection through it, so the next call site cannot be written the old way; **a stop you did not verify is not a stop** — `docker stop`, `docker kill` and `docker wait` can all fail quietly, so re-inspect and require `exited` or `dead` before believing anything about the database, and make the unprovable case its own state rather than a warning; **`docker compose up -d <service>` REPLACES that service's container** — compose finds it by project and service *labels*, stops it, renames it aside and removes it, so the container a recovery meant to restart is gone the moment the new one is created, **and `docker rename` does not hide it**, because the labels are what the lookup uses: keep the *image id* and the *deployed commit's own compose file* instead, and reconstruct from those two; **"the container was created" is not "the application is serving"** — `up -d` returns 0 as soon as Docker has started the process, so a state variable set there disarms a recovery on the strength of nothing, and only a request the application answered may do that; and **a trap cannot recover an interruption that is not an exit** — a power loss or a `SIGKILL` runs no handler at all, so write an intent record before the first irreversible step, reconcile it at the top of every later invocation, and remove it only once the thing it intended is a durable fact |
| [ARCHITECTURE.md](../../ARCHITECTURE.md) §10 | A third paragraph: the two root-level profiles are the **standalone** install, `deploy/` is the **beside another Caddy** install, and this is where the shared `web` network and the sites-folder hook are described. The sentence "Migrations run on every boot in `main.ts`" is corrected to name `LOOM_MIGRATE_ON_BOOT` |
| [README.md](../../../README.md) "Running locally" | A short **Deploying beside another Caddy** paragraph pointing at `deploy/` and naming the one command; the existing production paragraph keeps describing the standalone `--profile prod` install |
| [TESTING.md](../../TESTING.md) §1 | The generalised truncate guard (`_test` suffix), the testcontainer's database name, and the sentence about pointing `TEST_DATABASE_URL` somewhere safe (§6). One more sentence in the build-before-test paragraph: `src/server/test/migrate.test.ts` runs the built entry as a child process, so it is one of the suites that needs `pnpm -r build` first (§11.2). And one on the two **package-local** Testcontainers fixtures, `src/core/test/pg-container.ts` and `src/server/test/pg-container.ts`: the migration suites start a Postgres of their own rather than using the shared global-setup database, because they need one with no migrations applied (§11.1, §11.2) |
| [TESTING.md](../../TESTING.md), a new short section | **The shell contract tests** of §11.7: `pnpm test:deploy`, or `bash deploy/test/run.sh`, runs the real `deploy/live-update.sh` against stub `docker`, `git`, `curl`, `timeout` and `flock` commands in a temporary directory, with `LIVE_UPDATE_TEST_ROOT` pointing the script's five path constants into that same directory, so the run reads and writes nothing the live server owns and is therefore safe on the server itself (round 9's F1). It needs **no Docker, no Postgres and no network**, which is the one thing about it a reader must know before the first time it is run on a laptop, and it is **not** part of `pnpm -r test`: it is a `bash` runner, not a `vitest` suite, so it is its own script. The section also says what the harness does not cover — reality — and points at §11.6 for what does |
| root [`package.json`](../../../package.json) | One script: `"test:deploy": "bash deploy/test/run.sh"`. Named beside `test` rather than folded into it, because the two need different things (one needs Docker, the other needs nothing) and a developer who breaks the deployment script should be able to run the fast one alone |
| [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) | **Rows deleted:** the `mcp/index.ts:111` session-less `GET` 500 (§5.4). **Rows added:** one, and only one — the first-boot Lobby link of the row below; §13 is scope, not defects, so nothing in it becomes a row. **Rows kept, and now depended on:** the `commands/lobby.ts` keeper-cannot-read-the-Lobby row stays deferred exactly as written; §9 step 10 works around it with a `lobby join` and points at it, so the row gains one clause noting that the live-instance runbook is a caller that has to do that |
| [KNOWN-ISSUES.md](../../KNOWN-ISSUES.md) and [v2-notes.md](v2-notes.md) — **the first-boot Lobby link** | **One row and one note added, and this is review round 6's F1 follow-up.** `main.ts` prints the Lobby's `/w/<43-character secret>` link unredacted on the boot that creates it — by design, documented in the README, and the only way a first operator learns where the Lobby is. It is also the reason every log read in this slice goes through `redact_logs` (§8.1) and the reason §9 step 4's done-check asserts a shape on the server instead of reading the log. The note records the alternative for a later slice: **gate that one line behind an explicit flag** (`LOOM_PRINT_LOBBY_LINK=1`, say) so the secret is printed only when someone asked for it, and have the unflagged boot print the Lobby's id alone. **It is not this slice's change** — it alters an interface the README documents and a first-run path nothing else has exercised, and redacting at the reader already closes the transcript hole this slice is responsible for. The KNOWN-ISSUES row is the defect statement, the v2-notes entry is the idea with this decision attached |
| [`.gitignore`](../../../.gitignore) | **Eight** lines, beside the existing `.env`: `deploy/.deployed-sha`, `deploy/.verified-sha`, `deploy/.deployed-image`, `deploy/.update-state`, `deploy/.dump-in-progress` (round 10's F2) and the three atomic-write temporaries `deploy/.deployed-sha.new`, `deploy/.verified-sha.new` and `deploy/.update-state.new`. All eight are server state written by `live-update.sh`, and an untracked file in the checkout would trip the script's own clean-tree check — including one a killed run left behind, which is why the temporaries are named too (§4, §4.1, §4.5 banners 1, 2, 3, 7 and 8). Eight explicit lines rather than a glob, so a reviewer can read what is ignored — and a `deploy/.deployed-*` glob would have covered neither `.update-state` nor `.dump-in-progress` |
| [v2-notes.md](v2-notes.md) | The "A live Loom instance …" entry becomes **built**, dated, with the hostname, the `deploy/` path and a one-line pointer to this spec; the 2026-09-20 dogfood finding about the session-less `GET` gains its "fixed in PR #N" note |
| [CONTRIBUTING.md](../../../CONTRIBUTING.md) | **A new short section, `## Migrations`, after `## Concurrency conventions`** — this is the one convention this slice does add, in answer to review round 4's F4. Four bullets now, the fourth being review round 8's F4 as review round 10's F3 corrects it: **the journal's `when` values must be strictly increasing in file order**, so a migration generated on a long-lived branch and merged **after** a newer one must be **regenerated** — and that is **three** deletions, not two: the unmerged migration's `.sql` file, its `_journal.json` entry **and its `meta/<NNNN>_snapshot.json`**, restoring `meta/` to the merged-`main` baseline (`git fetch origin` then `git restore --source=origin/main --staged --worktree -- src/core/drizzle/meta` when the only unmerged migration is yours; otherwise remove that one snapshot file by hand, because that command would discard a second unmerged migration too) — then re-run `drizzle-kit generate` and commit that. **It has to be `git restore` and not `git checkout`, which is round 11's F2**: `git checkout <ref> -- <path>` is *overlay* mode and leaves every branch-only file in place, so the obsolete `meta/<NNNN>_snapshot.json` survives the very command that was supposed to remove it and the regeneration still emits nothing; `git restore` is non-overlay by default and stages the deletion (verified in a throwaway repository, §5.1). On Git older than 2.23, `git rm -r --cached` + `rm -rf` + `git checkout origin/main -- src/core/drizzle/meta` is the equivalent. The reason the snapshot must go is that **`drizzle-kit generate` diffs against the newest snapshot file in `meta/`, chosen by name and independently of the journal** (`prepareOutFolder`'s `readdirSync` + `sort` and `preparePrevSnapshot`'s `snapshots[snapshots.length - 1]` in `drizzle-kit@0.31.10`, §5.1) — so a snapshot left behind already contains the change, the diff is empty, and `generate` prints `No schema changes, nothing to migrate` and emits **no replacement at all**, leaving the author with a deleted migration and nothing to merge. **Already-deployed migrations are never touched**: their file, journal entry and snapshot all stay, because the live database's rows are matched against them by `(created_at, hash)`. All of it is needed because the branch's original stamp is older than a migration the live database has already applied, and a database whose rows are not an exact prefix of the journal makes `migrationStatus` refuse and stops the deployment at §4.5 banner 6 with Loom still serving. Editing the `when` by hand is not the fix: the entry's hash is recorded with it, so a stamp edited after the file has been applied anywhere produces a hash mismatch instead (§5.1). And the other three: **a run is one transaction**, which is what makes a failed migration a no-op and the deployment's recovery possible (§4.5); **so a migration file may not contain a transaction-control statement or a statement PostgreSQL cannot run inside a transaction block** — the list of §5.1, enforced by `assertTransactionSafe`, which `runMigrations` and `migrate --check` both call, and which §11.1 runs over every real file; and **a migration that genuinely needs to be non-transactional is a guarded hand-run deployment**, never an input `live-update.sh` accepts (§13). It is in CONTRIBUTING and not only in the spec because it binds every future migration, and a rule that lives in one slice's design document is a rule the next author will not read |
| `.claude/launch.json` | **Unchanged, deliberately.** It stays pinned to port 3000: it is the *development* preview harness on Paw's PC, and the live instance is not something the harness starts. DOGFOOD's gap list said it "cannot start the live instance without editing it" — that row is not a gap any more, it is the right behaviour, and §13 says so |

## 11. Tests

Every test below is assigned to exactly one plan task
([HANDBOOK.md](../../HANDBOOK.md) §3 step 5). The seven groups are honest about what is and is not
covered by an automated suite: §11.6 says what no suite touches at all, and §11.7 — new in answer to
review round 8's F5 — is the first automated test anything in `deploy/` has ever had, with its own
paragraph on the difference between testing a script's control flow and testing a deployment.

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
server entry. The `assertTransactionSafe` cases (9, 10 and 11) need no database at all and are in
this file because they test the same module, and so does the journal half of cases 5, 7 and 12 — a
`when` sequence that is not strictly increasing, and a folder that disagrees with its journal, are
both refused before anything is read.

**Cases 11 and 12 are appended rather than inserted**, although 12 belongs with the drift family of
cases 5 to 7 and 11 with the guard cases 9 and 10. Appending is what keeps every existing
cross-reference to cases 1 to 10 — in this document, in the plan and in the commit history of both —
pointing at the case it was written about. The groups that follow are renumbered, because they must
stay contiguous.

1. **A fresh database lists every journal entry as pending and nothing as applied** — the count
   equals the journal's entry count, the order is the journal's, and
   `to_regclass('drizzle.__drizzle_migrations')` is null, which is the probe of §5.1 answering.
2. **Applying moves them all across.** After `runMigrations`, `migrationStatus` reports every tag
   applied and nothing pending.
3. **A second run applies nothing.** Idempotence, and the assertion is the *rule* — `pending` is
   empty and the table's row count is unchanged — never an exact write count
   ([HANDBOOK.md](../../HANDBOOK.md) §5).
4. **A clean prefix is the happy path, and the hash is what proves the check is real — new in
   answer to review round 8's F4.** Against a fresh database, `runMigrations` applies every real
   migration; then the newest row is **deleted** from `__drizzle_migrations` and `migrationStatus` is
   asked again: the remaining rows are exactly journal entries 0 to n-2, so those tags are `applied`
   and the last one is `pending`. Rows are *deleted* rather than inserted on purpose — the rows that
   remain carry drizzle's **own** `created_at` and `hash`, so a case that passes proves
   `migrationStatus` computes the same `(created_at, hash)` pair drizzle inserted, which is the one
   claim §5.1's paragraph about `readMigrationFiles` cannot make by assertion. The previous case here
   inserted a single hand-made row to simulate "migrated to entry 1" and asserted the
   maximum-`created_at` rule; that rule is what F4 removed, and a single row at entry 1's `when` is
   now correctly reported as **drift**, because entry 0's row is missing (case 6).
5. **A backdated entry appended after a newer one is drift — F4's own scenario, and no database is
   needed for it.** A temporary folder (the mechanism case 8 introduces) whose journal is, in file
   order, `Y` at `when` 200 and then `X` at `when` 150, with a valid `.sql` file for each.
   `migrationStatus(db, folder)` is expected to **reject**, with a message naming the two entries
   that are out of order, and **`runMigrations(db, folder)` is expected to reject too, applying
   nothing** — `to_regclass` for both files' tables is null afterwards. That second half is the
   answer to F4's question about whether core should refuse as well: it must, because drizzle's
   `migrate()` would otherwise apply by its own maximum rule and skip `X` exactly as the finding
   describes. The process-level half — both forms of the migrate entry exiting 1 — is §11.2 case 18.
6. **A row that is not where the journal says is drift, and so is a gap.** Take case 4's clean
   prefix and (a) change one remaining row's `hash` to a different 64-hex string, (b) instead delete
   a row from the **middle** so the rows are no longer a prefix. Both are expected to reject, and the
   message must name **the first** mismatching position, its journal tag and what the row at that
   position actually held — because that message is the whole user interface of this check and the
   developer has to know which file to regenerate.
7. **A duplicate `when` is drift.** A temporary folder whose journal holds two entries with the same
   `when`: strictly increasing excludes equality, so it rejects, naming both. This is the case a
   hand-edited journal or a badly resolved merge conflict produces, and it would otherwise make the
   prefix comparison ambiguous about which of the two a row matched.
8. **A failing migration leaves the schema unchanged** — the case §4.5 banners 7 and 9 stand on, and
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
   because case 9 refuses it at the source.
9. **`assertTransactionSafe` accepts every real migration file — new in answer to review round 4's
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
   pointed at a temporary folder — the mechanism case 8 introduced — holding one file with a valid
   `create table t_first (id int)` and a second file carrying a bare `COMMIT;` between two valid
   statements. The call is expected to **reject with the guard's message**, and then
   `to_regclass('public.t_first')` is **null**: the refusal happened over the whole pending set
   *before* anything was applied, not part-way through it, which is the ordering §5.1 specifies and
   the only ordering that is any use. The process-level half of this needs no case of its own —
   `migrate.ts` reports a thrown error through `logError` and exits 1, which §11.2 case 17 already
   asserts as a process contract — and the deployment-level half is `live-update.sh` step 5 running
   `--check`, which §11.6 lists among the mechanisms that are structural rather than tested.
10. **`assertTransactionSafe` rejects each form, and is not fooled by the look-alikes.** Unit cases,
   no database: **one rejection per spelling in §5.1's table**, which is review round 5's F6 as a
   test list — `BEGIN;`, `BEGIN WORK;`, `BEGIN TRANSACTION;`, `START TRANSACTION;`, `COMMIT;`,
   `COMMIT WORK;`, `COMMIT TRANSACTION;`, `END;`, `END WORK;`, `END TRANSACTION;`, `ROLLBACK;`,
   `ROLLBACK WORK;`, `ROLLBACK TRANSACTION;`, **`ABORT;`**, `ROLLBACK TO s1;`,
   `ROLLBACK TO SAVEPOINT s1;`, `SAVEPOINT s1;`, `RELEASE SAVEPOINT s1;`,
   `PREPARE TRANSACTION 'gid';`, `COMMIT PREPARED 'gid';`, `ROLLBACK PREPARED 'gid';`,
   `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;`, `SET TRANSACTION SNAPSHOT '000003A1-1';`,
   `DISCARD ALL;`, `DISCARD PLANS;`, `CREATE INDEX CONCURRENTLY i ON t (c);`,
   `DROP INDEX CONCURRENTLY i;`, `REINDEX INDEX CONCURRENTLY i;`,
   `REFRESH MATERIALIZED VIEW CONCURRENTLY mv;`, `ALTER TABLE t DETACH PARTITION p CONCURRENTLY;`,
   `VACUUM;`,
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
   `INSERT INTO t (c) VALUES ('commit');` as a string literal; `CREATE INDEX i ON t (c);`,
   `REFRESH MATERIALIZED VIEW mv;` and `ALTER TABLE t DETACH PARTITION p;` without
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
   folder — the mechanism case 8 introduced — holding **one** file whose **first** statement is valid
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
11. **A comment between two keywords does not join them — PR #27's plan review round 1 F1, and the
    reason the pass emits a separator.** Unit cases, no database, and each asserted to throw naming
    the file and the keyword: `COMMIT/**/WORK;`, `ROLLBACK/* x */TO SAVEPOINT s;`,
    `END/**/TRANSACTION;`, `CREATE INDEX/**/CONCURRENTLY i ON t (c);`, and `ABORT--x` with `WORK;`
    on the next line, which is the same rule across a **line** comment. PostgreSQL reads every one
    of these as the ordinary spaced statement and executes it; a scan that deletes the comment
    instead of replacing it sees `COMMITWORK` and accepts the file. The line-comment form is
    included although the pass answers it correctly either way — it stops *at* the newline, so the
    newline is the separator — because what the case pins is the rule, not the implementation
    detail that happens to satisfy it today. **And the accepted look-alike is the other half:** a
    comment sitting inside a statement whose leading keyword is not on §5.1's table must still be
    accepted — `ALTER TABLE t/* comment */RENAME COLUMN a TO b;`,
    `INSERT INTO t(c)/**/VALUES ('commit');` and
    `SELECT CASE WHEN x THEN 1 ELSE 2 END/**/FROM t;` — so the separator is shown to change word
    boundaries and nothing else.
12. **An orphan `.sql` file and a journal entry with no file are both drift — PR #27's plan review
    round 1 F2, and the case the previous draft's check could not fail.** Two sub-cases over
    temporary folders (the mechanism case 8 introduced), neither needing a database beyond the one
    the call is handed: (a) a journal of one entry beside **two** `.sql` files —
    `migrationStatus(db, folder)` rejects, naming the orphan file, and `runMigrations(db, folder)`
    rejects too, applying nothing; (b) a journal of two entries beside **one** `.sql` file — both
    reject, naming the entry whose file is missing, and the message is **this check's**, naming the
    journal and the remedy, rather than drizzle's `No file … found in … folder`. Sub-case (a) is the
    one that matters: `readMigrationFiles` loops over journal entries, so with two files and one
    entry it returns **one**, and a check that compares its length with the journal's length can
    never fail in that direction. The case is written to assert the **refusal**, so an implementation
    that reintroduces the length comparison fails it.
**And the one signature change cases 5 to 8 need, decided here rather than left to the plan.**
`runMigrations(db)` resolves its folder internally today, so a test cannot give it one. It becomes
`runMigrations(db, folder = migrationsFolder())` — the same helper §5.1 extracts, as the **default**,
and `migrationStatus(db, folder = migrationsFolder())` takes it the same way, for the same reason and
so that the two can never be pointed at different folders (§5.1). Every existing caller
(`main.ts`, the migrate entry, `freshDb()`) is unchanged and unaware, and a
test can pass a folder it wrote. The alternative, having the test call drizzle's `migrate()` itself,
would test drizzle rather than the function this repository actually deploys with, which is the
opposite of what case 8 is for.

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

13. **No flag, nothing pending:** prints `migrations: 5 applied, nothing to apply` on stdout,
   exit **0**.
14. **No flag, some pending:** prints the applied count, then `applying:` and each pending tag on its
   own line, applies them, then the `migrations: applied 2 (…)` summary; exit **0**, and the
   database is migrated afterwards.
15. **`--check` applies nothing, and its output has the shape `live-update.sh` parses.** With
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
16. **An unknown argument exits 2** and prints the usage line to **stderr**, with nothing on stdout
   and no connection attempted — a mistyped invocation must be distinguishable from a failure.
17. **`DATABASE_URL` absent** fails with the same message `loadConfig` already gives, and exits
   **1**.
18. **A drifted journal exits 1 in both forms, and prints no status — new in answer to review round
    8's F4.** The child process is given a `LOOM_MIGRATIONS_FOLDER`-free, ordinary invocation against
    a database the case has drifted by deleting a row from the middle of `__drizzle_migrations`
    (§11.1 case 6's shape). Both `node dist/migrate.js` and `node dist/migrate.js --check` exit
    **1**, stdout carries **no** `migrations: N applied` line and **no** `pending:` line — because a
    drifted database has no honest status to print, and `live-update.sh` parses that stdout — and the
    drift message naming the first mismatch is on stderr through `logError`. This is the case that
    makes §4.5 banner 6 a gate rather than a hope: without it a drift would be reported as a healthy
    "nothing to apply" and the update would proceed through the quiesce.
19. **The process ends on every path.** Each of the cases above is asserted to exit within the
    suite's timeout rather than being killed, which is what proves `closeDb` runs — a migrate
    container that never exits would hang `docker compose run --rm migrate` and therefore hang the
    update, with the lock of §4.5 banner 2 still held.

### 11.3 The boot switch — `src/server/test/config.test.ts` and the server boot suite

20. **Default true.** `loadConfig({ DATABASE_URL: … })` gives `migrateOnBoot: true`; `"true"` and
    `"false"` (in any case, with surrounding whitespace) parse to the obvious values.
21. **Anything else throws** — `"0"`, `"no"`, `""`, `"yes"` — with the variable name in the message.
22. **`false` with migrations pending refuses to start**, with the message of §5.3 naming the count
    and the pending tags, and the process exits non-zero. Against a database migrated to an earlier
    point than the journal (the row-deletion trick of case 4).
23. **`false` with nothing pending starts normally** and serves a request — the case that proves the
    refusal is not simply "false never boots".
24. **`true` is unchanged**: a server booted against an unmigrated database migrates it and serves,
    exactly as today.

### 11.4 The MCP guard — `src/server/test/mcp.test.ts`

25. **Session-less `GET /mcp?agent=<key>` answers 400 `{ code: "validation" }`** — with a valid agent
    key, and with `Accept: text/event-stream`, because that is the request the real connector sends.
26. **Session-less `DELETE /mcp` answers 400** the same way.
27. **A session-less `GET` with a revoked key is still 400, not 401** — the guard runs before any
    credential resolution (§5.4).
28. **A bogus `mcp-session-id` is still 404 `not_found`** — the existing case, unchanged.
29. **A full `initialize` over `POST` still works**, and the two concurrent session-less `PUT`
    requests of `mcp.test.ts:95` still get two connect attempts and two 405s — the coverage the
    guard's method list exists to preserve.

### 11.5 The truncate guard — `src/core/test/db-guard.test.ts`

30. **Refused:** a URL whose database is `loom`; one whose database is `spool`; one whose database is
    `loom_live`; one whose database is `postgres`; and an unparseable URL.
31. **Allowed:** `loom_test`; any other `<name>_test`; and the **named testcontainer URL** of §6
    (`.../loom_test`) — replacing the old case that asserted a bare `test` database was allowed.
32. **Not fooled by the name elsewhere in the URL** — `postgres://loom:loom@loom:5432/loom_test` is
    allowed. The existing case, kept.
33. **`fallbackTestUrl` is unchanged** — both existing cases stand.
34. **The whole suite still runs.** Not a test but a verification step the plan must name: after
    `.withDatabase("loom_test")`, `pnpm --workspace-concurrency=1 -r test` passes on the normal
    Testcontainers path *and* on the fallback path. Case 31 would pass while every other test in the
    repository refused to start, which is precisely the failure §6 exists to prevent.

### 11.6 What no unit test covers, said plainly

**`live-update.sh`'s control flow is covered by the harness of §11.7; everything else in `deploy/`
is covered by the first deployment (§9), by the rehearsals below, and by nothing else** —
`docker-compose.yml`, `loom.caddy`, the two wrappers, the two committed texts and the two PowerShell
helpers. There is no compose harness in this repository and no Caddy fixture, and inventing one for
files that run once per merge against one specific server would be a larger and less honest change
than reading them. **The script itself is the exception, and round 8's F5 is why it stopped being
one.** Ten review rounds have each found a defect in it that a reading had missed — a pipeline that
dies on an empty result, a status command that does not read status, a state variable read before it
is set, a trap that cannot recover an interruption, a container identified by a mutable tag, a
volume inspection whose failure was read as an absence, a reconciliation that never reaped the
migrator it was reconciling, a marker deleted by the very recovery it was written on — and
two of those rounds could only pin their finding with a few lines of `bash` run locally. At the
eighth round the honest conclusion was drawn: an 866-line script with fourteen recovery branches is not
a thing anyone reads correctly, so §11.7 runs the **real** script against stub commands and asserts
the branch it took. What that does **not** cover is Docker, Caddy, Postgres and the network, which
is what the rehearsals below and §9 are for; the division is stated at the top of §11.7 so that
neither half is mistaken for the other. The two texts are the easy case —
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
  `Test-Path` over all ten `deploy/` files and the harness's `test/run.sh` — before the server is
  touched, and with that commit's
  SHA becoming the value step 2 requires the server's clone to equal. Nothing tests that the
  runbook's `Get-Content` calls will find their files; this step checks it instead.
- The failure paths that matter are structural rather than tested: `flock -n` on an open descriptor
  cannot let two runs overlap; the `HEAD == refs/remotes/origin/main` assertion cannot pass on a
  dirty or locally-committed tree; the topology guard runs **before** the fast-forward and against
  the recorded deployed SHA, so a refusal leaves the checkout where it was and a retry cannot find
  an empty diff; the guard's match cannot let a compose change that mentions `postgres`,
  `pgdata` or `volumes` reach the dump, the migration or the restart — **and cannot be defeated by
  the size of the diff either, because it is a here-string and not a pipeline** (§4.5 banner 3,
  round 6's F2), which is the property §11.7's 1.2 MB case pins; the
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
  own client (§4.5 banner 9), and because R8's status read is bounded at 120 s and routes to R13
  rather than hanging; **a surviving one-off cannot be behind the reconciliation, because
  `reap_oneoff` runs on *every* non-success of the migrator and inside `read_status` on every failed
  status read, not only on `timeout`'s 124 and 137** (round 6's F3) — **and cannot be *believed* dead
  without proof either, because `reap_oneoff` classifies `docker inspect`'s failure ("No such object"
  versus anything else), re-inspects after the stop, requires `exited` or `dead`, and otherwise
  returns 2, which becomes `MIGRATE_STATE=unreapable` and sends the recovery straight to R13 without
  reading a status or starting a container** (round 7's F1); **the quiesce cannot be torn,
  because `QUIESCED=1` is set before `docker compose stop` and is cleared again only when
  `docker inspect` positively answers `true`** (round 6's F5); **no log this script prints can carry
  a credential into the controller's transcript, because every one of them goes through
  `redact_logs`** (round 6's F1); a migration file
  carrying a transaction-control statement cannot reach the quiesce at all, because step 5's
  `--check` runs `assertTransactionSafe` over the pending set while Loom is still serving; the one
  `EXIT` handler — installed at the **top** of the script, after every recovery input has been
  assigned, so no `set -u` read can abort it, and inert until `QUIESCED=1` — cannot leave Loom
  stopped **except** on the branches that decide to (R2, R3, R5, R13), because every path out of
  banners 7 to 11 runs through it and **`HEALTHY=1` is the only thing that disarms it, which a
  created-but-unanswering container cannot set** (round 7's F3); the classification inside it
  cannot be cut short by `errexit`, because the handler clears it before classifying; the recovery cannot *assume* a rollback, because it re-reads the
  migration status and compares it with the set recorded in step 5, and it cannot combine the old
  image with the new compose definition, because its first choice is `docker start` on the container
  whose **image id is the recorded one** — the exact object `docker compose stop` left in place,
  proved rather than assumed (round 8's F3) — and its fallback starts the old image through **the
  old commit's own** compose file, extracted with `git show` (round 7's F3); the per-commit `image:`
  tag cannot be overwritten in a way that matters, because a container holds its image by id and the
  old id is recorded before the build — and the id and the SHA a restore uses cannot drift apart,
  because both are captured into variables in banner 3 rather than read back from files a later
  banner may have rewritten; `deploy/.deployed-sha` is written atomically **and durably** (`sync -f`)
  and only when the image **and** the schema are a fact — the instant the migrator exits 0, or, when
  nothing was pending, only after the new container has **answered the loopback check** — so it
  cannot name a commit that is not what is serving, a write that fails is its own state
  (`record-failed`, R2) rather than a silent continuation, and a disagreement between that record and
  `docker inspect --format '{{.Config.Image}}' loom-loom-1` stops the next update before it fetches
  (round 7's F2); **an interruption that runs no handler at all cannot leave the box unattended
  either, because `deploy/.update-state` is written before the quiesce and every later invocation
  reconciles it, against the pending set it recorded, before it fetches anything** (round 7's F2);
  `deploy/.verified-sha` is read by no mechanism,
  so a failing public check cannot misdirect anything; `cmp` makes the Caddy install idempotent; the
  `.prev` restore cannot leave an unbootable sites folder behind a failed reload;
  `${LOOM_DB_PASSWORD:?…}` cannot default; `-p loom` on every command cannot be outranked by the
  caller's directory or environment, and the script refuses to start at all if
  `COMPOSE_PROJECT_NAME` is set; `--env-file` on every Spool command cannot be defeated by the
  directory the caller is in; and both health checks read a route that touches the database.
  **And five more are round 8's, two of them corrected by round 9.** No **Docker or network**
  operation after the quiesce can hang without a deadline,
  because every `docker` call goes through `dk`'s `timeout 60` and the two that need longer carry
  their own (the dump pipeline's 330 + 15, the migrator's 600 + 30), so the table of §4.5 banner 7
  is a sum of constants rather than a hope (F1) — **but that is not a bound on the outage, and
  §4.5 banner 7 now says which waits sit outside it**: a `gzip` or a `pg_dump` wedged in
  uninterruptible I/O survives `TERM` and `KILL`, and `sync -f` is under no `timeout` at all (round
  9's F2). No `pg_dump` can outlive its client **unnoticed** either, because a
  timed-out dump is followed by a bounded `pkill -TERM -f pg_dump` **inside** the Postgres container
  and then by a bounded in-container check that looks for what the signal was aimed at and prints
  its own verdict; anything but a definite `DUMP_GONE` writes `deploy/.dump-in-progress`, and the
  next invocation refuses to fetch, dump, migrate **or reconcile** until a check of its own is
  answered `DUMP_GONE` — **and that marker cannot be taken away by the restore that follows it,
  because it is its own file and not a key inside `.update-state`, which R6 removes** — **nor by a
  Docker failure that merely looks like an empty answer, which is round 11's F1** (F1, round 9's
  F2, round 10's F2, round 11's F1). **Nor can an interrupted update be reconciled beside a live migrator, because the
  reconciliation reaps `loom-migrate-run` through `reap_oneoff`'s verified semantics before it
  probes, reads a status or compares anything, and an unproven reap refuses, restores nothing and
  keeps the record** (round 10's F1). No `curl` can block on an accepted connection that never
  answers, because every probe carries `--connect-timeout 5 --max-time 20` and every loop is bounded
  by an absolute `SECONDS` deadline rather than a count of tries (F1). No target can be believed
  started without a request it answered **and** a durable record, because all four start paths — the
  normal one, R7, R11 and the reconciliation's case (b) — go through `start_target_and_prove`, which
  is also the only place `.update-state` is removed on a forward path (F2). And the previous
  deployment cannot be misidentified, because `restore_prev` and `manual_recovery` compare
  `docker inspect --format '{{.Image}}' loom-loom-1` with the recorded **image id** and reconstruct
  whenever they differ — so a same-SHA rebuild over a newer base image, which leaves the tag and
  both records saying the right commit, cannot make a `docker start` of the wrong binary look like a
  restore (F3).
  **And three are round 9's.** No inspection's *failure* can be read as an object's absence, because
  every `docker inspect` and `docker volume inspect` in the file goes through `classify_inspect` and
  only the daemon's own `No such object|volume|container` is absence — so a `dk` that hits its 60 s
  during the quiesce cannot take the "first deployment, nothing to dump" branch over a populated
  volume, and an unanswered question stops the run (`fail_and_restore`) or, inside the handler,
  refuses to act on the object (F3). No update can begin with a `.deployed-sha` present and an
  unread previous image, because that capture is no longer `|| true`: it must succeed, or the run
  stops **before** the build and the quiesce (F3). And no path in the file is a literal any more —
  the five constants are the only absolute paths, and `LIVE_UPDATE_TEST_ROOT` is the one thing that
  can move them, which is what lets §11.7 run the real script without being able to touch the live
  server's `.env`, sites folder, backups or lock (F1).
- **What is structural but one-sided, said rather than implied.** The reconciliation of §4.5's
  recovery procedure is only as good as `migrate --check`'s output shape, which is why §11.2 case 15
  asserts that shape and not merely its words. And R11 and R13 — the "committed but unacknowledged"
  and "cannot tell" branches — are reachable only by a torn connection or a partial apply, so
  **neither is exercised by anything before the day it happens**; R2 (`record-failed`) and R3
  (`unreapable`) join them, because one needs a filesystem that refuses a 41-byte write and the other
  a Docker daemon that answers some questions and not others. They are written as a numbered
  procedure, with the exact commands and the exact message, for precisely that reason: the first
  person to meet them will be reading, not reasoning.
- The **second** time the script runs — §9 step 8, and then the first real merge after this slice —
  is when idempotence is actually observed. That run is recorded in v2-notes as a dogfood note,
  whatever it shows.
- **The recovery's R6/R10 branch gets a deployment check of its own — a numbered step of the plan,
  run once on the first day — and round 4 changed what that check is.** §11.1 case 8 proves the
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
  discovered during a real failed migration. **The R14 last resort is deliberately not rehearsed**:
  proving it would mean deleting the container, and what it adds over R6 is a `docker tag`, a
  `git show` and a warning. Its result is recorded in v2-notes with the other dogfood notes.
- **The pending-migration-plus-failed-dump path is rehearsed with a stub and no SQL at all, which is
  round 8's F5 applied to round 5's F4.** The rehearsal above proves the recovery's *commands*; it
  does not prove that the handler survives the path F4 broke — a pending migration and a dump that
  then fails, where the old design read `MIGRATE_STATE` before anything had assigned it and the
  handler died under `set -u` with Loom stopped. The previous draft staged it by **deleting the
  newest row from the live migration journal** and putting it back afterwards by hand, and F5 was
  right that editing the live journal to rehearse a script is a poor trade: one mistyped `insert` and
  the live database's history is wrong in a way nothing checks. **So the pending set is a fiction the
  stub tells**, and the database is not touched:

      install -d -m 755 /tmp/stub
      printf '%s\n' '#!/bin/sh' \
        'case " $* " in' \
        '  *" node dist/migrate.js --check "*)' \
        '    printf "migrations: 5 applied\\npending:\\n9999_rehearsal_only\\n"; exit 0 ;;' \
        'esac' \
        'exec /usr/bin/docker "$@"' > /tmp/stub/docker
      chmod 755 /tmp/stub/docker
      mv /root/backups/loom /root/backups/loom.bak && : > /root/backups/loom   # a file where the directory must be
      PATH=/tmp/stub:$PATH ~/git/Loom/deploy/live-update.sh --bootstrap ; echo "exit=$?"

  The one lie is the status read: banner 6 records `9999_rehearsal_only` as pending, so the run takes
  the has-a-migration path — `MIGRATE_STATE=not-attempted`, an intent record that carries that tag —
  and every other `docker` command, the stop and the real dump attempt included, passes through to
  the real client. No migration is applied because the run never gets past the dump.

  *Checked:* the run prints `pending: 9999_rehearsal_only`, writes `deploy/.update-state` with that
  tag in it, stops `loom`, fails at `install -d`, and then — from the handler, not from any step —
  prints `no migration ran; the previous deployment is serving again`; `exit=` is
  **non-zero**; `curl -fsS http://127.0.0.1:3100/api/guidelines` answers 200 within a few seconds;
  `cat ~/git/Loom/deploy/.deployed-sha` is **unchanged**; `~/git/Loom/deploy/.update-state` is
  **gone**, because the restore settled it; and no `MANUAL RECOVERY REQUIRED` line was
  printed, because R6 — not R8 — is the branch a dump failure takes. Undone in two commands,
  `rm /root/backups/loom && mv /root/backups/loom.bak /root/backups/loom` and `rm -rf /tmp/stub`,
  with no SQL to get wrong. The path is written absolutely because since round 9's F1 the directory
  is the constant `BACKUP_DIR` and not `$HOME/backups/loom`; on the server, as root, they are the
  same directory. If anything about it goes wrong, the first day's
  escape is the one §9 step 5 already licenses: `docker compose -p loom down -v` and §9 step 4 again.
  It is done **once**, on the first day, for the same reason the R6/R10 rehearsal is. **The
  classification itself is §11.7's business** — the harness runs the same failure against stubs on
  every `pnpm test:deploy` — and what this live run adds is the one thing the harness cannot: that a
  real `docker start` of a real container really does serve again.
- **The shell contract checks that need no server and no Docker are now a harness, not two
  snippets — §11.7.** Round 6's F2 check (the topology guard against a 1.2 MB diff) and round 5's
  F2 check (`pending_tags` over an empty result, §11.2 case 15) were the first two, written as
  pasteable snippets because there was nowhere to put them. §11.7 is that place, they are two of its
  cases, and every later round's finding has somewhere to land.
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
  ran; the previous deployment is serving again`; `exit=` is non-zero; `curl -fsS
  http://127.0.0.1:3100/api/guidelines` answers 200 within a few seconds; `.deployed-sha` is
  unchanged; and no `MANUAL RECOVERY REQUIRED` line was printed. That is the case the previous draft
  got wrong, where `QUIESCED=0` sent `recover` home on its first line and left Loom down with no
  message.

  Then the other direction, with the pass-through removed from that one line so the container is
  **not** stopped — `*" compose -p loom stop loom "*) exit 1 ;;` — and the script run again.
  *Checked:* the run says the stop failed and `loom-loom-1` is still running, `exit=` is non-zero,
  **no** restart line is printed because there was nothing to restart, `curl` answers 200
  throughout, from the same container id as before the run — `docker inspect -f '{{.Image}}'
  loom-loom-1` unchanged — and `~/git/Loom/deploy/.update-state` does **not** exist afterwards,
  because that branch removes it: nothing was stopped, so there is no interrupted update. That is the
  only branch allowed to clear `QUIESCED`, and it is allowed to
  because the container is demonstrably still serving. Undone with `rm -rf /tmp/stub`, which is the
  whole of the cleanup: nothing else was touched, and the stub was never on root's own `PATH`.
- **The failed start is rehearsed by hand, in both its directions, on the first day — review round
  7's F3.** The two branches R4 and R5 divide on one thing, whether a migration committed, and
  neither can be reached by waiting: the way to reach them is to make the new container fail its
  loopback check on purpose. The same `PATH` stub does it, with a different lie — this one lets
  `up -d loom` run for real and then makes the health check unreachable by stopping the container
  behind the script's back, which is exactly the observable a startup regression produces:

      install -d -m 755 /tmp/stub
      printf '%s\n' '#!/bin/sh' \
        'case " $* " in' \
        '  *" compose -p loom up -d --no-build loom "*)' \
        '    /usr/bin/docker "$@"; /usr/bin/docker stop -t 1 loom-loom-1 >/dev/null 2>&1; exit 0 ;;' \
        'esac' \
        'exec /usr/bin/docker "$@"' > /tmp/stub/docker
      chmod 755 /tmp/stub/docker
      PATH=/tmp/stub:$PATH ~/git/Loom/deploy/live-update.sh --bootstrap ; echo "exit=$?"

  *Checked, without a migration (R4):* the run prints `created loom-loom-1 from loom-live:<SHA> —
  not yet proven healthy`, then fails the
  loopback probe at its 60-second deadline and prints the redacted tail of the
  container's log, and then — **from the handler** — that the container never answered and is being
  removed, followed by `restored the previous deployment`; `exit=` is non-zero;
  `curl -fsS http://127.0.0.1:3100/api/guidelines` answers
  200 within a few seconds; `cat ~/git/Loom/deploy/.deployed-sha` is **unchanged**, which is the
  invariant F3 asked for — a created-but-unproven container never became the record;
  `~/git/Loom/deploy/.update-state` is gone; and `docker inspect -f '{{.Config.Image}}' loom-loom-1`
  names the deployed SHA, from the reconstruction of R14 rather than the original object, because
  banner 10's `up -d loom` had already replaced it — **and the warning the reconstruction prints
  names the recorded image id**, which is round 8's F3 observed rather than argued: the id of the
  container that had just been removed was a different one, and the restore said so. Undone with
  `rm -rf /tmp/stub` and one ordinary
  `~/git/Loom/deploy/live-update.sh --bootstrap`, which deploys the head again with nothing pending.

  *Checked, with a committed migration (R5) — and this is review round 8's F5, which found that the
  previous version of this rehearsal could not reach R5 at all.* It said to delete the newest journal
  row and then let the **real** migrator apply that file again, which cannot work: the file's schema
  changes are still in place, so the migration fails on an object that already exists (for the
  current newest file, an index), the run takes the migration-failure reconciliation instead of the
  committed-migration branch, and the first day's check produces an output the spec does not
  describe — after a human has edited the live migration journal for nothing. So R5 is reached by
  **deterministic fault injection and no SQL at all**, with one stub telling three lies:

      install -d -m 755 /tmp/stub
      printf '%s\n' '#!/bin/sh' \
        'case " $* " in' \
        '  *" node dist/migrate.js --check "*)' \
        '    printf "migrations: 5 applied\\npending:\\n9999_rehearsal_only\\n"; exit 0 ;;' \
        '  *" --name loom-migrate-run "*) exit 0 ;;' \
        '  *" compose -p loom up -d --no-build loom "*)' \
        '    /usr/bin/docker "$@"; /usr/bin/docker stop -t 1 loom-loom-1 >/dev/null 2>&1; exit 0 ;;' \
        'esac' \
        'exec /usr/bin/docker "$@"' > /tmp/stub/docker
      chmod 755 /tmp/stub/docker
      PATH=/tmp/stub:$PATH ~/git/Loom/deploy/live-update.sh --bootstrap ; echo "exit=$?"

  The three lies are exactly the three facts R5 needs and nothing else. The status read reports one
  fabricated pending tag, so the run believes it has a migration to apply. The migrator **exits 0
  without running**, so `MIGRATE_STATE` becomes `succeeded` and `.deployed-sha` is written the moment
  it does — which is the state R5 branches on — while the database's real journal and real schema are
  never touched by anything. And the `up` runs for real and the container is then stopped behind the
  script's back, which is precisely the observable a startup regression produces. Everything else,
  including the real dump, passes through.

  *Checked:* the run prints `pending: 9999_rehearsal_only`, takes a real dump, prints that
  `.deployed-sha` is now the head's SHA, creates the container, fails the loopback probe, and then
  prints `LOOM IS DOWN` with both records, the dump's path, the absolute redacted-log command and the
  absolute retry command; `exit=` is non-zero; **no** restore line is printed and `docker inspect -f
  '{{.Config.Image}}' loom-loom-1` still names the head's SHA — the old image was deliberately not
  started against what the script believes is a migrated schema; and
  `~/git/Loom/deploy/.update-state` is **still there**, with `pending=9999_rehearsal_only` in it, for
  the next run to reconcile. Undone by `rm -rf /tmp/stub` and one ordinary run, which reconciles the
  record through banner 2's case (b) — the fabricated tag is not pending in the real journal, so
  every recorded tag is "gone", the target is started through `start_target_and_prove` and the record
  is cleared — and then one more run to deploy normally. That two-run finish is itself the
  observation F2's reconciliation is there to make, and it is why these rehearsals are done in this
  order. **What is deliberately fictional here is named rather than glossed:** no migration ran, so
  this rehearsal proves the *script's* R5 branch and not that a real committed migration behaves
  this way. The schema half of that is §11.1 case 8's, and the two halves do not meet before the day
  a real migration fails — which §14.8 says.
- **And the interrupted update is rehearsed by hand too — round 7's F2 — because the state it
  recovers from cannot be produced by any exit.** It is produced by removing the handler: a
  `SIGKILL`. After the rehearsals above and still before §9 step 10, with nothing pending:

      ( ~/git/Loom/deploy/live-update.sh --bootstrap & echo $! > /tmp/lu.pid ; wait ) &
      sleep 12 && kill -9 "$(cat /tmp/lu.pid)"     # inside the quiesce: after the stop, before the start
      cat ~/git/Loom/deploy/.update-state          # six key=value lines, target_sha = the head's SHA
      curl -fsS http://127.0.0.1:3100/api/guidelines ; echo "loom answers: $?"   # non-zero: it is down
      ~/git/Loom/deploy/live-update.sh --bootstrap ; echo "exit=$?"

  *Checked:* the killed run leaves `deploy/.update-state` behind and Loom stopped — no handler ran,
  which is the whole point. The next invocation prints `an interrupted update is on record`, does
  **not** fetch or build, reads the status inside its bound, takes case (a) because nothing was
  pending, restores the previous deployment, removes the record, prints that the update is closed and
  exits **non-zero**. Then `curl` answers 200, `.deployed-sha` is unchanged, and a third,
  ordinary run deploys the head with `health: ok`. The timing of the `kill -9` is the one fragile
  part of the rehearsal — it has to land between the stop and the start — so the window is widened
  honestly rather than guessed at: the run is made to sit in the dump by pointing it at a database
  with something in it, and if the kill lands too early (before the quiesce) the observable is simply
  no record and a still-running Loom, which is a second, cheaper thing worth seeing once.
- **The `dump_verdict` wrapper's text is checked by hand, in a disposable container, and this is
  round 12's F1.** The harness of §11.7 stubs `docker`, so it can assert what the script *does with*
  a verdict but never what the wrapper *itself* answers — and round 12's finding was in the wrapper
  text, which three readings had passed. So the wrapper is run exactly as §4.5 spells it, in a
  throwaway `postgres:17-alpine` with no network and no database, in both of the two states it
  has to tell apart. Run on Paw's PC against Docker 29.8.0, image `postgres:17-alpine`
  (`18cfe3ef5e68`); each container is `--rm` and removed when it exits, and `--network none` makes
  it incapable of reaching the live instance or anything else.

  **Case one — nothing is dumping; the wrapper must say `DUMP_GONE`:**

      docker run --rm --network none --entrypoint sh postgres:17-alpine -c 'command -v pgrep >/dev/null 2>&1 || { echo DUMP_NO_PGREP; exit 0; }
           pgrep -x pg_dump >/dev/null 2>&1; p=$?
           case "$p" in 0) echo DUMP_RUNNING ;; 1) echo DUMP_GONE ;; *) echo "DUMP_PGREP_$p" ;; esac'

  printed, whole:

      DUMP_GONE

  **Case two — a real `pg_dump` is alive; the wrapper must say `DUMP_RUNNING`:**

      docker run --rm --network none --entrypoint sh postgres:17-alpine -c 'sleep 300 | nc -l -p 5432 >/dev/null 2>&1 & sleep 1
           pg_dump -h 127.0.0.1 -p 5432 -U postgres postgres >/dev/null 2>&1 & sleep 2
           command -v pgrep >/dev/null 2>&1 || { echo DUMP_NO_PGREP; exit 0; }
           pgrep -x pg_dump >/dev/null 2>&1; p=$?
           case "$p" in 0) echo DUMP_RUNNING ;; 1) echo DUMP_GONE ;; *) echo "DUMP_PGREP_$p" ;; esac'

  printed, whole:

      DUMP_RUNNING

  **Why the long-running `pg_dump` is made that way rather than with a copied `sleep`.** The obvious
  fake — `cp /bin/sleep /tmp/pg_dump && /tmp/pg_dump 300 &` — does not work on Alpine and was tried
  first: `/bin/sleep` is a busybox link, busybox dispatches on its own `argv[0]`, and a copy invoked
  as `pg_dump` dies immediately with `pg_dump: applet not found`, so the container has no process to
  find. The image's **real** `pg_dump` is better evidence anyway: it is the exact binary the live
  dump runs. It is made to block by giving it a socket that accepts the connection and then never
  answers — busybox `nc` listening on 5432 with a `sleep` holding its stdin open, all on loopback
  inside the container — which is also, not coincidentally, the shape of the outage the marker
  exists for. Without the held-open stdin `nc` closes the connection at once and `pg_dump` exits
  with `server closed the connection unexpectedly`, which was the first attempt's result.

  **And the same two runs with the defect in place, as the control.** Changing only `-x` back to
  `-f`, with **no** dump running and nothing else in the container, printed:

      DUMP_RUNNING

  which is the finding, reproduced: an empty container answering "a dump is running" because the
  wrapper matched the shell that was running it.

- The one mechanism nothing at all exercises before the day is the **reload-failure restore** of
  §4.5 banner 12: it needs a `loom.caddy` that validates in the staged check and is then refused by the
  running Caddy. It is covered against stubs by §11.7's Caddy-reload case, and against a real Caddy
  by nothing; §14 names it as a risk rather than pretending it is covered.

### 11.7 Shell contract tests for `live-update.sh` — `deploy/test/`

**What this is, and what it is not, said before the case list so that neither half is mistaken for
the other.** This harness runs the **real** `deploy/live-update.sh` with a directory of stub
commands earlier on `PATH`, and asserts three things per case: the **sequence of `docker` and `git`
calls** the script made, the **contents of the records** it left behind, and its **exit code**. That
is a test of the script's control flow — which branch a given set of answers takes, which command it
runs next, which file it writes and which it leaves alone — and it is worth having because ten
review rounds have each found a control-flow defect that a careful reading had missed. It is **not**
a test of Docker, Compose, Caddy, Postgres or the network: every one of those is a stub that answers
what the scenario tells it to. The first deployment (§9) and the by-hand rehearsals of §11.6 are
what test the script against reality, and §11.6 is now trimmed to the cases that need reality — a
real container coming back as itself, a real torn stop, a real kill. Neither half replaces the
other, and a case list that grows here does not make a rehearsal removable.

**One boundary inside that boundary is worth naming on its own, because round 12's F1 fell exactly
across it: the harness stubs the transport, so it can never test the wrapper text.** Every
in-container question this script asks — the dump, the `pkill`, and `dump_verdict`'s `sh -c`
wrapper — reaches the harness as arguments to a stub `docker`, and the stub answers whatever the
scenario file told it to. That is the right design for testing control flow: the cases of this
section pin what the script *does with* `DUMP_GONE`, `DUMP_RUNNING` and an unanswered check, and
they do it without a container. But it means the harness would pass unchanged with a wrapper that
can only ever print one of those tokens — which is precisely the defect round 12 found, a
`pgrep -f` matching the shell that ran it: every case below would have gone on passing with that
wrapper in the file. **So the wrapper text is verified where it can only be
verified, by running it: §11.6's by-hand check runs it as written in a disposable container in both
states, and that check — not this harness — is what says the two tokens can both actually occur.**
What this section *can* do about it statically it does: the reading case below asserts the wrapper
line in the real file still says `pgrep -x`, so the two halves cannot drift apart silently.

**No framework, and `bats` deliberately not added.** The runner is `deploy/test/run.sh`, plain
`bash`, and `pnpm test:deploy` at the repository root runs it (§10); it is also runnable as
`bash deploy/test/run.sh` by anyone with a shell, which matters because the thing under test is a
shell script and the machine that will need to run it in a hurry may be the server. Adding a test
framework to this repository for one file would mean a dependency, a lockfile entry and a tool every
future contributor has to know, against a runner that is a `for` loop over `deploy/test/cases/*.sh`
with a pass/fail count — and the repository's own convention is that a helper earns its machinery
(§11.2's two four-line container fixtures make the same argument).

**How a case is built, and why nothing it does can reach a production path — review round 9's F1.**
`run.sh` makes a temporary directory per case, `$TEST_ROOT`, and **exports
`LIVE_UPDATE_TEST_ROOT="$TEST_ROOT"`**, which is the script's own test mode (§4.5 banner 0): every
one of the five path constants is then re-pointed under that root and the run prints one `TEST MODE:`
line. The harness lays the world out to match — `$TEST_ROOT/git/Loom/deploy` with the real
`live-update.sh`, the real `loom.caddy`, an `.env` holding placeholders, and whichever of
`.deployed-sha`, `.verified-sha`, `.deployed-image`, `.update-state` and `.dump-in-progress` the
case wants;
`$TEST_ROOT/git/Spool/deploy` with a two-line `.env` and a Caddyfile; `$TEST_ROOT/caddy-sites`;
`$TEST_ROOT/backups`; `$TEST_ROOT/run/lock` — and sets `HOME` and `TMPDIR` under it too, so that
even `mktemp` lands inside. That is what round 8's version could not do: it copied the script into a
fake checkout and redirected `HOME`, which left `/root/git/Spool/deploy/.env`, `/root/caddy-sites`,
`/run/lock/loom-live-update.lock` and the reconstruction's `/root/git/Loom` exactly where they were
— unreadable on a laptop, and *writable* on the server, where a Caddy-install case would have
replaced the shop's real `loom.caddy` with `docker` stubbed out. The working directory is the
script's own business now: it `cd`s to `LOOM_DEPLOY_DIR` itself. `deploy/test/stubs` goes first on
`PATH`. The
stubs are `docker`, `git`, `curl`, `timeout` and `flock`, one small `sh` script each, and they are
**driven by a scenario file** the case writes: a table of "when the arguments match this pattern,
print this, exit with this status". Every stub appends its full argument list to one
`$CALLS` file in call order, which is what the case's assertions read. Four notes on the stubs,
because each is a decision:

- **`timeout` is stubbed too, and that is what makes the deadline cases deterministic.** The stub
  reads its first arguments, records the deadline it was given, and then either runs the rest
  through or returns **124** on demand — so "the dump blocked for 300 s" is a scenario line rather
  than five minutes of a test suite's life. The deadline it recorded is asserted, which is how the
  numbers in §4.5 banner 7's table are pinned to the script rather than to this document.
- **`flock` is stubbed to succeed, and one case stubs it to fail**, so the "another live-update is
  running" refusal is exercised without a second process.
- **There is no `pg_dump` stub, because the script never calls one.** The dump is
  `docker compose exec … pg_dump`, so it is the `docker` stub's business; naming that here stops the
  next reader looking for a stub that should not exist.
- **Every stub screens the host paths it was handed, which is half of how containment is proved.**
  A stub knows which of its arguments are **host** paths, because the commands' own grammar says so:
  the part before the first colon of each `-v`, and the values of `--env-file`,
  `--project-directory` and `-f`. Everything from the image or service name onward is the
  container's own argv — `/etc/caddy/Caddyfile`, `dist/migrate.js` — and is not a host path at all.
  Any host path that is absolute and not under `$TEST_ROOT` makes the stub write a `VIOLATION` line
  into `$CALLS` and the case fails. `strace -f -e trace=file` would prove more and is deliberately
  **not** used: it is Linux-only, it needs privileges the repository cannot assume, and a test
  harness a developer cannot run on their own machine is a harness that stops being run.
- **`curl` is stubbed, and the probe's loop is not skipped.** A case that wants a target which never
  answers has `curl` fail every time and asserts that the script gave up at its deadline and took
  R4 or R5 — with the `sleep` between tries left alone, because a 60-second case is acceptable and a
  stubbed `sleep` would make the deadline arithmetic untestable. Cases that want a healthy target
  answer on the first call, which is the common path and is fast.

**The cases.** Each names the branch it is there for, and every one of them exists because a review
round found that branch by reading rather than by running:

| Case | What it asserts |
| --- | --- |
| Happy path, nothing pending | build, `--check`, the intent record, stop, dump, **no** migrator call, `up -d --no-build loom`, one `curl`, `.deployed-sha` = the target, `.update-state` **gone**, Caddy reload skipped by `cmp`, public probe, `.verified-sha` = the target, exit 0 |
| Happy path, with a migration | the same, plus the migrator call, `.deployed-sha` written **before** the `up` (the call order proves it), and the dump taken between the stop and the migrator |
| Topology change refused | a `git diff` answer mentioning `postgres`, and: exit 1, **no** build, **no** stop, the checkout not fast-forwarded, no record touched |
| A 1.2 MB topology diff refused | round 6's F2 as a case rather than a snippet: the stubbed diff is a match on line 1 followed by more than a megabyte, and the guard still refuses — the shape that made the `printf … \| grep -Eq` version report 141 and wave it through |
| Dirty tree refused | a `git status --porcelain` answer with one line in it: exit 1, nothing stopped, the porcelain output printed |
| `COMPOSE_PROJECT_NAME` set refused | exit 1 before `flock` is called at all, which the `$CALLS` file shows by being empty |
| Leftover `.update-state`, case (a) | nothing committed: no fetch, no build, `restore_prev` by the recorded image id, `.update-state` gone, exit non-zero |
| Leftover `.update-state`, case (b) | everything committed: `.deployed-sha` = the target, `start_target_and_prove`, `.update-state` gone, exit non-zero — **and the same case with the target never answering**, where the record **stays** and `LOOM IS DOWN` is printed, which is round 8's F2 |
| Leftover `.update-state`, case (c) | a partial apply and an unreadable status: `manual_recovery` printed, the record **left in place**, nothing started |
| Failed dump → R2's sibling R6 | the dump stub exits non-zero: `restore_prev` starts the container whose image id **is** `PREV_IMAGE`, the probe answers, the record is unchanged and `.update-state` is gone |
| A dump that blocks on a lock → the handler restores Loom | round 8's F1 and round 9's F2: the `timeout` stub returns **124** for the dump, and the case asserts the deadline it was given was `--signal=TERM --kill-after=15 330` and that what it wrapped was the **whole pipeline** (the stub records the `bash -c` script, and the assertion is that it contains both `pg_dump` and `gzip`), that the **next** `docker` call is the bounded `exec … pkill -TERM -f pg_dump` and the one after it the bounded `exec … sh -c` verdict check, that a check answering **exit 0 with `DUMP_GONE`** leaves **no** `deploy/.dump-in-progress` file behind, and that the run then takes R6 and serves again |
| Migrator timeout → reap → classify | `timeout` returns 124 for the migrator, the reap's calls appear in order (inspect, stop, wait, logs, inspect, rm), and the status read that follows decides R10 or R11 according to the scenario's `--check` answer |
| Unreapable → R13 | the post-stop `inspect` answers `running`: **no** status read and **no** `up` appear in `$CALLS` at all, and `manual_recovery` is printed — round 7's F1 as an assertion about calls that must be *absent* |
| Failed start, no migration → restore by image id | the target never answers: the container's `{{.Image}}` differs from `PREV_IMAGE`, so the case asserts the removal, the `docker tag` of `PREV_IMAGE`, the `git show` of `PREV_SHA:deploy/docker-compose.yml`, the `up` through that file, and the probe **before** `.update-state` is removed |
| Failed start after a committed migration → R5 | `.deployed-sha` = the target, `LOOM IS DOWN` printed, **no** `docker start` and **no** `docker tag` in `$CALLS`, `.update-state` **present** afterwards, exit non-zero |
| Same-SHA rebuild with a different image id | round 8's F3: `PREV_SHA` equals the target's SHA and the container's `{{.Image}}` is **not** `PREV_IMAGE`, and the case asserts the script reconstructs from `PREV_IMAGE` rather than running `docker start` — the exact walk-through the finding described, which the previous code would have got wrong while printing that the previous deployment was restored |
| Record failure → `record-failed` | the fake `deploy/` is made unwritable: `record_failed_message` is printed, **nothing** is started, exit non-zero |
| Caddy reload failure → `.prev` restored | the reload call exits non-zero: `loom.caddy` on disk equals what it was before the run, or is absent when there was no previous file, and exit non-zero |
| Public health failure → no `.verified-sha` | the public probe fails: `.verified-sha` is **not** written, `.deployed-sha` **is** the target, `.update-state` is gone, exit non-zero — the two-record invariant of round 4's F2 as a case |
| `pending_tags` over an empty and a non-empty `--check` output | round 5's F2, moved here from §11.6 and kept as §11.2 case 15's shell half: the pipeline prints the expected tags and exits 0, and prints nothing and still exits 0 |
| **The production defaults, asserted by reading** | round 9's F1: the case **does not run the script**. It reads `deploy/live-update.sh` and asserts that the constants block assigns exactly `LOOM_DEPLOY_DIR=/root/git/Loom/deploy`, `SPOOL_DEPLOY_DIR=/root/git/Spool/deploy`, `SITES_DIR=/root/caddy-sites`, `BACKUP_DIR=/root/backups/loom` and `LOCK_FILE=/run/lock/loom-live-update.lock`; that those five assignments are guarded by nothing (they are the unconditional defaults); that the only `LIVE_UPDATE_TEST_ROOT` branch is the one that re-points them; and that **no other line in the file contains an absolute path outside a printed message** — the check that keeps a sixth hard-coded path from being added later. Running the script could never assert this, because a run that asserted the production values would be a run pointed at them. **Round 12's F1 adds one more line to the same case:** it asserts that `dump_verdict`'s in-container wrapper matches on `pgrep -x pg_dump` and that the file contains no `pgrep -f` inside an `sh -c` wrapper, because a `-f` there matches the wrapper's own command line and answers `DUMP_RUNNING` forever (§11.6 runs the wrapper itself; this line only keeps the file from drifting back). The bare `pgrep -af` and `pkill -TERM -f` that Compose execs directly are explicitly allowed by the assertion, having no wrapper shell to match |
| **Nothing outside the temporary root was read or written** | round 9's F1: the happy path with a migration, run whole, with `$TEST_ROOT/.mark` touched first. Afterwards the case asserts (a) no stub wrote a `VIOLATION` line — so every host path handed to `docker`, `git` or `curl` was under the root — and (b) `find "$TEST_ROOT" -newer "$TEST_ROOT/.mark"` lists exactly the files the case expects (the records, the dump, the site block, the lock, the temporaries) and nothing else. The `docker` stub also fails the case if any `-v`'s host side, `--env-file`, `--project-directory` or `-f` names a path outside the root |
| Timed-out volume inspection → stop and restore | round 9's F3: the `docker` stub makes `volume inspect loom_pgdata` return **124** with empty stderr. The case asserts that `$CALLS` contains **no** `pg_dump`, **no** migrator run and **no** `up -d --no-build loom`, that `inspection unanswered` was printed, that the run took R6 and restored the previous deployment, and that the words `first deployment` appear **nowhere** in the output — the exact wrong turn the previous listing would have taken |
| Unreadable previous image with `.deployed-sha` present | round 9's F3: `.deployed-sha` holds a SHA and the stub makes the `inspect --format '{{.Image}}'` of banner 3 fail with a daemon error. The case asserts the run stopped **before** `docker compose build` and before any `stop` — `$CALLS` has neither — that `.update-state` was never written, and that the exit code is non-zero. The sibling case, where that inspection answers `No such object` while `.deployed-sha` exists, asserts the same refusal with the other message |
| A dump that is not proven gone → `.dump-in-progress`, and it survives the restore | round 9's F2 as round 10's F2 corrects it and round 11's F1 sharpens it: the `timeout` stub returns 124 for the dump pipeline and the `docker` stub answers the following verdict check with **exit 0 and `DUMP_RUNNING`**. The case asserts the `pkill` and then the `exec … sh -c` check appear in `$CALLS` in that order, that **`deploy/.dump-in-progress` exists**, that the run took R6 and Loom is serving — **and that `deploy/.update-state` is gone while the marker is still there**, which is the invariant the seventh-key design could not hold. Then it **runs the script a second time**, with the stub still answering `DUMP_RUNNING`, and asserts that it printed `REFUSING TO RUN`, made **no** `git fetch`, ran no dump and no migrator, left the marker in place and exited non-zero — and a **third** time, with the check now answering exit 0 and `DUMP_GONE`, asserting that the marker is removed and the run proceeds to a normal deployment |
| A verdict check that is not answered → the marker is written, and kept | round 11's F1, the finding's own reproduction turned into two cases. **Writing:** the `timeout` stub returns 124 for the dump pipeline and the `docker` stub makes the verdict check **exit 1 with empty stdout and a line on stderr** — the shape a Compose or daemon failure has, and the shape the previous gate mistook for "nothing matched". The case asserts that `deploy/.dump-in-progress` **exists** anyway, that the words `NOT proven gone` and the stub's stderr text were printed, and that the run took R6. **Keeping:** the same stub answer on a run that starts with the marker already present, asserting `REFUSING TO RUN`, the marker **still there**, no `git fetch`, no dump, no migrator, and a non-zero exit. Two sibling answers assert the same two outcomes for **exit 0 with empty stdout** and for **exit 0 with unrecognised stdout**, because "it ran and said something else" is as much a non-answer as "it never ran" |
| Leftover `.update-state` + a migrator that cannot be reaped | round 10's F1: `.update-state` is present and the `docker` stub answers the reconciliation's post-stop `inspect --format '{{.State.Status}}' loom-migrate-run` with `running`. The case asserts that `$CALLS` contains **no** `--check` status read, **no** `docker start`, **no** `up -d --no-build loom` and **no** `git fetch`; that `REFUSING TO RECONCILE` naming `loom-migrate-run` was printed; that `deploy/.update-state` is **still there** and `deploy/.deployed-sha` unchanged; and that the exit code is non-zero. The sibling case, where the same inspection answers `No such object`, asserts the ordinary case (a) reconciliation runs and restores — so the refusal is shown to be about the *unproven* answer and not about the reap existing |

**Which paths the harness can prove untouched, and which it cannot — said plainly, because F1 asked
for a proof and this is how far the proof goes.** It **can** prove three things. First, that every
host path handed to a stubbed command was under `$TEST_ROOT`, because each stub screens its own
arguments and a violation fails the case. Second, that the set of files created or modified during a
run, *within the root*, is exactly the expected one, by `find "$TEST_ROOT" -newer "$TEST_ROOT/.mark"`
— so a case cannot quietly leave state even inside its own sandbox. Third, and this is the one that
covers the paths nobody watches at runtime, that the script **contains** no absolute path outside
its constants block, asserted by reading the file rather than by running it.

It **cannot** prove the negative directly: nothing here stats, reads or lists `/root/caddy-sites`,
`/root/backups/loom`, `/run/lock/loom-live-update.lock` or `/root/git/Spool/deploy/.env` to show
they were not touched, because **a test that reads production paths to prove it did not touch them
is the thing F1 objected to**, and on a developer's machine those paths do not exist while on the
server they are the shop's. So the guarantee is the conjunction of the three checks above, not an
observation of the live filesystem: a path this script could touch has to be spelled somewhere in
the file (caught by the reading case) or handed to a command (caught by the stubs). What would
escape both is a future edit that computes a path at runtime from something other than the
constants — which is exactly the shape the reading case is there to make a reviewer notice, and it
is stated here rather than glossed.

**What the harness deliberately does not assert.** It does not check the *text* of any message
beyond the few lines a human is meant to act on (`LOOM IS DOWN`, `MANUAL RECOVERY REQUIRED`,
`restored the previous deployment`, and since round 10 the two refusals `REFUSING TO RUN` and
`REFUSING TO RECONCILE`), because pinning prose makes a test that fails on every edit to
prose. It does not assert timings other than the deadlines handed to the stubbed `timeout`. And it
does not test the two PowerShell wrappers or the two `.ps1` helpers, which are Windows-side and are
exercised by §9 steps 8 and 12.

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
- **The five server-written records carry no secret, and that includes the new one.**
  `.deployed-sha` and `.verified-sha` hold a short SHA, `.deployed-image` an image id,
  `.update-state` two short SHAs, an image id, an image tag, a list of drizzle journal tags and a
  UTC timestamp, and `.dump-in-progress` the single character `1`. None of those is a credential, so the reconciliation of §4.5 banner 2 may print what it
  read — and does, because the operator needs it — and none of the five needs a mode stricter than
  the directory's. **What banner 2 also prints, since round 11's F1, is not one of the five**: when
  the in-container dump check is not answered, its **stderr** is printed so that the operator can
  tell a stopped container from an unreachable daemon. Docker's diagnostics are not credentials
  either, but they are text this script did not write, so they go through `redact_logs` like every
  other line of foreign output (`docker compose logs`, the migrator's output) rather than being
  trusted for being short. They are nevertheless all git-ignored (§10) for a different reason: they are
  server state, and an untracked file inside the checkout trips the script's own clean-tree check.
  The same holds of the harness of §11.7: its stubs' recorded call lists hold container names, image
  ids, short SHAs and journal tags, and it runs against no real credential at all — the `.env` it
  writes into its temporary directory holds a placeholder, because nothing in it ever reaches a real
  Postgres. **And since round 9's F1 it cannot reach the real ones either**: it runs under
  `LIVE_UPDATE_TEST_ROOT`, so the script's five path constants point inside its temporary directory
  and Spool's `.env` — which carries the shop's `DB_PASSWORD` — is not a file any case can open. The
  previous design left that path absolute, which on the one machine that has the file would have had
  a test reading it.
- **The copies on Paw's PC live in `C:\Users\paw\.loom`**, inside Paw's own profile, whose inherited
  ACL grants Paw and the local administrators access and nobody else — the same protection
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
  through `redact_logs` — the `sed` of §8.1, the same three lines in every one of
  `live-update.sh`'s log reads (§4.5 banner 1), the literal `sed` R5 prints for an operator who has
  no such function in
  their shell, and §9 steps 5 and 7. §9 step 4's done-check, which is the one that runs
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
  so for the length of a dump, a migration, a container start **and the loopback answer that proves
  it** — well under a minute on this
  database — `https://loom.3dbox.dk` answers 502 from Caddy, the web client's stream drops and the
  reviewer's next poll fails. **And there is NO ceiling on the outage — review round 9's F2, which
  withdraws a claim round 8's F1 led this document to make.** What the script enforces is a deadline
  on every **Docker and network** operation after the quiesce: `dk`'s **60 s** on every `docker`
  call; the dump pipeline's **330 + 15**; the migrator's **600 + 30**; a reap's seven bounded calls,
  **420**; the status read's **120**; the loopback probe's **60** absolute deadline with a **20 s**
  per-call ceiling; and the public probe's **120 + 20**. §4.5 banner 7 lays those out phase by phase
  and sums each branch — **965 s** for a happy update with nothing pending, **1655 s** with a
  migration, **1085 s** for a dump that hits its deadline before the previous deployment is serving
  again, **2535 s** for the longest such branch (a failed migrator, a successful reap, a status read
  that then fails) — and those sums bound the Docker and network work on that branch, **which is not
  the same thing as bounding the outage**. Two waits sit outside them and neither has a deadline: a
  `gzip` writing the dump into a stalled or full filesystem, or an in-container `pg_dump` in the same
  state, cannot be ended by `TERM` or by `KILL`, and `timeout` waits for a child the kernel will not
  kill; and `sync -f` — in `record_deployed` and on the intent record — is under no `timeout` at
  all, deliberately, because a half-flushed 41-byte record is worse than a wait. **If one of those
  happens, Loom stays stopped, the update lock stays held, `.update-state` stays on disk, every
  request is a 502 and no trap runs, because the script has not exited.** Nothing pages anyone. It
  ends when a human kills the run, deals with the storage and brings Loom back with the absolute
  command in this section's manual-rollback bullet — then settles `.deployed-sha` and removes
  `.update-state` last. The previous draft's "about sixteen minutes", and then "about forty-two
  minutes", were both ceilings this script cannot enforce; the honest statement is a per-operation
  deadline plus a named, unbounded tail. The local filesystem
  and `git` reads are unbounded for the same reason and are short; the whole pre-quiesce phase is
  unbounded on purpose, because Loom is still serving through it.
  **And more bounded waits sit outside the quiesce, all of them on an invocation that finds work
  left over.** A `deploy/.dump-in-progress` marker costs one bounded in-container verdict check
  (60 s) before the run either clears it or refuses; and an invocation that finds `deploy/.update-state` spends up to
  **420 s** reaping `loom-migrate-run` and another **420 s** reaping `loom-migrate-check` (round
  10's F1: seven bounded `dk` calls each) before it probes anything, then up to 120 s on its
  reconciliation's status read, then up to 380 s restoring — during which Loom is already down,
  because it was a killed run that left
  the record. Those are the same constants §4.5 banner 7's table is built from, and they are named
  here because the reconciliation is the one path a reader meets while the instance is *already*
  unavailable. That is chosen, not tolerated: the alternative is a dump with a live
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
  written atomically **and durably** at one of two moments and **never at the quiesce**, which is
  round 5's F3: the
  instant the migrator exits 0, before Loom is started, when there was something to apply; and only
  once the new container has **answered the loopback check**, when there was not — which is round 7's
  F3, because `up -d` returning proves the container was created and nothing more, and a record that
  ran ahead of a request the application never answered would send the next run's recovery at an
  image that was never serving. Read by the
  topology guard, by banner 2's agreement check and by the recovery. `deploy/.verified-sha`
  is **the last commit that answered the public health check** — written last, read by nobody but a
  human and §9's done-checks. So a run that fails after its migration committed leaves
  `.deployed-sha` on the new commit (correct: that is what is live) and `.verified-sha` on the old
  one (correct: this run never proved the public path), and neither file is lying. **What is not
  promised:** nothing reconciles the two if someone edits them, nothing warns when they disagree for
  a long time, and a `--bootstrap` run writes no `.verified-sha` at all. What *is* new is one check
  in the other direction: an update refuses to start when `.deployed-sha` and the running container's
  configured image disagree, which catches a hand-edited record rather than reconciling it (§4.5
  banner 2).
- **`deploy/.update-state` is an intent record, not a lock and not a journal.** It says what one run
  set out to do and had not finished; it holds one update at a time, is overwritten by the next run
  and is deleted only after something has been proved — the target answering and recorded, inside
  `start_target_and_prove`, or the previous deployment answering, inside `restore_prev` (§4.1,
  §4.5 banners 2, 7 and 10, round 8's F2).
  **What it buys** is the one thing a `trap` cannot: a run killed by a power loss or a `SIGKILL` is
  reconciled by the *next* invocation instead of leaving a stopped Loom nobody can classify (round
  7's F2). **What it does not promise:** it is not a queue, so a reconciliation deploys nothing and
  exits non-zero — whatever was merged since waits for the next run; it cannot help if it is itself
  unreadable, in which case the script says so and asks for a hand; nothing warns that one has been
  lying there for a week; and while it exists **no update can run**, which is deliberate and is the
  cost — a box in an unfinished update is a box that must be settled before it is changed again.
  **And reconciling it is not unconditional either — round 10's F1.** The reconciliation reaps the
  interrupted run's `loom-migrate-run` first, with `reap_oneoff`'s verified semantics, and when that
  container cannot be **proven** stopped it refuses outright: no status read, nothing started,
  nothing restored, the record kept, a printed message naming the container and a non-zero exit. So
  a leftover record beside a live migrator is another way this box can sit needing a human, and it
  is the right one: R3's rule, applied to the one path that could not reach R3 because the run doing
  the reconciling is not the run that started the migrator.
- **`deploy/.dump-in-progress` is a hazard marker, and it is deliberately not part of the record
  above — round 10's F2.** It says a pre-update `pg_dump` could not be proven gone inside
  `loom-postgres-1` (§4.5 banner 8). While it exists every invocation refuses before the fetch — no
  dump, no migration, and **no reconciliation of an interrupted update either** — after asking once
  more with a bounded in-container check whose verdict the container prints itself, and a definite
  `DUMP_GONE` from that check is the only thing that removes it (§4.5 banner 2, round 11's F1). **Why it is a file rather than a key in `.update-state`:** the run that writes it is
  on the R6 path, and a successful R6 removes `.update-state` — so a marker living inside that
  record died with the restore that was supposed to leave it standing, and the next update walked
  into the dump it existed to prevent. What it does **not** promise: the script cannot kill a
  process the kernel will not kill, and it cannot tell a dump that is genuinely wedged from a check
  that was simply not answered — both are marked, both refuse, and the by-hand `rm -f` is
  offered only for the case where the container itself is gone and cannot be asked. **What it now
  does promise, which is round 11's F1, is that those two cases are told apart from a dump that is
  genuinely gone:** the container prints `DUMP_GONE` or `DUMP_RUNNING` itself, and a transport
  failure — exit 1, nothing on stdout, a line on stderr — can no longer impersonate the first of
  those. The refusal is deliberately the *safe* side of the ambiguity, so the residual cost is an
  operator running one command, and never a migration over a snapshot nobody knew was open.

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
  availability.** The classification of §4.5's recovery procedure reaches R13 — Loom **down**, a
  printed manual-recovery message, non-zero exit — whenever the migration status cannot be read, or
  shows a partially-applied run, or a migrator container could not be **proven** stopped (round 7's
  F1, R3). Two more branches end with Loom not serving and say so instead of guessing: a
  `.deployed-sha` that could not be written (R2) leaves the containers exactly as they are, because
  the record is what every later run believes; and a start that never answered over a **committed**
  migration (R5) leaves the new container in place and refuses to put the old image in front of the
  new schema. That is deliberate: starting either binary against a schema nobody
  can characterise risks writes against a shape the code does not understand, and that costs the
  event log rather than a minute of uptime. What this does *not* promise is that a human is told:
  nothing pages anyone, so an R13 outage lasts until whoever ran the update reads its output, or
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
- **The automated test of `deploy/` tests one file, and tests it against stubs.** §11.7's harness
  runs the real `live-update.sh` — under `LIVE_UPDATE_TEST_ROOT`, so every path it touches is inside
  a temporary directory — with stub `docker`, `git`, `curl`, `timeout` and `flock` commands
  and asserts the branch it took, the records it left and its exit code. **What the containment
  itself promises is narrow and §11.7 says so:** that no host path handed to a stub was outside the
  root, that nothing unexpected changed inside it, and that the file contains no absolute path
  outside its constants block. It does **not** inspect `/root/caddy-sites`, `/root/backups/loom` or
  Spool's `.env` to prove they were untouched, because reading production paths to prove a test did
  not read them is the defect, not the proof. What that does **not**
  promise otherwise: it says nothing about Docker's, Compose's, Caddy's or Postgres's real behaviour — a stub
  that answers the way this spec believes Docker answers is a test of the spec's belief, and where
  that belief has been wrong before (`up -d` replacing a container, `run` replacing a `command:`,
  `grep -q` killing its producer) it was wrong in the spec and in the stub together. Nothing in
  `deploy/` other than `live-update.sh` is covered at all: the compose file, the site block, the two
  wrappers, the two texts and the two PowerShell helpers are read, and then exercised by the first
  deployment. §11.6 says which mechanisms are structural rather than tested, and names the one — the
  reload-failure restore against a **real** Caddy — that nothing exercises before the day it is
  needed.
- **No monitoring and no alerting.** Nothing watches the instance, nothing pages anyone, and a Loom
  that has been down since Tuesday is discovered by someone trying to use it. `restart:
  unless-stopped` brings it back after a crash or a reboot, and that is the whole of the
  availability story.
- **No tested restore.** The dumps are taken; nothing has ever been restored from one. Spool's
  ROLLOUT.md is right that an untested restore is a guess, and proving Loom's is its own step. What
  narrows the reliance on it: the ordinary bad day — a migration that fails — does **not** need the
  dump at all, because the run's migrations roll back as one transaction and the script restarts the
  container it stopped (§4.5's recovery procedure, R10, and §11.1 case 8). The dump is for the day something worse happens, and
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

Nine, because each one is a thing that could go wrong on the day and each has an answer that is
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
   `trap` and one file.** From §4.5 banner 7 to the loopback answer Loom is not serving: the public
   hostname answers 502, and
   anything that fails in between — Postgres not coming healthy, a failed `pg_dump`, a failed
   migration, a container that starts and never answers, a `set -e` death — would leave it that way
   if nothing restored it. The answer is the
   **single `EXIT` handler installed at the top of the script**, whose recovery does nothing until
   the quiesce sets `QUIESCED=1` and nothing again once `HEALTHY=1`; it runs the recovery procedure
   of §4.5 and reaches a `docker start` of the exact stopped container, a faithful reconstruction of
   it, a start of the new image, or
   a printed refusal — and it says **loom is DOWN** in as many words when it cannot recover.
   **Round 7's F3 is why the disarming flag is `HEALTHY` and not `STARTED`**: `docker compose up -d
   loom` returns as soon as Docker has started the process, so the previous flag disarmed the
   recovery on the strength of a container's existence, and a commit that started and never bound a
   port went out as a deployment with a 502 behind it. The flag is now set by the loopback answer
   alone, and the window between the two — created, not yet answering — has its own branches: R4
   restores the previous deployment when no migration ran, R5 says Loom is down and keeps the new
   commit as the only valid target when one committed. **And round 7's F2 is why the `trap` is no
   longer the whole answer:** a trap runs on exits, and a power loss or a `SIGKILL` is not an exit.
   `deploy/.update-state`, written before the quiesce and removed only once the target is healthy and
   recorded, is what the *next* invocation reconciles from. **Round
   5's F4 is why it is at the top rather than armed at the quiesce**: every variable it reads is
   assigned before it is installed, so `set -u` cannot abort the handler and leave Loom stopped with
   no message, and it clears `errexit` before classifying, so a `docker` call that is *expected* to
   fail cannot cut the recovery short. **And round 6's F5 is why `QUIESCED=1` is set *before*
   `docker compose stop` rather than after it**: the stop can succeed and the client still exit
   non-zero — a lost acknowledgement, a dropped connection, a `Ctrl-C` in the gap — and a flag armed
   only on success meant the handler returned on its first line over a stopped Loom, with no restart
   and no message. It is cleared again only when `docker inspect` positively answers that the
   container is still running, which is the one case where nothing needs starting; §11.6 rehearses
   both directions with a `docker` stub. **And round 8's F2 is why there is now exactly one place
   that ends the quiesce**: `start_target_and_prove`, which the normal path, R7, R11 and the
   reconciliation's case (b) all call, because two of those four used to remove the intent record on
   compose's exit code alone — the same mistake as `STARTED`, one level down, on the paths a human
   meets only after something has already gone wrong. Four things are accepted with it. The outage is real and is stated as a promise not made (§13): seconds per
   update, longer if the dump grows, and nobody is told about it except whoever is watching. The
   recovery depends on the stopped container still being there — which `docker compose stop`
   guarantees and `docker compose down` beside the script would not — and on its image still being
   on disk, which is why nothing prunes images and why §11.6 proves that exact restart once by hand
   on the first day, image id and all — and, since round 5, so is the pending-migration-plus-failed-
   dump path, which is the one F4 broke (§11.6) — and, since round 6, the **torn stop** in both its
   directions, with a stub that makes `docker compose stop` lie — and, since round 7, the **failed
   start** in both its directions and the **killed run**, with a stub that stops the new container
   behind the script's back and a `kill -9` inside the quiesce (§11.6) — **and, since round 8, the
   whole control flow against stub commands on every `pnpm test:deploy`** (§11.7) — **and, since
   round 9's F1, under `LIVE_UPDATE_TEST_ROOT`, so that those runs cannot read or write the live
   server's `.env`, sites folder, backups or lock even when the harness is run on the server
   itself** — which is what
   finally makes the branches nobody can stage live — R2, R3, R11, R13 — assertions rather than
   prose. **Past banner 10 the stopped
   container is gone**, because `up -d loom` replaces it and compose finds its service's container by
   label rather than by name, so the restore there is a reconstruction — the recorded image **id**
   under the deployed commit's tag, through **that commit's own** compose file (R14) — **and since
   round 8's F3 the id is what decides that**, not the tag or the SHA, because a same-SHA rebuild
   over a newer base image leaves both records telling the truth about a container that holds a
   different binary. **And the
   outage the handler can hold is long, and — since round 9's F2 — is NOT bounded at all:** the
   Docker and network work on each branch is a sum of enforced deadlines (60 s per `docker` call,
   330 + 15 for the dump pipeline, 600 + 30 for the migrator, 420 for a reap, 120 for the status
   read, 60 + 20 for the loopback probe; **2535 s** on the longest such branch), but a `gzip` or an
   in-container `pg_dump` wedged in uninterruptible I/O survives `TERM` and `KILL` and `sync -f` is
   under no deadline, so the outage has a named, unbounded tail that ends with an operator and not
   with a timer. §13's first bullet and §4.5 banner 7 state it that way, in place of round 8's
   "about forty-two minutes" and round 7's "sixteen minutes" — both of which were ceilings this
   script cannot enforce (round 8's F1, round 9's F2). And the very first deployment has no previous container at
   all, so a failure there leaves the instance down until someone runs §9 step 4 again — acceptable
   only because at that moment the database holds nothing but an empty schema, which is exactly the
   window §9 step 5's text says it is.
8. **A migrator failure is classified, not assumed — and the classification has its own failure
   mode, which is Loom left down on purpose.** This is the risk round 4's F3 introduced along with
   its fix, and it is worth naming rather than filing as solved. The script no longer says "the
   migrator failed, therefore nothing was applied"; it records the pending set before migrating
   (§4.5 banner 6) and re-reads the status afterwards, and it acts on the comparison (R8–R13). Five
   things are accepted with that. **The classification can itself fail to get an answer** — a
   Postgres that has gone away, or a still-open transaction from a migrator whose client was killed,
   takes R8's `--check` down with it — and the answer then is R13: Loom stays stopped with a message
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
   transaction has not committed **yet**, R10 restarts the old image, and the surviving migrator
   commits the new schema underneath it. `reap_oneoff` now runs on every non-success of the migrator
   and inside every failed `read_status`, so nothing is classified while a migrator is alive.
   **And round 7's F1 is the rest of *that*, because calling the reap everywhere is not the same as
   the reap proving anything.** The function used to read a failed `docker inspect` as "the container
   is not there" and to ignore the status of its own `stop`, `kill`, `wait` and `rm` — so during the
   very outage that produces the finding's scenario, a daemon that cannot answer would have been
   taken for a daemon saying "absent", and the classification would have run beside a live migrator
   after all. It now classifies the inspection's error, re-inspects after the stop, requires `exited`
   or `dead`, and otherwise returns a failure that becomes `MIGRATE_STATE=unreapable` — **so R8, R10
   and R11 cannot run at all without a proven reap**, and the unprovable case goes straight to R13
   with Loom stopped and nothing read. What is accepted with it: an unreachable daemon now produces a
   manual recovery where the previous draft produced a confident wrong answer, which is more manual
   work and less risk to the event log. **And round 9's F3 is that same lesson applied outside the
   reap**, where it was still unlearned: the volume inspection that decides whether a backup is
   taken, the previous-image capture that a restore depends on, and every inspection inside the
   recovery's own messages all read a failure as an absence. They now share one `classify_inspect`,
   and an unanswered question either stops the run before the quiesce or, inside the handler,
   refuses to act on the object. The same trade is accepted again: more runs end in a human reading
   a message, and none ends in a migration over an un-dumped volume. **And round 10's F1 is the
   third place that lesson had still not reached: the reconciliation.** `reap_oneoff` guards the
   *recovery* of the run that started the migrator; it guarded nothing at all for the run that
   arrives afterwards and finds `deploy/.update-state` lying there — which is precisely the case a
   `SIGKILL` or a power loss produces, and precisely the case in which `loom-migrate-run` is most
   likely to have outlived its client. The reconciliation now reaps it first, before the cheap
   "already healthy" probe and before any status is read, and refuses without restoring when the
   reap cannot prove anything. What is accepted with it is the same trade a fourth time: an
   interrupted update beside an unprovable migrator is now a message and a stopped Loom rather than
   an old image started just in time for that migrator to commit the new schema underneath it.
   That is chosen over guessing, for the reason §13 states: a Loom serving against a schema nobody
   has characterised costs the event log, and a 502 costs an afternoon. **R2, R3, R11 and R13 are
   not exercised against a real failure before the day it happens** — they need a torn connection, a
   partial apply, a filesystem that refuses a 41-byte write, or a daemon that answers some questions
   and not others — **but since round 8's F5 all four are exercised against stubs**, which is what
   §11.7 is for: a scenario file can hand the script a daemon that answers `running` after a stop,
   or a `--check` that reports nothing pending after a failed migrator, in a second and repeatably.
   What that buys is that the *branch* is known to be reachable and to print what this document says
   it prints; what it does not buy is any claim about how Docker or Postgres really behave in that
   moment, which is why they are still written as a numbered procedure with their exact commands.
   **The comparison depends on `migrate --check`'s output
   shape**, which is
   therefore a contract in §5.2 and an assertion in §11.2 case 15 rather than a convention. And
   **R12's partial-apply case should now be unreachable**, because `assertTransactionSafe` refuses the
   files that could produce it (§5.1) — but it is implemented anyway, and it routes to R13, because
   "should be unreachable" is exactly the reasoning that produced this finding in the first place.
9. **The journal check is stricter than drizzle's own migrator, and that asymmetry is the price of
   round 8's F4.** `migrationStatus` refuses a journal whose `when` values are not strictly
   increasing and a `__drizzle_migrations` table that is not an exact `(created_at, hash)` prefix of
   it (§5.1); drizzle's `migrate()` applies whatever has a `when` above the table's maximum and
   would happily skip a backdated entry. Three things follow, all accepted. **A repository state
   drizzle tolerates now stops the deployment**, at banner 6, with Loom still serving — which is the
   whole point, but it means the first long-lived branch to merge after a newer migration will be
   met by a refusal rather than a deployment, and the remedy is a regenerated migration, which is a
   commit and a merge and therefore Paw's word again. **And the remedy has a trap of its own, which
   is round 10's F3:** deleting the `.sql` file and the journal entry is not enough, because
   `drizzle-kit generate` takes its previous schema from the newest `meta/*_snapshot.json` and not
   from the journal — so the obvious two-file deletion produces `No schema changes, nothing to
   migrate` and no replacement migration at all. The snapshot has to go with them. **And round
   11's F2 is the trap inside that fix**: the command round 10 wrote down for it,
   `git checkout origin/main -- src/core/drizzle/meta`, is Git's *overlay* mode and does not delete
   the branch-only snapshot at all — it restores the baseline files around it and leaves it as the
   newest input to the next `generate`, so the remedy looked done and was not. The written remedy
   is now `git fetch origin` and
   `git restore --source=origin/main --staged --worktree -- src/core/drizzle/meta`, non-overlay by
   default, with the pre-2.23 equivalent beside it. §5.1 and CONTRIBUTING say what to do, with the
   drizzle-kit call sites the claim was checked against and the throwaway-repository run that
   showed both the defect and the fix; nobody has done it on a real branch yet. **The check depends on computing the same hash drizzle inserts**, and it takes
   it from drizzle's own `readMigrationFiles` for exactly that reason — but a drizzle upgrade that
   changes how the hash is derived would turn every clean database into "drift" and refuse every
   boot and every update. §11.1 case 4 is the alarm: it applies the real migrations and reads the
   rows back, so the upgrade that breaks the agreement fails a test rather than a deployment. And
   **anyone who runs `drizzle-kit migrate` or drizzle's `migrate()` by hand bypasses all of it**,
   because the refusal lives in `runMigrations` and in the migrate entry, not in the library. That is
   stated rather than fixed: the repository has one migration path and this slice makes it refuse, and
   a hook that could police a developer's own shell is not something this design can promise.
