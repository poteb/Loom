# Case 24: .deployed-sha names a commit and the previous image id cannot be read.
# With a record to restore to, that read MUST succeed: the run stops BEFORE the build and before
# any stop, .update-state is never written, and the exit code is non-zero. The sibling, where the
# daemon says the container does not exist, refuses with the other message.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending

answer_docker() {
  case " $* " in
    *"{{.Image}}"*)                   printf 'Cannot connect to the Docker daemon\n' >&2
                                      return 1 ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *"--check"*)                      cat "$HARNESS/check-output" ;;
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "inspection unanswered"
refute_call "docker compose -p loom build"
refute_call "stop loom"
refute_call "pg_dump"
refute_call "up -d --no-build loom"
assert_record_absent .update-state
assert_record .deployed-sha "$T_PREV_SHA"

# the sibling: the daemon answers, and what it says is that there is nothing to restore to
answer_docker() {
  case " $* " in
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *"--check"*)                      cat "$HARNESS/check-output" ;;
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "would have nothing to restore to"
refute_call "docker compose -p loom build"
refute_call "stop loom"
refute_call "pg_dump"
refute_call "up -d --no-build loom"
assert_record_absent .update-state
assert_record .deployed-sha "$T_PREV_SHA"
