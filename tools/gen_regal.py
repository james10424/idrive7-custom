#!/usr/bin/env python3
"""Generates apps/custom_cluster/hud/layouts/regal.json: the Regal theme, after a 1987 Buick Regal's dash (photo
1474x448, scaled 1.3 and moved down 110 px so the pods' tops clear the hood; the bottom row under it holds the music
title). Edit the numbers here and run it: python3 tools/gen_regal.py"""
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
GEAR_X0, GEAR_P = 449, 22


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
    'vfdL': [432, 167, 144, 181], 'vfdR': [1264, 167, 136, 181],
    'spd': [PIVOT[0], PIVOT[1], NUM_Y, TICK_Y], 'spdVirt': list(VIRT), 'spdMax': SPD_MAX, 'spdMid': SPD_MID, 'spdStep': 5, 'spdRest': 12, 'fuelG': list(FUEL), 'podG': list(POD),
    'podSignals': [{'signal': 'volt12', 'range': [8, 16]}, {'signal': 'oil', 'range': [50, 150], 'mid': 110}],
    'led': list(LED), 'ledN': 16, 'rpmMax': 8000,
    'led2': list(LED2), 'led2N': 15, 'led2Signal': 'boost', 'led2Range': [0, 1.5],
    'gearBox': [GEAR_X0 - 10, 309, 20, 28], 'gearPitch': GEAR_P,
    'lampB': [120, 478, 120, 36], 'arrow': [180, 545, 26], 'batIcon': [132, 328],
}]

# speed numbers (mph) on their marks: 5, 15 ... 85, the 55 in amber; no km/h row (as the Turbo 3.8's)
for mph in range(5, SPD_MAX + 1, 10):
    wd.append(centred('mph%d' % mph, ray_x(mph_deg(mph), NUM_Y), NUM_Y, 44, 39, str(mph), 'r_num', 'amber' if mph == SPD_MID else 'fg'))
wd.append(centred('mph_unit', PIVOT[0], 318, 46, 21, 'MPH', 'r_lbl'))

# left VFD: speed in the units setting's unit, the odometer, the gear row
wd.append(text('vfd_speed', 446, 182, 123, 48, '{{speed}}', 'r_seg', 'vfd', 'right'))
wd.append(centred('vfd_mph', 528, 243, 60, 21, '{{u:speed}}', 'r_lbl', 'vfd'))
wd.append(centred('vfd_odo', 504, 280, 116, 25, '{{odometer}}', 'r_seg_s', 'vfd'))
# the gear row: P R N D, a gap, then the gear number while driving (lit in manual, M)
for i, g in enumerate('PRND'):
    wd.append(centred('gear_' + g, GEAR_X0 + GEAR_P * i, 323, 20, 24, g, 'r_vfd', 'vfd'))
wd.append(centred('gear_num', GEAR_X0 + GEAR_P * 5, 323, 20, 24, '{{gearInD}}', 'r_vfd', 'vfd'))
# right VFD: the clock, the range
wd.append(centred('vfd_clock', 1332, 228, 132, 36, '{{time}}', 'r_seg_m', 'vfd'))
wd.append(centred('vfd_rlabel', 1332, 274, 60, 17, 'RANGE', 'r_tiny', 'vfd'))
wd.append(text('vfd_range', 1281, 290, 78, 25, '{{range4}}', 'r_seg_s', 'vfd', 'right'))
wd.append(text('vfd_runit', 1362, 296, 26, 21, '{{u:distUc}}', 'r_lbl', 'vfd', 'left'))

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
wd.append(centred('lamp_turn_l', 180, 575, 100, 17, '{{lampTurnL}}', 'r_tiny', 'green'))
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
wd.append(centred('lamp_turn_r', W - 180, 575, 100, 17, '{{lampTurnR}}', 'r_tiny', 'green'))
wd.append(centred('lamp_cruise', W - 180, 496, 112, 17, '{{lampCruise}}', 'r_tiny', 'lampTextG'))

# the bottom row: the song title, centred on the screen (630..1290: clear of BMW's belt light and gear letter)
wd.append({'id': 'music_title', 'type': 'text', 'z': 5, 'x': 630, 'y': 674, 'w': 660, 'h': 34, 'text': '{{musicTitle}}',
           'font': '@sys', 'size': 25, 'color': 'dim', 'align': 'center', 'own': True})

out = {
    'schemaVersion': 2, 'name': 'Regal', 'theme': 'regal',
    '_about': "After a 1987 Buick Regal's dash (generated by tools/gen_regal.py, edit that): chrome-framed side pods, the left a 12 V voltmeter (8..16 V) and the right oil temperature (50 / 110 / 150 C), each needle pivoting from the pod's inner edge, with the BRAKE lamp, the turn arrows and CRUISE under them; the centre panel holds a swinging speed needle over a straight row of mph numbers, 5 to 85 with 55 amber at the middle (as the Turbo 3.8's), the orange VFD windows (speed, odometer, P R N D and the gear number; the clock and range), the fuel needle centred between a yellow LED boost bar (0..1.5 bar) and the LED rev bar (yellow from the shift point). No map window. Shader rdash plus text sheets. The bottom row has the song title.",
    'widgets': wd,
}
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'apps', 'custom_cluster', 'hud', 'layouts', 'regal.json')
with open(p, 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('wrote', p, len(wd), 'widgets')
