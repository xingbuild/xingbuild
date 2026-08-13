#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h}"
cd "$ROOT_DIR"
export XBUILD_TASK_ID="${XBUILD_TASK_ID:-elon}"

# The only supported local content-preview launcher. The Node entrypoint owns
# the fixed 4317 lease identity, unknown-occupant guard, and cleanup.
exec node scripts/content-site-preview.mjs "$@"
