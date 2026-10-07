#!/usr/bin/env python3
"""Original neutral Aigora artwork, MIT, gopuda11.
No upstream image, font, provider logo or external renderer is used.
Run with Python 3; --root can reproduce the assets in an empty review directory.
"""
from pathlib import Path
import argparse, math, struct, zlib

PNG_SIZES = {
    "lib/public/apple-touch-icon.png": 180,
    "lib/public/favicon-banded.png": 64,
    "lib/public/icon-192.png": 192,
    "lib/public/icon-512.png": 512,
    "lib/public/icon-banded-76.png": 76,
    "lib/public/icon-maskable-192.png": 192,
    "lib/public/icon-maskable-512.png": 512,
    "media/logo/aigora-icon-256.png": 256,
}
SEGMENTS = [(30, 72, 50, 27), (50, 27, 70, 72), (38, 54, 62, 54)]

def distance(x, y, segment):
    ax, ay, bx, by = segment
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)

def chunk(kind, data):
    return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))

def png(size):
    rows = bytearray()
    background, foreground = (32, 55, 77), (246, 249, 252)
    for y in range(size):
        rows.append(0)
        for x in range(size):
            coverage = sum(min(distance((x + sx) * 100 / size, (y + sy) * 100 / size, seg) for seg in SEGMENTS) <= 4
                           for sy in (.25, .75) for sx in (.25, .75))
            rows.extend((b * (4 - coverage) + f * coverage) // 4 for b, f in zip(background, foreground))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")

def svg(mono=False):
    color = "#000" if mono else "#f6f9fc"
    bg = "" if mono else '<rect width="100" height="100" rx="18" fill="#20374d"/>'
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Aigora">' + bg +
            '<path d="M30 72 L50 27 L70 72 M38 54 L62 54" fill="none" stroke="' + color +
            '" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>\n')

def generate(root):
    def write(name, data):
        dest = root / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data if isinstance(data, bytes) else data.encode())
    for name, size in PNG_SIZES.items():
        write(name, png(size))
    data = png(64)
    write("lib/public/favicon.ico", struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 64, 64, 0, 0, 1, 32, len(data), 22) + data)
    write("media/logo/aigora-icon.svg", svg())
    write("lib/public/icon-mono.svg", svg(True))
    for vendor, letter, color in [("claude", "C", "#435b72"), ("codex", "X", "#526579")]:
        write("lib/public/avatar-" + vendor + ".svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="' + color + '"/><text x="32" y="32" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="32" font-weight="600" fill="#fff">' + letter + '</text></svg>\n')

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    generate(parser.parse_args().root)
