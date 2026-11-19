"""Generates the scene file songs/neon-rain.json (run: python3.14 tools/gen-song.py [out.json] [--orders])
Reads the instruments from client/presets. With --orders it writes plain orders (for the render CLI) instead of a scene file.

"Neon Rain" (A minor, 100 bpm, 64 bars of 16 rows = 2:34).

Structure (bars, 0-based):
   0- 7  intro:      rain, pad that opens up, bell melody from bar 4, a soft hat teaser
   8-15  build:      kick, hats, bass, pluck arpeggios; snare from bar 12; riser into the verse
  16-31  verse:      full groove; bell melody (16-23), then the lead + chord stabs (24-31)
  32-39  breakdown:  thunder, rain, pad sweeping open, bell, a heartbeat kick, riser + snare roll
  40-55  drop:       everything, acid line with a sweeping filter, lead + bell, claps
  56-63  outro:      drums thin out, rain returns, pad and bell fade, last thunder
"""
import json, os, sys

ROOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PRESETS = os.path.join(ROOT_DIR, 'client', 'presets') + os.sep
BPM, BARS, RPB = 100, 64, 16
TOTAL = BARS * RPB


def load(name, **over):
    d = json.load(open(PRESETS + name + '.json'))['instrument']
    d.update(over)
    return d


class Track:
    def __init__(self, inst):
        self.inst = inst
        self.notes = []  # (row, midi, vel, length or None)
        self.fx = {}

    def hit(self, row, note=60, vel=100):
        self.notes.append((row, note, vel, None))

    def note(self, row, note, length, vel=100):
        self.notes.append((row, note, vel, length))

    def f(self, row, **kw):
        if 0 <= row < TOTAL:
            self.fx.setdefault(row, {'row': row}).update(kw)

    def span(self, row, length, **kw):
        for r in range(row, row + length):
            self.f(r, **kw)

    def sweep(self, node, port, a, b, v0, v1, glide=True):
        """Automate a node parameter from v0 to v1 over rows a..b (exponential), one entry per row."""
        n = b - a
        for r in range(a, b):
            v = v0 * (v1 / v0) ** ((r + 1 - a) / n)
            cell = self.fx.setdefault(r, {'row': r})
            cell.setdefault('params', []).append({'node': node, 'port': port, 'value': round(v, 1), 'glide': glide})

    def lane(self):
        steps = {}
        for row, n, v, _ in self.notes:
            if row < TOTAL:
                steps[row] = {'row': row, 'note': n, 'vel': v}
        for row, n, v, l in self.notes:
            if l and row < TOTAL:
                end = row + l
                if end < TOTAL and end not in steps:
                    steps[end] = {'row': end, 'note': None, 'vel': 100}
        lane = {'instrument': self.inst['id'], 'steps': [steps[r] for r in sorted(steps)]}
        if self.fx:
            lane['fx'] = [self.fx[r] for r in sorted(self.fx)]
        return lane


def r(bar, row=0):
    return bar * RPB + row


def rng(a, b):
    return range(a, b)


ROOT = [45, 41, 48, 43]      # A F C G
THIRD = [3, 4, 4, 4]
PAD = [64, 65, 64, 62]       # smooth voice leading
CH = lambda bar: bar % 4

# --------------------------------------------------------------------------------------------------- instruments
kick = Track(load('kick'))
snare = Track(load('snare', gain=0.7))
hat = Track(load('hat', gain=0.5))
ohat = Track(load('openhat', gain=0.55))
clap = Track(load('clap', gain=0.6))
bass = Track(load('fmbass', gain=0.9))
acid = Track(load('acid', gain=0.55))
pad = Track(load('dualpad', gain=0.7))
saw = Track(load('supersaw', gain=0.5))
pluck = Track(load('pluck', gain=0.7))
bell = Track(load('fmbell', gain=0.75))
lead = Track(load('foldlead', gain=0.5))
riser = Track(load('riser', gain=0.7))
rain = Track(load('rain', gain=0.9))
thunder = Track(load('thunder', gain=0.7))

