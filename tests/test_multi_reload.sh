#!/bin/sh
. "$(dirname "$0")/lib.sh"
root=$(cd "$(dirname "$0")/.." && pwd)
manager="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager"
mkdir -p "$TT_TEST_TMP/out" "$TT_TEST_TMP/bin" "$TT_TEST_TMP/sets"
sed -n '/^build_routing() {/,/^}/p' "$manager" > "$TT_TEST_TMP/build.sh"
. "$TT_TEST_TMP/build.sh"
OUTDIR="$TT_TEST_TMP/out" TABLE_NAME=trusttunnel_multi
_groups='youtube chatgpt'
group_set() { printf 'g_%s%s' "$1" "$2"; }
route_chain() { printf 'r_%s' "$1"; }
lan_set() { printf '{ "br-lan" }'; }
config_list_foreach() {
	case "$2" in domain) "$3" "$1.com"; [ "${TT_ADD_DOMAIN:-0}" = 1 ] && [ "$1" = youtube ] && "$3" 'extra.youtube.com';; esac
	return 0
}
emit_domain() { printf 'nftset=/%s/4#inet#%s#%s\n' "$1" "$TABLE_NAME" "$set4" >> "$DNSCONF"; }
resolve_host() { :; }
log() { :; }
nft_check_file() { return 0; }
publish_dnsmasq() { :; }
cat > "$TT_TEST_TMP/bin/nft" <<'NFT'
#!/bin/sh
if [ "$1" = list ]; then
	printf 'table inet trusttunnel_multi {\n'
	for name in endpoints4 endpoints6 g_youtube4 g_youtube6 g_chatgpt4 g_chatgpt6 g_old4 g_old6; do printf '\tset %s {\n\t}\n' "$name"; done
	for name in prerouting r_youtube r_chatgpt r_old; do printf '\tchain %s {\n\t}\n' "$name"; done
	printf '}\n'
	exit 0
fi
[ "${TT_FAIL_APPLY:-0}" = 1 ] && exit 1
cp "$2" "$TT_TEST_TMP/applied.nft"
if grep -q '^delete table ' "$2"; then
	: > "$TT_TEST_TMP/sets/g_youtube4"; : > "$TT_TEST_TMP/sets/g_chatgpt4"
fi
awk '$1=="flush" && $2=="set" { print $5 }' "$2" | while IFS= read -r name; do : > "$TT_TEST_TMP/sets/$name"; done
exit 0
NFT
chmod +x "$TT_TEST_TMP/bin/nft"
NFT="$TT_TEST_TMP/bin/nft"
printf '192.0.2.10\n' > "$TT_TEST_TMP/sets/g_youtube4"
printf '192.0.2.20\n' > "$TT_TEST_TMP/sets/g_chatgpt4"
printf 'nftset=/youtube.com/4#inet#trusttunnel_multi#g_youtube4\nnftset=/chatgpt.com/4#inet#trusttunnel_multi#g_chatgpt4\n' > "$OUTDIR/dnsmasq.conf"
TT_ADD_DOMAIN=1
build_routing
assert_eq '192.0.2.10' "$(cat "$TT_TEST_TMP/sets/g_youtube4")" 'adding a domain preserves YouTube cached addresses'
assert_eq '192.0.2.20' "$(cat "$TT_TEST_TMP/sets/g_chatgpt4")" 'adding a YouTube domain preserves ChatGPT cached addresses'
assert_contains "$(cat "$TT_TEST_TMP/applied.nft")" 'flush chain inet trusttunnel_multi prerouting' 'dispatch rules are replaced in the same transaction'
assert_contains "$(cat "$TT_TEST_TMP/applied.nft")" 'delete chain inet trusttunnel_multi r_old' 'removed group chain is deleted'
assert_contains "$(cat "$TT_TEST_TMP/applied.nft")" 'delete set inet trusttunnel_multi g_old4' 'removed group addresses are deleted'
_groups='youtube chatgpt extra'
build_routing
assert_contains "$(cat "$TT_TEST_TMP/applied.nft")" 'chain r_extra { drop; }' 'new groups fail closed until their server selection is applied'
_groups='youtube chatgpt'
TT_ADD_DOMAIN=0
build_routing
assert_eq '' "$(cat "$TT_TEST_TMP/sets/g_youtube4")" 'removing a domain clears only its group addresses'
assert_eq '192.0.2.20' "$(cat "$TT_TEST_TMP/sets/g_chatgpt4")" 'removing a YouTube domain leaves ChatGPT intact'
TT_ADD_DOMAIN=1
TT_FAIL_APPLY=1; export TT_FAIL_APPLY
before=$(cat "$OUTDIR/dnsmasq.conf")
assert_exit 1 'failed atomic update reports failure' build_routing
assert_eq "$before" "$(cat "$OUTDIR/dnsmasq.conf")" 'failed transaction keeps the published domain mappings'
unset TT_FAIL_APPLY
: > "$OUTDIR/dnsmasq.conf"
build_routing
assert_eq '192.0.2.20' "$(cat "$TT_TEST_TMP/sets/g_chatgpt4")" 'an empty old mapping does not flush new group addresses'
tt_test_summary
