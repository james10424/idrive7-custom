#!/usr/bin/env python3
"""Generates apps/custom_cluster/hud/layouts/regal.json: the Grand National theme, after a 1987 Buick Grand National's dash (photo
1474x448, scaled 1.3 and moved down 155 px (DY below) so the pods' tops clear the hood and the centre clears the dash camera).
Edit the numbers here and run it: python3 tools/gen_regal.py"""
import json, math, os

W = 1920
PIVOT = (912, 502)                 # the speed needle's pivot, hidden under the speed window: where the needle lines of two
                                   # photos cross (the museum car's at rest, a replica's at ~38 mph), 0.84 of the number
                                   # row's half width below it, so the needle comes up from the window's bottom edge
VIRT = (584, 28.7)                 # the numbers' places: rays of a far pivot this far below the number row, half sweep deg
                                   # (evenly spread, the ends a little wider apart, as the photo's 5 and 85)
TICK_Y = 295
SPD_MIN, SPD_MAX, SPD_MID = 5, 85, 45   # mph: 5..85, linear, 45 in the middle: its mark points straight down at the pivot,
                                        # as the Turbo 3.8's
SPD_AMBER = 55                     # the amber number and mark, right of the middle as on the Turbo 3.8
NUM_Y, KMH_Y = 252, 212            # middle of the number row and of the km/h row
FUEL = (933, 528, 110, 20)         # fuel: the pivot just under PREMIUM FUEL (centred in the lower window), the end marks
                                   # crossing the line 110 px out (E and F there), the marks' lower parts 20 px tall: wide
                                   # enough that PREMIUM FUEL sits between the outer two, as the Grand National's
FUEL_LINE = 468                    # where the fuel marks split (a horizontal line): E, the pump and F sit on it
POD = (300, 292, 112, 146)         # left pod needle pivot, tick radii (right pod mirrored)
LED = (1104, 466, 312, 22)
LED2 = (2 * 933 - 1104 - 312, 466, 312, 22)   # the boost bar, the rev bar mirrored about the lower window's middle
POD_WIN_X, POD_WIN_W = 104, 152   # the left pod's inner box ('podWin')
GEAR_P = POD_WIN_W / 5            # the gear row P R N D S spread around the pod's inner box (justify-around: a fifth each,
GEAR_X0 = POD_WIN_X + GEAR_P / 2  # each letter in the middle of its fifth), under the gear number
GEAR_Y = 606
GEAR_NEEDLE = (GEAR_Y + 15, 647, 150)   # the gear needle under the row: its tip's y, its bottom's y, its far pivot this far
                                        # below the row (the letters at about +-22 deg), as the 1950s Buicks' P R N D G
ODO_Y = 347                     # the rolling odometer under the scale's middle, below MPH, where the gear row was


def ray_x(deg, y=None):
    # a number's place on the row (the needle turns to point at it)
    return PIVOT[0] + VIRT[0] * math.tan(math.radians(deg))


def mph_deg(mph):
    f = 0.5 * (mph - SPD_MIN) / (SPD_MID - SPD_MIN) if mph <= SPD_MID else 0.5 + 0.5 * (mph - SPD_MID) / (SPD_MAX - SPD_MID)
    return -VIRT[1] + 2 * VIRT[1] * f


def text(id, x, y, w, h, t, font, color='fg', align='center', **kw):
    d = {'id': id, 'type': 'text', 'z': 5, 'x': round(x), 'y': round(y), 'w': round(w), 'h': round(h), 'text': t,
         'font': font, 'color': color, 'align': align}
    d.update(kw)
    return d


def centred(id, cx, cy, w, h, t, font, color='fg', **kw):
    return text(id, cx - w / 2, cy - h / 2, w, h, t, font, color, 'center', **kw)


