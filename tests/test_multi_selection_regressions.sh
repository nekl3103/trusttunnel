#!/bin/sh
. "$(dirname "$0")/lib.sh"
root=$(cd "$(dirname "$0")/.." && pwd)
manager="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager"
mkdir -p "$TT_TEST_TMP/out"
cat > "$TT_TEST_TMP/functions.sh" <<'STUB'
config_get() {
	cfg_var=$1; cfg_value=${4:-}
	case "$3" in
		strategy) cfg_value=$TEST_STRATEGY;;
		server) cfg_value=${TEST_FIXED:-};;
		metric) cfg_value=$TEST_METRIC;;
		primary) cfg_value=srv_a;;
		switch_threshold) cfg_value=15;;
		switch_cooldown) cfg_value=120;;
	esac
	eval "$cfg_var=\$cfg_value"
}
config_list_foreach() { for member in $TEST_POOL; do "$3" "$member"; done; }
STUB
# Load the production functions without dispatching a command or touching networking.
sed '/^cmd=${1:-status}/,$d' "$manager" > "$TT_TEST_TMP/functions-manager.sh"
TT_FUNCTIONS="$TT_TEST_TMP/functions.sh"
TT_MULTI_OUT="$TT_TEST_TMP/out"
export TT_FUNCTIONS TT_MULTI_OUT
# shellcheck disable=SC1090
. "$TT_TEST_TMP/functions-manager.sh"
_servers='srv_a srv_b'
TEST_STRATEGY=auto; TEST_METRIC=latency; TEST_POOL='srv_a srv_b'
export TEST_STRATEGY TEST_METRIC TEST_POOL
printf 'srv_a\ttun0\t0x9601\t901\ta.example\t443\t0\nsrv_b\ttun1\t0x9602\t902\tb.example\t443\t0\n' > "$OUTDIR/servers.tsv"
write_health() {
	printf 'srv_a\tup\t20\t0\t0\t20\t0\t0\t100000\t%s\nsrv_b\tup\t50\t0\t0\t50\t0\t0\t200000\t99\n' "$1" > "$HEALTH"
}
select_current() { printf 'group\tsrv_a\t%s\n' "$1" > "$SELECTION"; }
selected() { choose_server group | cut -f1; }
select_current 1
write_health 80
TEST_METRIC=reliability
assert_eq srv_b "$(selected)" 'reliability switches from 80 percent to 99 percent despite lower current latency'
TEST_METRIC=speed
assert_eq srv_b "$(selected)" 'speed switches to the faster server despite lower current latency'
TEST_METRIC=latency
write_health 100
assert_eq srv_a "$(selected)" 'an eligible faster current server remains selected'
TEST_POOL=srv_b
select_current "$(date +%s)"
assert_eq srv_b "$(selected)" 'removing the current server from the pool bypasses cooldown'
TEST_POOL='srv_a srv_b'
printf 'group\tsrv_a\tfail\t0\t%s\tprobe\t3\t500\n' "$(date +%s)" > "$GROUP_HEALTH"
assert_eq srv_b "$(selected)" 'three site failures bypass stability and cooldown'
TEST_STRATEGY=priority
assert_eq srv_b "$(selected)" 'a primary server with repeated site failures is excluded'
rm "$GROUP_HEALTH"
TEST_POOL=srv_b
assert_eq srv_b "$(selected)" 'a primary server outside the pool is excluded'
TEST_STRATEGY=auto; TEST_POOL='srv_a srv_b'
# An expired site result must not exclude a healthy server indefinitely.
printf 'group\tsrv_a\tfail\t0\t%s\tprobe\t3\t500\n' "$(($(date +%s) - 901))" > "$GROUP_HEALTH"
assert_eq srv_a "$(selected)" 'expired site failures allow the server again'
printf 'group\tsrv_a\tfail\t0\t%s\tprobe\t3\t500\ngroup\tsrv_b\tfail\t0\t%s\tprobe\t3\t500\n' "$(date +%s)" "$(date +%s)" > "$GROUP_HEALTH"
assert_eq '' "$(selected)" 'no eligible server leaves the group unavailable'
rm "$GROUP_HEALTH"
TEST_STRATEGY=manual; TEST_FIXED=srv_a; TEST_POOL=srv_b
write_health 100
assert_eq srv_a "$(selected)" 'healthy pinned server works independently of the automatic pool'
printf 'srv_a\tdown\t999999\t100\t0\t999999\t1\n' > "$HEALTH"
assert_eq '' "$(selected)" 'unavailable pinned server is excluded'
write_health 100
_servers=srv_b
assert_eq '' "$(selected)" 'deleted server is excluded even with stale health and routing records'
_servers='srv_a srv_b'; TEST_STRATEGY=auto; TEST_POOL='srv_a srv_b'
printf 'group\tsrv_a\t0\t%s\n' "$(route_signature group | sha256sum | awk '{print $1}')" > "$OVERRIDES"
printf 'srv_a\tdown\t999999\t100\t0\t999999\t1\n' > "$HEALTH"
assert_eq '' "$(selected)" 'temporary override cannot select an unavailable server'
write_health 100
assert_eq srv_a "$(selected)" 'temporary override recovers only when its server is healthy'
tt_test_summary
