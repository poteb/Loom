# Case 12: the migrator does not finish, its container is reaped, and the status read that
# follows decides R10 or R11. The reap calls appear in order: inspect, stop, wait, logs,
# inspect, rm.

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
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
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

run_script                                        # R10: the transaction rolled back

assert_rc_nonzero
assert_out "the migrator did not finish within 600s"

assert_order "docker rm -f loom-migrate-run" "--kill-after=30 600"
assert_order "--kill-after=30 600" "docker inspect loom-migrate-run"
assert_order "docker inspect loom-migrate-run" "docker stop -t 10 loom-migrate-run"
assert_order "docker stop -t 10 loom-migrate-run" "docker wait loom-migrate-run"
assert_order "docker wait loom-migrate-run" "docker logs --tail 50 loom-migrate-run"
assert_order "docker logs --tail 50 loom-migrate-run" \
             "docker inspect --format {{.State.Status}} loom-migrate-run"
docker_calls_after "docker inspect --format {{.State.Status}} loom-migrate-run" \
  > "$HARNESS/next"                               # the removal is the call after the proven exit,
AFTER_STATUS="$(sed -n 1p "$HARNESS/next")"       # and it is NOT the pre-run rm of the same name
case "$AFTER_STATUS" in
  "docker rm -f loom-migrate-run") ;;
  *) fail "the call after the proven exit is [$AFTER_STATUS], expected the removal" ;;
esac
refute_call "docker kill loom-migrate-run"        # the stop reported success, so no kill

assert_out "migration rolled back"
assert_call "docker start $T_CONTAINER"
assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state

# the same failure, with the status read afterwards saying every pending tag is now applied: R11
printf '0\n' > "$HARNESS/checks"
answer_docker() {
  case " $* " in
    *"--check"*)
      N="$(cat "$HARNESS/checks")"
      N=$((N + 1))
      printf '%s\n' "$N" > "$HARNESS/checks"
      if [ "$N" = 1 ]; then cat "$HARNESS/check-output"
      else                  printf 'migrations: 6 applied\npending:\n'
      fi ;;
    *" inspect loom-migrate-run "*)   printf '[{"Id":"deadbeef"}]\n' ;;
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
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
    *)                                return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "the migrator failed but every pending migration is applied"
assert_call "up -d --no-build loom"
assert_sha_at_up 1 "$T_TARGET_SHA"
assert_record .deployed-sha "$T_TARGET_SHA"
assert_record_absent .update-state
refute_call "docker start $T_CONTAINER"
