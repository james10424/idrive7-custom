#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 James Zhao
"""Tries live2d-render off the car (make try): starts it on Mesa's software renderer with its frames on stdout and
the GPU's 4:2:0 checked against the CPU's, opens a model through its socket as an app would, turns the head for a
few seconds with parameter messages, and saves the frames (frames.yuv) and one of them (frame.pgm, its Y plane)."""
import argparse
import json
import math
import os
import socket
import subprocess
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument('--bin', required=True)
ap.add_argument('--sdk', required=True)
ap.add_argument('--model', required=True)
ap.add_argument('--frame', required=True)
ap.add_argument('--hide', default='')
ap.add_argument('--params', default='')
ap.add_argument('--out', required=True)
ap.add_argument('--size', default='248x280')
ap.add_argument('--frames', type=int, default=90)
ap.add_argument('--core', type=int, default=1, help='Cubism Core every core-th frame (the open\'s core)')
ap.add_argument('--script', default='', help='messages to send, one JSON line a frame, instead of the head turn')
a = ap.parse_args()
W, H = (int(v) for v in a.size.split('x'))
FRAME = W * H * 3 // 2
sock_path = '/tmp/live2d-render-try.sock'
os.makedirs(a.out, exist_ok=True)
err = open(os.path.join(a.out, 'service.log'), 'w')
loader = '/lib64/ld-linux-x86-64.so.2'   # the binary names the head unit's /lib one
svc = subprocess.Popen([loader, a.bin, '--software', '--stdout', '--check', '--socket', sock_path,
                        '--sdk', a.sdk, '--state', '/tmp/live2d-render-try-state'], stdout=subprocess.PIPE, stderr=err)
for _ in range(50):
    if os.path.exists(sock_path):
        break
    time.sleep(0.1)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)


def send(obj):
    s.sendall((json.dumps(obj) + '\n').encode())


send({'t': 'open', 'model': a.model, 'w': W, 'h': H, 'fps': 15, 'frame': a.frame, 'hide': a.hide, 'v': a.params, 'core': a.core})
s.settimeout(30)
reply = b''
while not reply.endswith(b'\n'):
    chunk = s.recv(65536)
    if not chunk:
        break
    reply += chunk
reply = reply.decode().strip()
print('reply:', reply[:160] + ('...' if len(reply) > 160 else ''))
open(os.path.join(a.out, 'opened.json'), 'w').write(reply + '\n')
if '"opened"' not in reply:
    svc.kill()
    sys.exit(1)
script = [l for l in open(a.script).read().splitlines() if l.strip()] if a.script else []
if script:
    a.frames = len(script)
frames = open(os.path.join(a.out, 'frames.yuv'), 'wb')
keep = None
t0 = time.time()
for i in range(a.frames):
    t = time.time() - t0
    if script:
        s.sendall((script[i] + '\n').encode())
    else:
        send({'t': 'p', 'v': 'ParamAngleX=%.2f ParamAngleY=%.2f' % (25 * math.sin(t * 2), 8 * math.sin(t * 3))})
    buf = b''
    while len(buf) < FRAME:
        chunk = svc.stdout.read(FRAME - len(buf))
        if not chunk:
            break
        buf += chunk
    if len(buf) < FRAME:
        print('the service stopped after %d frames' % i)
        break
    frames.write(buf)
    if i == a.frames // 2:
        keep = buf
s.close()
svc.terminate()
svc.wait(10)
err.close()
if keep:
    with open(os.path.join(a.out, 'frame.pgm'), 'wb') as f:
        f.write(b'P5 %d %d 255\n' % (W, H) + keep[:W * H])
log = open(os.path.join(a.out, 'service.log')).read().splitlines()
checks = [l for l in log if l.startswith('check:')]
bad = [l for l in checks if ' 0 of ' not in l]
for l in log:
    if not l.startswith('check:'):
        print(l)
print('%d frames checked, %d differ from the CPU 4:2:0' % (len(checks), len(bad)))
for l in bad[:5]:
    print(l)
sys.exit(1 if bad or not checks else 0)
