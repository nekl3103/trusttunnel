#!/bin/sh
. "$(dirname "$0")/lib.sh"

root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$TT_TEST_TMP/state" "$TT_TEST_TMP/lists" "$TT_TEST_TMP/bin"
cat > "$TT_TEST_TMP/state/geosite.dat_plain.yml" <<'EOF'
items:
  - name: "video"
    length: 4
    rules:
      - "domain:youtube.com"
      - "full:api.example.com:@test"
      - "regexp:^ignored"
      - "cidr:203.0.113.0/24"
EOF
cat > "$TT_TEST_TMP/bin/uci" <<'EOF'
#!/bin/sh
echo "trusttunnel.g=group"
echo "trusttunnel.g.source='Geosite/video.lst'"
EOF
chmod +x "$TT_TEST_TMP/bin/uci"

PATH="$TT_TEST_TMP/bin:$PATH" TT_STATE_DIR="$TT_TEST_TMP/state" TT_LISTS_DIR="$TT_TEST_TMP/lists" \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/geosite-sync" sync

assert_contains "$(cat "$TT_TEST_TMP/lists/Geosite/video.lst")" 'youtube.com' 'geosite extracts domain rules'
assert_contains "$(cat "$TT_TEST_TMP/lists/Geosite/video.cidr")" '203.0.113.0/24' 'geosite extracts network rules'
assert_contains "$(cat "$TT_TEST_TMP/lists/Geosite/video.meta")" 'ignored=1' 'geosite reports unsupported regex rules'
catalog=$(TT_STATE_DIR="$TT_TEST_TMP/state" sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/geosite-sync" catalog)
assert_contains "$catalog" "$(printf 'video\t4\t3\t1')" 'catalog reports source and usable rule counts'
assert_exit 0 'parsed catalog is cached for subsequent page loads' test -s "$TT_TEST_TMP/state/geosite.catalog.tsv"
printf 'video\t9\t8\t1\n' > "$TT_TEST_TMP/state/geosite.catalog.tsv"
catalog=$(TT_STATE_DIR="$TT_TEST_TMP/state" sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/geosite-sync" catalog)
assert_contains "$catalog" "$(printf 'video\t9\t8\t1')" 'unchanged source uses the parsed catalog cache'
touch -t 200001010000 "$TT_TEST_TMP/state/geosite.catalog.tsv"
catalog=$(TT_STATE_DIR="$TT_TEST_TMP/state" sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/geosite-sync" catalog)
assert_contains "$catalog" "$(printf 'video\t4\t3\t1')" 'newer source rebuilds the parsed catalog cache'

tt_test_summary