# --------------------------------------------------------------------------------------------------- drums
KICK_BARS = list(rng(8, 32)) + list(rng(40, 58))
for b in KICK_BARS:
    for row in (0, 4, 8, 12):
        kick.hit(r(b, row), vel=118 if row == 0 else 105)
    if b >= 40 and b % 4 == 3 and b < 56:
        kick.hit(r(b, 14), vel=95)           # syncopated pickup in the drop
for b in rng(36, 40):                        # heartbeat in the breakdown
    kick.hit(r(b, 0), vel=100)
    kick.hit(r(b, 6), vel=70)

FILL_BARS = [15, 23, 31, 47, 55]
for b in list(rng(12, 32)) + list(rng(40, 56)):
    snare.hit(r(b, 4))
    if b in FILL_BARS:
        for row in range(8, 16):
            snare.hit(r(b, row), vel=90 + row * 2)
            snare.f(r(b, row), volume=round(0.3 + 0.1 * (row - 8), 2), **({'retrig': 3} if row >= 12 else {}))
    else:
        snare.hit(r(b, 12))
for row in range(16):                        # roll into the drop
    snare.hit(r(39, row), vel=100)
    snare.f(r(39, row), volume=round(0.25 + 0.05 * row, 2), **({'retrig': 3} if row >= 8 else {}))
for b in list(rng(24, 32)) + list(rng(40, 56)):
    if b not in FILL_BARS:
        clap.hit(r(b, 4), vel=95)
        clap.hit(r(b, 12), vel=95)

# hats: soft 8ths while building, 16ths with accents in the verse and drop, fading 8ths in the outro
for b in (6, 7):
    for row in range(0, 16, 2):
        hat.hit(r(b, row), vel=60)
        hat.f(r(b, row), volume=round(0.4 + 0.3 * (b - 6) / 2 + row / 64, 2))
for b in rng(8, 16):
    for row in range(0, 16, 2):
        hat.hit(r(b, row), vel=95 if row % 4 == 0 else 75)
        hat.f(r(b, row), volume=1.0 if row % 4 == 2 else 0.75)
for b in list(rng(16, 32)) + list(rng(40, 56)):
    for row in range(16):
        hat.hit(r(b, row), vel=100)
        hat.f(r(b, row), volume={0: 0.9, 2: 1.0}.get(row % 4, 0.45))
    if b % 4 == 3:                           # a stuttering roll at the end of each phrase
        for row in (14, 15):
            hat.f(r(b, row), volume=0.8, retrig=2)
for b in rng(56, 60):
    for row in range(0, 16, 2):
        hat.hit(r(b, row), vel=80)
        hat.f(r(b, row), volume=round(0.9 - 0.2 * (b - 56) - row / 40, 2) if b < 59 else 0.15)
for b in list(rng(20, 32)) + list(rng(40, 56)):
    for row in (6, 14):
        ohat.hit(r(b, row), vel=95)

# --------------------------------------------------------------------------------------------------- bass
BASS_BARS = list(rng(8, 32)) + list(rng(40, 58))
for b in BASS_BARS:
    R = ROOT[CH(b)]
    for row, off, ln, vel in ((0, 0, 3, 115), (3, 0, 1, 80), (6, 12, 2, 95), (8, 0, 3, 108), (11, 7, 1, 80), (12, 0, 2, 100), (14, 12, 1, 85)):
        bass.note(r(b, row), R + off, ln, vel)
    if b % 4 == 3:
        bass.f(r(b, 14), slide=-5)           # fall into the next chord

ACID_DEG = [0, None, 12, 0, None, 10, 0, 12, 0, None, 7, 0, 12, None, 10, 7]
for b in rng(40, 56):
    R = ROOT[CH(b)] + 12
    for row, d in enumerate(ACID_DEG):
        if d is not None:
            acid.note(r(b, row), R + d, 1, 122 if row in (0, 6, 10, 12) else 82)
    if b % 4 == 3:
        acid.f(r(b, 15), slide=12)
