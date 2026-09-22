# Case 03: a topology change in deploy/docker-compose.yml is refused.
# exit 1, NO build, NO stop, the checkout not fast-forwarded, no record touched.

seed_record .deployed-sha "$T_PREV_SHA"

answer_git() {
  case " $* " in
    *" diff --no-color "*)
      printf -- '-    image: postgres:17-alpine\n+    image: postgres:18-alpine\n' ;;
    *" symbolic-ref --short HEAD "*)          printf 'main\n' ;;
    *" rev-parse --short HEAD "*)             printf '%s\n' "$T_TARGET_SHA" ;;
    *" rev-parse HEAD "*)                     printf '%s\n' "$T_TARGET_FULL" ;;
    *" rev-parse refs/remotes/origin/main "*) printf '%s\n' "$T_TARGET_FULL" ;;
    *)                                        return 0 ;;
  esac
}

run_script

assert_rc 1
assert_out "database topology changed"
refute_call "docker compose -p loom build"
refute_call "stop loom"
refute_call "merge --ff-only"
assert_record .deployed-sha "$T_PREV_SHA"
assert_record_absent .update-state
assert_record_absent .deployed-image
assert_record_absent .verified-sha
