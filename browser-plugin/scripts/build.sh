#!/bin/bash
# Build: compile src/ → lib/ with locally installed npm dependencies.
# Works without a dsh source checkout: devDependencies (cordis, dsh-tools,
# dsh-shell, typescript) are installed from npm on demand.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# npm 镜像:默认淘宝源(快),可被外部 NPM_REGISTRY 覆盖
REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

echo "=== Ensuring build dependencies (registry: $REGISTRY) ==="
if [ ! -x node_modules/.bin/tsc ]; then
  npm install --registry "$REGISTRY" --no-audit --no-fund
fi

echo "=== Compiling src → lib ==="
./node_modules/.bin/tsc -p tsconfig.json
echo "=== Build complete ==="
