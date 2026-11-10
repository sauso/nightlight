"""Regenerate the seven public icons from the committed 1024px logo (#943)."""
from pathlib import Path
from PIL import Image

FRONTEND = Path(__file__).resolve().parents[1]
SOURCE = FRONTEND / "branding" / "logo-source.png"
OUTPUT = FRONTEND / "public" / "icons"
NAVY = (20, 20, 42)

with Image.open(SOURCE) as original:
    logo = original.convert("RGB")
    if logo.size != (1024, 1024):
        raise ValueError("logo-source.png must be 1024 × 1024 before regenerating icons")

    for filename, size in [
        ("apple-touch-icon.png", 180),
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("now-playing-512.png", 512),
    ]:
        logo.resize((size, size), Image.Resampling.LANCZOS).save(OUTPUT / filename, optimize=True)

    # favicon-32.png is deliberately NOT generated here any more (owner, 2026-11-10: "the fav icon for the server isn't round
    # like the website, make them the same"). It is a byte-for-byte copy of nightlight-website/assets/favicon.png, a 32px
    # RGBA icon with transparent rounded corners (radius about 8px); this script's old square RGB crop put an opaque navy
    # square in the browser tab. If the logo changes, re-copy it from the website repo; running this script leaves it alone.

    for size in (192, 512):
        canvas = Image.new("RGB", (size, size), NAVY)
        # Entire source sits inside the centre 80%, so launchers may mask the outer edge.
        artwork_size = round(size * 0.8)
        artwork = logo.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
        offset = (size - artwork_size) // 2
        # The supplied square has its own near-black ground. Fade its outer edge into
        # the palette navy so the safe zone does not look like a second square.
        fade = Image.new("L", (artwork_size, artwork_size))
        pixels = fade.load()
        feather = max(1, round(artwork_size * 0.12))
        for y in range(artwork_size):
            for x in range(artwork_size):
                edge = min(x, y, artwork_size - 1 - x, artwork_size - 1 - y)
                pixels[x, y] = min(255, round(255 * edge / feather))
        canvas.paste(artwork, (offset, offset), fade)
        canvas.save(OUTPUT / f"icon-maskable-{size}.png", optimize=True)
