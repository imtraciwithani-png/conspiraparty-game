#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d node_modules/ws ]]; then
  npm install
fi
exec node server.js
