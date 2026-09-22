# Case 22: nothing outside the temporary root was read or written.
# The happy path with a migration, run whole, with $TEST_ROOT/.mark touched first. Afterwards:
# (a) no stub wrote a VIOLATION line, so every host path handed to docker, git or curl was under
# the root; and (b) find -newer lists exactly the files this case expects -- the records, the
# dump, the site block, the lock and the temporaries -- and nothing else.

seed_record .deployed-sha "$T_PREV_SHA"
rm -f "$SITES/loom.caddy"                         # no previous site block, so this run installs one
set_check_pending 0003_threads

touch "$TEST_ROOT/.mark"
run_script

assert_rc 0

grep -F -q 'VIOLATION' "$CALLS" && fail "a stub was handed a host path outside the temporary root"

FOUND="$(find "$TEST_ROOT" -newer "$TEST_ROOT/.mark" -type f \
         | sed "s#^$TEST_ROOT/##" \
         | sed -E 's#loom-pre-update-[0-9A-Za-z]+\.sql\.gz#loom-pre-update-TS.sql.gz#' \
         | LC_ALL=C sort)"

EXPECTED="$(LC_ALL=C sort <<TXT
backups/loom/loom-pre-update-TS.sql.gz
caddy-sites/loom.caddy
git/Loom/deploy/.deployed-image
git/Loom/deploy/.deployed-sha
git/Loom/deploy/.verified-sha
harness/calls
harness/out.1
harness/scenario.sh
harness/sha-at-up
harness/state-at-probe
run/lock/loom-live-update.lock
TXT
)"

if [ "$FOUND" != "$EXPECTED" ]; then
  printf 'what the run created or modified inside the root:\n%s\n' "$FOUND"
  printf 'what the case expects:\n%s\n' "$EXPECTED"
  fail "the set of files the run touched is not the expected one"
fi
