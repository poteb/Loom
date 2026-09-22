# Case 25: a dump that is not proven gone writes .dump-in-progress, and the marker SURVIVES the
# restore that removes the intent record. Three runs.
#   1. the dump times out and the container answers DUMP_RUNNING: the pkill then the verdict
#      check, the marker on disk, R6 taken and Loom serving -- and .update-state gone while the
#      marker is still there, which is the invariant a single record could not hold.
#   2. the same answer on the next run: REFUSING TO RUN, and nothing at all is read or touched.
#   3. the container answers DUMP_GONE: the marker is cleared and the run deploys normally.

seed_record .deployed-sha "$T_PREV_SHA"
cp "$DEPLOY/loom.caddy" "$SITES/loom.caddy"
set_check_pending 0003_threads
printf 'RUNNING\n' > "$HARNESS/verdict"
printf '1\n' > "$HARNESS/dumpfail"

answer_timeout() {
  case " $* " in
    *"--kill-after=15 330 "*)
      if [ "$(cat "$HARNESS/dumpfail")" = 1 ]; then return 124; fi
      return 0 ;;
    *) return 0 ;;
  esac
}

answer_docker() {
  case " $* " in
    *pkill*)                          return 0 ;;
    *pgrep*)                          printf 'DUMP_%s\n' "$(cat "$HARNESS/verdict")" ;;
    *pg_dump*)                        printf -- '-- a fake pg_dump\n' ;;
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

run_script                                        # 1. the dump blocked and is still running

assert_rc_nonzero
assert_order "exec -T postgres pkill -TERM -f pg_dump" "exec -T postgres sh -c"
assert_out "STILL RUNNING"
assert_record_exists .dump-in-progress
assert_record_absent .update-state                # the intent is settled, the hazard is not
assert_call "docker start $T_CONTAINER"
assert_out "the previous deployment is serving again"
assert_record .deployed-sha "$T_PREV_SHA"

run_script                                        # 2. the next run refuses everything

assert_rc_nonzero
assert_out "REFUSING TO RUN"
refute_call "fetch origin main"
refute_call "pg_dump -U loom loom"
refute_call "--name loom-migrate-run"
refute_call "docker compose -p loom build"
assert_record_exists .dump-in-progress
assert_record .deployed-sha "$T_PREV_SHA"

printf 'GONE\n' > "$HARNESS/verdict"              # 3. the container itself says it is gone now
printf '0\n' > "$HARNESS/dumpfail"

run_script

assert_rc 0
assert_out "is cleared and this run continues"
assert_record_absent .dump-in-progress
assert_call "pg_dump -U loom loom"
assert_call "up -d --no-build loom"
assert_record .deployed-sha "$T_TARGET_SHA"
assert_record .verified-sha "$T_TARGET_SHA"
assert_record_absent .update-state
