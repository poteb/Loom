# Case 06: COMPOSE_PROJECT_NAME in the environment is refused before anything at all happens.
# exit 1 BEFORE flock is called, which $CALLS shows by being empty.

seed_record .deployed-sha "$T_PREV_SHA"

COMPOSE_PROJECT_NAME=something-else
export COMPOSE_PROJECT_NAME

run_script

assert_rc 1
assert_out "COMPOSE_PROJECT_NAME is set in this environment"
refute_out "TEST MODE:"                          # it refuses before the constants are even moved

SIZE="$(wc -c < "$CALLS" | tr -d ' ')"
assert_equal "$SIZE" 0 "the size of the recorded call list"

assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state
