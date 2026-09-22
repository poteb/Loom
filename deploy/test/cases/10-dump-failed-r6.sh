# Case 10: the dump fails outright, so R6 restores the previous deployment.
# restore_prev starts the container whose image id IS PREV_IMAGE, the probe answers, the record
# is unchanged and .update-state is gone.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending 0003_threads

answer_docker() {
  case " $* " in
    *pkill*)                          return 0 ;;
    *pgrep*)                          printf 'DUMP_GONE\n' ;;
    *pg_dump*)                        printf 'pg_dump: error: connection to server failed\n' >&2
                                      return 1 ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *"{{.State.Running}}"*)           printf 'true\n' ;;
    *"{{.State.Health.Status}}"*)     printf 'healthy\n' ;;
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
    *".Mounts"*)                      printf 'loom_pgdata \n' ;;
    *" volume inspect loom_pgdata "*) printf '[{}]\n' ;;
    *" inspect "*)                    printf 'Error: No such object: %s\n' "${*: -1}" >&2
                                      return 1 ;;
    *"--check"*)                      cat "$HARNESS/check-output" ;;
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "backup: pg_dump failed"
refute_call "--name loom-migrate-run"             # the migration never ran
refute_call "up -d --no-build loom"               # and the new image was never created

assert_call "docker start $T_CONTAINER"
assert_order "docker start $T_CONTAINER" "$T_LOCAL_URL"
assert_out "the previous deployment is serving again"

assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state
assert_record_absent .dump-in-progress
