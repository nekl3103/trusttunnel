#!/bin/sh
. "$(dirname "$0")/lib.sh"

root=$(cd "$(dirname "$0")/.." && pwd)
stub="$TT_TEST_TMP/functions.sh"
cat > "$stub" <<'EOF'
config_load() { :; }
config_get() {
	var=$1; sec=$2; opt=$3; def=${4:-}; val=$def
	case "$sec.$opt" in
		srv.hostname) val=vpn.example.com;; srv.username) val=alice;; srv.password) val=secret;;
		srv.protocol) val=http2;; srv.certificate) val='PEM DATA';; main.log_level) val=info;; network.mtu) val=1340;;
	esac
	eval "$var=\$val"
}
config_get_bool() { config_get "$@"; }
config_list_foreach() {
	sec=$1; opt=$2; cb=$3
	case "$sec.$opt" in srv.address) "$cb" 192.0.2.1:443; "$cb" 192.0.2.2:443;; esac
}
EOF

out=$(TT_FUNCTIONS="$stub" sh "$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/multi-gen-config" srv)
assert_eq "0" "$(printf '%s' "$out" | grep -c 'device_name' || true)" "multi config does not emit unsupported device_name"
assert_eq "0" "$(printf '%s' "$out" | grep -c 'use_existing' || true)" "multi config does not emit unsupported use_existing"
assert_contains "$out" 'addresses = ["192.0.2.1:443", "192.0.2.2:443"]' "multi config keeps all server addresses"
assert_contains "$out" 'hostname = "vpn.example.com"' "multi config exports endpoint"
assert_contains "$out" "certificate = '''" "multi config exports pinned certificate"

tt_test_summary
