# Case 19: the public probe fails.
# .verified-sha is NOT written, .deployed-sha IS the target and .update-state is gone: the
# two-record invariant as a case. What was proved on the loopback is recorded; what was not
# proved publicly is not.

seed_record .deployed-sha "$T_PREV_SHA"
cp "$DEPLOY/loom.caddy" "$SITES/loom.caddy"
set_check_pending

answer_curl() {
  case " $* " in
    *"$T_PUBLIC_URL"*) return 7 ;;                # the public address never answers
    *)                 return 0 ;;
  esac
}

run_script

assert_rc_nonzero
assert_out "did not answer within 120s"
assert_call "curl -fsS --connect-timeout 5 --max-time 20 $T_PUBLIC_URL"

assert_record .deployed-sha "$T_TARGET_SHA"
assert_record_absent .verified-sha
assert_record_absent .update-state
