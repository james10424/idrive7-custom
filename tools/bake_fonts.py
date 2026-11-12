#!/usr/bin/env python3
"""Bake the HUD's bitmap font atlases from the Barlow TTFs in tools/fonts-src/.

    UV_CACHE_DIR=... uv run --no-project --with pillow python tools/bake_fonts.py [app_id ...]

Runs on the Mac only (needs Pillow). The car never rasterizes fonts: it blits
these pre-drawn glyphs (shared/hud_text.js). Each app has its own set (FONTS below); output per
font, in apps/<app_id>/hud/fonts/<name>.json: the metrics plus the atlas as
one alpha byte per pixel (coverage), base64 in "alpha". JSON because the kit's
build packs the app's data folders into hud.pack, which holds JSON only, and
because then the car needs no PNG decoder. Barlow is SIL OFL 1.1; the licence
ships in each app's NOTICE.

Metrics: every glyph cell is the same height, from the highest ink to the lowest
ink across the font's glyph set, so a widget's y is the top of its tallest
character. `ox` shifts a cell from the pen position (ink overhang), `advance`
moves the pen. Digits get one shared advance (tabular), so a changing number
doesn't shift sideways.
"""
import base64, json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'fonts-src')
APPS = os.path.join(HERE, '..', 'apps')

UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
DIGITS = '0123456789'
LOWER = 'abcdefghijklmnopqrstuvwxyz'
# Custom HUD, fitted to the part of the 800x480 HUD the driver can see (485x278 from the Nov 5 2026 grid
# photo): hero 140 -> 96, big 42 -> 34, mid 30 -> 24; label and small stay, BMW's own "mph" is that size.
HUD_FONTS = [
    # name, file, px size, characters
    ('hero', 'BarlowSemiCondensed-SemiBold.ttf', 96, DIGITS + 'PRND-'),
    ('big', 'BarlowSemiCondensed-Medium.ttf', 34, DIGITS + ':.-° PRND'),
    ('mid', 'BarlowSemiCondensed-Medium.ttf', 24, DIGITS + ':.-° ' + UPPER),
    ('label', 'Barlow-Medium.ttf', 15, UPPER + DIGITS + '/.:-°%>· '),
    ('small', 'Barlow-Medium.ttf', 13, UPPER + DIGITS + '/.:-°%>· '),
]
# Custom Cluster, 1920x720 LCD. GT3: the race-dash look, Barlow Condensed.
CLUSTER_FONTS = [
    ('unit', 'BarlowCondensed-SemiBold.ttf', 34, UPPER + DIGITS + '/°%>·.: -'),
    ('head', 'BarlowCondensed-SemiBold.ttf', 24, UPPER + DIGITS + '/°%>·.: -'),
    # Sport: BMW Live Cockpit style, the wide numbers in Michroma like BMW's own
    ('s_scale', 'Michroma-Regular.ttf', 27, DIGITS, 1),
    ('s_speed', 'Michroma-Regular.ttf', 74, DIGITS + '-', 3),
    ('s_gear', 'Michroma-Regular.ttf', 70, DIGITS + 'PRNDSM-', 3),
    ('s_val', 'Michroma-Regular.ttf', 26, DIGITS + ':+-.', 1),
    ('s_unit', 'Barlow-Medium.ttf', 24, LOWER + UPPER + DIGITS + '°/-. '),
    ('s_gl', 'Michroma-Regular.ttf', 21, DIGITS + '/', 1),
    # Grand National (1987 Buick Grand National dash): tall condensed white numbers, small print, and the orange VFD's seven segments
    ('r_num', 'BarlowCondensed-SemiBold.ttf', 50, DIGITS),
    ('r_gl', 'BarlowCondensed-SemiBold.ttf', 34, DIGITS + 'EF'),
    ('r_ef', 'BarlowCondensed-SemiBold.ttf', 27, 'EF'),   # the fuel gauge's E and F, 80% of r_gl
    ('r_lbl', 'Barlow-Medium.ttf', 21, UPPER + DIGITS + ' ./°-'),
    ('r_tiny', 'Barlow-Medium.ttf', 16, UPPER + ' .'),
    ('r_vfd', 'BarlowSemiCondensed-SemiBold.ttf', 25, UPPER + DIGITS + ' '),
    ('r_seg', 'SEG', 44, DIGITS + '- '),
    ('r_seg_m', 'SEG', 32, DIGITS + '-: '),
    ('r_seg_s', 'SEG', 21, DIGITS + '-. '),
]
FONTS = {'custom_hud': HUD_FONTS, 'custom_cluster': CLUSTER_FONTS}
PAD = 2
ATLAS_W = 1024