wd = [{
    'id': 'regal', 'type': 'rdash', 'class': 'ambient', 'z': -10, 'x': 0, 'y': 0, 'w': W, 'h': 720,
    'podL': [90, 110, 180, 553], 'podWin': [104, 124, 152, 336],
    'ctr': [397, 110, 1072, 429], 'win1': [413, 122, 1040, 270], 'win2': [413, 400, 1040, 128],
    'vfdL': [0, 0, 0, 0], 'vfdR': [0, 0, 0, 0],   # no VFD boxes: the speed sits over the scale, the clock and range in the pods
    'spd': [PIVOT[0], PIVOT[1], NUM_Y, TICK_Y], 'spdVirt': list(VIRT), 'spdMax': SPD_MAX, 'spdMin': SPD_MIN, 'spdMid': SPD_MID, 'spdAmber': SPD_AMBER, 'spdStep': 5, 'spdRest': 12, 'fuelG': list(FUEL), 'podG': list(POD),
    'podSignals': [{'signal': 'volt12', 'range': [8, 16]}, {'signal': 'oil', 'range': [50, 150], 'mid': 110}],
    # coloured zones: the battery red under 11.5 V and over 15.5 V, green 12.5-15 V (running, BMW's smart charging
    # included); the oil blue while cold (under 60 C, as the cold redline), red over 130 C
    'podZones': [{'low': 11.5, 'ok': [12.5, 15], 'high': 15.5}, {'low': 60, 'high': 130}],
    'fuelLine': FUEL_LINE, 'fuelRowH': 21, 'coldRedline': [4500, 60, 80], 'led': list(LED), 'ledN': 28, 'rpmMax': 7000,
    'led2': list(LED2), 'led2N': 15, 'led2Signal': 'boost', 'led2Range': [0, 1.5], 'led2RangeUs': [0, round(20 / 14.5038, 4)],
    'gearRow': [GEAR_X0, GEAR_P, GEAR_Y],
    'gearNeedle': [POD_WIN_X + POD_WIN_W / 2, GEAR_Y + GEAR_NEEDLE[2], GEAR_NEEDLE[0], GEAR_NEEDLE[1]],
    'lampB': [120, 478, 120, 36], 'arrow': [0, 0, 0], 'batIcon': [132, 328],   # arrow size 0: no turn arrows
}]

# speed numbers (mph) on their marks: 5, 15 ... 85, the 55 in amber; no km/h row (as the Turbo 3.8's)
for mph in range(5, SPD_MAX + 1, 10):
    wd.append(centred('mph%d' % mph, ray_x(mph_deg(mph), NUM_Y), NUM_Y, 44, 39, str(mph), 'r_num', 'amber' if mph == SPD_AMBER else 'fg'))
wd.append(centred('mph_unit', PIVOT[0], 318, 46, 21, 'MPH', 'r_lbl'))

# the speed in the units setting's unit, big in the VFD orange over the scale's middle, its unit beside; the
# needle's tip stops at y 212, under it
wd.append(centred('spd_val', PIVOT[0], 174, 124, 48, '{{speed}}', 'r_seg', 'vfd'))       # the digits centred on the panel
wd.append(text('spd_unit', PIVOT[0] + 66, 176, 62, 21, '{{u:speed}}', 'r_lbl', 'vfd', 'left'))
# the gear row in the left pod under the gear number: P R N D S in white, a red needle under it (the shader's) pointing
# at the selected one (M at S, the stick on the side)
for i, g in enumerate('PRNDS'):
    wd.append(centred('gear_' + g, GEAR_X0 + GEAR_P * i, GEAR_Y, 20, 24, g, 'r_vfd'))
# the drum row below MPH, as the Grand National's two counters: the rolling odometer (six drums) and the range (three, its unit
# beside), white digits (r_gl) in the units setting's unit, spread along the speed window (justify-around: each at a
# quarter of its width from its end); the speed needle (its own layer, regal_needle below) sweeps over them
WIN1 = (413, 1040)                       # the speed window's x and width (wd[0]['win1'], before the shifts)
ODO_W, ODO_H = 6 * 20 + 2, 30
RNG_W, RNG_UW = 3 * 20 + 2, 30           # the range drums and their unit
odo_cx, rng_cx = WIN1[0] + WIN1[1] / 4, WIN1[0] + 3 * WIN1[1] / 4
wd.append({'id': 'odo', 'type': 'odo', 'class': 'content', 'z': 2, 'x': round(odo_cx - ODO_W / 2), 'y': ODO_Y - ODO_H // 2,
           'w': ODO_W, 'h': ODO_H, 'drums': 6, 'font': 'r_gl', 'color': 'fg', 'gap': 2, 'frame': 1})
rng_x = round(rng_cx - (RNG_W + 6 + RNG_UW) / 2)  # the drums and the unit centred together
wd.append({'id': 'range_drums', 'type': 'odo', 'source': 'range', 'class': 'content', 'z': 2, 'x': rng_x,
           'y': ODO_Y - ODO_H // 2, 'w': RNG_W, 'h': ODO_H, 'drums': 3, 'font': 'r_gl', 'color': 'fg', 'gap': 2,
           'frame': 1})
wd.append(text('range_unit', rng_x + RNG_W + 6, ODO_Y - 10, RNG_UW, 21, '{{u:distUc}}', 'r_lbl', 'fg', 'left'))

