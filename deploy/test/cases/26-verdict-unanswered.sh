# Case 26: a verdict check that is not ANSWERED writes the marker, and keeps it.
# Three shapes of non-answer, each asserted twice. Writing: the dump times out and the check does
# not answer, so the marker exists anyway and the run takes R6. Keeping: the same answer on a run
# that starts with the marker present refuses everything and leaves it. The three shapes are a
# transport failure (exit 1, empty stdout, a line on stderr -- what a Compose or daemon failure
# looks like, and what a gate reading an exit status mistakes for nothing matched), an exit 0
# with empty stdout, and an exit 0 with a token that is not an answer: it ran and said something
# else is as much a non-answer as it never ran.
#
# Each shape takes two runs, so out.1 and out.2 are the first shape, out.3 and out.4 the second.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending 0003_threads
STDERR_TEXT="Error response from daemon: container loom-postgres-1 is not running"
printf '%s\n' "$STDERR_TEXT" > "$HARNESS/stderr-text"

answer_timeout() {
  case " $* " in
    *"--kill-after=15 330 "*) return 124 ;;
    *)                        return 0 ;;
  esac
}

answer_docker() {
  case " $* " in
    *pkill*)                          return 0 ;;
    *pgrep*)
      case "$(cat "$HARNESS/shape")" in
        transport-failure)            cat "$HARNESS/stderr-text" >&2; return 1 ;;
        empty-stdout)                 return 0 ;;
        *)                            printf 'DUMP_NO_PGREP\n' ;;
      esac ;;
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

for SHAPE in transport-failure empty-stdout unrecognised-stdout; do
  printf '%s\n' "$SHAPE" > "$HARNESS/shape"
  rm -f "$DEPLOY/.dump-in-progress"
  seed_record .deployed-sha "$T_PREV_SHA"

  run_script                                      # writing

  assert_rc_nonzero
  assert_out "NOT proven gone"
  assert_record_exists .dump-in-progress
  assert_call "docker start $T_CONTAINER"
  assert_out "the previous deployment is serving again"
  assert_record_absent .update-state
  if [ "$SHAPE" = transport-failure ]; then assert_out "$STDERR_TEXT"; fi

  run_script                                      # keeping

  assert_rc_nonzero
  assert_out "REFUSING TO RUN"
  assert_out "was NOT answered"
  assert_record_exists .dump-in-progress
  refute_call "fetch origin main"
  refute_call "pg_dump -U loom loom"
  refute_call "--name loom-migrate-run"
  refute_call "docker compose -p loom build"
  if [ "$SHAPE" = transport-failure ]; then assert_out "$STDERR_TEXT"; fi
done
