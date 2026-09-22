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
