# Case 16: a rebuild of the SAME commit, where the container no longer holds the recorded image
# id. The previous deployment is the recorded IMAGE ID and nothing else, so the script must
# reconstruct from PREV_IMAGE rather than run docker start -- which the SHA comparison alone
# would have got wrong while printing that the previous deployment was restored.

seed_record .deployed-sha "$T_TARGET_SHA"         # the record already names the target commit
set_check_pending

answer_docker() {
  case " $* " in
    *"{{.Image}}"*)
      N="$(cat "$HARNESS/img" 2>/dev/null || printf 0)"
      N=$((N + 1))
      printf '%s\n' "$N" > "$HARNESS/img"
      if [ "$N" = 1 ]; then printf '%s\n' "$T_PREV_IMAGE"
      else                  printf '%s\n' "$T_NEW_IMAGE"
      fi ;;
    *"--project-directory"*)          printf 'ok\n' > "$HARNESS/restored"; return 0 ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_TARGET_SHA" ;;
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

answer_curl() {
  [ -f "$HARNESS/restored" ] || return 7
  return 0
}

run_script

assert_rc_nonzero
refute_call "docker start $T_CONTAINER"           # the SHA matches and the image id does NOT
assert_call "docker rm -f $T_CONTAINER"
assert_call "docker tag $T_PREV_IMAGE loom-live:$T_TARGET_SHA"
assert_call "show $T_TARGET_SHA:deploy/docker-compose.yml"
assert_call "--project-directory $DEPLOY"
assert_out "which is NOT the recorded previous image"
assert_out "a new container object"

assert_record .deployed-sha "$T_TARGET_SHA"
assert_record_absent .update-state
