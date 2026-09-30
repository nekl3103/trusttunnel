#!/bin/sh
. "$(dirname "$0")/lib.sh"

root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$TT_TEST_TMP/bin" "$TT_TEST_TMP/net" "$TT_TEST_TMP/out/srv"

cat > "$TT_TEST_TMP/bin/ip" <<EOF
#!/bin/sh
echo "\$*" >> "$TT_TEST_TMP/ip.log"
EOF
cat > "$TT_TEST_TMP/bin/client" <<EOF
#!/bin/sh
mkdir -p "$TT_TEST_TMP/net/tun7"
: > "$TT_TEST_TMP/net/tun7/tun_flags"
sleep 2
EOF
chmod +x "$TT_TEST_TMP/bin/ip" "$TT_TEST_TMP/bin/client"
: > "$TT_TEST_TMP/out/srv/client.toml"

TT_CLIENT="$TT_TEST_TMP/bin/client" TT_IP="$TT_TEST_TMP/bin/ip" \
	TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NETDIR="$TT_TEST_TMP/net" \
	TT_MULTI_LOCK="$TT_TEST_TMP/lock" \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-client" \
	srv 901 "$TT_TEST_TMP/out/srv/client.toml"

log=$(cat "$TT_TEST_TMP/ip.log")
assert_contains "$log" 'route replace default dev tun7 table 901 metric 1' "client TUN is attached to its IPv4 table"
assert_contains "$log" '-6 route replace default dev tun7 table 901 metric 1' "client TUN is attached to its IPv6 table"
assert_contains "$log" 'route replace blackhole default table 901 metric 32767' "route table fails closed after client exits"
if [ ! -e "$TT_TEST_TMP/out/srv/device" ]; then
	_tt_pass "stale device state is removed after exit"
else
	_tt_fail "stale device state is removed after exit"
fi

tt_test_summary