# lower window: fuel and the LED revs. The fuel gauge as the Grand National's: UNLEADED FUEL ONLY over it, E, the pump and
# F standing on the line its marks split at, where the end and middle marks' upper parts would be, PREMIUM FUEL under it
GAP = 4                                           # half the marks' gap at the line (the shader's)
for lbl, side in (('E', -1), ('F', 1)):
    x = FUEL[0] + side * FUEL[2]                  # where that end mark crosses the line
    # r_ef: 21 px letters, their ink 2 px above the cell's bottom: the ink's bottom on the marks' cut edge
    wd.append(centred('fuel_' + lbl, x, FUEL_LINE - GAP + 2 - 11.5, 16, 23, lbl, 'r_ef'))
# the pump as tall as the letters: its ink is 72% of the box from 22% down (icons.js), so 21 px of ink is a 29 px box,
# its bottom (94% down) on the marks' cut edge with the letters'
ICON_H = 29
wd.append({'id': 'fuel_icon', 'type': 'icon', 'icon': 'fuel', 'z': 5, 'x': round(FUEL[0] - ICON_H * 26 / 30 / 2),
           'y': round(FUEL_LINE - GAP - 0.94 * ICON_H), 'w': round(ICON_H * 26 / 30), 'h': ICON_H, 'color': 'fg'})
wd.append(centred('fuel_top', FUEL[0], 414, 200, 17, 'UNLEADED FUEL ONLY', 'r_tiny'))
wd.append(centred('fuel_bottom', FUEL[0], 516, 130, 17, 'PREMIUM FUEL', 'r_tiny'))
# left of the bar's middle: clear of the red mark, which starts as low as 4500 rpm (64% along) on a cold engine
wd.append(centred('rpm_label', LED[0] + LED[2] * 0.4, 418, 104, 21, 'RPM X 100', 'r_lbl'))
wd.append(centred('boost_label', LED2[0] + LED2[2] / 2, 418, 200, 21, 'TURBO BOOST - {{u:boost}}', 'r_lbl'))
# its scale: 0 .. 1.5 bar in thirds, or with US units 0 .. 20 psi in quarters (the Grand National's 0 5 10 15); the ends are
# shared, the slots between belong to one unit and are empty in the other
for tok, f, w in (('0', 0, 12), ('m1', 1 / 3, 30), ('m2', 2 / 3, 28), ('u1', 1 / 4, 12), ('u2', 2 / 4, 24),
                  ('u3', 3 / 4, 24), ('end', 1, 30)):
    wd.append(centred('boost_' + tok, LED2[0] + LED2[2] * f + (8 if f == 0 else -8 if f == 1 else 0), 446, w, 21,
                      '{{boostTick:%s}}' % tok, 'r_lbl'))
for k in range(0, 8):   # 0 .. 70, each over its orange segment (every fourth of 28)
    t = str(k * 10)
    wd.append(centred('rpm%d' % k, LED[0] + LED[2] * k / 7 + LED[2] / 56, 446, 12 * len(t), 21, t, 'r_lbl'))

# the pods' scales: battery (V) left, oil temperature right; labels at the ends and the middle of 5 marks over +-50 deg
def pod_label(side, f, t, w):
    a = math.radians((f - 0.5) * 100)
    x = POD[0] - 168 * math.cos(a)
    y = POD[1] - 168 * math.sin(a)
    if side == 'R':
        x = W - x
    return centred('pod%s%d' % (side, int(f * 2)), x, y, w, 28, t, 'r_gl')
for f, t in ((1, '16'), (0.5, '12'), (0, '8')):
    wd.append(pod_label('L', f, t, 16 * len(t)))
for f, c in ((1, 150), (0.5, 110), (0, 50)):     # oil: 110 C (the B58's running temperature) in the middle
    wd.append(pod_label('R', f, '{{temp:%d}}' % c, 48))
wd.append({'id': 'oilcan', 'type': 'icon', 'icon': 'oilcan', 'z': 5, 'x': W - 132 - 20, 'y': 314, 'w': 40, 'h': 26, 'color': 'fg'})

