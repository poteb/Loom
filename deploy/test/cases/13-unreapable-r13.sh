# Case 13: the migrator container is not proven stopped, so nothing may be believed.
# An assertion about calls that must be ABSENT: no status read after the failure, no `up`
# anywhere, no removal of the unproven container, and manual_recovery is printed.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending 0003_threads

answer_timeout() {
  case " $* " in
    *"--kill-after=30 600 "*) return 124 ;;
    *)                        return 0 ;;
  esac
}

answer_docker() {
  case " $* " in
    *" inspect loom-migrate-run "*)   printf '[{"Id":"deadbeef"}]\n' ;;
    *"{{.State.Status}}"*)            printf 'running\n' ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *"{{.State.Running}}"*)           printf 'true\n' ;;
    *"{{.State.Health.Status}}"*)     printf 'healthy\n' ;;
    *".Mounts"*)                      printf 'loom_pgdata \n' ;;
    *" volume inspect loom_pgdata "*) printf '[{}]\n' ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *pkill*)                          return 0 ;;
    *pgrep*)                          printf 'DUMP_GONE\n' ;;
    *pg_dump*)                        printf -- '-- a fake pg_dump\n' ;;
    *"--check"*)                      cat "$HARNESS/check-output" ;;
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "is NOT proven stopped"
assert_out "MANUAL RECOVERY REQUIRED"

# No status is read after the migrator failed. The pre-quiesce read of banner 6 is the only one
# in the file, and it necessarily precedes the failure, so the assertion is scoped to after it.
refute_call_after "--kill-after=30 600 " "--check"
refute_call_after "docker inspect --format {{.State.Status}} loom-migrate-run"                   "docker rm -f loom-migrate-run"
refute_call "up -d --no-build loom"
refute_call "docker start $T_CONTAINER"

assert_record .deployed-sha "$T_PREV_SHA"
assert_record_exists .update-state
