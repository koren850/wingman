#!/usr/bin/env bash
# Rebuild all Wingman logo files: SVGs -> PNGs -> Wingman.icns (Mac) + wingman.ico (Windows).
set -euo pipefail
cd "$(dirname "$0")"
python3 build.py "$@"
../stage0/node_modules/.bin/electron render.cjs

# Mac .icns
rm -rf Wingman.iconset && mkdir Wingman.iconset
for n in 16 32 128 256 512; do
  cp "png/mac/icon-$n.png" "Wingman.iconset/icon_${n}x${n}.png"
  cp "png/mac/icon-$((n * 2)).png" "Wingman.iconset/icon_${n}x${n}@2x.png"
done
iconutil -c icns Wingman.iconset -o Wingman.icns
rm -rf Wingman.iconset

# Windows .ico (PNG entries)
python3 - <<'EOF'
import struct
sizes = [16, 24, 32, 48, 64, 128, 256]
data = [open(f"png/icon-{n}.png", "rb").read() for n in sizes]
head = struct.pack("<HHH", 0, 1, len(sizes))
off = 6 + 16 * len(sizes)
dirs = b""
for n, d in zip(sizes, data):
    dirs += struct.pack("<BBBBHHII", n % 256, n % 256, 0, 0, 1, 32, len(d), off)
    off += len(d)
open("wingman.ico", "wb").write(head + dirs + b"".join(data))
EOF
echo "done: brand/svg, brand/png, brand/Wingman.icns, brand/wingman.ico"
