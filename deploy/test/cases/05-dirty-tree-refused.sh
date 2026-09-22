# Case 05: a checkout that is not clean is refused.
# exit 1, nothing stopped, and the porcelain output printed so the operator can see what it is.

seed_record .deployed-sha "$T_PREV_SHA"

answer_git() {
  case " $* " in
    *" status --porcelain "*)                 printf ' M src/server/src/main.ts\n' ;;
    *" diff --no-color "*)                    return 0 ;;
    *" symbolic-ref --short HEAD "*)          printf 'main\n' ;;
    *" rev-parse --short HEAD "*)             printf '%s\n' "$T_TARGET_SHA" ;;
    *" rev-parse HEAD "*)                     printf '%s\n' "$T_TARGET_FULL" ;;
    *" rev-parse refs/remotes/origin/main "*) printf '%s\n' "$T_TARGET_FULL" ;;
    *)                                        return 0 ;;
  esac
}

run_script

assert_rc 1
assert_out "the checkout is not clean"
assert_out " M src/server/src/main.ts"
refute_call "docker compose -p loom build"
refute_call "stop loom"
refute_call "merge --ff-only"
assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state