# seven-segment digits (a VFD's): segment a..g as [x0, y0, x1, y1] lines in a 0..1 x 0..2 cell, before slant
SEG_LINES = {'a': (0, 0, 1, 0), 'b': (1, 0, 1, 1), 'c': (1, 1, 1, 2), 'd': (0, 2, 1, 2), 'e': (0, 1, 0, 2), 'f': (0, 0, 0, 1), 'g': (0, 1, 1, 1)}
SEG_ON = {'0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg',
          '9': 'abcdfg', '-': 'g'}


def seg_glyph(c, H):
    """One glyph drawn at 4x and scaled down: hexagonal segments with small gaps, slanted like a VFD's."""
    K = 4
    t = 0.14 * H * K               # segment thickness
    W = 0.5 * H * K                # digit width (segment centre lines)
    slant = 0.07
    m = t * 0.75                   # margin round the centre lines
    gap = 0.035 * H * K
    img = Image.new('L', (int(W + 2 * m + slant * H * K) + 2, int(H * K) + 2), 0)
    d = ImageDraw.Draw(img)
    unit = (H * K - t) / 2         # half the height between the top and bottom centre lines
    def P(x, y):                   # cell coords (x 0..1 across, y 0..2 down) -> px, slanted
        px, py = m + x * W, t / 2 + y * unit
        return (px + slant * (H * K - py), py)
    if c in SEG_ON:
        for sname in SEG_ON[c]:
            x0, y0, x1, y1 = SEG_LINES[sname]
            a, b = P(x0, y0), P(x1, y1)
            vx, vy = b[0] - a[0], b[1] - a[1]
            L = (vx * vx + vy * vy) ** 0.5
            ux, uy = vx / L, vy / L
            nx, ny = -uy * t / 2, ux * t / 2
            a = (a[0] + ux * gap, a[1] + uy * gap); b = (b[0] - ux * gap, b[1] - uy * gap)
            tip = t / 2
            d.polygon([a, (a[0] + ux * tip + nx, a[1] + uy * tip + ny), (b[0] - ux * tip + nx, b[1] - uy * tip + ny), b,
                       (b[0] - ux * tip - nx, b[1] - uy * tip - ny), (a[0] + ux * tip - nx, a[1] + uy * tip - ny)], fill=255)
    elif c == ':':
        img = Image.new('L', (int(t * 2.2), int(H * K) + 2), 0)
        d = ImageDraw.Draw(img)
        for yy in (0.32, 0.72):
            cx, cy = t * 1.1 + slant * H * K * (1 - yy) * 0.5, yy * H * K
            d.rectangle([cx - t / 2, cy - t / 2, cx + t / 2, cy + t / 2], fill=255)
    elif c == '.':
        img = Image.new('L', (int(t * 1.6), int(H * K) + 2), 0)
        d = ImageDraw.Draw(img)
        d.rectangle([t * 0.3, H * K - t, t * 1.3, H * K], fill=255)
    return img.resize((max(1, img.width // K), max(1, img.height // K)), Image.LANCZOS)


def bake_seg(out, name, H, chars):
    """Like bake(), for the seven-segment VFD digits (no font file): every digit the same cell, tabular."""
    height = H + 2 * PAD
    imgs = {c: seg_glyph(c, H) for c in chars if c != ' '}
    tab = imgs['8'].width + round(0.16 * H)
    cells = []
    for c in chars:
        if c == ' ':
            cells.append((c, None, 0, tab))
            continue
        g = imgs[c]
        img = Image.new('L', (g.width + 2 * PAD, height), 0)
        img.paste(g, (PAD, PAD))
        adv = tab if c in DIGITS or c == '-' else g.width + round(0.1 * H)
        cells.append((c, img, -PAD, adv))
    x = y = 0
    placed = {}
    for c, img, ox, adv in cells:
        if img is None:
            continue
        if x + img.width > ATLAS_W:
            x, y = 0, y + height
        placed[c] = (x, y)
        x += img.width
    atlas = Image.new('L', (ATLAS_W, y + height), 0)
    glyphs = {}
    for c, img, ox, adv in cells:
        if img is None:
            glyphs[c] = {'x': 0, 'y': 0, 'w': 0, 'h': 0, 'ox': 0, 'advance': adv}
            continue
        gx, gy = placed[c]
        atlas.paste(img, (gx, gy))
        glyphs[c] = {'x': gx, 'y': gy, 'w': img.width, 'h': img.height, 'ox': ox, 'advance': adv}
    meta = {'source': 'seven segments', 'size': H, 'cellHeight': height, 'baseline': PAD + H, 'glyphs': glyphs,
            'width': ATLAS_W, 'height': atlas.height, 'alpha': base64.b64encode(atlas.tobytes()).decode('ascii')}
    with open(os.path.join(out, name + '.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'), ensure_ascii=False)
    print('%-6s %3dpx  seven segments  %d glyphs' % (name, H, len(glyphs)))


def bake(out, name, file, size, chars, stroke=0, weight=None, subs=None):
    if file == 'SEG':
        return bake_seg(out, name, size, chars)
    """stroke: px of extra weight round every glyph (Michroma has one weight). weight: a named instance of a
    variable font (Orbitron: Regular .. Black), for the M theme's squared BMW-style gear, speed and numbers.
    subs: {char: glyph drawn for it} (Orbitron's zero is slashed; the M8's is plain, so its O stands in)."""
    font = ImageFont.truetype(os.path.join(SRC, file), size)
    if weight: font.set_variation_by_name(weight)
    subs = subs or {}
    glyph = lambda c: subs.get(c, c)
    ink = [c for c in chars if c != ' ']
    boxes = {c: font.getbbox(glyph(c), anchor='ls', stroke_width=stroke) for c in ink}
    top = min(b[1] for b in boxes.values())
    bottom = max(b[3] for b in boxes.values())
    height = bottom - top + 2 * PAD
    tab = (max(font.getlength(glyph(d)) for d in DIGITS if d in chars) + 2 * stroke) if any(d in chars for d in DIGITS) else 0

    cells = []
    for c in chars:
        adv = font.getlength(glyph(c)) + (2 * stroke if c != ' ' else 0)
        if c == ' ':
            cells.append((c, None, 0, round(adv if adv else size * 0.25)))
            continue
        l, _, r, _ = boxes[c]
        w = r - l + 2 * PAD
        img = Image.new('L', (w, height), 0)
        ImageDraw.Draw(img).text((PAD - l, PAD - top), glyph(c), font=font, fill=255, anchor='ls', stroke_width=stroke, stroke_fill=255)
        shift = (tab - adv) / 2 if c in DIGITS else 0
        cells.append((c, img, round(l - PAD + shift), round(tab if c in DIGITS else adv)))

    # simple row packing
    x = y = 0
    placed = {}
    for c, img, ox, adv in cells:
        if img is None:
            continue
        if x + img.width > ATLAS_W:
            x, y = 0, y + height
        placed[c] = (x, y)
        x += img.width
    atlas_h = y + height
    atlas = Image.new('L', (ATLAS_W, atlas_h), 0)
    glyphs = {}
    for c, img, ox, adv in cells:
        if img is None:
            glyphs[c] = {'x': 0, 'y': 0, 'w': 0, 'h': 0, 'ox': 0, 'advance': adv}
            continue
        gx, gy = placed[c]
        atlas.paste(img, (gx, gy))
        glyphs[c] = {'x': gx, 'y': gy, 'w': img.width, 'h': img.height, 'ox': ox, 'advance': adv}
    meta = {'source': file, 'size': size, 'cellHeight': height, 'baseline': PAD - top, 'glyphs': glyphs,
            'width': ATLAS_W, 'height': atlas_h, 'alpha': base64.b64encode(atlas.tobytes()).decode('ascii')}
    with open(os.path.join(out, name + '.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'), ensure_ascii=False)
    print('%-6s %3dpx  cell height %3d  atlas %dx%d  %d glyphs' % (name, size, height, ATLAS_W, atlas_h, len(glyphs)))


if __name__ == '__main__':
    import sys
    for app in sys.argv[1:] or sorted(FONTS):
        out = os.path.join(APPS, app, 'hud', 'fonts')
        os.makedirs(out, exist_ok=True)
        print(app)
        for spec in FONTS[app]:
            bake(out, *spec)
