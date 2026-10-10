# Frames a phone screenshot for the README: rounded screen, dark bezel, grey hairline, transparent corners,
# so it reads as a device on light and dark pages. Usage: python3 test/ui/frame.py <shot.png> <out.webp> (Pillow).
import sys
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
W = 500                      # screen width in output px
B, R, S = 14, 62, 4          # bezel, outer radius, supersample
shot = Image.open(src).convert("RGB")
H = round(shot.height * W / shot.width)
shot = shot.resize((W, H), Image.LANCZOS)
ow, oh = W + 2 * B, H + 2 * B
def rr(size, box, r, fill):
    m = Image.new("L", (size[0] * S, size[1] * S), 0)
    ImageDraw.Draw(m).rounded_rectangle([v * S for v in box], r * S, fill=fill)
    return m.resize(size, Image.LANCZOS)
img = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))
img.paste((110, 118, 129, 255), mask=rr((ow, oh), (0, 0, ow - 1, oh - 1), R, 255))          # hairline
img.paste((16, 18, 22, 255), mask=rr((ow, oh), (2, 2, ow - 3, oh - 3), R - 2, 255))        # bezel
screen = Image.new("RGBA", (ow, oh), (0, 0, 0, 0)); screen.paste(shot, (B, B))
img.paste(screen, mask=rr((ow, oh), (B, B, B + W - 1, B + H - 1), R - B, 255))
img.save(out, "WEBP", quality=88, method=6)
