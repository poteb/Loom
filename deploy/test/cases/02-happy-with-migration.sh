# Case 02: the happy path with a migration.
# Everything case 01 asserts, plus the migrator call, .deployed-sha written BEFORE the up, and
# the dump taken between the stop and the migrator.

seed_record .deployed-sha "$T_PREV_SHA"
cp "$DEPLOY/loom.caddy" "$SITES/loom.caddy"
set_check_pending 0003_threads 0004_listeners

run_script

assert_rc 0
assert_out "pending: 0003_threads 0004_listeners"

assert_call "docker compose -p loom run --rm -T --name loom-migrate-run migrate"
assert_call "docker compose -p loom up -d --no-build loom"

# the dump is taken between the stop and the migrator, and the migrator before the up
assert_order "docker compose -p loom stop loom" "pg_dump -U loom loom"
assert_order "pg_dump -U loom loom" "--name loom-migrate-run migrate"
assert_order "--name loom-migrate-run migrate" "up -d --no-build loom"

# the record is written before the target's container is created, which no call list can show
assert_sha_at_up 1 "$T_TARGET_SHA"

assert_record .deployed-sha "$T_TARGET_SHA"
assert_record .verified-sha "$T_TARGET_SHA"
assert_record_absent .update-state
