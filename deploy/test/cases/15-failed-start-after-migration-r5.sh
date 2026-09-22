# Case 15: the migration committed and the new image will not serve, so R5 refuses to start the
# previous image against the moved schema.
# .deployed-sha = the target, LOOM IS DOWN printed, NO docker start and NO docker tag, and
# .update-state is left for the next run to reconcile.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending 0003_threads

answer_curl() { return 7; }                       # the target never answers

run_script

assert_rc_nonzero
assert_call "--name loom-migrate-run migrate"
assert_call "up -d --no-build loom"
assert_out "LOOM IS DOWN"

refute_call "docker start"
refute_call "docker tag"
refute_call "--project-directory"

assert_record .deployed-sha "$T_TARGET_SHA"       # the schema is the target schema
assert_record_exists .update-state
assert_record_absent .verified-sha
