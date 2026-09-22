# Case 09: a leftover .update-state, reconciliation case (c) -- it cannot be told what happened.
# manual_recovery printed, the record left in place, nothing started. Both shapes of (c): a
# status read that fails, and a partial apply.

seed_record .deployed-sha "$T_PREV_SHA"
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads 0004_listeners"

answer_docker() {
  case " $* " in
    *"--check"*)                      printf 'could not connect to the database\n' >&2; return 1 ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "MANUAL RECOVERY REQUIRED"
refute_call "docker start $T_CONTAINER"
refute_call "up -d --no-build loom"
assert_record_exists .update-state
assert_record .deployed-sha "$T_PREV_SHA"

# the other shape of (c): one recorded tag is gone and one is still pending
seed_update_state "$T_PREV_SHA" "$T_PREV_IMAGE" "$T_TARGET_SHA" "0003_threads 0004_listeners"
set_check_pending 0004_listeners
unset -f answer_docker
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
assert_out "PARTIALLY applied"
assert_out "MANUAL RECOVERY REQUIRED"
refute_call "docker start $T_CONTAINER"
refute_call "up -d --no-build loom"
assert_record_exists .update-state
assert_record .deployed-sha "$T_PREV_SHA"
