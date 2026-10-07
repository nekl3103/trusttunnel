#!/bin/sh
. "$(dirname "$0")/lib.sh"
root=$(cd "$(dirname "$0")/.." && pwd)
manager="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager"
mkdir -p "$TT_TEST_TMP/out/srv" "$TT_TEST_TMP/bin"
sed -n '/^check_group_target() {/,/^}/p' "$manager" > "$TT_TEST_TMP/check.sh"
. "$TT_TEST_TMP/check.sh"
OUTDIR="$TT_TEST_TMP/out" GROUP_HEALTH="$OUTDIR/group-health.tsv"
printf tun0 > "$OUTDIR/srv/device"
config_get() { eval "$1=https://example.com/check"; }
cat > "$TT_TEST_TMP/bin/curl" <<'CURL'
#!/bin/sh
printf '%s 0.25' "$TT_HTTP_CODE"
exit "${TT_CURL_EXIT:-0}"
CURL
chmod +x "$TT_TEST_TMP/bin/curl"
PATH="$TT_TEST_TMP/bin:$PATH"
export TT_HTTP_CODE TT_CURL_EXIT
for code in 200 302 401 403 429 500; do
	TT_HTTP_CODE=$code; TT_CURL_EXIT=0
	printf 'grp\tsrv\tfail\t0\t0\thttps://example.com/check\t4\n' > "$GROUP_HEALTH"
	check_group_target grp srv 2000
	state=$(cut -f3 "$GROUP_HEALTH"); failures=$(cut -f7 "$GROUP_HEALTH")
	case "$code" in
	200|302) assert_eq ok "$state" "HTTP $code confirms site response";;
	401|403|429)
		assert_eq restricted "$state" "HTTP $code is an access restriction, not a broken tunnel"
		assert_eq 0 "$failures" "HTTP $code resets false transport failures";;
	500) assert_eq fail "$state" 'HTTP 500 remains a service failure';;
	esac
	assert_eq "$code" "$(cut -f8 "$GROUP_HEALTH")" "HTTP $code is recorded for diagnostics"
done
TT_HTTP_CODE=000; TT_CURL_EXIT=28
printf 'grp\tsrv\tfail\t0\t0\thttps://example.com/check\t2\n' > "$GROUP_HEALTH"
check_group_target grp srv 2000
assert_eq fail "$(cut -f3 "$GROUP_HEALTH")" 'connection timeout remains a failure'
assert_eq 3 "$(cut -f7 "$GROUP_HEALTH")" 'consecutive connection failures still accumulate'
tt_test_summary
