"""
Generates the 509 Electric app icon and splash source PNGs from the brand logo.

Inputs:
- assets/logo-source.png  the canonical 509 Electric mark (orange circle + white bolt, RGBA)

Outputs (consumed by @capacitor/assets):
- assets/icon.png    1024x1024  RGB (no alpha), solid orange fill, white bolt centered.
                     Apple applies the rounded-corner mask, so we ship a full square.
- assets/splash.png  2732x2732  RGB navy canvas with the icon centered at ~30%.
                     @capacitor/assets crops to each device aspect ratio, so the
                     centered logo always lands in the safe area.

Run this whenever the logo changes. Both PNGs ship in the repo so CI doesn't re-render.
"""
import os
from PIL import Image

ASSETS_DIR = os.path.dirname(__file__)
SRC = os.path.join(ASSETS_DIR, "logo-source.png")
ICON_OUT = os.path.join(ASSETS_DIR, "icon.png")
SPLASH_OUT = os.path.join(ASSETS_DIR, "splash.png")

ICON_SIZE = 1024
SPLASH_SIZE = 2732
SPLASH_BG = (15, 23, 42)        # #0f172a — matches capacitor.config.json splash backgroundColor

# Sampled from logo-source.png: the dominant opaque color of the circle.
# Hardcoded so the result is deterministic even if the source is edited.
BRAND_ORANGE = (221, 66, 42)    # #dd422a

# -------------------------- Icon --------------------------
# The source logo is "inverted": only the orange ring and the orange wedges
# inside the bolt are opaque; the bolt itself and the disk behind it are
# transparent (so the favicon shows the page background through them).
#
# To produce a solid app icon we rebuild the layers:
#   1. Start with an orange canvas (so the four corners of the square are orange).
#   2. Paint a white disk inscribed in the square (so the bolt area is white).
#   3. Paste the source logo on top — its orange parts cover the disk where
#      the ring lives; the transparent bolt lets the white disk show through.
# iOS then masks the whole thing into a squircle.
from PIL import ImageDraw

logo = Image.open(SRC).convert("RGBA")
bbox = logo.getbbox()
if bbox:
    logo = logo.crop(bbox)
logo = logo.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)

icon = Image.new("RGB", (ICON_SIZE, ICON_SIZE), BRAND_ORANGE)
disk_draw = ImageDraw.Draw(icon)
disk_draw.ellipse((0, 0, ICON_SIZE - 1, ICON_SIZE - 1), fill=(255, 255, 255))
icon.paste(logo, (0, 0), logo)  # alpha mask = logo's own alpha
icon.save(ICON_OUT, "PNG", optimize=True)
print(f"Wrote {ICON_OUT}: {os.path.getsize(ICON_OUT)} bytes")

# -------------------------- Splash --------------------------
# 2732x2732 navy canvas with the 1024 icon centered at 30% scale.
splash = Image.new("RGB", (SPLASH_SIZE, SPLASH_SIZE), SPLASH_BG)
logo_size = int(SPLASH_SIZE * 0.30)
logo_for_splash = icon.resize((logo_size, logo_size), Image.LANCZOS)
splash.paste(
    logo_for_splash,
    ((SPLASH_SIZE - logo_size) // 2, (SPLASH_SIZE - logo_size) // 2),
)
splash.save(SPLASH_OUT, "PNG", optimize=True)
print(f"Wrote {SPLASH_OUT}: {os.path.getsize(SPLASH_OUT)} bytes")
