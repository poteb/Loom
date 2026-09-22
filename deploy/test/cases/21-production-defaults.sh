# Case 21: the production defaults, asserted by READING the file.
# This case does not run the script. Running it could never assert this, because a run that
# asserted the production values would be a run pointed at them. It asserts that the five path
# constants are the production ones, assigned unconditionally; that the only LIVE_UPDATE_TEST_ROOT
# branch is the one that re-points them; that no other line in the file carries an absolute path
# outside a printed message -- the check that keeps a sixth hard-coded path from being added
# later; and that dump_verdict still matches on pgrep -x.

SCRIPT="$SCRIPT_SOURCE"

IF_LINE="$(grep -n -F 'if [ -n "${LIVE_UPDATE_TEST_ROOT:-}" ]; then' "$SCRIPT" | sed -n 1p | cut -d: -f1)"
[ -n "$IF_LINE" ] || fail "the LIVE_UPDATE_TEST_ROOT branch is not in the file at all"
IF_COUNT="$(grep -c -F 'if [ -n "${LIVE_UPDATE_TEST_ROOT:-}" ]; then' "$SCRIPT")"
assert_equal "$IF_COUNT" 1 "the number of LIVE_UPDATE_TEST_ROOT branches"

FI_LINE="$(sed -n "$((IF_LINE + 1)),\$p" "$SCRIPT" | grep -n -x -F 'fi' | sed -n 1p | cut -d: -f1)"
FI_LINE=$((IF_LINE + FI_LINE))

assert_constant() {               # $1 the name, $2 the production value it must be assigned
  local n count
  n="$(grep -n -x -F "$1=$2" "$SCRIPT" | sed -n 1p | cut -d: -f1)"
  [ -n "$n" ] || fail "the file has no unindented, unguarded line assigning $1=$2"
  [ "$n" -lt "$IF_LINE" ] || fail "$1 is assigned only inside the LIVE_UPDATE_TEST_ROOT branch"
  count="$(grep -c -E "^[[:space:]]*$1=" "$SCRIPT")"
  assert_equal "$count" 2 "the number of assignments to $1"
  n="$(grep -n -E "^[[:space:]]+$1=" "$SCRIPT" | sed -n 1p | cut -d: -f1)"
  [ -n "$n" ] || fail "$1 is never re-pointed under LIVE_UPDATE_TEST_ROOT"
  [ "$n" -gt "$IF_LINE" ] && [ "$n" -lt "$FI_LINE" ] \
    || fail "the second assignment to $1 is not inside the LIVE_UPDATE_TEST_ROOT branch"
}

assert_constant LOOM_DEPLOY_DIR  /root/git/Loom/deploy
assert_constant SPOOL_DEPLOY_DIR /root/git/Spool/deploy
assert_constant SITES_DIR        /root/caddy-sites
assert_constant BACKUP_DIR       /root/backups/loom
assert_constant LOCK_FILE        /run/lock/loom-live-update.lock

# every mention of LIVE_UPDATE_TEST_ROOT outside a comment is inside that one branch
grep -n -F 'LIVE_UPDATE_TEST_ROOT' "$SCRIPT" > "$HARNESS/mentions"
while IFS= read -r ROW; do
  N="${ROW%%:*}"
  TEXT="${ROW#*:}"
  TRIM="${TEXT#"${TEXT%%[![:space:]]*}"}"
  case "$TRIM" in '#'*) continue ;; esac
  [ "$N" -ge "$IF_LINE" ] && [ "$N" -le "$FI_LINE" ] \
    || fail "line $N mentions LIVE_UPDATE_TEST_ROOT outside the one branch: $TEXT"
done < "$HARNESS/mentions"

# no other line carries an absolute path that could be the live server own, outside a message.
# /etc/caddy/Caddyfile and /etc/caddy/sites are allowed: they are paths INSIDE the container the
# script runs, named in that container own argv, and are not host paths at all.
grep -n -E '/(root|run|var|home|srv|opt|mnt|etc|usr|tmp)/' "$SCRIPT" > "$HARNESS/abs"
while IFS= read -r ROW; do
  N="${ROW%%:*}"
  TEXT="${ROW#*:}"
  if [ "$N" -ge "$((IF_LINE - 5))" ] && [ "$N" -le "$FI_LINE" ]; then continue; fi
  TRIM="${TEXT#"${TEXT%%[![:space:]]*}"}"
  case "$TRIM" in
    '#'*)      continue ;;
    'echo '*)  continue ;;
    'printf '*) continue ;;
  esac
  STRIPPED="${TEXT//\/etc\/caddy\/Caddyfile/}"
  STRIPPED="${STRIPPED//\/etc\/caddy\/sites/}"
  case "$STRIPPED" in
    */root/*|*/run/*|*/var/*|*/home/*|*/srv/*|*/opt/*|*/mnt/*|*/etc/*|*/usr/*|*/tmp/*)
      fail "line $N carries an absolute path outside the constants block and outside a message: $TEXT" ;;
  esac
done < "$HARNESS/abs"

# round 12 F1, kept from drifting back: the in-container wrapper matches on the executable name
grep -F -q -- 'pgrep -x pg_dump' "$SCRIPT" || fail "dump_verdict no longer matches on pgrep -x pg_dump"
grep -F -q -- 'pgrep -f' "$SCRIPT" && fail "the file contains a pgrep -f, which inside an sh -c wrapper matches the wrapper own command line"
sed -n '/^dump_verdict()/,/^}/p' "$SCRIPT" > "$HARNESS/verdict-fn"
grep -F -q -- 'pgrep -x pg_dump' "$HARNESS/verdict-fn" || fail "dump_verdict body has no pgrep -x pg_dump"
grep -F -q -- 'pgrep -f' "$HARNESS/verdict-fn" && fail "dump_verdict body contains a pgrep -f"
# the bare pgrep -af and pkill -TERM -f that Compose execs directly have no wrapper shell to match
grep -F -q -- 'pgrep -af pg_dump' "$SCRIPT" || fail "the operator hint no longer offers pgrep -af"
grep -F -q -- 'pkill -TERM -f pg_dump' "$SCRIPT" || fail "the signal is no longer a pkill -TERM -f"
