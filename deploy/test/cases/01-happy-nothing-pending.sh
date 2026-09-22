# Case 01: the happy path with nothing pending.
# build, --check, the intent record, stop, dump, NO migrator call, up -d --no-build loom, one
# curl, .deployed-sha = the target, .update-state gone, the Caddy reload skipped by cmp, the
# public probe, .verified-sha = the target, exit 0.

seed_record .deployed-sha "$T_PREV_SHA"
cp "$DEPLOY/loom.caddy" "$SITES/loom.caddy"      # identical, so cmp skips the reload
set_check_pending                                 # nothing pending

run_script

assert_rc 0
assert_out "TEST MODE:"

assert_call "docker compose -p loom build"
assert_call "node dist/migrate.js --check"
assert_call "docker compose -p loom stop loom"
assert_call "docker compose -p loom exec -T postgres pg_dump -U loom loom"
assert_call "docker compose -p loom up -d --no-build loom"

refute_call "--name loom-migrate-run"             # nothing pending: no migrator at all

assert_order "docker compose -p loom build" "node dist/migrate.js --check"
assert_order "node dist/migrate.js --check" "docker compose -p loom stop loom"
assert_order "docker compose -p loom stop loom" "pg_dump -U loom loom"
assert_order "pg_dump -U loom loom" "up -d --no-build loom"

# one curl for the loopback probe and one for the public probe, and no retry of either
CURLS="$(grep -c '^curl ' "$CALLS")"
assert_equal "$CURLS" 2 "the number of curl calls"
assert_call "curl -fsS --connect-timeout 5 --max-time 20 $T_LOCAL_URL"
assert_call "curl -fsS --connect-timeout 5 --max-time 20 $T_PUBLIC_URL"
assert_order "up -d --no-build loom" "$T_LOCAL_URL"
assert_order "$T_LOCAL_URL" "$T_PUBLIC_URL"

refute_call "caddy reload"                        # the site block did not change
assert_same "$DEPLOY/loom.caddy" "$SITES/loom.caddy"

assert_record .deployed-sha "$T_TARGET_SHA"
assert_record .verified-sha "$T_TARGET_SHA"
assert_record .deployed-image "$T_PREV_IMAGE"
assert_record_absent .update-state
