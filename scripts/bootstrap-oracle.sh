#!/usr/bin/env bash
# Install the verified local runtime versions for the personal Oracle VM.
# Run as the SSH user; no sudo, credentials, firewall or service changes.
set -euo pipefail
umask 077

[[ "$(uname -sm)" == 'Linux x86_64' ]] || { echo 'Requires Linux x86_64'; exit 1; }
NODE_VERSION=24.18.0
CODEX_VERSION=0.162.1
NODE_NAME="node-v${NODE_VERSION}-linux-x64"
NODE_ROOT="$HOME/.local/lib/$NODE_NAME"
mkdir -p "$HOME/.local/lib" "$HOME/.local/bin"

if [[ ! -x "$NODE_ROOT/bin/node" ]]; then
  [[ ! -e "$NODE_ROOT" ]] || { echo 'Incomplete Node directory exists; inspect manually.'; exit 1; }
  DOWNLOAD_DIR=$(mktemp -d)
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_NAME}.tar.xz" -o "$DOWNLOAD_DIR/${NODE_NAME}.tar.xz"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$DOWNLOAD_DIR/SHASUMS256.txt"
  (cd "$DOWNLOAD_DIR"; awk -v file="${NODE_NAME}.tar.xz" '$2 == file' SHASUMS256.txt > selected-sha256.txt; test -s selected-sha256.txt; sha256sum --check selected-sha256.txt)
  tar -xJf "$DOWNLOAD_DIR/${NODE_NAME}.tar.xz" -C "$HOME/.local/lib" --no-same-owner
fi

export PATH="$NODE_ROOT/bin:$HOME/.local/bin:$PATH"
[[ "$(node --version)" == "v$NODE_VERSION" ]]
npm install --global --prefix "$HOME/.local" "@openai/codex@$CODEX_VERSION"
node --version
codex --version
echo 'Runtime installed. Authentication and website deployment are separate steps.'
