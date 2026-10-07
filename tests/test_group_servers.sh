#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
	echo '  SKIP: node is unavailable (run the group lifecycle test on the development host)'
	exit 0
fi
node tests/test_group_servers.js