for p in range(40, 56, 4):                  # a filter sweep over every four bars
    acid.sweep('lp', 'freq', r(p), r(p + 4), 160, 1400) if (p // 4) % 2 == 0 else acid.sweep('lp', 'freq', r(p), r(p + 4), 1400, 160)

# --------------------------------------------------------------------------------------------------- pad and chords
for b in rng(0, 60):
    n = PAD[CH(b)]
    pad.note(r(b), n, 16, 95)
    if b >= 56:
        pad.span(r(b), 16, volume=round(1.0 - (b - 56) * 0.1, 2))
pad.note(r(60), 57, 16, 90)                  # final Am
pad.note(r(61), 64, 16, 80)
pad.note(r(62), 60, 16, 80)
pad.note(r(63), 57, 16, 80)
pad.span(r(60), 64, volume=0.7)
for i in range(64):
    pad.f(r(60) + i, volume=round(0.7 * (1 - i / 64) ** 1.5, 3))
pad.sweep('lp', 'freq', r(0), r(8), 300, 900)           # intro: opens up
pad.sweep('lp', 'freq', r(32), r(40), 400, 4200)        # breakdown: opens wide before the drop
pad.sweep('lp', 'freq', r(56), r(64), 1100, 250)        # outro: closes again

SAW_BARS = list(rng(24, 32)) + list(rng(40, 56))
for b in SAW_BARS:
    P = ROOT[CH(b)] + 12
    for row, ln in ((0, 3), (3, 3), (6, 2), (10, 3)):
        saw.note(r(b, row), P, ln, 100)
        saw.span(r(b, row), ln, arp={'offsets': [0, THIRD[CH(b)], 7]})
    if b % 4 == 3:
        saw.note(r(b, 13), P + 12, 3, 105)
        saw.span(r(b, 13), 3, arp={'offsets': [0, THIRD[CH(b)], 7, 12]})

# --------------------------------------------------------------------------------------------------- pluck arpeggios
PLUCK_BARS = list(rng(12, 32)) + list(rng(36, 56))
for b in PLUCK_BARS:
    P = ROOT[CH(b)] + 12
    th = THIRD[CH(b)]
    pattern = [0, th, 7, 12, th + 12, 12, 7, th]
    for i, o in enumerate(pattern):
        row = i * 2
        pluck.note(r(b, row), P + o, 2, 100 if i % 2 == 0 else 80)
        if b < 16 or 36 <= b < 40:           # fade in
            frac = (b - 12) / 4 if b < 16 else (b - 36) / 4
            pluck.f(r(b, row), volume=round(0.25 + 0.2 * frac + 0.5 * (1 if i % 2 == 0 else 0.7) * frac, 2))
        elif i % 2 == 1:
            pluck.f(r(b, row), volume=0.75)

# --------------------------------------------------------------------------------------------------- melodies
MEL1 = [  # (bar in cycle, row, midi, length)
    (0, 0, 76, 6), (0, 6, 72, 2), (0, 8, 74, 2), (0, 10, 76, 6),
    (1, 0, 72, 4), (1, 4, 69, 4), (1, 8, 72, 4), (1, 12, 77, 4),
    (2, 0, 79, 6), (2, 6, 76, 2), (2, 8, 74, 4), (2, 12, 72, 4),
    (3, 0, 74, 6), (3, 6, 71, 2), (3, 8, 67, 4), (3, 12, 71, 2), (3, 14, 74, 2),
]
MEL2 = [
    (0, 0, 81, 4), (0, 4, 79, 2), (0, 6, 76, 2), (0, 8, 72, 4), (0, 12, 76, 4),
    (1, 0, 77, 6), (1, 6, 76, 2), (1, 8, 72, 4), (1, 12, 69, 4),
    (2, 0, 76, 3), (2, 3, 79, 3), (2, 6, 76, 2), (2, 8, 74, 2), (2, 10, 72, 2), (2, 12, 74, 4),
    (3, 0, 74, 4), (3, 4, 79, 4), (3, 8, 76, 2), (3, 10, 74, 6),
]


def put(track, mel, start, vel=100, oct_shift=0):
    for cb, row, n, ln in mel:
        track.note(r(start + cb, row), n + oct_shift, ln, vel)


for start, mel in ((4, MEL1), (8, MEL1), (12, MEL2), (16, MEL1), (20, MEL2), (32, MEL1), (36, MEL2),
                   (48, MEL1), (52, MEL2), (56, MEL1)):
    put(bell, mel, start)
bell.note(r(60), 69, 16, 95)                  # a last A that rings out
bell.span(r(60), 16, volume=0.8)
for i in range(16):
    bell.f(r(60) + i, volume=round(0.8 * (1 - i / 16), 2))
for b in range(56, 60):                       # the outro melody fades with the pad
    bell.span(r(b), 16, volume=round(0.9 - 0.1 * (b - 56), 2))

LEAD = [
    [(0, 69, 2), (2, 72, 2), (4, 76, 4), (8, 74, 2), (10, 72, 2), (12, 69, 4)],
    [(0, 69, 2), (2, 72, 2), (4, 77, 4), (8, 76, 2), (10, 72, 2), (12, 69, 4)],
    [(0, 67, 2), (2, 72, 2), (4, 76, 4), (8, 79, 2), (10, 76, 2), (12, 72, 4)],
    [(0, 71, 2), (2, 74, 2), (4, 79, 4), (8, 77, 2), (10, 74, 2), (12, 71, 4)],
]
for b in list(rng(24, 32)) + list(rng(40, 56)):
    for row, n, ln in LEAD[CH(b)]:
        lead.note(r(b, row), n, ln, 105)
    if b % 4 == 3:
        lead.f(r(b, 15), slide=-3)
        lead.f(r(b, 14), slide=-2)

# --------------------------------------------------------------------------------------------------- ambience and effects
rain.note(r(0), 57, 16 * 16, 100)
for i in range(64):
    rain.f(r(12) + i, volume=round(1.0 - i / 64, 3))
rain.note(r(32), 57, 8 * 16, 100)
rain.note(r(56), 57, 8 * 16, 100)
for i in range(32):
    rain.f(r(56) + i, volume=round(0.5 + 0.5 * i / 32, 3))

thunder.note(r(0, 8), 40, 32, 90)             # distant, before the beat
thunder.note(r(32), 36, 64, 110)
thunder.note(r(40), 38, 48, 120)              # the drop
thunder.note(r(60), 36, 64, 90)

riser.note(r(14), 57, 32, 100)
riser.note(r(38), 57, 32, 110)
for start in (r(14), r(38)):
    for i in range(32):
        riser.f(start + i, slide=1)

TRACKS = [kick, snare, hat, ohat, clap, bass, acid, pad, saw, pluck, bell, lead, riser, rain, thunder]

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out = args[0] if args else os.path.join(ROOT_DIR, 'songs', 'neon-rain.json')
    orders = {'instruments': [t.inst for t in TRACKS], 'lanes': [t.lane() for t in TRACKS]}
    if '--orders' in sys.argv:
        json.dump(orders, open(out, 'w'))
    else:
        scene = {
            'format': 'band-game-tracks', 'version': 1, 'exported': '2026-11-19T12:00:00.000Z',
            'build': {'server': 'unknown', 'client': 'unknown'},
            'config': {'bpm': BPM, 'bars': BARS, 'rows_per_bar': RPB, 'seed': '20261119'},
            'orders': orders,
        }
        json.dump(scene, open(out, 'w'), separators=(',', ':'))
    print(out, len(TRACKS), 'tracks')
