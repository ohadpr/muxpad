# mobile.png: the navigator and the link sheet side by side, rounded corners.
from PIL import Image, ImageDraw
D = '/private/tmp/mxd/out'
a = Image.open(f'{D}/mobile-rail.png').convert('RGBA'); b = Image.open(f'{D}/mobile-sheet.png').convert('RGBA')
def rnd(im, r=56):
    m = Image.new('L', im.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, im.width - 1, im.height - 1], r, fill=255)
    o = Image.new('RGBA', im.size, (0, 0, 0, 0)); o.paste(im, (0, 0), m); return o
gap = 60; c = Image.new('RGBA', (a.width + b.width + gap, max(a.height, b.height)), (0, 0, 0, 0))
c.paste(rnd(a), (0, 0)); c.paste(rnd(b), (a.width + gap, 0)); c.save(f'{D}/mobile.png')
