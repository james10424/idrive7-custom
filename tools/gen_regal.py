#!/usr/bin/env python3
"""Generates apps/custom_cluster/hud/layouts/regal.json: the Regal theme, after a 1987 Buick Regal's dash (photo
1474x448, scaled 1.3 and moved down 155 px (DY below) so the pods' tops clear the hood and the centre clears the dash camera).
Edit the numbers here and run it: python3 tools/gen_regal.py"""
import json, math, os

W = 1920
PIVOT = (912, 396)                 # the speed needle's pivot: on the frame line under the speed window
VIRT = (308, 46.1)                 # the numbers' places: rays of a far pivot this far below the number row, half sweep deg
TICK_Y = 295
SPD_MAX, SPD_MID = 85, 55          # mph: 0..85 with 55 at the middle, as the Turbo 3.8's
NUM_Y, KMH_Y = 252, 212            # middle of the number row and of the km/h row
FUEL = (933, 540, 72, 98)          # fuel needle pivot (centred in the lower window), tick radii
POD = (300, 292, 112, 146)         # left pod needle pivot, tick radii (right pod mirrored)
LED = (1104, 466, 312, 22)
LED2 = (2 * 933 - 1104 - 312, 466, 312, 22)   # the boost bar, the rev bar mirrored about the lower window's middle
GEAR_P = 22
GEAR_X0 = PIVOT[0] - 2.5 * GEAR_P    # the gear row (P R N D, a gap, the number) centred under the 55, below MPH
GEAR_Y = 347


def ray_x(deg, y=None):
    # a number's place on the row (the needle turns to point at it)
    return PIVOT[0] + VIRT[0] * math.tan(math.radians(deg))


def mph_deg(mph):
    f = 0.5 * mph / SPD_MID if mph <= SPD_MID else 0.5 + 0.5 * (mph - SPD_MID) / (SPD_MAX - SPD_MID)
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
    'vfdL': [0, 0, 0, 0], 'vfdR': [0, 0, 0, 0],   # no VFD boxes: the speed sits over the 55, the clock and range in the pods
    'spd': [PIVOT[0], PIVOT[1], NUM_Y, TICK_Y], 'spdVirt': list(VIRT), 'spdMax': SPD_MAX, 'spdMid': SPD_MID, 'spdStep': 5, 'spdRest': 12, 'fuelG': list(FUEL), 'podG': list(POD),
    'podSignals': [{'signal': 'volt12', 'range': [8, 16]}, {'signal': 'oil', 'range': [50, 150], 'mid': 110}],
    'led': list(LED), 'ledN': 16, 'rpmMax': 8000,
    'led2': list(LED2), 'led2N': 15, 'led2Signal': 'boost', 'led2Range': [0, 1.5],
    'gearBox': [GEAR_X0 - 10, GEAR_Y - 14, 20, 28], 'gearPitch': GEAR_P,
    'lampB': [120, 478, 120, 36], 'arrow': [0, 0, 0], 'batIcon': [132, 328],   # arrow size 0: no turn arrows
}]

# speed numbers (mph) on their marks: 5, 15 ... 85, the 55 in amber; no km/h row (as the Turbo 3.8's)
for mph in range(5, SPD_MAX + 1, 10):
    wd.append(centred('mph%d' % mph, ray_x(mph_deg(mph), NUM_Y), NUM_Y, 44, 39, str(mph), 'r_num', 'amber' if mph == SPD_MID else 'fg'))
wd.append(centred('mph_unit', PIVOT[0], 318, 46, 21, 'MPH', 'r_lbl'))

# the speed in the units setting's unit, big in the VFD orange over the 55 (the digits centred on it), its unit beside; the
# needle's tip stops at y 212, under it
wd.append(centred('spd_val', PIVOT[0], 174, 124, 48, '{{speed}}', 'r_seg', 'vfd'))       # the digits centred on the 55
wd.append(text('spd_unit', PIVOT[0] + 66, 176, 62, 21, '{{u:speed}}', 'r_lbl', 'vfd', 'left'))
# the gear row under the 55, below MPH: P R N D, a gap, then the gear number while driving (lit in manual, M); the speed
# needle is its own layer over the text (regal_needle below), so it sweeps over the row
for i, g in enumerate('PRND'):
    wd.append(centred('gear_' + g, GEAR_X0 + GEAR_P * i, GEAR_Y, 20, 24, g, 'r_vfd', 'vfd', litGear=i))
wd.append(centred('gear_num', GEAR_X0 + GEAR_P * 5, GEAR_Y, 20, 24, '{{gearInD}}', 'r_vfd', 'vfd', litGear=5))
# the lit letter (on the gear box) turns the white text colour: 5.0:1 on the box (WCAG AA), the VFD orange was 1.9:1

# lower window: fuel and the LED revs
for lbl, a in (('E', -63), ('F', 63)):
    r = FUEL[3] + 14
    wd.append(centred('fuel_' + lbl, FUEL[0] + r * math.sin(math.radians(a)), FUEL[1] - r * math.cos(math.radians(a)), 16, 28, lbl, 'r_gl'))
