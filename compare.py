#!/usr/bin/env python3
"""Compare clone (verify/<slug>) vs original (capture/<slug>) screenshots per segment.
Outputs an RMSE-based difference table. Hero/slideshow segments naturally differ.
"""
import os, re, subprocess, glob, sys

ROOT = os.path.dirname(os.path.abspath(__file__))

def segs(d, kind):
    fs = sorted(glob.glob(os.path.join(d, f'screenshot-{kind}-seg*.png')))
    if not fs:
        f = os.path.join(d, f'screenshot-{kind}.png')
        if os.path.exists(f): fs = [f]
    return fs

def rmse(a, b):
    # normalized RMSE via ImageMagick compare; returns float 0..1 (0=identical)
    try:
        out = subprocess.run(['compare', '-metric', 'RMSE', a, b, 'null:'],
                             capture_output=True, text=True)
        s = out.stderr.strip()
        m = re.search(r'\(([0-9.]+)\)', s)
        if m: return float(m.group(1))
        m = re.search(r'^([0-9.]+)', s)
        if m: return float(m.group(1))
    except Exception as e:
        return None
    return None

slugs = [l.split('|')[0] for l in open(os.path.join(ROOT,'urls.txt')) if '|' in l]
only = sys.argv[1:]
print(f"{'PAGE':34s} {'KIND':7s} {'SEG':4s} {'RMSE':>7s}  NOTE")
flagged = []
for slug in slugs:
    if only and slug not in only: continue
    orig = os.path.join(ROOT, 'capture', slug)
    clone = os.path.join(ROOT, 'verify', slug)
    if not os.path.isdir(clone):
        print(f"{slug:34s} (no clone capture)"); continue
    for kind in ['desktop','mobile']:
        o = segs(orig, kind); c = segs(clone, kind)
        n = min(len(o), len(c))
        if len(o) != len(c):
            print(f"{slug:34s} {kind:7s} SEGCOUNT orig={len(o)} clone={len(c)}  <-- height/segment mismatch")
        for i in range(n):
            # resize to same dims if needed
            r = rmse(o[i], c[i])
            note = ''
            if r is None: note = 'compare-failed (dim mismatch?)'
            elif r > 0.18: note = 'HIGH DIFF'
            elif r > 0.08: note = 'medium diff'
            if note:
                print(f"{slug:34s} {kind:7s} {i:<4d} {('%.4f'%r) if r is not None else 'NA':>7s}  {note}")
                if r is None or r > 0.08:
                    flagged.append((slug, kind, i, r))
print(f"\nFlagged segments (RMSE>0.08 or failed): {len(flagged)}")
for f in flagged: print("  ", f)
