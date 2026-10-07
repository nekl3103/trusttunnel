#!/bin/sh
. "$(dirname "$0")/lib.sh"

root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$TT_TEST_TMP/bin" "$TT_TEST_TMP/out"
stub="$TT_TEST_TMP/functions.sh"
cat > "$stub" <<'EOF'
config_load() { :; }
config_foreach() { cb=$1; type=$2; case "$type" in server) "$cb" srv_a; "$cb" srv_b;; group) "$cb" grp_video;; esac; }
config_get_bool() { eval "$1=${4:-1}"; }
config_get() {
	var=$1; sec=$2; opt=$3; def=${4:-}; val=$def
	case "$sec.$opt" in grp_video.strategy) val=${TT_TEST_STRATEGY:-auto};; grp_video.server) val=${TT_TEST_FIXED:-};; srv_a.priority|srv_b.priority) val=0;; main.switch_threshold) val=15;; main.switch_cooldown) val=120;; esac
	eval "$var=\$val"
}
config_list_foreach() { sec=$1; opt=$2; cb=$3; [ "$sec.$opt" = grp_video.pool ] && { "$cb" srv_a; "$cb" srv_b; }; }
EOF
cat > "$TT_TEST_TMP/bin/tcping" <<'EOF'
#!/bin/sh
case "$*" in *a.example*) echo 'response time=50.0 ms';; *) echo 'response time=20.0 ms';; esac
EOF
cat > "$TT_TEST_TMP/bin/nft" <<EOF
#!/bin/sh
echo "\$*" >> "$TT_TEST_TMP/nft.log"
[ "\$1" = -f ] && cat "\$2" >> "$TT_TEST_TMP/nft.log"
EOF
chmod +x "$TT_TEST_TMP/bin/tcping" "$TT_TEST_TMP/bin/nft"
printf 'srv_a\tttm1\t0x9601\t901\ta.example\t443\t0\n' > "$TT_TEST_TMP/out/servers.tsv"
printf 'srv_b\tttm2\t0x9602\t902\tb.example\t443\t0\n' >> "$TT_TEST_TMP/out/servers.tsv"

PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select

selection=$(cat "$TT_TEST_TMP/out/selection.tsv")
assert_contains "$selection" "$(printf 'grp_video\tsrv_b\t')" "automatic group chooses the lowest latency server"
assert_contains "$(cat "$TT_TEST_TMP/nft.log")" 'meta mark set 0x9602' "selected server mark is applied atomically"

# A small latency fluctuation must not switch back during the cooldown window.
cat > "$TT_TEST_TMP/bin/tcping" <<'EOF'
#!/bin/sh
case "$*" in *a.example*) echo 'response time=10.0 ms';; *) echo 'response time=20.0 ms';; esac
EOF
chmod +x "$TT_TEST_TMP/bin/tcping"
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select
assert_contains "$(cat "$TT_TEST_TMP/out/selection.tsv")" "$(printf 'grp_video\tsrv_b\t')" "cooldown prevents server flapping"

# A failed probe immediately excludes the server despite cooldown.
cat > "$TT_TEST_TMP/bin/tcping" <<'EOF'
#!/bin/sh
case "$*" in *a.example*) echo 'response time=40.0 ms';; *) exit 1;; esac
EOF
chmod +x "$TT_TEST_TMP/bin/tcping"
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select
assert_contains "$(cat "$TT_TEST_TMP/out/selection.tsv")" "$(printf 'grp_video\tsrv_a\t')" "single probe failure immediately switches the current server"
assert_contains "$(cat "$TT_TEST_TMP/out/health.tsv")" "$(printf 'srv_b\tdown\t')" "failed server is marked unavailable immediately"
for attempt in 2 3; do
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select
done
assert_contains "$(cat "$TT_TEST_TMP/out/selection.tsv")" "$(printf 'grp_video\tsrv_a\t')" "three failed probes trigger failover despite cooldown"

# With no healthy server the group must drop traffic instead of leaking direct.
cat > "$TT_TEST_TMP/bin/tcping" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$TT_TEST_TMP/bin/tcping"
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select
for attempt in 2 3; do
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select
done
assert_contains "$(cat "$TT_TEST_TMP/out/selection.tsv")" "$(printf 'grp_video\t-\t')" "group records unavailable state"
assert_contains "$(cat "$TT_TEST_TMP/nft.log")" 'add rule inet trusttunnel_multi r_grp_video drop' "unavailable group fails closed"

PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" override grp_video srv_a 1800
assert_contains "$(cat "$TT_TEST_TMP/out/selection.tsv")" "$(printf 'grp_video\t-\t')" "temporary choice cannot use an unavailable server"
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 TT_TEST_STRATEGY=manual TT_TEST_FIXED=srv_b \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select
assert_contains "$(cat "$TT_TEST_TMP/out/selection.tsv")" "$(printf 'grp_video\t-\t')" "manual selection cannot use an unavailable server"
assert_eq '' "$(cat "$TT_TEST_TMP/out/overrides.tsv")" "stale temporary choice is removed"
cat > "$TT_TEST_TMP/bin/tcping" <<'EOF'
#!/bin/sh
echo 'response time=20.0 ms'
EOF
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_MULTI_OUT="$TT_TEST_TMP/out" TT_NFT="$TT_TEST_TMP/bin/nft" TT_REQUIRE_DEVICE=0 TT_TEST_STRATEGY=manual TT_TEST_FIXED=srv_b \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" select
assert_contains "$(cat "$TT_TEST_TMP/out/selection.tsv")" "$(printf 'grp_video\tsrv_b\t')" "manual server becomes available again after recovery"
tt_test_summary
