# Case 11: the dump blocks on a lock, so the exit handler restores Loom.
# The deadline handed to `timeout` is asserted, and so is the fact that what it wrapped was the
# WHOLE pipeline. The next docker call is the bounded pkill and the one after it the bounded
# verdict check; the container answers DUMP_GONE, so NO marker is left behind and the run takes
# R6 and serves again.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending 0003_threads

answer_timeout() {
  case " $* " in
    *"--kill-after=15 330 "*) return 124 ;;
    *)                        return 0 ;;
  esac
}

run_script

assert_rc_nonzero

# the deadline is the script own, not this document own, and it bounded the whole pipeline
assert_call "timeout --signal=TERM --kill-after=15 330 bash -c"
DUMPLINE="$(grep -F -- 'timeout --signal=TERM --kill-after=15 330' "$CALLS")"
case "$DUMPLINE" in *pg_dump*) ;; *) fail "the bounded command does not mention pg_dump" ;; esac
case "$DUMPLINE" in *gzip*)    ;; *) fail "the bounded command does not mention gzip" ;; esac

docker_calls_after "--kill-after=15 330" > "$HARNESS/next"
FIRST="$(sed -n 1p "$HARNESS/next")"
SECOND="$(sed -n 2p "$HARNESS/next")"
case "$FIRST" in
  *"exec -T postgres pkill -TERM -f pg_dump"*) ;;
  *) fail "the call after the dump is [$FIRST], expected the pkill" ;;
esac
case "$SECOND" in
  *"exec -T postgres sh -c"*) ;;
  *) fail "the call after the pkill is [$SECOND], expected the verdict check" ;;
esac
case "$SECOND" in *"pgrep -x pg_dump"*) ;; *) fail "the verdict check is not a pgrep -x" ;; esac

assert_call "timeout 60 docker compose -p loom exec -T postgres pkill"
assert_call "timeout 60 docker compose -p loom exec -T postgres sh -c"

assert_out "loom-postgres-1 answered DUMP_GONE"
assert_record_absent .dump-in-progress

assert_call "docker start $T_CONTAINER"
assert_out "the previous deployment is serving again"
refute_call "--name loom-migrate-run"
refute_call "up -d --no-build loom"
assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state
