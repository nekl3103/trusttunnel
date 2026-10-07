#!/bin/sh
. "$(dirname "$0")/lib.sh"
root=$(cd "$(dirname "$0")/.." && pwd)
helper="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/service-action"
export TT_ACTION_STATE="$TT_TEST_TMP/actions" TT_ACTION_INIT="$TT_TEST_TMP/init"
cat > "$TT_ACTION_INIT" <<'EOF'
#!/bin/sh
case "$1" in
running) [ ! -f "$TT_ACTION_STATE/not-running" ];;
start|restart) sleep 2; echo finished;;
update_lists) echo download-failed; exit 7;;
stop) exit 0;;
esac
EOF
chmod +x "$TT_ACTION_INIT"
job=$(sh "$helper" enqueue restart)
assert_exit 0 'worker is alive after enqueue returns' kill -0 "$(cat "$TT_ACTION_STATE/$job/pid")"
assert_exit 1 'second request cannot start a concurrent action' sh "$helper" enqueue stop
await_job() {
	i=0
	while [ ! -f "$TT_ACTION_STATE/$1/result" ] || [ -d "$TT_ACTION_STATE/lock" ]; do
		i=$((i + 1)); [ "$i" -lt 10 ] || return 1
		sleep 1
	done
}
await_job "$job"
assert_eq 0 "$(cat "$TT_ACTION_STATE/$job/result")" 'detached operation completes successfully'
assert_contains "$(cat "$TT_ACTION_STATE/$job/output")" finished 'operation output is retained'
touch "$TT_ACTION_STATE/not-running"
job=$(sh "$helper" enqueue start)
await_job "$job"
assert_eq 1 "$(cat "$TT_ACTION_STATE/$job/result")" 'silent init start failure is reported'
assert_exit 0 'failed start is distinguished from command failure' test -f "$TT_ACTION_STATE/$job/not-running"
job=$(sh "$helper" enqueue update_lists)
await_job "$job"
assert_eq 7 "$(cat "$TT_ACTION_STATE/$job/result")" 'download error is propagated'
assert_contains "$(cat "$TT_ACTION_STATE/$job/output")" download-failed 'download error is available to UI'
tt_test_summary
