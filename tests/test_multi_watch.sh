#!/bin/sh
. "$(dirname "$0")/lib.sh"
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$TT_TEST_TMP/bin" "$TT_TEST_TMP/out"
export TT_LIBDIR="$TT_TEST_TMP/bin" TT_MULTI_OUT="$TT_TEST_TMP/out"
printf 'broken\tdown\t999999\n' > "$TT_MULTI_OUT/health.tsv"
printf 'working\tup\t20\n' >> "$TT_MULTI_OUT/health.tsv"
printf 'video\tworking\t0\n' > "$TT_MULTI_OUT/selection.tsv"
printf 'saved-new-server\n' > "$TT_TEST_TMP/config"
printf 'old-server\n' > "$TT_TEST_TMP/last-good.uci"
cat > "$TT_TEST_TMP/bin/multi-manager" <<'EOF'
#!/bin/sh
echo "$1" >> "$TT_TEST_TMP/checks"
EOF
cat > "$TT_TEST_TMP/bin/uci" <<'EOF'
#!/bin/sh
echo overwritten > "$TT_TEST_TMP/config"
EOF
cat > "$TT_TEST_TMP/bin/sleep" <<'EOF'
#!/bin/sh
n=0; [ ! -f "$TT_TEST_TMP/sleeps" ] || n=$(cat "$TT_TEST_TMP/sleeps")
n=$((n + 1)); echo "$n" > "$TT_TEST_TMP/sleeps"
[ "$n" -lt 9 ] || kill -TERM "$PPID"
EOF
chmod +x "$TT_TEST_TMP/bin/"*
# Isolate the legacy rollback paths too: this regression must fail with the
# old watcher even when the test machine has no /etc/trusttunnel directory.
sed -e "s|/etc/trusttunnel/last-good.uci|$TT_TEST_TMP/last-good.uci|g" \
	-e "s|/var/run/trusttunnel-rollback-attempted|$TT_TEST_TMP/rollback-attempted|g" \
	-e "s|/usr/libexec/trusttunnel|$TT_LIBDIR|g" \
	-e "s|/var/etc/trusttunnel/multi|$TT_MULTI_OUT|g" \
	"$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-watch" > "$TT_TEST_TMP/watcher"
PATH="$TT_TEST_TMP/bin:$PATH" sh "$TT_TEST_TMP/watcher" 5 60 2>/dev/null
assert_eq saved-new-server "$(cat "$TT_TEST_TMP/config")" 'unavailable server never replaces saved settings'
assert_eq 8 "$(wc -l < "$TT_TEST_TMP/checks" | tr -d ' ')" 'health checks continue beyond the previous rollback threshold'
tt_test_summary
