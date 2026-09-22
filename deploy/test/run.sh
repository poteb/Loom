#!/usr/bin/env bash
# deploy/test/run.sh — the shell contract harness for deploy/live-update.sh (spec 11.7).
#
# WHAT THIS IS. It runs the REAL deploy/live-update.sh with a directory of stub commands first on
# PATH, inside a temporary directory, and asserts three things per case: the sequence of `docker`
# and `git` calls the script made, the contents of the records it left behind, and its exit code.
# That is a test of control flow: which branch a given set of answers takes, which command it runs
# next, which file it writes and which it leaves alone. No framework, and bats deliberately not
# added: a `for` loop over cases/*.sh with a pass/fail count. It needs NO Docker, NO Postgres and
# NO network, and it is safe to run on the live server itself, because LIVE_UPDATE_TEST_ROOT (the
# script's own test mode, which prints one `TEST MODE:` line) re-points every one of its five path
# constants under the temporary root.
#
# WHAT IT DELIBERATELY DOES NOT ASSERT.
#   * The TEXT of any message, beyond the few lines a human is meant to act on: LOOM IS DOWN,
#     MANUAL RECOVERY REQUIRED, restored the previous deployment, REFUSING TO RUN,
#     REFUSING TO RECONCILE. Pinning prose makes a test that fails on every edit to prose.
#   * Any timing other than the deadlines handed to the stubbed `timeout`.
#   * The two PowerShell wrappers and the two .ps1 helpers: they are Windows-side and are
#     exercised by spec section 9 steps 8 and 12.
#
# ONE BOUNDARY INSIDE THAT BOUNDARY: THE HARNESS STUBS THE TRANSPORT, SO IT CAN NEVER TEST THE
# WRAPPER TEXT. Every in-container question the script asks -- the dump, the `pkill`, and
# dump_verdict's `sh -c` wrapper -- reaches the harness as arguments to a stub `docker`, which
# answers whatever the scenario said. The cases below pin what the script DOES WITH DUMP_GONE,
# DUMP_RUNNING and an unanswered check, and they do it without a container -- but they would pass
# unchanged with a wrapper that can only ever print one of those tokens, which is exactly the
# defect round 12 found. The wrapper text is verified where it can only be verified, by RUNNING
# it (spec section 11.6); case 21 only keeps the file from drifting back to a `pgrep -f`.
#
# HOW A CASE IS BUILT. The runner makes $TEST_ROOT, lays the world out under it (including HOME
# and TMPDIR, so even mktemp lands inside), puts deploy/test/stubs first on PATH, and sources the
# case file. The case defines one `answer_<command>` shell function per stubbed command -- a
# `case " $* " in ... esac` that prints what the scenario wants and returns the status it wants --
# then calls `run_script` as often as it needs, and asserts. `run_script` truncates $CALLS, writes
# the current answer functions into $SCENARIO (the stubs are separate processes and source it),
# runs the script, and leaves the exit status in $RC and the merged output in the file $OUT.
# On success the directory is removed; on failure it is left, with its path printed.
#
# A case that cannot run on this machine calls `skip "<reason>"`; the runner counts it separately
# and prints the reason. That is for a platform limit -- Windows does not honour a read-only
# directory -- and never for a case that merely fails.
#
# A SKIP IS NOT A PASS ON THE MACHINE THAT CAN RUN THE CASE. With LIVE_UPDATE_TEST_STRICT=1 in the
# environment, a run that skipped anything exits non-zero and names every case it skipped. On
# LINUX -- the server, and any Linux checkout -- the harness is meant to be run that way:
#
#     LIVE_UPDATE_TEST_STRICT=1 bash deploy/test/run.sh
#
# There the read-only directory is honoured, case 17 (record_failure) EXECUTES, and nothing is
# skipped, so STRICT is the gate that keeps a Windows skip from becoming a permanent hole.
# Without it the default stands: a skip is reported, and the run still passes.
#
# A CASE THAT ERRORS IS A CASE THAT FAILS. The runner sets no `set -e` -- the assert helpers are
# built on `&&` and `||` and errexit would misread them -- so instead it traps ERR inside the
# sourced case (any command IN THE CASE FILE that fails and is checked by nothing fails the case),
# defines `command_not_found_handle` (a mistyped helper name fails the case instead of being
# skipped silently), propagates the case's own exit status, and refuses a case pattern that
# matches no file. A harness that reports PASS for a case that never ran is worse than no harness.
#
# ONE CASE AT A TIME: `bash deploy/test/run.sh 21` runs the cases whose file name contains 21.
# A pattern that matches nothing is an error: the runner prints "no case matched" and exits 2.
#
# RUNTIME is a few minutes: the cases where a probe never answers let the script's own retry loop
# run to its 60s or 120s deadline, because `sleep` is deliberately NOT stubbed -- a stubbed sleep
# would make the deadline arithmetic untestable.

