#!/bin/sh
. "$(dirname "$0")/lib.sh"

root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$TT_TEST_TMP/bin" "$TT_TEST_TMP/out" "$TT_TEST_TMP/lists" "$TT_TEST_TMP/dns"
stub="$TT_TEST_TMP/functions.sh"
cat > "$stub" <<'EOF'
config_load() { :; }
config_foreach() {
	cb=$1; type=$2
	case "$type" in server) "$cb" srv_one;; group) "$cb" grp_video;; device) "$cb" dev_phone;; dnsmasq) "$cb" dns;; esac
}
config_get_bool() { config_get "$@"; }
config_get() {
	var=$1; sec=$2; opt=$3; def=${4:-}; val=$def
	case "$sec.$opt" in
		srv_one.hostname) val=vpn.example.com;; srv_one.username) val=alice;; srv_one.password) val=secret;;
		srv_one.protocol) val=http2;; srv_one.priority) val=0;;
		grp_video.strategy) val=auto;; network.lan_devices) val=br-test;; network.mtu) val=1350;;
		main.log_level) val=info;; main.switch_threshold) val=15;; main.switch_cooldown) val=120;;
		main.device_routing) val=${TT_DEVICE_ROUTING:-0};; dev_phone.enabled) val=1;;
		dev_phone.match) val=192.168.1.20;;
		dns.confdir) val=DNSDIR;;
	esac
	case "$val" in DNSDIR) val=$TT_DNS_DIR;; esac
	eval "$var=\$val"
}
config_list_foreach() {
	sec=$1; opt=$2; cb=$3
	case "$sec.$opt" in
		srv_one.address) "$cb" 192.0.2.10:443;;
		grp_video.pool) "$cb" srv_one;;
		grp_video.domain) "$cb" '*.YouTube.com';;
		dev_phone.group) "$cb" grp_video;;
	esac
}
EOF
cat > "$TT_TEST_TMP/bin/ip" <<EOF
#!/bin/sh
echo "\$*" >> "$TT_TEST_TMP/ip.log"
EOF
cat > "$TT_TEST_TMP/bin/nft" <<EOF
#!/bin/sh
echo "\$*" >> "$TT_TEST_TMP/nft.log"
[ "\$1" = -f ] && cat "\$2" >> "$TT_TEST_TMP/nft.log"
EOF
cat > "$TT_TEST_TMP/bin/nslookup" <<'EOF'
#!/bin/sh
printf 'Name: vpn.example.com\nAddress 1: 192.0.2.10\n'
EOF
cat > "$TT_TEST_TMP/bin/dnsmasq" <<'EOF'
#!/bin/sh
echo 'Compile time options: nftset'
EOF
cat > "$TT_TEST_TMP/bin/dns-init" <<EOF
#!/bin/sh
echo "\$*" >> "$TT_TEST_TMP/dns-init.log"
EOF
cat > "$TT_TEST_TMP/bin/client" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$TT_TEST_TMP/bin/"*

PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" \
	TT_LIBDIR="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel" \
	TT_MULTI_OUT="$TT_TEST_TMP/out" TT_LISTS_DIR="$TT_TEST_TMP/lists" \
	TT_IP="$TT_TEST_TMP/bin/ip" TT_NFT="$TT_TEST_TMP/bin/nft" \
	TT_CLIENT="$TT_TEST_TMP/bin/client" TT_DNSMASQ_INIT="$TT_TEST_TMP/bin/dns-init" \
	TT_DNS_DIR="$TT_TEST_TMP/dns" \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" prepare

nft_log=$(cat "$TT_TEST_TMP/nft.log")
assert_contains "$nft_log" 'iifname != { "br-test" } return' "multi routing is limited to configured LAN devices"
assert_contains "$nft_log" 'add rule inet trusttunnel_multi r_grp_video drop' "groups fail closed until a client TUN exists"
assert_contains "$(cat "$TT_TEST_TMP/dns/trusttunnel-multi.conf")" 'nftset=/youtube.com/' "custom domains are normalized"
assert_contains "$(cat "$TT_TEST_TMP/dns-init.log")" 'restart' "dnsmasq restarts when the multi-server mapping changes"
assert_contains "$(cat "$TT_TEST_TMP/out/srv_one/client.toml")" 'hostname = "vpn.example.com"' "per-server client config is generated"

: > "$TT_TEST_TMP/nft.log"
PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" TT_DEVICE_ROUTING=1 \
	TT_LIBDIR="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel" \
	TT_MULTI_OUT="$TT_TEST_TMP/out" TT_LISTS_DIR="$TT_TEST_TMP/lists" \
	TT_IP="$TT_TEST_TMP/bin/ip" TT_NFT="$TT_TEST_TMP/bin/nft" \
	TT_CLIENT="$TT_TEST_TMP/bin/client" TT_DNSMASQ_INIT="$TT_TEST_TMP/bin/dns-init" \
	TT_DNS_DIR="$TT_TEST_TMP/dns" \
	sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" prepare
assert_contains "$(cat "$TT_TEST_TMP/nft.log")" \
	'add rule inet trusttunnel_multi r_grp_video ip saddr 192.168.1.20 drop' \
	"device routing limits the group killswitch to the assigned source"

cat > "$TT_TEST_TMP/bin/dnsmasq" <<'EOF'
#!/bin/sh
echo 'Compile time options: no-nftset'
EOF
chmod +x "$TT_TEST_TMP/bin/dnsmasq"
if PATH="$TT_TEST_TMP/bin:$PATH" TT_FUNCTIONS="$stub" \
		TT_LIBDIR="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel" \
		TT_MULTI_OUT="$TT_TEST_TMP/out" TT_LISTS_DIR="$TT_TEST_TMP/lists" \
		TT_IP="$TT_TEST_TMP/bin/ip" TT_NFT="$TT_TEST_TMP/bin/nft" \
		TT_CLIENT="$TT_TEST_TMP/bin/client" TT_DNSMASQ_INIT="$TT_TEST_TMP/bin/dns-init" \
		TT_DNS_DIR="$TT_TEST_TMP/dns" \
		sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-manager" prepare; then
	_tt_fail "multi preparation rejects dnsmasq without nftset"
else
	_tt_pass "multi preparation rejects dnsmasq without nftset"
fi
assert_contains "$(cat "$TT_TEST_TMP/nft.log")" 'delete table inet trusttunnel_multi' "failed preparation removes its nft table"
if [ ! -e "$TT_TEST_TMP/dns/trusttunnel-multi.conf" ]; then
	_tt_pass "failed preparation removes its dnsmasq file"
else
	_tt_fail "failed preparation removes its dnsmasq file"
fi

tt_test_summary
