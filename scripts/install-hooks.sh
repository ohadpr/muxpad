#!/bin/sh
# Point this checkout's hooks at scripts/hooks (tracked, reviewable, shared).
# Idempotent; run it once per clone.
set -e
cd "$(dirname "$0")/.."
git config core.hooksPath scripts/hooks
echo "hooks → scripts/hooks ($(ls scripts/hooks | tr '\n' ' '))"
