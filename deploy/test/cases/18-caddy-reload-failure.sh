# Case 18: the Caddy reload fails, so the site block that was just installed is put back.
# With a previous file: what is on disk afterwards is byte for byte what was there before the
# run. With no previous file: nothing is on disk afterwards. Either way the run exits non-zero.

seed_record .deployed-sha "$T_PREV_SHA"
set_check_pending
printf 'loom.test {\n  respond "an older site block"\n}\n' > "$SITES/loom.caddy"
cp "$SITES/loom.caddy" "$HARNESS/prev.caddy"

answer_docker() {
  case " $* " in
    *"caddy reload"*)                 printf 'reload failed\n' >&2; return 1 ;;
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

assert_rc_nonzero
assert_call "caddy reload --config /etc/caddy/Caddyfile"
assert_out "the previous site configuration was restored"
assert_same "$SITES/loom.caddy" "$HARNESS/prev.caddy"
[ -e "$SITES/loom.caddy.prev" ] && fail "the .prev copy was left behind"
assert_record_absent .verified-sha                # the public probe is never reached

# the same failure with no previous site block at all: nothing is left on disk
rm -f "$SITES/loom.caddy"
seed_record .deployed-sha "$T_PREV_SHA"
rm -f "$DEPLOY/.verified-sha"

run_script

assert_rc_nonzero
assert_out "the previous site configuration was restored"
[ -e "$SITES/loom.caddy" ] && fail "a site block was left behind where there had been none"
[ -e "$SITES/.loom.caddy.new" ] && fail "the staging copy was left behind"
assert_record_absent .verified-sha
