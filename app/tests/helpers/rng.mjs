// Deterministic PRNG for property-style stress tests. Tests must be
// reproducible from the seed alone, so never mix in Math.random().

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rand, maxExclusive) {
  return Math.floor(rand() * maxExclusive);
}

export function pick(rand, values) {
  return values[randomInt(rand, values.length)];
}
