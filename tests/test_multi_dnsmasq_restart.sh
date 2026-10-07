#!/bin/sh
. "$(dirname "$0")/lib.sh"
root=$(cd "$(dirname "$0")/.." && pwd)
manager="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager"
mkdir -p "$TT_TEST_TMP/out" "$TT_TEST_TMP/dns" "$TT_TEST_TMP/bin"
printf 'config_load() { :; }\n' > "$TT_TEST_TMP/functions.sh"
cat > "$TT_TEST_TMP/bin/dnsmasq" <<'STUB'
#!/bin/sh
echo 'Compile time options: nftset'
STUB
cat > "$TT_TEST_TMP/bin/dns-init" <<'STUB'
#!/bin/sh
echo restart >> "$TT_TEST_TMP/restarts"
[ ! -f "$TT_TEST_TMP/fail" ]
STUB
chmod +x "$TT_TEST_TMP/bin/"*
PATH="$TT_TEST_TMP/bin:$PATH"
TT_FUNCTIONS="$TT_TEST_TMP/functions.sh"
TT_MULTI_OUT="$TT_TEST_TMP/out"
TT_DNSMASQ_INIT="$TT_TEST_TMP/bin/dns-init"
TT_IP=true; TT_NFT=true
export PATH TT_FUNCTIONS TT_MULTI_OUT TT_DNSMASQ_INIT TT_IP TT_NFT
sed '/^cmd=${1:-status}/,$d' "$manager" > "$TT_TEST_TMP/manager.sh"
# shellcheck disable=SC1090
. "$TT_TEST_TMP/manager.sh"
set +e
dnsmasq_confdir() { printf '%s' "$TT_TEST_TMP/dns"; }
printf 'nftset=/youtube.com/4#inet#trusttunnel_multi#g_youtube4\n' > "$OUTDIR/dnsmasq.conf"
publish_dnsmasq
assert_eq 1 "$(wc -l < "$TT_TEST_TMP/restarts" | tr -d ' ')" 'first publication restarts DNS'
publish_dnsmasq
assert_eq 1 "$(wc -l < "$TT_TEST_TMP/restarts" | tr -d ' ')" 'unchanged running mappings preserve DNS cache'
down
assert_eq no "$(test -f "$OUTDIR/dnsmasq.loaded" && echo yes || echo no)" 'stop invalidates loaded mappings'
assert_eq no "$(test -f "$TT_TEST_TMP/dns/trusttunnel-multi.conf" && echo yes || echo no)" 'stop removes published mappings'
publish_dnsmasq
assert_eq 3 "$(wc -l < "$TT_TEST_TMP/restarts" | tr -d ' ')" 'start reloads identical mappings after stop'
printf 'nftset=/googlevideo.com/4#inet#trusttunnel_multi#g_youtube4\n' >> "$OUTDIR/dnsmasq.conf"
touch "$TT_TEST_TMP/fail"
assert_exit 1 'failed DNS restart reports an error' publish_dnsmasq
assert_eq no "$(test -f "$OUTDIR/dnsmasq.loaded" && echo yes || echo no)" 'failed restart does not record loaded mappings'
rm "$TT_TEST_TMP/fail"
publish_dnsmasq
assert_eq 5 "$(wc -l < "$TT_TEST_TMP/restarts" | tr -d ' ')" 'next publication retries after a failed restart'
assert_eq "$(cat "$OUTDIR/dnsmasq.conf")" "$(cat "$OUTDIR/dnsmasq.loaded")" 'successful restart records current mappings'
tt_test_summary
