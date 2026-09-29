# Case 29: a leftover .update-state whose migrator is absent, in Docker 29's lowercase wording.
# Docker 29.6.1 prints "error: no such object: loom-migrate-run", not "Error: No such object:".
# That is still the daemon ITSELF saying the container is gone, so the ordinary case (a)
# reconciliation runs, exactly as in case 27's sibling. Before the fix the lowercase message was
# read as an unanswered question and the rerun refused forever (live, 2026-09-29).

seed_record .deployed-sha "$T_PREV_SHA"
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads"
set_check_pending 0003_threads

answer_docker() {
  case " $* " in
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
    *" inspect "*)                    printf 'error: no such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *"--check"*)                      cat "$HARNESS/check-output" ;;
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
refute_out "REFUSING TO RECONCILE"
assert_call "--check"
assert_call "docker start $T_CONTAINER"
assert_out "the interrupted update changed no schema"
assert_record_absent .update-state
assert_record .deployed-sha "$T_PREV_SHA"
