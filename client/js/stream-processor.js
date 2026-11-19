// AudioWorkletProcessor for the streaming player (stream.js): plays the audio that the render worker (live-worker.js)
// writes into the shared ring. It runs on the audio thread, so it only copies: it never waits and never allocates.
//
// It is locked to the AudioContext clock: frame 0 of the run plays at context frame `startFrame` (so a run started
// at the same time as the band mix stays in step with it), and frame f at startFrame + f. Audio that is not there in
// time is skipped, not waited for, and counted as an underrun: a late block costs a moment of silence, never sync.
// The ring layout is ring.js's (repeated here: a worklet cannot rely on module imports in every browser).

const WRITE = 0, READ = 1, UNDERRUNS = 2, STARTED = 5;
const HEADER_INTS = 8;

class RingPlayer extends AudioWorkletProcessor {
  constructor({ processorOptions: { ring, capacity, startFrame } }) {
    super();
    this.capacity = capacity;
    this.startFrame = startFrame;
    this.header = new Int32Array(ring, 0, HEADER_INTS);
    this.left = new Float32Array(ring, HEADER_INTS * 4, capacity);
    this.right = new Float32Array(ring, HEADER_INTS * 4 + capacity * 4, capacity);
  }

  process(_inputs, outputs) {
    const [outL, outR] = outputs[0];
    const n = outL.length;
    const h = this.header;
    // Which run frames this block covers (the start may fall inside it).
    const from = currentFrame - this.startFrame;
    if (from + n <= 0) {
      outL.fill(0);
      outR?.fill(0);
      return true;
    }
    const skip = Math.max(0, -from); // leading frames before the run starts
    const first = from + skip; // the first run frame to play
    const want = n - skip;
    const write = Atomics.load(h, WRITE);
    if (write < first + want) {
      // Not rendered in time: silence (keeping the clock), and count it once playback is under way.
      outL.fill(0);
      outR?.fill(0);
      if (Atomics.load(h, STARTED)) Atomics.add(h, UNDERRUNS, 1);
    } else {
      outL.fill(0, 0, skip);
      outR?.fill(0, 0, skip);
      for (let i = 0; i < want; i++) {
        const at = (first + i) % this.capacity;
        outL[skip + i] = this.left[at];
        if (outR) outR[skip + i] = this.right[at];
      }
      Atomics.store(h, STARTED, 1);
    }
    Atomics.store(h, READ, first + want);
    Atomics.notify(h, READ);
    return true;
  }
}

registerProcessor('ring-player', RingPlayer);
