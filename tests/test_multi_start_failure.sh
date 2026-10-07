#!/bin/sh
. "$(dirname "$0")/lib.sh"
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$TT_TEST_TMP/bin" "$TT_TEST_TMP/out"
printf 'new-server\n' > "$TT_TEST_TMP/config"
printf 'old-server\n' > "$TT_TEST_TMP/last-good.uci"
cat > "$TT_TEST_TMP/bin/multi-manager" <<'EOF'
#!/bin/sh
echo 'invalid new server configuration' >&2
exit 1
EOF
cat > "$TT_TEST_TMP/bin/uci" <<'EOF'
#!/bin/sh
echo overwritten > "$TT_TEST_TMP/config"
EOF
chmod +x "$TT_TEST_TMP/bin/"*
sed -n '/^start_multi_service() {/,/^}/p' "$root/packages/luci-app-trusttunnel/root/etc/init.d/trusttunnel" |
	sed "s|/etc/trusttunnel/last-good.uci|$TT_TEST_TMP/last-good.uci|g" > "$TT_TEST_TMP/start.sh"
. "$TT_TEST_TMP/start.sh"
LIBDIR="$TT_TEST_TMP/bin" OUTDIR="$TT_TEST_TMP/out"
PATH="$TT_TEST_TMP/bin:$PATH"
unlink_dnsmasq() { :; }
config_foreach() { :; }
config_load() { :; }
setup_multi_trust_store() { return 0; }
logger() { :; }
assert_exit 1 'invalid configuration fails startup without a fallback' start_multi_service
assert_eq new-server "$(cat "$TT_TEST_TMP/config")" 'startup failure preserves the saved new servers'
tt_test_summary
