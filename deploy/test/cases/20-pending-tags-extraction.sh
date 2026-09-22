# Case 20: the pending_tags pipeline, over an empty and a non-empty --check output.
# The case does not run the script: it reads the real pending_tags out of the real file and runs
# it, because the rule under test is that an EMPTY pending set is not a failure -- a grep in that
# pipeline would exit 1 and, under pipefail and errexit, kill the run one line later.

eval "$(sed -n '/^pending_tags()/,/^}/p' "$SCRIPT_SOURCE")"

printf 'migrations: 3 applied\npending:\n  0004_listeners\n  0003_threads\n' > "$HARNESS/nonempty"
GOT="$(pending_tags "$HARNESS/nonempty")"
RC_TAGS=$?
assert_equal "$RC_TAGS" 0 "the exit status over a non-empty pending set"
assert_equal "$GOT" "$(printf '0003_threads\n0004_listeners')" "the extracted tags, sorted"

printf 'migrations: 5 applied\npending:\n' > "$HARNESS/empty"
GOT="$(pending_tags "$HARNESS/empty")"
RC_TAGS=$?
assert_equal "$RC_TAGS" 0 "the exit status over an empty pending set"
assert_equal "$GOT" "" "the extracted tags over an empty pending set"

printf 'migrations: 5 applied\n' > "$HARNESS/noheader"
GOT="$(pending_tags "$HARNESS/noheader")"
RC_TAGS=$?
assert_equal "$RC_TAGS" 0 "the exit status over an output with no pending section at all"
assert_equal "$GOT" "" "the extracted tags over an output with no pending section at all"
