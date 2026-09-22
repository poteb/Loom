# Case 27: a leftover .update-state whose migrator cannot be reaped.
# The interrupted update applying container may still hold an open transaction, so NOTHING below
# it may be believed: no status read, no start, no up, no fetch. The record is left exactly as it
# was. The sibling, where the daemon says the container is absent, runs the ordinary case (a)
# reconciliation -- so the refusal is about the UNPROVEN answer and not about the reap existing.

seed_record .deployed-sha "$T_PREV_SHA"
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads"
set_check_pending 0003_threads

answer_docker() {
  case " $* " in
    *" inspect loom-migrate-run "*)   printf '[{"Id":"deadbeef"}]\n' ;;
    *"{{.State.Status}}"*)            printf 'running\n' ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *"--check"*)                      cat "$HARNESS/check-output" ;;
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "REFUSING TO RECONCILE"
assert_out "loom-migrate-run"

refute_call "--check"
refute_call "docker start"
refute_call "up -d --no-build loom"
refute_call "fetch origin main"
refute_call "docker compose -p loom build"

assert_record_exists .update-state
assert_record .deployed-sha "$T_PREV_SHA"

# the sibling: the daemon says the migrator container is gone, so reconciliation runs
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads"
answer_docker() {
  case " $* " in
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
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
