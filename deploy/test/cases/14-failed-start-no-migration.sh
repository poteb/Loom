# Case 14: the target never answers and no migration ran, so R4 restores the previous deployment
# BY IMAGE ID. The container that is there holds a different image id, so it is removed and the
# previous deployment is reconstructed: the removal, the docker tag of PREV_IMAGE, the git show
# of PREV_SHA deploy/docker-compose.yml, the up through that file, and the probe BEFORE
# .update-state is removed.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending                                 # nothing pending: R4, not R5

answer_docker() {
  case " $* " in
    *"{{.Image}}"*)                   # the first read is banner 3; by the time the recovery asks,
      N="$(cat "$HARNESS/img" 2>/dev/null || printf 0)"
      N=$((N + 1))
      printf '%s\n' "$N" > "$HARNESS/img"
      if [ "$N" = 1 ]; then printf '%s\n' "$T_PREV_IMAGE"
      else                  printf '%s\n' "$T_NEW_IMAGE"    # compose has replaced the container
      fi ;;
    *"--project-directory"*)          printf 'ok\n' > "$HARNESS/restored"; return 0 ;;
    *"{{.Config.Image}}"*)            printf '%s\n' "loom-live:$T_PREV_SHA" ;;
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

answer_curl() {                                   # only the reconstructed container answers
  [ -f "$HARNESS/restored" ] || return 7
  return 0
}

run_script

assert_rc_nonzero
assert_out "the new container never answered"
assert_out "restored the previous deployment"

assert_order "docker rm -f $T_CONTAINER" "docker tag $T_PREV_IMAGE loom-live:$T_PREV_SHA"
assert_order "docker tag $T_PREV_IMAGE loom-live:$T_PREV_SHA" \
             "show $T_PREV_SHA:deploy/docker-compose.yml"
assert_order "show $T_PREV_SHA:deploy/docker-compose.yml" "--project-directory"
assert_call "--project-directory $DEPLOY"
assert_call_after "--project-directory" "$T_LOCAL_URL"

# the probe happened while .update-state was still on disk, and only then was it removed
LAST="$(tail -1 "$HARNESS/state-at-probe" | cut -d' ' -f1)"
assert_equal "$LAST" present ".update-state at the probe that answered"
assert_record_absent .update-state

assert_record .deployed-sha "$T_PREV_SHA"
refute_call "docker start $T_CONTAINER"           # the object is NOT the previous deployment
