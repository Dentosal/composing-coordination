"""Generates the demo scene client/demos/low-orbit.json and its entry in client/demos/index.json.
Run: python3.14 tools/gen-song-low-orbit.py [out.json] [--orders]  (with an explicit out.json the index is left alone;
with --orders it writes plain orders, for the render CLI, instead of a scene file). Reads the instruments from client/presets.

"Low Orbit": dubstep in F minor, 140 bpm, half-time drums, 96 bars of 16 rows = 2:45.
Chords, two bars each: Fm - Db - Ab - Eb. Every lane plays one note at a time, so the pad chords are three tracks.

The wobble is the wobble preset's filter LFO, its rate automated row by row in step with the tempo: at 140 bpm a row is
1/9.33 s, so an LFO cycle per quarter note is 2.33 Hz, per eighth 4.67 Hz, per eighth triplet 7 Hz, per sixteenth 9.33 Hz.
Each note restarts the LFO, so the wobbles stay on the grid.

Structure (bars, 0-based):
    0- 15  intro:      thunder and pads, a bell motif, the sub from 8, hats from 12, riser and snare build into the drop
   16- 47  drop 1:     half-time kick and snare, wobble bass over the sub, stabs, lasers; second half wobbles faster
   48- 63  breakdown:  drums out; pads, choir and the supersaw lead; half-time kick from 56, a build into drop 2
   64- 87  drop 2:     the wobble answered by a growl, triplet wobbles, the lead on top in the last eight bars
   88- 95  outro:      the bass drops out, pads and bell over the thunder, fading
"""
import json, os, sys

ROOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PRESETS = os.path.join(ROOT_DIR, 'client', 'presets') + os.sep
BPM, BARS, RPB = 140, 96, 16
TOTAL = BARS * RPB
ROWS_PER_SEC = BPM / 60 * 4


def load(preset, id=None, name=None, nodes=None, **over):
    """A preset instrument; `nodes` = {node id: {field: value}} changes its nodes."""
    d = json.load(open(PRESETS + preset + '.json'))['instrument']
    d['id'] = id or preset
    if name:
        d['name'] = name
    d.update(over)
    for n in d['nodes']:
        n.update((nodes or {}).get(n['id'], {}))
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

    def p(self, row, node, port, value, glide=False):
        if 0 <= row < TOTAL:
            cell = self.fx.setdefault(row, {'row': row})
            ps = cell.setdefault('params', [])
            ps[:] = [x for x in ps if (x['node'], x['port']) != (node, port)]
            ps.append({'node': node, 'port': port, 'value': round(value, 2), **({'glide': True} if glide else {})})

    def fade(self, row, length, v0, v1):
        """Volume from v0 to v1 over `length` rows."""
        for i in range(length):
            self.f(row + i, volume=round(v0 + (v1 - v0) * i / max(1, length - 1), 3))

    def sweep(self, node, port, a, b, v0, v1):
        """Automate a node parameter from v0 to v1 over rows a..b (exponential), one gliding entry per row."""
        n = b - a
        for r in range(a, b):
            self.p(r, node, port, v0 * (v1 / v0) ** ((r + 1 - a) / n), glide=True)

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


def bars(*spans):
    return [b for a, z in spans for b in range(a, z)]


