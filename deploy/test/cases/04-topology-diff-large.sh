# Case 04: a topology diff of more than 1.2 MB is still refused.
# The shape that made the `printf ... | grep -Eq` version die of SIGPIPE, report 141 and wave the
# change through: the match is on line 1 and a megabyte of unrelated text follows it.

seed_record .deployed-sha "$T_PREV_SHA"

{ printf -- '-    image: postgres:17-alpine\n'
  head -c 1300000 /dev/zero | tr '\0' 'x'
  printf '\n'
} > "$HARNESS/bigdiff"

SIZE="$(wc -c < "$HARNESS/bigdiff" | tr -d ' ')"
[ "$SIZE" -gt 1200000 ] || fail "the fixture diff is only $SIZE bytes, expected more than 1.2 MB"

answer_git() {
  case " $* " in
    *" diff --no-color "*)                    cat "$HARNESS/bigdiff" ;;
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
assert_record_absent .update-state
