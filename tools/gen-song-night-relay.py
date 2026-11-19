"""Generates the demo scene client/demos/night-relay.json and its entry in client/demos/index.json.
Run: python3.14 tools/gen-song-night-relay.py [out.json] [--orders]  (with an explicit out.json the index is left alone;
with --orders it writes plain orders, for the render CLI, instead of a scene file). Reads the instruments from client/presets.

"Night Relay": liquid drum & bass in D minor, 174 bpm, 112 bars of 16 rows = 2:34.
Chords, two bars each: Dm9 - Bbmaj7 - Gm7 - A7. Every lane plays one note at a time, so chords are several tracks
(three string voices, two choir voices).

Structure (bars, 0-based):
    0- 15  intro:      rumble underneath, strings that open up, choir from 8, pluck arpeggio and hats from 8, riser into the drop
   16- 47  drop 1:     two-step drums, reese bass, arpeggio; the lead melody from 32
   48- 63  breakdown:  drums out; choir, strings and the melody on bell over the rumble; half-time kick from 56, snare roll, riser
   64- 95  drop 2:     everything, ride cymbal, reese filter sweeps; the lead with the choir from 80
   96-111  outro:      drums thin out and stop, the chords fade over a last Dm
"""
import json, os, sys

ROOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PRESETS = os.path.join(ROOT_DIR, 'client', 'presets') + os.sep
BPM, BARS, RPB = 174, 112, 16
TOTAL = BARS * RPB


def load(preset, id=None, name=None, **over):
    d = json.load(open(PRESETS + preset + '.json'))['instrument']
    d['id'] = id or preset
    if name:
        d['name'] = name
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

    def fade(self, row, length, v0, v1):
        """Volume from v0 to v1 over `length` rows."""
        for i in range(length):
            self.f(row + i, volume=round(v0 + (v1 - v0) * i / max(1, length - 1), 3))

    def sweep(self, node, port, a, b, v0, v1, glide=True):
        """Automate a node parameter from v0 to v1 over rows a..b (exponential), one entry per row."""
        n = b - a
        for r in range(a, b):
            if 0 <= r < TOTAL:
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


def bars(*spans):
    """bars((16, 48), (64, 96)) -> every bar in those half-open spans."""
    return [b for a, z in spans for b in range(a, z)]


