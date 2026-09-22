# Case 17: the record cannot be written, so nothing may be believed.
# record_failed_message is printed, NOTHING is started, and the run exits non-zero. The deploy
# directory is made unwritable at the moment the target container is created, which is the only
# point at which the intent record has already been written and the deployment record has not.

mkdir -p "$HARNESS/wprobe"
chmod 500 "$HARNESS/wprobe"
if touch "$HARNESS/wprobe/x" 2>/dev/null; then
  chmod 700 "$HARNESS/wprobe"
  skip "this platform does not honour a read-only directory (Git Bash on Windows), so a failing record_deployed cannot be staged; the case runs on the server and on any Linux checkout"
fi
chmod 700 "$HARNESS/wprobe"

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending

answer_docker() {
  case " $* " in
    *" up -d --no-build loom "*)      chmod 500 "$DEPLOY"; return 0 ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
    *"{{.Image}}"*)                   printf '%s\n' "$T_PREV_IMAGE" ;;
    *"{{.State.Running}}"*)           printf 'true\n' ;;
    *"{{.State.Health.Status}}"*)     printf 'healthy\n' ;;
    *"{{.State.Status}}"*)            printf 'exited\n' ;;
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
chmod 700 "$DEPLOY"

assert_rc_nonzero
assert_out "MANUAL RECOVERY REQUIRED"
assert_out "could NOT be written"
refute_call "docker start"
refute_call "docker tag"
refute_call "--project-directory"
assert_record .deployed-sha "$T_PREV_SHA"         # still the previous commit, as the message says
