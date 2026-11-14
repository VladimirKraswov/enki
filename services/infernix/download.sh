#!/bin/bash
# Resume the public Infernix artifact with parallel HTTPS and verify every byte.
set -euo pipefail
DIR="${1:-/srv/models/ornith-infernix}"
BASE="https://huggingface.co/wallawalla47/Ornith-1.5-122B-NVFP4-Infernix/resolve/main"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR"
cd "$DIR"
for f in \
  Ornith-1.5-122B-NVFP4-Infernix-00001-of-00003.infernix \
  Ornith-1.5-122B-NVFP4-Infernix-00002-of-00003.infernix \
  Ornith-1.5-122B-NVFP4-Infernix-00003-of-00003.infernix; do
  echo "START $f"
  aria2c -c -x8 -s8 -k4M --file-allocation=none --allow-overwrite=true \
    --auto-file-renaming=false --max-tries=20 --retry-wait=5 \
    --summary-interval=60 --console-log-level=warn -d "$DIR" -o "$f.part" "$BASE/$f"
  mv "$f.part" "$f"
  echo "DONE $f"
done
sha256sum -c "$HERE/artifacts.sha256"
echo "ARTIFACT VERIFIED"
