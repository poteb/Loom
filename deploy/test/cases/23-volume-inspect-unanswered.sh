# Case 23: the volume inspection is not answered, so the run stops and restores.
# An unanswered question is not an absent volume: $CALLS contains NO pg_dump, NO migrator run and
# NO up; the run took R6 and restored the previous deployment; and the words first deployment
# appear NOWHERE in the output, which is the wrong turn an exit status read as an answer takes.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending 0003_threads

answer_timeout() {
  case " $* " in
    *" volume inspect loom_pgdata "*) return 124 ;;   # the daemon never answered, and said nothing
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "inspection unanswered"
refute_out "first deployment"

refute_call "pg_dump"
refute_call "--name loom-migrate-run"
refute_call "up -d --no-build loom"

assert_call "docker start $T_CONTAINER"
assert_out "the previous deployment is serving again"
assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state
