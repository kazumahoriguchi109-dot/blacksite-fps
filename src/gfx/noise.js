// Seeded procedural noise toolkit. Pure JS, no deps — everything the texture
// generators need to build height fields: value/gradient noise, FBM, domain
// warping, worley/voronoi, and ridged variants.

export function makeRNG(seed = 1337) {
  let s = seed >>> 0;
  return function rng() {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

const PERM_SIZE = 512;

export function makePerm(seed) {
  const rng = makeRNG(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(PERM_SIZE);
  for (let i = 0; i < PERM_SIZE; i++) perm[i] = p[i & 255];
  return perm;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

// 2D gradient noise (Perlin), returns [-1,1]
export function makePerlin2(seed = 1) {
  const perm = makePerm(seed);
  const grads = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  return function perlin2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = perm[(perm[X] + Y) & 255] & 7;
    const ab = perm[(perm[X] + Y + 1) & 255] & 7;
    const ba = perm[(perm[(X + 1) & 255] + Y) & 255] & 7;
    const bb = perm[(perm[(X + 1) & 255] + Y + 1) & 255] & 7;
    const d = (g, dx, dy) => grads[g][0] * dx + grads[g][1] * dy;
    const x1 = lerp(d(aa, xf, yf), d(ba, xf - 1, yf), u);
    const x2 = lerp(d(ab, xf, yf - 1), d(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  };
}

// Tileable Perlin: wraps on a lattice of `period` cells so textures repeat seamlessly.
export function makeTileablePerlin2(seed = 1, period = 16) {
  const perm = makePerm(seed);
  const grads = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  const wrap = (n) => ((n % period) + period) % period;
  return function perlin2(x, y) {
    const X = Math.floor(x), Y = Math.floor(y);
    const xf = x - X, yf = y - Y;
    const u = fade(xf), v = fade(yf);
    const x0 = wrap(X), x1i = wrap(X + 1), y0 = wrap(Y), y1i = wrap(Y + 1);
    const g = (gx, gy) => perm[(perm[gx & 255] + gy) & 255] & 7;
    const d = (gi, dx, dy) => grads[gi][0] * dx + grads[gi][1] * dy;
    const a = lerp(d(g(x0, y0), xf, yf), d(g(x1i, y0), xf - 1, yf), u);
    const b = lerp(d(g(x0, y1i), xf, yf - 1), d(g(x1i, y1i), xf - 1, yf - 1), u);
    return lerp(a, b, v);
  };
}

/** Fractal brownian motion over any 2D noise basis. Returns roughly [-1,1]. */
export function fbm(noise, x, y, { octaves = 6, lacunarity = 2.0, gain = 0.5, freq = 1 } = {}) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * f, y * f) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp creases, good for rock, rust edges, cracked paint. */
export function ridged(noise, x, y, { octaves = 5, lacunarity = 2.0, gain = 0.5, freq = 1 } = {}) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(x * f, y * f));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Billowy (abs) FBM — puffy, good for dirt clumps and grime. */
export function billow(noise, x, y, opts = {}) {
  const { octaves = 5, lacunarity = 2.0, gain = 0.5, freq = 1 } = opts;
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += Math.abs(noise(x * f, y * f)) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Domain-warped FBM. Produces organic, non-repetitive flow — the single
 *  biggest quality lever for making procedural surfaces stop looking procedural. */
export function warpedFbm(noise, x, y, { warp = 0.6, octaves = 6, freq = 1 } = {}) {
  const qx = fbm(noise, x + 0.0, y + 0.0, { octaves: 4, freq });
  const qy = fbm(noise, x + 5.2, y + 1.3, { octaves: 4, freq });
  const rx = fbm(noise, x + warp * qx + 1.7, y + warp * qy + 9.2, { octaves: 4, freq });
  const ry = fbm(noise, x + warp * qx + 8.3, y + warp * qy + 2.8, { octaves: 4, freq });
  return fbm(noise, x + warp * rx, y + warp * ry, { octaves, freq });
}

/**
 * Tileable Worley / cellular noise.
 * Returns { f1, f2, id } — f1 distance to nearest feature point, f2 to second,
 * id a stable per-cell hash useful for flat-shading tiles (bricks, tiles, flakes).
 */
export function makeWorley2(seed = 7, cells = 8) {
  const rng = makeRNG(seed);
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    pts[i * 2] = rng();
    pts[i * 2 + 1] = rng();
  }
  const idHash = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) idHash[i] = rng();

  return function worley(x, y) {
    // x,y in [0,1) texture space
    const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
    let f1 = 1e9, f2 = 1e9, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = ((cx + ox) % cells + cells) % cells;
        const gy = ((cy + oy) % cells + cells) % cells;
        const idx = gy * cells + gx;
        const px = (cx + ox + pts[idx * 2]) / cells;
        const py = (cy + oy + pts[idx * 2 + 1]) / cells;
        const dx = px - x, dy = py - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; id = idHash[idx]; }
        else if (d < f2) { f2 = d; }
      }
    }
    return { f1: f1 * cells, f2: f2 * cells, id };
  };
}

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const mix = lerp;
