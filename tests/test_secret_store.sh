#!/bin/sh
. "$(dirname "$0")/lib.sh"

root=$(cd "$(dirname "$0")/.." && pwd)
store="$root/packages/luci-app-trusttunnel/root/usr/libexec/trusttunnel/secret-store"
dir="$TT_TEST_TMP/secrets"
printf 'very-secret' | TT_SECRET_DIR="$dir" sh "$store" set server_one
assert_contains "$(TT_SECRET_DIR="$dir" sh "$store" get server_one)" 'very-secret' 'password round-trips through secret store'
mode=$(stat -f '%Lp' "$dir/server_one.password" 2>/dev/null || stat -c '%a' "$dir/server_one.password")
assert_contains "$mode" '600' 'stored password is owner-only'
if printf x | TT_SECRET_DIR="$dir" sh "$store" set '../escape' >/dev/null 2>&1; then
	_tt_fail 'secret store rejects unsafe section names'
else
	_tt_pass 'secret store rejects unsafe section names'
fi

tt_test_summary
