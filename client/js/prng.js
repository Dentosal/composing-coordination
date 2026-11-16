// Seeded PRNG. MUST match server/src/prng.rs exactly.
//  - seedFromKey: FNV-1a (32-bit) over the UTF-8 bytes of the key string.
//  - Mulberry32: the classic mulberry32 generator. nextF64 = nextU32 / 2^32, in [0, 1).

export function seedFromKey(key) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(key)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Mulberry32 {
  constructor(seed) {
    this.s = seed >>> 0;
  }

  static fromKey(key) {
    return new Mulberry32(seedFromKey(key));
  }

  nextU32() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  nextF64() {
    return this.nextU32() / 4294967296;
  }

  /** Uniform in [-1, 1). */
  nextBipolar() {
    return this.nextF64() * 2 - 1;
  }
}
