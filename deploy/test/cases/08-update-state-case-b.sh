# Case 08: a leftover .update-state, reconciliation case (b) -- everything was committed.
# .deployed-sha = the target, start_target_and_prove, .update-state gone, exit non-zero.
# And the same case with the target never answering: the record STAYS and LOOM IS DOWN is printed.

seed_record .deployed-sha "$T_PREV_SHA"
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads 0004_listeners"
set_check_pending                                 # nothing is pending any more: it committed

run_script

assert_rc_nonzero
assert_call "up -d --no-build loom"
assert_sha_at_up 1 "$T_TARGET_SHA"                # recorded before the container was created
assert_record .deployed-sha "$T_TARGET_SHA"
assert_record_absent .update-state
refute_out "LOOM IS DOWN"

# the same reconciliation, with the target never answering the loopback
seed_record .deployed-sha "$T_PREV_SHA"
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads 0004_listeners"
answer_curl() { return 7; }                       # nothing answers, ever

run_script

assert_rc_nonzero
assert_call "up -d --no-build loom"
assert_out "LOOM IS DOWN"
assert_record .deployed-sha "$T_TARGET_SHA"       # the schema is the target's, so the record is
assert_record_exists .update-state                # and the interrupted update stays on record
