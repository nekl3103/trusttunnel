#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
uc=${UCODE:-ucode}
if ! command -v "$uc" >/dev/null 2>&1; then
	echo '  SKIP: ucode is unavailable (run this test on OpenWrt or with UCODE set)'
	exit 0
fi
TT_TEST_TMP=${TT_TEST_TMP:-$(mktemp -d)}
adapter="$TT_TEST_TMP/deeplink.uc"
sed -n '/^\/\/ BEGIN deep-link compatibility adapter$/,/^\/\/ END deep-link compatibility adapter$/p' \
	packages/luci-app-trusttunnel/root/usr/share/rpcd/ucode/luci.trusttunnel > "$adapter"
cat >> "$adapter" <<'UCODE'
function check(ok, name) {
	if (!ok) { warn('FAIL: ' + name + '\n'); exit(1); }
	print('  ok: ' + name + '\n');
}
function link(payload) {
	return 'tt://?' + replace(replace(replace(b64enc(payload), /\+/g, '-'), /\//g, '_'), /=+$/, '');
}
function field(tag, value) {
	let size = length(value);
	return chr(tag) + (size < 64 ? chr(size) : chr(64 | (size >> 8), size & 255)) + value;
}
let prefix = '4824c364b084996800a406e6b5663921/4aeeebfff9cffffe0eac07e7ffe6fb29';
let settings = field(1, 'cloud.secflow.ru') + field(2, 'cloud.secflow.ru:443') +
	field(5, 'test-user') + field(6, 'test-password') + field(11, prefix) +
	field(13, chr(13) + 'tls://1.1.1.1');
let v1 = link(chr(0, 1, 1) + settings), v2 = link(chr(0, 1, 2) + settings);
check(wizard_deeplink(v1).link == v1, 'v1 stays unchanged');
check(wizard_deeplink(v2).link == v1, 'v2 preserves all static fields including a 65-byte masked TLS random');
check(wizard_deeplink('TT://' + substr(v2, 5)).link == v1, 'scheme is case insensitive');
check(wizard_deeplink(link(chr(0, 1, 3) + settings)).error != null, 'future versions are rejected');
check(wizard_deeplink(link(chr(0, 1, 2) + settings + field(14, 'https://example.com/sub'))).error != null, 'subscriptions are not silently downgraded');
check(wizard_deeplink(link(chr(0, 1, 2) + field(14, 'https://example.com/sub'))).error != null, 'subscription-only links give an error');
check(wizard_deeplink(link(chr(0, 1, 2) + settings + chr(2, 63))).error != null, 'truncated fields are rejected');
check(wizard_deeplink(link(chr(0, 1, 2) + settings + field(11, 'aabb/ff'))).error != null, 'unequal prefix and mask lengths are rejected');
check(wizard_deeplink('tt://?not valid!').error != null, 'invalid base64 is rejected');
print('PASS: deep-link import compatibility\n');
UCODE
"$uc" "$adapter"
