# Case 07: a leftover .update-state, reconciliation case (a) -- nothing was committed.
# No fetch, no build, restore_prev by the recorded image id, .update-state gone, exit non-zero.

seed_record .deployed-sha "$T_PREV_SHA"
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads 0004_listeners"
set_check_pending 0003_threads 0004_listeners     # every recorded tag is still pending

run_script

assert_rc_nonzero
assert_out "an interrupted update is on record"
assert_out "the interrupted update changed no schema"

refute_call "fetch origin main"                   # no new commit is read while one is unsettled
refute_call "docker compose -p loom build"
refute_call "up -d --no-build loom"

assert_call "docker start $T_CONTAINER"           # the recorded image id IS this container's
assert_order "docker start $T_CONTAINER" "$T_LOCAL_URL"

assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state
