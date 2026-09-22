# Case 28: the lock is already held, so the run refuses before it touches anything.
# `flock -n 9` answers non-zero: the script prints "another live-update is running" on stderr and
# exits non-zero, and $CALLS shows the flock call and NOTHING else -- no git, no docker. The lock
# is taken before every question the script asks, which is the whole point of taking it: a second
# run must not fetch, build, stop, dump or migrate while the first one is mid-flight.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending

answer_flock() { return 1; }                      # the lock is held by another live-update

run_script

assert_rc_nonzero
assert_out "another live-update is running"

assert_call "flock -n 9"

refute_call "git "                                # nothing was asked of the checkout
refute_call "docker "                             # nothing was asked of the daemon

# and, said the other way round: the flock call is the ONLY call the run made
CALL_COUNT="$(grep -c . "$CALLS")"
assert_equal "$CALL_COUNT" 1 "the number of recorded calls once the lock is refused"

assert_record .deployed-sha "$T_PREV_SHA"         # no record was touched
assert_record_absent .update-state
assert_record_absent .verified-sha