# Chords, two bars each, eight-bar cycle. CH(b) is the chord of bar b.
CH = lambda b: (b // 2) % 4
BASS = [38, 34, 31, 33]                                   # D2 Bb1 G1 A1
STRINGS = [(53, 57, 64), (53, 57, 62), (53, 58, 62), (52, 55, 61)]   # Dm9 (F A E), Bbmaj7 (F A D), Gm7 (F Bb D), A7 (E G C#)
CHOIR = [(62, 69), (62, 65), (62, 67), (61, 64)]
ARP = [(62, 65, 69, 72, 76), (62, 65, 69, 70, 74), (62, 65, 67, 70, 74), (61, 64, 67, 69, 73)]

DROPS = ((16, 48), (64, 96))
INTRO, BREAK, OUTRO = (0, 16), (48, 64), (96, 112)

# --------------------------------------------------------------------------------------------------- instruments
kick = Track(load('kick', gain=1.0))
snare = Track(load('snare', gain=1.0))
hat = Track(load('hat', gain=1.0))
ride = Track(load('openhat', id='ride', name='Ride', gain=0.5))
shaker = Track(load('shaker', gain=0.45))
clave = Track(load('clave', id='ghost', name='Ghost clave', gain=0.5))
reese = Track(load('reese', gain=0.6))
strings = [Track(load('strings', id=f'str{i + 1}', name=f'Strings {i + 1}', gain=0.42)) for i in range(3)]
choir = [Track(load('choir', id=f'choir{i + 1}', name=f'Choir {i + 1}', gain=0.55)) for i in range(2)]
pluck = Track(load('pluck', gain=0.4))
lead = Track(load('lead', gain=0.5))
bell = Track(load('fmbell', id='bell', name='Bell', gain=0.6))
riser = Track(load('riser', gain=0.55))
rumble = Track(load('rumble', gain=0.3))

# --------------------------------------------------------------------------------------------------- drums
FILLS = {23, 31, 39, 47, 71, 79, 87, 95}                  # the last bar of each eight-bar phrase
DRUM_BARS = bars(*DROPS, (96, 104))
for b in DRUM_BARS:
    # Two-step: kick on 1 and the "and" of 3, snare on 2 and 4.
    kick.hit(r(b, 0), vel=120)
    kick.hit(r(b, 10), vel=110)
    if b % 2 == 1 and b not in FILLS:
        kick.hit(r(b, 14), vel=92)
    snare.hit(r(b, 4), vel=118)
    if b in FILLS:
        for row in range(12, 16):                         # a roll into the next phrase
            snare.hit(r(b, row), vel=100 + 4 * (row - 12))
            snare.f(r(b, row), volume=round(0.55 + 0.15 * (row - 12), 2), retrig=3)
    else:
        snare.hit(r(b, 12), vel=118)
    # ghost notes: the soft knocks between the backbeats that make it roll
    for row in ((7, 15) if b % 2 == 0 else (2, 9)):
        if not (b in FILLS and row >= 12):
            clave.hit(r(b, row), vel=60)

for b in bars((8, 16), *DROPS, (96, 104)):                # hats: 8ths, the off-beats louder
    for row in range(0, 16, 2):
        hat.hit(r(b, row), vel=100 if row % 4 == 2 else 70)
        if b < 16:
            hat.f(r(b, row), volume=round(0.35 + 0.6 * (b - 8 + row / 16) / 8, 2))
        elif b >= 100:
            hat.f(r(b, row), volume=round(0.9 - 0.2 * (b - 100), 2))
for b in bars(*DROPS):                                    # shaker: 16ths, swung by velocity
    for row in range(16):
        shaker.hit(r(b, row), vel=95 if row % 2 else 55)
for b in bars((64, 96)):                                  # ride on the beat in drop 2
    for row in (0, 4, 8, 12):
        ride.hit(r(b, row), vel=90 if row else 105)

# Breakdown: a half-time heartbeat from bar 56, then a snare roll that speeds up into drop 2.
for b in range(56, 62):
    kick.hit(r(b, 0), vel=105)
    if b % 2 == 1:
        kick.hit(r(b, 10), vel=85)
    snare.hit(r(b, 8), vel=100)
for b in (62, 63):
    for row in range(0, 16, 2 if b == 62 else 1):
        snare.hit(r(b, row), vel=95 + (b - 62) * 15)
        snare.f(r(b, row), volume=round(0.3 + 0.7 * ((b - 62) * 16 + row) / 32, 2), **({'retrig': 3} if b == 63 and row >= 8 else {}))
for i in range(8):                                        # the intro's last half bar: a short roll into drop 1
    snare.hit(r(15, 8 + i), vel=90 + 5 * i)
    snare.f(r(15, 8 + i), volume=round(0.3 + 0.1 * i, 2))

# --------------------------------------------------------------------------------------------------- reese bass
for b in bars(*DROPS):
    R = BASS[CH(b)]
    if b % 2 == 0:
        pattern = ((0, 0, 6), (8, 0, 2), (10, 0, 6))
    else:
        pattern = ((0, 0, 4), (6, 12, 2), (10, 0, 3), (14, 7, 2))
    for row, off, ln in pattern:
        reese.note(r(b, row), R + off, ln, 115 if row == 0 else 100)
    if b % 8 == 7:
        nxt = BASS[CH(b + 1)]                             # at the end of a phrase, dive towards the next chord's root
        reese.f(r(b, 15), slide=max(-12, min(12, nxt - (R + 7))))
for p in range(64, 96, 4):                                # drop 2: the filter breathes over every four bars
    lo, hi = 260, 1500
    if (p // 4) % 2 == 0:
        reese.sweep('lp', 'freq', r(p), r(p + 4), lo, hi)
    else:
        reese.sweep('lp', 'freq', r(p), r(p + 4), hi, lo)

# --------------------------------------------------------------------------------------------------- strings and choir
for b in range(0, 104, 2):                                # a chord every two bars; the outro's last chord comes below
    c = CH(b)
    for v, t in enumerate(strings):
        t.note(r(b), STRINGS[c][v], 32, 90)
for t in strings:
    t.sweep('lp', 'freq', r(0), r(12), 500, 2800)         # the intro opens up
    t.sweep('lp', 'freq', r(96), r(104), 2800, 900)       # the outro closes
CHOIR_BARS = bars((8, 16), BREAK, (80, 104))
for b in CHOIR_BARS:
    if b % 2 == 0:
        for v, t in enumerate(choir):
            t.note(r(b), CHOIR[CH(b)][v], 32, 85)
for t in choir:
    t.fade(r(8), 64, 0.2, 0.8)                            # fades in over the intro's second half
    t.fade(r(96), 128, 0.8, 0.3)

# The last chord: Dm9 held for the final eight bars, fading out.
for v, t in enumerate(strings):
    t.note(r(104), STRINGS[0][v], 8 * 16 - 1, 85)
    t.fade(r(104), 8 * 16, 0.9, 0.0)
for v, t in enumerate(choir):
    t.note(r(104), CHOIR[0][v], 8 * 16 - 1, 80)
    t.fade(r(104), 8 * 16, 0.3, 0.0)

# --------------------------------------------------------------------------------------------------- pluck arpeggio
UPDOWN = [0, 1, 2, 3, 4, 3, 2, 1]
for b in bars((8, 16), *DROPS, (96, 100)):
    tones = ARP[CH(b)]
    for row in range(16):
        n = tones[UPDOWN[row % 8]] + (12 if (b % 8 == 7 and row >= 8) else 0)   # up an octave at the end of a phrase
        pluck.note(r(b, row), n, 1, 100 if row % 4 == 0 else 78)
    if b < 16:
        pluck.fade(r(b), 16, round(0.2 + 0.8 * (b - 8) / 8, 2), round(0.2 + 0.8 * (b - 7) / 8, 2))
    elif b >= 96:
        pluck.fade(r(b), 16, round(1 - 0.25 * (b - 96), 2), round(1 - 0.25 * (b - 95), 2))
    elif 80 <= b < 96:
        for row in range(16):
            pluck.f(r(b, row), volume=0.7)                # makes room for the lead and choir

# --------------------------------------------------------------------------------------------------- melody
# Eight bars, two per chord: (row in the two-bar block, midi, length).
MELODY = [
    [(0, 69, 6), (6, 72, 2), (8, 74, 8), (16, 76, 4), (20, 74, 4), (24, 72, 4), (28, 69, 4)],      # Dm9
    [(0, 70, 6), (6, 69, 2), (8, 65, 8), (16, 69, 4), (20, 70, 4), (24, 72, 8)],                    # Bbmaj7
    [(0, 74, 6), (6, 72, 2), (8, 70, 8), (16, 67, 4), (20, 70, 4), (24, 74, 4), (28, 77, 4)],      # Gm7
    [(0, 76, 12), (12, 73, 4), (16, 76, 4), (20, 79, 4), (24, 76, 8)],                              # A7
]


def melody(track, start_bar, n_bars, vel=105, octave=0):
    for b in range(start_bar, start_bar + n_bars, 2):
        for row, n, ln in MELODY[CH(b)]:
            track.note(r(b) + row, n + octave, ln, vel)


melody(lead, 32, 16)
melody(lead, 80, 16)
for b in (39, 47, 87, 95):                                # a falling slide at the end of each phrase
    lead.f(r(b, 14), slide=-1)
    lead.f(r(b, 15), slide=-2)
melody(bell, 48, 16, vel=95, octave=12)
bell.fade(r(48), 32, 0.4, 0.9)
bell.note(r(104), 74, 64, 90)                             # a last D that rings out
bell.fade(r(104), 64, 0.7, 0.0)

# --------------------------------------------------------------------------------------------------- risers and rumble
for start in (r(12), r(60)):
    riser.note(start, 50, 64, 105)
    for i in range(0, 64, 3):                             # climbs about an octave and a half over the four bars
        riser.f(start + i, slide=1)
rumble.note(r(0), 38, 16 * 16, 100)                       # D2: the deepest the preset goes comfortably
rumble.fade(r(0), 64, 0.3, 1.0)
rumble.fade(r(12), 64, 1.0, 0.0)
rumble.note(r(48), 38, 16 * 16, 110)
rumble.fade(r(48), 32, 0.2, 1.0)
rumble.note(r(104), 38, 8 * 16 - 1, 90)
rumble.fade(r(104), 8 * 16, 0.8, 0.0)

TRACKS = [kick, snare, clave, hat, shaker, ride, reese, *strings, *choir, pluck, lead, bell, riser, rumble]

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    demos = os.path.join(ROOT_DIR, 'client', 'demos')
    out = args[0] if args else os.path.join(demos, 'night-relay.json')
    orders = {'instruments': [t.inst for t in TRACKS], 'lanes': [t.lane() for t in TRACKS]}
    if '--orders' in sys.argv:
        json.dump(orders, open(out, 'w'))
    else:
        scene = {
            'format': 'band-game-tracks', 'version': 1, 'exported': '2026-11-19T12:00:00.000Z',
            'build': {'server': 'unknown', 'client': 'unknown'},
            'config': {'bpm': BPM, 'bars': BARS, 'rows_per_bar': RPB, 'seed': '174112'},
            'orders': orders,
        }
        json.dump(scene, open(out, 'w'), separators=(',', ':'))
        if not args:
            path = os.path.join(demos, 'index.json')
            index = [d for d in json.load(open(path)) if d['file'] != 'night-relay']
            index.append({
                'file': 'night-relay', 'title': 'Night Relay', 'artist': 'Claude Opus 5.5',
                'bpm': BPM, 'seconds': round(BARS * 4 * 60 / BPM), 'tracks': len(TRACKS),
            })
            json.dump(index, open(path, 'w'), indent=1)
            open(path, 'a').write('\n')
    print(out, len(TRACKS), 'tracks')