# lamps: their text shows only while lit
wd.append(centred('lamp_brake', 180, 496, 112, 17, '{{lampBrake}}', 'r_tiny', 'lampText'))
# the gear number where the left turn signal was (the range is on the drum row): GEAR over it in VFD digits, while driving
wd.append(centred('pod_glabel', 180, 530, 80, 17, 'GEAR', 'r_tiny', 'vfd'))
wd.append(centred('pod_gear', 180, 563, 40, 36, '{{gearInD}}', 'r_seg_m', 'vfd'))
# under the right turn lamp, in the VFD's seven segments: the outside temperature
wd.append(centred('pod_tlabel', W - 180, 600, 80, 17, 'OUTSIDE', 'r_tiny', 'vfd'))
# centred under OUTSIDE for two digits (38 px) + 3 px + the unit (21 px)
wd.append(text('pod_temp', W - 180 + 7 - 62, 612, 62, 25, '{{ambientN}}', 'r_seg_s', 'vfd', 'right'))
wd.append(text('pod_tunit', W - 180 + 10, 618, 34, 21, '{{u:temp}}', 'r_lbl', 'vfd', 'left'))
# the clock where the right turn signal was, level with the range
wd.append(centred('pod_clock', W - 180, 563, 132, 36, '{{time}}', 'r_seg_m', 'vfd'))
wd.append(centred('lamp_cruise', W - 180, 496, 112, 17, '{{lampCruise}}', 'r_tiny', 'lampTextG'))

# the dash sits DY px lower than drawn above: the pods' outer top corners clear the hood (x 90 / 1830 hidden above
# y ~150) and the centre panel's top lines up with the pods', clear of the dash camera (x ~760..1200, down to y ~132;
# car photo, Nov 8 2026).
DY = 45
BOX_KEYS = ('podL', 'podWin', 'ctr', 'win1', 'win2', 'vfdL', 'vfdR', 'fuelG', 'podG', 'led', 'led2', 'lampB',
            'arrow', 'batIcon')
for k in BOX_KEYS:
    wd[0][k][1] += DY
wd[0]['spd'] = [wd[0]['spd'][0]] + [v + DY for v in wd[0]['spd'][1:]]   # pivot y, number row, tick row
wd[0]['fuelLine'] += DY
wd[0]['gearRow'][2] += DY
wd[0]['gearNeedle'] = [wd[0]['gearNeedle'][0]] + [v + DY for v in wd[0]['gearNeedle'][1:]]
for w in wd[1:]:
    w['y'] += DY

# the centre section (its panel, windows, needles, LED bars and everything between the pods) moves DX px right, so
# the gaps either side of it are equal: the photo's centre panel sat 27 px left of the middle (gaps 127 and 181 px)
POD_IN_L = wd[0]['podL'][0] + wd[0]['podL'][2]           # the left pod's inner edge; the right pod is its mirror
DX = round(W / 2 - (wd[0]['ctr'][0] + wd[0]['ctr'][2] / 2))
for k in ('ctr', 'win1', 'win2', 'fuelG', 'led', 'led2'):
    wd[0][k][0] += DX
wd[0]['spd'][0] += DX                                     # the speed needle's pivot x
for w in wd[1:]:
    if POD_IN_L < w['x'] + w['w'] / 2 < W - POD_IN_L:
        w['x'] += DX


# the speed and fuel needles as their own layer over the text (so they sweep over the odometer and PREMIUM FUEL): the same
# widget, needles only, its box both windows of the centre panel
import copy
ndl = copy.deepcopy(wd[0])
ndl.update({'id': 'regal_needle', 'needleOnly': True, 'class': 'content', 'z': 8,
            'x': ndl['win1'][0], 'y': ndl['win1'][1], 'w': ndl['win1'][2],
            'h': ndl['win2'][1] + ndl['win2'][3] - ndl['win1'][1]})
wd.append(ndl)

out = {
    'schemaVersion': 2, 'name': 'Grand National', 'theme': 'regal',
    '_about': "After a 1987 Buick Grand National's dash (generated by tools/gen_regal.py, edit that): chrome-framed side pods, the left a 12 V voltmeter (8..16 V) and the right oil temperature (50 / 110 / 150 C), each needle pivoting from the pod's inner edge, with the BRAKE lamp and CRUISE under them; the centre panel holds a swinging speed needle over a straight row of mph numbers, 5 to 85 spread evenly with 55 amber right of the middle (as the Turbo 3.8's), the speed big in the VFD orange over the middle, a rolling odometer under it (the needle, a layer of its own, sweeps over it), the gear number with P R N D S under it in the left pod (white, a red needle under them from a far pivot) and the clock in the right, where the turn signals were, the fuel needle centred between a yellow LED boost bar (0..1.5 bar) and the LED rev bar (0..7000 rpm in 28 segments, green with each 1000's orange, a red mark above the labels from the Redline setting to the end; the fuel gauge's marks split at one horizontal line that E, the pump and F stand on, UNLEADED FUEL ONLY over it and PREMIUM FUEL under it, as the Grand National's); no map window. Shader rdash plus text sheets.",
    'widgets': wd,
}
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'apps', 'custom_cluster', 'hud', 'layouts', 'regal.json')
with open(p, 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('wrote', p, len(wd), 'widgets')