wd.append({'id': 'fuel_icon', 'type': 'icon', 'icon': 'fuel', 'z': 5, 'x': FUEL[0] - 13, 'y': 410, 'w': 26, 'h': 30, 'color': 'fg'})
wd.append(centred('rpm_label', LED[0] + LED[2] / 2, 418, 104, 21, 'RPM X 100', 'r_lbl'))
wd.append(centred('boost_label', LED2[0] + LED2[2] / 2, 418, 70, 21, 'BOOST', 'r_lbl'))
for k, t in enumerate(('0', '0.5', '1.0', '1.5')):
    wd.append(centred('boost%d' % k, LED2[0] + LED2[2] * k / 3 + (8 if k == 0 else -8 if k == 3 else 0), 446, 12 * len(t), 21, t, 'r_lbl'))
for k in range(0, 9):
    t = str(k * 10)
    wd.append(centred('rpm%d' % k, LED[0] + LED[2] * k / 8 + 8, 446, 12 * len(t), 21, t, 'r_lbl'))

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
# the range where the left turn signal was: its label, then four VFD digits and the unit, bottoms aligned
wd.append(centred('pod_rlabel', 180, 530, 80, 17, 'RANGE', 'r_tiny', 'vfd'))
# up to three digits (999 past it, no leading zeros), right-aligned: the group (3 digits, the unit) centred in the pod
wd.append(text('pod_range', 180 - 58, 545, 86, 36, '{{range3}}', 'r_seg_m', 'vfd', 'right'))
wd.append(text('pod_runit', 180 + 32, 559, 30, 21, '{{u:distUc}}', 'r_lbl', 'vfd', 'left'))
# under the turn lamps, in the VFD's seven segments: average consumption (left), outside temperature (right)
wd.append(centred('pod_clabel', 180, 600, 80, 17, 'AVG FUEL', 'r_tiny', 'vfd'))
# centred under AVG FUEL: metric for "9.8" (44 px) + 3 + L/100KM (85), US for "24.0" (63) + 3 + MPG (40)
wd.append(text('pod_cons', 158 - 62, 612, 62, 25, '{{consumption}}', 'r_seg_s', 'vfd', 'right', toggle='!units=us'))
wd.append(text('pod_cunit', 161, 618, 90, 21, '{{u:consUc}}', 'r_lbl', 'vfd', 'left', toggle='!units=us'))
wd.append(text('pod_cons_us', 190 - 72, 612, 72, 25, '{{consumption}}', 'r_seg_s', 'vfd', 'right', toggle='units=us'))
wd.append(text('pod_cunit_us', 193, 618, 50, 21, '{{u:consUc}}', 'r_lbl', 'vfd', 'left', toggle='units=us'))
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
BOX_KEYS = ('podL', 'podWin', 'ctr', 'win1', 'win2', 'vfdL', 'vfdR', 'fuelG', 'podG', 'led', 'led2', 'gearBox', 'lampB',
            'arrow', 'batIcon')
for k in BOX_KEYS:
    wd[0][k][1] += DY
wd[0]['spd'] = [wd[0]['spd'][0]] + [v + DY for v in wd[0]['spd'][1:]]   # pivot y, number row, tick row
for w in wd[1:]:
    w['y'] += DY


# the speed needle as its own layer over the text (so it sweeps over the gear row): the same widget, needle only, its box
# the speed window
import copy
ndl = copy.deepcopy(wd[0])
ndl.update({'id': 'regal_needle', 'needleOnly': True, 'class': 'content', 'z': 8,
            'x': ndl['win1'][0], 'y': ndl['win1'][1], 'w': ndl['win1'][2], 'h': ndl['win1'][3]})
wd.append(ndl)

# Miku lying in the black strip under the centre panel (it ends at y 584), centred under the fuel gauge (x 933), clear
# of BMW's seat-belt light (x 587-626) and gear letter (x 1380-1455); her own bake (miku-lie/), the "mikuLie" setting
MIKU_W = 270
wd.append({'id': 'miku_lie', 'type': 'mikuLie', 'class': 'content', 'z': 0, 'toggle': 'mikuLie',
           'x': FUEL[0] - MIKU_W // 2, 'y': 586, 'w': MIKU_W, 'h': 134, 'floor': 4})

out = {
    'schemaVersion': 2, 'name': 'Regal', 'theme': 'regal',
    '_about': "After a 1987 Buick Regal's dash (generated by tools/gen_regal.py, edit that): chrome-framed side pods, the left a 12 V voltmeter (8..16 V) and the right oil temperature (50 / 110 / 150 C), each needle pivoting from the pod's inner edge, with the BRAKE lamp and CRUISE under them; the centre panel holds a swinging speed needle over a straight row of mph numbers, 5 to 85 with 55 amber at the middle (as the Turbo 3.8's), the the speed big in the VFD orange over the 55, P R N D and the gear number under it (the needle, a layer of its own, sweeps over them), the range and the clock in the pods where the turn signals were, the fuel needle centred between a yellow LED boost bar (0..1.5 bar) and the LED rev bar (yellow from the shift point); Miku lying under the centre panel (your own bake, tools/live2d_bake pose lie). No map window. Shader rdash plus text sheets.",
    'widgets': wd,
}
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'apps', 'custom_cluster', 'hud', 'layouts', 'regal.json')
with open(p, 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('wrote', p, len(wd), 'widgets')