set -uo pipefail                 # NOT -e: a failing case must be reported, not abort the runner

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SCRIPT_SOURCE="$REPO_ROOT/deploy/live-update.sh"
CADDY_SOURCE="$REPO_ROOT/deploy/loom.caddy"
STUB_DIR="$HERE/stubs"
export STUB_DIR
CASE_DIR="$HERE/cases"
export SCRIPT_SOURCE

# --- the world's fixed values, exported so the stubs and the cases share one vocabulary --------
export T_PREV_SHA=aaaa111
export T_PREV_FULL=aaaa111000000000000000000000000000000000
export T_TARGET_SHA=bbbb222
export T_TARGET_FULL=bbbb222000000000000000000000000000000000
export T_PREV_IMAGE=sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0
export T_NEW_IMAGE=sha256:99887766554433221100aabbccddeeff99887766554433221100aabbccddeeff
export T_CONTAINER=loom-loom-1
export T_LOCAL_URL=http://127.0.0.1:3100/api/guidelines
export T_PUBLIC_URL=https://loom.3dbox.dk/api/guidelines

# --- the stub side, written into $SCENARIO by run_script and sourced by every stub -------------

stub_path_ok() {                 # a host path is fine when it is relative, or under $TEST_ROOT
  case "$1" in
    /*) case "$1" in "$TEST_ROOT"|"$TEST_ROOT"/*) return 0 ;; *) return 1 ;; esac ;;
    *)  return 0 ;;
  esac
}

stub_screen() {                  # the host paths a command was handed, by the command's own
  local cmd="$1"; shift          #   grammar: the part before the first colon of each -v, and the
  local a want=""                #   values of --env-file, --project-directory, -f, and of the -C
  for a in "$@"; do              #   that is the only host path git is ever handed here.
    case "$want" in              #
      volume) a="${a%%:*}"
              stub_path_ok "$a" || printf 'VIOLATION %s\n' "$a" >> "$CALLS" ;;
      path)   stub_path_ok "$a" || printf 'VIOLATION %s\n' "$a" >> "$CALLS" ;;
    esac                         #   Everything from the image or service name onward is the
    want=""                      #   container's OWN argv (/etc/caddy/Caddyfile, dist/migrate.js)
    case "$a" in                 #   and is not a host path -- which is also why only an ABSOLUTE
      -v|--volume)                                    want=volume ;;
      --env-file|--project-directory|-f|--file|-C)    want=path ;;
      --env-file=*|--project-directory=*|--file=*)    #   value can be a violation: `docker rm -f
        a="${a#*=}"                                   #   <name>` and `pkill -TERM -f pg_dump`
        stub_path_ok "$a" || printf 'VIOLATION %s\n' "$a" >> "$CALLS" ;;
    esac                                              #   both hand -f something relative.
  done
  case "$cmd" in                 # `install`'s grammar puts the DESTINATION last, and it is always
    install)                     #   a host path -- the backup directory, or the site block's home
      [ "$#" -gt 0 ] || return 0 #   in the sites folder. Screened, so a hard-coded /root/... in
      a="${*: -1}"               #   either call raises a VIOLATION rather than waiting for case
      stub_path_ok "$a" || printf 'VIOLATION %s\n' "$a" >> "$CALLS" ;;   # 21's reading check.
  esac
}

stub_record() {                  # one call per line, in call order, arguments joined by a space.
  local name="$1" a line; shift  #   An argument's own newlines and tabs become spaces, so that
  line="$name"                   #   the dump's `bash -c` script and dump_verdict's `sh -c`
  for a in "$@"; do              #   wrapper are each ONE greppable line.
    a="${a//$'\n'/ }"
    a="${a//$'\t'/ }"
    a="${a//$'\r'/ }"
    line="$line $a"
  done
  printf '%s\n' "$line" >> "$CALLS"
}

stub_observe() {                 # two observations no case can lose by redefining an answer:
  local name="$1"; shift         #   what .deployed-sha held at the moment the target's container
  case "$name" in                #   was created, and whether .update-state was still on disk at
    curl)                        #   each probe. Both are orderings a call list cannot show,
      { if [ -f "$DEPLOY/.update-state" ]; then printf 'present '; else printf 'absent '; fi
        printf '%s\n' "${*: -1}"
      } >> "$HARNESS/state-at-probe" ;;
    docker)
      case " $* " in
        *" up -d --no-build loom "*)
          { cat "$DEPLOY/.deployed-sha" 2>/dev/null || printf 'none\n'; } >> "$HARNESS/sha-at-up" ;;
      esac ;;
  esac                           #   because a file write is not a call.
}

stub_main() {                    # every stub is three lines: source $SCENARIO, then call this
  local name="$1"; shift
  stub_record "$name" "$@"
  stub_screen "$name" "$@"
  stub_observe "$name" "$@"
  local rc=0
  case "$name" in
    docker)  answer_docker  "$@" || rc=$? ;;
    git)     answer_git     "$@" || rc=$? ;;
    curl)    answer_curl    "$@" || rc=$? ;;
    flock)   answer_flock   "$@" || rc=$? ;;
    install) answer_install "$@" || rc=$? ;;
    timeout) answer_timeout "$@" || rc=$?
             [ "$rc" -eq 0 ] || exit "$rc"     # a non-zero answer IS the status, 124 for a deadline
             while [ "$#" -gt 0 ]; do          # otherwise: drop the options and the duration, and
               case "$1" in                    # run the rest through, so the bounded command is
                 -*) shift ;;                  # itself recorded by whichever stub it names
                 *)  shift; break ;;
               esac
             done
             [ "$#" -gt 0 ] || exit 0
             exec "$@" ;;
  esac
  exit "$rc"
}

# --- the default scenario: a healthy world in which the previous deployment is up --------------
# A case redefines only the answers whose branch it is about.

answer_docker() {
  case " $* " in
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *"{{.State.Running}}"*)           printf 'true\n' ;;
    *"{{.State.Health.Status}}"*)     printf 'healthy\n' ;;
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
    *".Mounts"*)                      printf 'loom_pgdata \n' ;;
    *" volume inspect loom_pgdata "*) printf '[{}]\n' ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *pkill*)                          return 0 ;;
    *pgrep*)                          printf 'DUMP_GONE\n' ;;
    *pg_dump*)                        printf -- '-- a fake pg_dump\n' ;;
    *"--check"*)                      cat "$HARNESS/check-output" ;;
    *)                                return 0 ;;
  esac
}

answer_git() {
  case " $* " in
    *" fetch origin main "*)                  return 0 ;;
    *" cat-file -e "*)                        return 0 ;;
    *" diff --no-color "*)                    return 0 ;;   # no topology change
    *" symbolic-ref --short HEAD "*)          printf 'main\n' ;;
    *" status --porcelain "*)                 return 0 ;;   # a clean checkout
    *" merge --ff-only "*)                    return 0 ;;
    *" rev-parse --short HEAD "*)             printf '%s\n' "$T_TARGET_SHA" ;;
    *" rev-parse HEAD "*)                     printf '%s\n' "$T_TARGET_FULL" ;;
    *" rev-parse refs/remotes/origin/main "*) printf '%s\n' "$T_TARGET_FULL" ;;
    *":deploy/docker-compose.yml "*)          printf 'services:\n  loom:\n    build: .\n' ;;
    *)                                        return 0 ;;
  esac
}

answer_curl()    { return 0; }   # both URLs answer on the first try
answer_timeout() { return 0; }   # 0 means "run the wrapped command through"
answer_flock()   { return 0; }   # the lock is free

answer_install() {               # THE ONE STUB THAT IS NOT A SCENARIO: a compatibility shim.
  local real="" d rc=0 mode="" dashd=0 a       # `install` is not a command this harness has any
  local -a args=() dirs=()                     # reason to fake -- the script uses it to make the
  IFS=: read -r -a dirs <<< "$PATH"            # backup directory 700 and to place the site block
  for d in "${dirs[@]}"; do                    # -- but MSYS (Git Bash) REFUSES to take 700 off a
    case "$d" in "$STUB_DIR") continue ;; esac #    (`IFS=:` and a quoted expansion, because a
    [ -x "$d/install" ] && { real="$d/install"; break; }   # PATH entry on Windows carries spaces
  done                                         # directory, so `install -d -m 700` fails there and
  if [ -n "$real" ]; then                      # every case that reaches the dump would be
    "$real" "$@" && return 0                   # unrunnable on Windows. So: run the REAL install
    rc=$?                                      # first, and only when it fails retry WITHOUT the
  else                                         # mode and apply the mode separately, ignoring a
    rc=127                                     # refusal of the mode alone. On Linux, and on the
  fi                                           # server, the first line is the only one that runs,
  while [ "$#" -gt 0 ]; do                     # and a genuine permission failure still fails
    case "$1" in                               # twice and is still reported.
      -d) dashd=1 ;;
      -m) shift; mode="$1" ;;
      -m*) mode="${1#-m}" ;;
      -*) ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  if [ "$dashd" = 1 ]; then
    mkdir -p "${args[@]}" || return "$rc"
    for a in "${args[@]}"; do [ -z "$mode" ] || chmod "$mode" "$a" 2>/dev/null || true; done
    return 0
  fi
  [ "${#args[@]}" -ge 2 ] || return "$rc"
  local dst="${args[${#args[@]}-1]}"
  unset 'args[${#args[@]}-1]'
  cp "${args[@]}" "$dst" || return "$rc"
  [ -z "$mode" ] || chmod "$mode" "$dst" 2>/dev/null || true
  return 0
}

# --- what a case may call ----------------------------------------------------------------------

fail() {                         # the one way a case fails: say why, then show the evidence
  printf 'ASSERTION FAILED: %s\n' "$*"
  if [ -n "${OUT:-}" ] && [ -f "$OUT" ]; then
    printf -- '--- the run output, last 40 lines of %s ---\n' "$OUT"
    tail -40 "$OUT"
  fi
  if [ -f "$CALLS" ]; then
    printf -- '--- the recorded calls, %s ---\n' "$CALLS"
    cat "$CALLS"
  fi
  printf 'the temporary directory is left for inspection: %s\n' "$TEST_ROOT"
  exit 1
}

command_not_found_handle() {     # a mistyped helper name is an ASSERTION THAT NEVER RAN. Without
  : > "$HARNESS/command-not-found" 2>/dev/null || true   # this, bash prints `foo: command not
  fail "unknown command: $1"     #   found` to a stream the runner discards on a passing case and
}                                #   the case runs on to its end and reports PASS -- which is how
                                 #   assert_same came to be called by two cases and defined by none

harness_err() {                  # the ERR trap, armed only while a case file is sourced. It fires
  local rc="$1" cmd="$2"         #   wherever errexit would have exited, so the assert helpers'
  case "${BASH_SOURCE[1]:-}" in  #   `&&` / `||` idiom is untouched -- but a bare command in a
    "$CASE_FILE") ;;             #   case that fails and is checked by nothing fails the case.
    *) return 0 ;;               #   Only commands whose source file IS the case file count: the
  esac                           #   `. "$file"` that runs it, and the helpers defined here, are
  [ -e "$HARNESS/command-not-found" ] && exit 1   # the handler above already said which name
  fail "a command in the case failed with status $rc and nothing checked it: $cmd"
}                                #   the runner's own business and guard themselves.

skip() {
  printf 'SKIPPED: %s\n' "$*"
  chmod -R u+rwx "$TEST_ROOT" 2>/dev/null || true
  rm -rf "$TEST_ROOT"
  exit 77
}

set_check_pending() {            # what `migrate --check` prints; no argument means nothing pending
  local t
  { printf 'migrations: 5 applied\npending:\n'
    for t in "$@"; do printf '  %s\n' "$t"; done
  } > "$HARNESS/check-output"
}

seed_record() { printf '%s\n' "$2" > "$DEPLOY/$1"; }

seed_update_state() {            # $1 old_sha, $2 old_image, $3 target sha, $4 the pending tags
  printf 'old_sha=%s\nold_image=%s\ntarget_sha=%s\ntarget_tag=loom-live:%s\npending=%s\nstarted_at=20260921T101010Z\n' \
    "$1" "$2" "$3" "$3" "$4" > "$DEPLOY/.update-state"
}

run_script() {                   # one run of the real script; $RC and $OUT are what it left
  RUNS=$((RUNS + 1))
  : > "$CALLS"
  { printf '%s\n' '# generated per run by deploy/test/run.sh; sourced by every stub'
    declare -f stub_path_ok stub_screen stub_record stub_observe stub_main \
               answer_docker answer_git answer_curl answer_timeout answer_flock answer_install
  } > "$SCENARIO"
  OUT="$HARNESS/out.$RUNS"
  if bash "$DEPLOY/live-update.sh" "$@" > "$OUT" 2>&1; then RC=0; else RC=$?; fi
  return 0                       # a non-zero run is the NORMAL case here: $RC is the assertion
}

assert_rc()         { [ "$RC" = "$1" ] || fail "exit code is $RC, expected $1"; }
assert_rc_nonzero() { [ "$RC" != 0 ]   || fail "exit code is 0, expected non-zero"; }

assert_call() { grep -F -q -- "$1" "$CALLS" || fail "no recorded call contains: $1"; }
refute_call() { grep -F -q -- "$1" "$CALLS" && fail "a recorded call contains: $1"; return 0; }
assert_out()  { grep -F -q -- "$1" "$OUT"   || fail "the output does not contain: $1"; }
refute_out()  { grep -F -q -- "$1" "$OUT"   && fail "the output contains: $1"; return 0; }

line_of() {                      # the line number of the first call containing $1, or nothing.
  local n                        #   No match is an answer, not an error: the caller decides.
  n="$(grep -F -n -- "$1" "$CALLS" | sed -n 1p | cut -d: -f1)" || n=""
  printf '%s' "$n"
  return 0
}

assert_order() {                 # $1 must be called before $2
  local a b
  a="$(line_of "$1")"
  b="$(line_of "$2")"
  [ -n "$a" ] || fail "no recorded call contains: $1"
  [ -n "$b" ] || fail "no recorded call contains: $2"
  [ "$a" -lt "$b" ] || fail "'$1' at line $a was not called before '$2' at line $b"
}

calls_after() {                  # every recorded call after the first one containing $1
  local n
  n="$(line_of "$1")"
  [ -n "$n" ] || fail "no recorded call contains: $1"
  sed -n "$((n + 1)),\$p" "$CALLS"
}

docker_calls_after() {           # only the `docker` calls after the first one containing $1, so
                                 #   that a case can name the NEXT one and the one after it. Any
                                 #   further record of $1 itself is dropped, because `dk` records
                                 #   the bounded `timeout 60 docker ...` line AND the `docker ...`
                                 #   line it then runs, and both are the same call.
  calls_after "$1" > "$HARNESS/after-docker"   # NOT a pipeline: `calls_after` may `fail`, and a
                                               #   `fail` inside a pipeline's subshell would only
                                               #   kill the subshell and let the case carry on.
  grep -F -v -- "$1" "$HARNESS/after-docker" | sed -n 's/^docker /docker /p'
  return 0
}

refute_call_after() {            # $2 appears in no call after the first one containing $1
  calls_after "$1" > "$HARNESS/after"
  grep -F -q -- "$2" "$HARNESS/after" && fail "'$2' was called after '$1'"
  return 0
}

assert_call_after() {            # $2 appears in some call after the first one containing $1
  calls_after "$1" > "$HARNESS/after"
  grep -F -q -- "$2" "$HARNESS/after" || fail "'$2' was never called after '$1'"
  return 0
}

assert_record() {                # $1 is the record's name, $2 the single line it must hold
  local got
  [ -f "$DEPLOY/$1" ] || fail "$1 does not exist"
  got="$(cat "$DEPLOY/$1")"
  [ "$got" = "$2" ] || fail "$1 holds '$got', expected '$2'"
}

assert_record_absent() { [ -e "$DEPLOY/$1" ] && fail "$1 exists and should not"; return 0; }
assert_record_exists() { [ -f "$DEPLOY/$1" ] || fail "$1 does not exist"; return 0; }

assert_equal() { [ "$1" = "$2" ] || fail "${3:-value} is '$1', expected '$2'"; }

assert_same() {                  # two files are byte for byte the same; a missing file is not
  cmp -s "$1" "$2" || fail "$1 and $2 are not byte for byte the same file"
}

assert_sha_at_up() {             # what .deployed-sha held when the Nth `up -d --no-build loom` ran
  local got                      #   ($1 = N, $2 = the expected content, or the word none)
  [ -f "$HARNESS/sha-at-up" ] || fail "no up -d --no-build loom was ever called"
  got="$(sed -n "$1p" "$HARNESS/sha-at-up")"
  [ "$got" = "$2" ] || fail ".deployed-sha held '$got' at up number $1, expected '$2'"
}

assert_state_at_probe() {        # present or absent: was .update-state on disk at the Nth probe
  local got
  [ -f "$HARNESS/state-at-probe" ] || fail "no probe was ever made"
  got="$(sed -n "$1p" "$HARNESS/state-at-probe" | cut -d' ' -f1)"
  [ "$got" = "$2" ] || fail ".update-state was '$got' at probe number $1, expected '$2'"
}

# --- the runner ---------------------------------------------------------------------------------

build_world() {
  mkdir -p "$TEST_ROOT/git/Loom/deploy" "$TEST_ROOT/git/Spool/deploy" \
           "$TEST_ROOT/caddy-sites" "$TEST_ROOT/backups" "$TEST_ROOT/run/lock" \
           "$TEST_ROOT/tmp" "$TEST_ROOT/home" "$TEST_ROOT/harness"
  cp "$SCRIPT_SOURCE" "$TEST_ROOT/git/Loom/deploy/live-update.sh"
  cp "$CADDY_SOURCE"  "$TEST_ROOT/git/Loom/deploy/loom.caddy"
  printf 'POSTGRES_PASSWORD=placeholder\nLOOM_KEEPER_TOKEN=placeholder\n' \
    > "$TEST_ROOT/git/Loom/deploy/.env"
  printf 'SITE_ADDRESS=loom.test\nREDIRECT_ADDRESSES=www.loom.test\n' \
    > "$TEST_ROOT/git/Spool/deploy/.env"
  printf '%s\n' 'import /etc/caddy/sites/*.caddy' > "$TEST_ROOT/git/Spool/deploy/Caddyfile"
  : > "$TEST_ROOT/harness/calls"
}

run_one_case() {                 # in a subshell: a failed assertion exits it, nothing leaks out
  local file="$1" rc=0
  CASE_FILE="$file"
  TEST_ROOT="$(mktemp -d)"
  export TEST_ROOT
  export LIVE_UPDATE_TEST_ROOT="$TEST_ROOT"
  export HOME="$TEST_ROOT/home"
  export TMPDIR="$TEST_ROOT/tmp"
  export DEPLOY="$TEST_ROOT/git/Loom/deploy"
  export SPOOL="$TEST_ROOT/git/Spool/deploy"
  export SITES="$TEST_ROOT/caddy-sites"
  export BACKUPS="$TEST_ROOT/backups/loom"
  export HARNESS="$TEST_ROOT/harness"
  export CALLS="$TEST_ROOT/harness/calls"
  export SCENARIO="$TEST_ROOT/harness/scenario.sh"
  export PATH="$STUB_DIR:$PATH"
  unset COMPOSE_PROJECT_NAME LIVE_UPDATE_BOOTSTRAP
  RUNS=0
  RC=0
  OUT=""
  build_world
  set_check_pending
  set -E                         # errtrace: the ERR trap is inherited by the case's own functions
  trap 'harness_err "$?" "$BASH_COMMAND"' ERR
  # shellcheck disable=SC1090
  . "$file"
  rc=$?                          # the case's own status, not a blanket 0
  trap - ERR
  set +E
  chmod -R u+rwx "$TEST_ROOT" 2>/dev/null || true
  rm -rf "$TEST_ROOT"
  return "$rc"
}

main() {                         # an argument, if there is one, selects the cases whose file
  local pass=0 failed=0 skipped=0 f name rc out started   # name contains it, for working on one
  local pattern="${1:-}" matched=0 skipped_names=""

  for f in docker git curl timeout flock install; do
    [ -f "$STUB_DIR/$f" ] || { echo "missing stub $STUB_DIR/$f" >&2; exit 2; }
    [ -x "$STUB_DIR/$f" ] \
      || { echo "stub $STUB_DIR/$f is not executable; git update-index --chmod=+x it" >&2; exit 2; }
  done
  [ -f "$SCRIPT_SOURCE" ] || { echo "missing $SCRIPT_SOURCE" >&2; exit 2; }
  [ -f "$CADDY_SOURCE" ]  || { echo "missing $CADDY_SOURCE" >&2; exit 2; }

  echo "deploy/test: the shell contract harness for deploy/live-update.sh"
  echo "  under test: $SCRIPT_SOURCE"
  echo "  no Docker, no Postgres and no network are used or needed"
  echo

  for f in "$CASE_DIR"/*"$pattern"*.sh; do
    [ -f "$f" ] || continue      # an unmatched glob is the pattern itself: counted by nothing
    matched=$((matched + 1))
    name="$(basename "$f")"
    started="$SECONDS"
    printf '  %-42s ' "$name"
    out="$(run_one_case "$f" 2>&1)"
    rc=$?
    case "$rc" in
      0)  pass=$((pass + 1))
          printf 'PASS  %ss\n' "$((SECONDS - started))" ;;
      77) skipped=$((skipped + 1))
          skipped_names="$skipped_names $name"
          printf 'SKIP  %ss\n' "$((SECONDS - started))"
          printf '%s\n' "$out" | sed 's/^/        /' ;;
      *)  failed=$((failed + 1))
          printf 'FAIL  %ss\n' "$((SECONDS - started))"
          printf '%s\n' "$out" | sed 's/^/        /' ;;
    esac
  done

  if [ "$matched" -eq 0 ]; then
    echo "no case matched '$pattern' in $CASE_DIR" >&2
    exit 2
  fi

  echo
  echo "  $((pass + failed + skipped)) cases, $pass passed, $failed failed, $skipped skipped"
  [ "$failed" -eq 0 ] || return 1
  if [ "$skipped" -gt 0 ] && [ -n "${LIVE_UPDATE_TEST_STRICT:-}" ]; then
    echo "  LIVE_UPDATE_TEST_STRICT is set and these cases did not run:$skipped_names" >&2
    echo "  a skip is a hole, not a pass; run the harness on Linux, where nothing is skipped" >&2
    return 1
  fi
  return 0
}

main "$@"