CH = lambda b: (b // 2) % 4                               # Fm Db Ab Eb, two bars each
ROOT = [41, 37, 44, 39]                                   # F2 Db2 Ab2 Eb2 (the wobble); the sub plays an octave lower
PAD = [(56, 60, 65), (56, 61, 65), (56, 60, 63), (55, 58, 63)]   # Fm (Ab C F), Db (Ab Db F), Ab (Ab C Eb), Eb (G Bb Eb)
CHOIR = [(65, 72), (65, 68), (63, 72), (63, 70)]

DROP1, BREAK, DROP2, OUTRO = (16, 48), (48, 64), (64, 88), (88, 96)
DROPS = (DROP1, DROP2)

# --------------------------------------------------------------------------------------------------- instruments
kick = Track(load('kick', gain=0.85, nodes={'aenv': {'decay': 0.55}, 'drv': {'drive': 5}}))
snare = Track(load('snare', gain=0.85, send_reverb=0.25))
clap = Track(load('clap', gain=1.0))
hat = Track(load('hat', gain=1.0))
openhat = Track(load('openhat', gain=0.6))
sub = Track(load('sub', gain=0.42))
wobble = Track(load('wobble', gain=0.6, nodes={
    'l3': {'gain': 0.12},                                 # the sub has the low end: only a little of the square's weight
    'lp': {'freq': 900, 'q': 9, 'key_track': 0.2},
    'lfo_c': {'gain': -820},                              # starts closing: each note goes "wow" on the beat
    'drv': {'drive': 5},
}))
growl = Track(load('fmbass', id='growl', name='Growl', gain=0.55, send_reverb=0.05, nodes={
    'lp': {'freq': 1100, 'q': 7},
    'lfo': {'fixed_hz': 9.33},
    'lfo_c': {'gain': 900},
    'drv': {'drive': 8},
}))
pads = [Track(load('dualpad', id=f'pad{i + 1}', name=f'Pad {i + 1}', gain=1.0)) for i in range(3)]
choir = Track(load('choir', gain=1.0))
lead = Track(load('supersaw', id='lead', name='Lead', gain=0.9))
bell = Track(load('fmbell', id='bell', name='Bell', gain=0.8, send_delay=0.35))
stab = Track(load('stab', gain=0.75))
laser = Track(load('laser', gain=0.75))
riser = Track(load('riser', gain=0.55))
thunder = Track(load('thunder', gain=0.55))

# --------------------------------------------------------------------------------------------------- drums
DRUM_BARS = bars(*DROPS)
FILLS = {23, 31, 39, 47, 71, 79, 87}
for b in DRUM_BARS:
    # Half time: kick on 1, snare on 3; a second kick that moves around every other bar.
    kick.hit(r(b, 0), vel=124)
    kick.hit(r(b, 10 if b % 2 == 0 else 6), vel=110)
    if b % 4 == 3 and b not in FILLS:
        kick.hit(r(b, 14), vel=96)
    snare.hit(r(b, 8), vel=124)
    clap.hit(r(b, 8), vel=110)
    if b in FILLS:
        for i, row in enumerate(range(12, 16)):
            snare.hit(r(b, row), vel=100 + 6 * i)
            snare.f(r(b, row), volume=round(0.5 + 0.15 * i, 2), retrig=2 if row >= 14 else 3)
    elif b % 2 == 1:
        snare.hit(r(b, 15), vel=78)                       # a ghost before the next downbeat
for b in bars((12, 16), *DROPS):
    for row in range(0, 16, 2):
        hat.hit(r(b, row), vel=105 if row % 4 == 2 else 72)
        if b < 16:
            hat.f(r(b, row), volume=round(0.3 + 0.6 * ((b - 12) * 16 + row) / 64, 2))
    if b >= 64 and b % 2 == 1:                            # drop 2: 16th-note triplet-ish hat rolls
        hat.f(r(b, 14), retrig=2)
        hat.f(r(b, 6), retrig=3)
for b in DRUM_BARS:
    openhat.hit(r(b, 4), vel=90)
    openhat.hit(r(b, 12), vel=100)

# Builds: the intro's last four bars and the breakdown's last four bars, snare speeding up, then a beat of silence.
for start in (12, 60):
    for b in range(start, start + 4):
        step = (4, 2, 1, 1)[b - start]
        for row in range(0, 16, step):
            if b == start + 3 and row >= 12:
                break                                     # the gap before the drop
            snare.hit(r(b, row), vel=90 + 3 * (b - start) * 3)
            snare.f(r(b, row), volume=round(0.25 + 0.75 * ((b - start) * 16 + row) / 60, 2),
                    **({'retrig': 3} if b == start + 3 and row >= 8 else {}))
for b in range(56, 60):                                   # the breakdown's heartbeat
    kick.hit(r(b, 0), vel=110)
    kick.hit(r(b, 10), vel=90)

# --------------------------------------------------------------------------------------------------- bass
# A wobble pattern is a list of (row, length, rows per LFO cycle, octave); 0 rows per cycle holds the filter (no wobble).
Q, E, T, S = 4, 2, 4 / 3, 1                               # quarter, eighth, eighth triplet, sixteenth
PATTERNS = {
    'a': [(0, 6, Q, 0), (6, 2, E, 0), (8, 8, E, 0)],
    'b': [(0, 4, E, 0), (4, 4, Q, 0), (8, 2, S, 12), (10, 6, E, 0)],
    'c': [(0, 8, E, 0), (8, 4, T, 0), (12, 4, S, 0)],
    'd': [(0, 3, S, 0), (3, 3, E, 0), (6, 2, S, 12), (8, 6, T, 0), (14, 2, S, 12)],
    't': [(0, 16, T, 0)],
    'h': [(0, 12, Q, 0), (12, 4, S, 0)],
}
DROP1_SEQ = 'aaab' * 4 + 'cbcd' * 4                       # 32 bars: steady wobbles, then faster ones from bar 32
DROP2_SEQ = 'cdtd' * 2 + 'hdtd' * 2 + 'cdtt' * 2         # 24 bars (the growl answers in the gaps, below)


def wobble_bar(b, pat):
    root = ROOT[CH(b)]
    for row, ln, cyc, oct in PATTERNS[pat]:
        wobble.note(r(b, row), root + oct, ln, 118 if row == 0 else 104)
        for i in range(ln):
            if cyc:
                wobble.p(r(b, row + i), 'lfo', 'freq', ROWS_PER_SEC / cyc)
            else:
                wobble.p(r(b, row + i), 'lfo', 'freq', 0.01)


for b, pat in zip(range(*DROP1), DROP1_SEQ):
    wobble_bar(b, pat)
for b, pat in zip(range(*DROP2), DROP2_SEQ):
    if b % 4 == 1:
        continue                                          # every fourth bar from 65 belongs to the growl
    wobble_bar(b, pat)
for b in bars(DROP2):
    if b % 4 != 1:
        continue
    root = ROOT[CH(b)]
    for row, ln, off, rate in ((0, 3, 12, 9.33), (3, 3, 12, 14), (6, 2, 7, 4.67), (8, 4, 12, 7), (12, 4, 0, 9.33)):
        growl.note(r(b, row), root + off, ln, 115)
        for i in range(ln):
            growl.p(r(b, row + i), 'lfo', 'freq', rate)
    growl.f(r(b, 15), slide=-5)                           # dives back into the wobble
for b in (47, 87):                                        # a pitch dive at the end of each drop
    wobble.f(r(b, 12), slide=-2)
    wobble.f(r(b, 13), slide=-3)
    wobble.f(r(b, 14), slide=-4)
    wobble.f(r(b, 15), slide=-5)

# Sub: the root an octave down, held through each bar, on every drop bar (and quietly from the intro's middle).
for b in bars((8, 12), *DROPS):
    sub.note(r(b), ROOT[CH(b)] - 12, 15, 110)
    if b < 12:
        sub.fade(r(b), 16, round(0.3 + 0.15 * (b - 8), 2), round(0.3 + 0.15 * (b - 7), 2))

# --------------------------------------------------------------------------------------------------- pads and choir
PAD_BARS = list(range(0, 16, 2)) + list(range(48, 64, 2)) + list(range(88, 96, 2)) + \
    [b for b in range(*DROP2) if b >= 80 and b % 2 == 0]
for b in PAD_BARS:
    for v, t in enumerate(pads):
        t.note(r(b), PAD[CH(b)][v], 31 if b < 94 else 31, 92)
for t in pads:
    t.sweep('lp', 'freq', r(0), r(14), 300, 1600)          # the intro opens up
    t.fade(r(88), 8 * 16, 0.9, 0.0)
for b in range(48, 64, 2):
    choir.note(r(b), CHOIR[CH(b)][0] if (b // 2) % 2 == 0 else CHOIR[CH(b)][1], 31, 85)
choir.fade(r(48), 64, 0.2, 0.9)

# --------------------------------------------------------------------------------------------------- stabs and lasers
for b in bars(DROP1):
    if b % 2 == 1:
        stab.note(r(b, 6), PAD[CH(b)][2] + 12, 1, 100)
        stab.note(r(b, 7), PAD[CH(b)][1] + 12, 1, 90)
for b in bars(DROP1, DROP2):
    if b % 8 == 3:
        for i, row in enumerate((12, 13, 14, 15)):
            laser.hit(r(b, row), 72 + 3 * i, vel=95)
    if b % 8 == 7 and b not in FILLS:
        laser.hit(r(b, 4), 84, vel=100)

# --------------------------------------------------------------------------------------------------- melody
# Bell motif (intro, outro) and the lead (breakdown, end of drop 2): eight bars, two per chord.
MOTIF = [
    [(0, 72, 4), (4, 75, 2), (6, 77, 6), (12, 75, 4), (16, 72, 8), (24, 70, 4), (28, 68, 4)],     # Fm
    [(0, 68, 4), (4, 70, 2), (6, 72, 6), (12, 77, 4), (16, 77, 8), (24, 75, 8)],                   # Db
    [(0, 75, 4), (4, 72, 2), (6, 75, 6), (12, 79, 4), (16, 80, 8), (24, 79, 4), (28, 75, 4)],      # Ab
    [(0, 79, 12), (12, 77, 4), (16, 75, 8), (24, 70, 8)],                                           # Eb
]


def melody(track, start_bar, n_bars, vel=100, octave=0):
    for b in range(start_bar, start_bar + n_bars, 2):
        for row, n, ln in MOTIF[CH(b)]:
            track.note(r(b) + row, n + octave, ln, vel)


melody(bell, 4, 8, vel=90)
bell.fade(r(4), 32, 0.4, 0.9)
melody(bell, 88, 8, vel=85)
bell.fade(r(88), 8 * 16, 0.8, 0.1)
melody(lead, 52, 8)
lead.fade(r(52), 32, 0.4, 1.0)
melody(lead, 80, 8, vel=95)
for b in (59, 87):                                        # bends at the end of a phrase
    lead.f(r(b, 14), slide=-1)
    lead.f(r(b, 15), slide=-2)

# --------------------------------------------------------------------------------------------------- risers and thunder
for start in (r(12), r(60)):
    riser.note(start, 53, 60, 105)
    for i in range(0, 60, 3):
        riser.f(start + i, slide=1)
thunder.note(r(0), 29, 16 * 16 - 1, 100)
thunder.fade(r(0), 64, 0.3, 1.0)
thunder.fade(r(10), 96, 1.0, 0.0)
thunder.note(r(48), 29, 8 * 16, 100)
thunder.fade(r(48), 128, 0.8, 0.0)
thunder.note(r(88), 29, 8 * 16 - 1, 100)
thunder.fade(r(88), 8 * 16, 0.6, 0.0)

TRACKS = [kick, snare, clap, hat, openhat, sub, wobble, growl, *pads, choir, lead, bell, stab, laser, riser, thunder]

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    demos = os.path.join(ROOT_DIR, 'client', 'demos')
    out = args[0] if args else os.path.join(demos, 'low-orbit.json')
    orders = {'instruments': [t.inst for t in TRACKS], 'lanes': [t.lane() for t in TRACKS]}
    if '--orders' in sys.argv:
        json.dump(orders, open(out, 'w'))
    else:
        scene = {
            'format': 'band-game-tracks', 'version': 1, 'exported': '2026-11-19T12:00:00.000Z',
            'build': {'server': 'unknown', 'client': 'unknown'},
            'config': {'bpm': BPM, 'bars': BARS, 'rows_per_bar': RPB, 'seed': '140096'},
            'orders': orders,
        }
        json.dump(scene, open(out, 'w'), separators=(',', ':'))
        if not args:
            path = os.path.join(demos, 'index.json')
            index = [d for d in json.load(open(path)) if d['file'] != 'low-orbit']
            index.append({
                'file': 'low-orbit', 'title': 'Low Orbit', 'artist': 'Claude Opus 5.5',
                'bpm': BPM, 'seconds': round(BARS * 4 * 60 / BPM), 'tracks': len(TRACKS),
            })
            json.dump(index, open(path, 'w'), indent=1)
            open(path, 'a').write('\n')
    print(out, len(TRACKS), 'tracks')
