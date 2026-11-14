#!/usr/bin/env bash
# Stage the host Cargo git database so the Docker build can resolve private
# BitRouter / ACI git dependencies without network credentials. crates.io
# packages are still fetched during the image build.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${CARGO_HOME:-$HOME/.cargo}/git"
DST="deploy/market/.build-cargo/git"
rm -rf deploy/market/.build-cargo
mkdir -p "$DST/db" "$DST/checkouts"
for name in bitrouter-cloud-a1bb7e49695c832e private-ai-gateway-1b9904dbbbe04c38 bitrouter-bfe06b1654b7caed; do
  if [ -e "$SRC/db/$name" ]; then
    cp -a "$SRC/db/$name" "$DST/db/"
  fi
  if [ -d "$SRC/checkouts/$name" ]; then
    # Dereference symlinks: Docker Desktop rejects some symlink entries in the
    # build context ("invalid file request").
    cp -aL "$SRC/checkouts/$name" "$DST/checkouts/"
  fi
done
# Keep directory even if a name is missing so Docker COPY succeeds.
touch "$DST/.staged"
echo "staged cargo git deps into $DST"
