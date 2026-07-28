import * as THREE from 'three';
import {
  makeTileablePerlin2, makeWorley2, fbm, ridged, billow, warpedFbm,
  makeRNG, clamp, smoothstep, mix,
} from './noise.js';

/*
 * Procedural PBR texture generation.
 *
 * Every material is a "surface function" sampled per texel that returns a
 * height, albedo, roughness and metalness. The driver then derives a tangent-
 * space normal map from the height field (Sobel) and a cavity/AO map from the
 * difference between the height and a blurred copy of it. Doing it this way
 * means normals and AO always agree with the albedo, which is what stops
 * procedural surfaces from reading as flat noise.
 *
 * All noise bases are tileable, so every map repeats seamlessly.
 */

const CACHE = new Map();

// -------------------------------------------------------------- helpers ----

/*
 * Albedo is authored in *display* (sRGB) values — the numbers below are what
 * you'd pick in an image editor — and the map is tagged SRGBColorSpace so the
 * renderer linearises it. Real-world sRGB albedo references: fresh concrete
 * ~0.60, weathered asphalt ~0.25, red brick ~0.40, gun bluing ~0.22.
 */

/** Build a tangent-space normal map from a height field using a Sobel filter. */
function heightToNormal(height, size, strength) {
  const out = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1.0;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Separable box blur over a Float32 height field (wraps, so it stays tileable). */
function blurField(src, size, radius) {
  const tmp = new Float32Array(size * size);
  const dst = new Float32Array(size * size);
  const n = radius * 2 + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += src[y * size + ((x + k + size) % size)];
      tmp[y * size + x] = s / n;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[((y + k + size) % size) * size + x];
      dst[y * size + x] = s / n;
    }
  }
  return dst;
}

/** Cavity map: where the surface sits below its local average, it's occluded. */
function heightToAO(height, size, radius, strength) {
  const blurred = blurField(height, size, radius);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const d = height[i] - blurred[i];
    const ao = clamp(1.0 + d * strength, 0, 1);
    const v = ao * 255;
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}

function makeTexture(data, size, { srgb = false, aniso = 8, repeat = [1, 1] } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------- surfaces ----
/*
 * Each surface returns { h, r, g, b, rough, metal } for a UV in [0,1).
 * Colours are authored in sRGB-ish 0..1 and converted on write.
 */

function surfaceConcrete(seed) {
  // Noise period must divide the sampling frequency below or the map won't wrap.
  const p = makeTileablePerlin2(seed, 8);          // sampled at u*8
  const p2 = makeTileablePerlin2(seed + 91, 64);   // sampled at u*64
  const pores = makeWorley2(seed + 3, 130);   // ~2 cm voids at a 3 m tile
  const cracks = makeTileablePerlin2(seed + 55, 5); // sampled at u*5
  const stains = makeTileablePerlin2(seed + 771, 3); // sampled at u*3
  return (u, v) => {
    // Broad tonal blotching so large surfaces don't read as one flat colour.
    const base = warpedFbm((x, y) => p(x, y), u * 8, v * 8, { warp: 0.9, octaves: 5 });
    const fine = fbm((x, y) => p2(x, y), u * 64, v * 64, { octaves: 4 });
    const w = pores(u, v);
    // Only a minority of cells actually contain a void, and they cluster —
    // uniform coverage is what made this read as golf-ball dimpling.
    const poreMask = w.id > 0.72 ? 1 : 0;
    const pit = smoothstep(0.30, 0.0, w.f1) * 0.5 * poreMask;
    const agg = smoothstep(0.55, 0.85, w.f2 - w.f1) * 0.06;  // exposed aggregate

    // Hairline cracking driven by a ridged field.
    const cr = ridged((x, y) => cracks(x, y), u * 5, v * 5, { octaves: 4 });
    const crack = smoothstep(0.86, 0.98, cr) * 0.9;

    let h = 0.5 + base * 0.055 + fine * 0.035 - pit * 0.30 - crack * 0.22 + agg;

    const st = fbm((x, y) => stains(x, y), u * 3, v * 3, { octaves: 4 }) * 0.5 + 0.5;
    let tone = 0.585 + base * 0.11 + fine * 0.04;
    tone *= mix(0.82, 1.06, st);
    tone -= crack * 0.11;
    tone -= pit * 0.09;

    // Slight warm/cool variation keeps grey from looking dead.
    const r = tone * 1.02, g = tone * 1.0, b = tone * 0.965;
    const rough = clamp(0.86 + fine * 0.08 - agg * 0.2 + st * 0.05, 0.4, 1.0);
    return { h, r, g, b, rough, metal: 0 };
  };
}

function surfaceAsphalt(seed) {
  const p = makeTileablePerlin2(seed, 90);          // sampled at u*90
  const grit = makeWorley2(seed + 12, 170);   // ~2.4 cm chippings at a 4 m tile
  const patch = makeTileablePerlin2(seed + 300, 4);  // sampled at u*4
  return (u, v) => {
    const g = grit(u, v);
    const stone = smoothstep(0.75, 0.25, g.f1) * 0.55;
    const fine = fbm((x, y) => p(x, y), u * 90, v * 90, { octaves: 4 });
    const pa = warpedFbm((x, y) => patch(x, y), u * 4, v * 4, { warp: 1.1, octaves: 4 });

    const h = 0.5 + stone * 0.055 + fine * 0.022 + pa * 0.018;
    // Asphalt is a low-contrast dark grey. Its large-scale variation comes from
    // patching and tyre polish, not from per-stone albedo.
    let tone = 0.225 + stone * 0.045 + fine * 0.018 + Math.max(0, pa) * 0.035;
    // Occasional lighter repaired patches.
    tone += smoothstep(0.25, 0.5, pa) * 0.045;
    // Polished wheel tracks are the main roughness story on a used road.
    const polish = smoothstep(0.15, 0.55, pa);
    const rough = clamp(0.94 - stone * 0.06 - polish * 0.26 + fine * 0.03, 0.42, 1);
    return { h, r: tone * 1.0, g: tone * 0.99, b: tone * 1.02, rough, metal: 0 };
  };
}

function surfaceBrick(seed) {
  const p = makeTileablePerlin2(seed, 6);           // sampled at u*6
  const grain = makeTileablePerlin2(seed + 17, 150); // sampled at u*150
  const rng = makeRNG(seed + 5);
  // Per-brick colour jitter table.
  const ROWS = 16, COLS = 8;
  const jitter = new Float32Array(ROWS * COLS * 3);
  for (let i = 0; i < ROWS * COLS * 3; i++) jitter[i] = rng();

  return (u, v) => {
    const rowF = v * ROWS;
    const row = Math.floor(rowF);
    const offset = (row % 2) * 0.5;             // running bond
    const colF = u * COLS + offset;
    const col = Math.floor(colF);
    const fu = colF - col, fv = rowF - row;

    const mortarW = 0.055, mortarH = 0.10;
    const inBrickU = smoothstep(0, mortarW, fu) * smoothstep(1, 1 - mortarW, fu);
    const inBrickV = smoothstep(0, mortarH, fv) * smoothstep(1, 1 - mortarH, fv);
    const brick = inBrickU * inBrickV;

    const idx = ((row % ROWS + ROWS) % ROWS) * COLS + ((col % COLS + COLS) % COLS);
    const j0 = jitter[idx * 3], j1 = jitter[idx * 3 + 1], j2 = jitter[idx * 3 + 2];

    const gr = fbm((x, y) => grain(x, y), u * 150, v * 150, { octaves: 3 });
    const weather = warpedFbm((x, y) => p(x, y), u * 6, v * 6, { warp: 0.8, octaves: 5 });

    // Brick body colour: warm red-browns with heavy per-unit variation.
    let br = 0.400 + j0 * 0.10, bg = 0.268 + j1 * 0.060, bb = 0.232 + j2 * 0.050;
    // Some bricks are much darker (over-fired) — adds the irregularity real walls have.
    if (j2 > 0.82) { br *= 0.55; bg *= 0.6; bb *= 0.72; }
    br += gr * 0.05; bg += gr * 0.035; bb += gr * 0.03;

    const mr = 0.635 + gr * 0.06, mg = 0.625 + gr * 0.06, mb = 0.60 + gr * 0.06;

    const r = mix(mr, br, brick), g2 = mix(mg, bg, brick), b2 = mix(mb, bb, brick);
    const dark = clamp(0.82 + weather * 0.3, 0.6, 1.15);

    const h = 0.47 + brick * 0.055 + gr * 0.014;
    const rough = clamp(mix(0.95, 0.78 + j1 * 0.12, brick) + gr * 0.05, 0.4, 1);
    return { h, r: r * dark, g: g2 * dark, b: b2 * dark, rough, metal: 0 };
  };
}

function surfaceMetalPanel(seed, opts = {}) {
  const { tint = [0.55, 0.58, 0.615], rust = 0.35, panels = 4 } = opts;
  const p = makeTileablePerlin2(seed, 10);           // sampled at u*10
  const scratch = makeTileablePerlin2(seed + 44, 260); // sampled at v*260
  const rustN = makeTileablePerlin2(seed + 909, 7);  // sampled at u*7
  const rivets = makeWorley2(seed + 21, panels * 2);
  return (u, v) => {
    // Panel seams.
    const pu = u * panels, pv = v * panels;
    const su = Math.abs(pu - Math.round(pu)), sv = Math.abs(pv - Math.round(pv));
    const seam = 1 - smoothstep(0.0, 0.035, Math.min(su, sv));

    // Anisotropic brushed scratches (stretched along U).
    const scr = fbm((x, y) => scratch(x, y), u * 6, v * 260, { octaves: 4 });
    const dents = warpedFbm((x, y) => p(x, y), u * 10, v * 10, { warp: 0.7, octaves: 4 });

    // Rivets on the seams.
    const rv = rivets(u, v);
    const rivet = smoothstep(0.16, 0.06, rv.f1) * (rv.id > 0.45 ? 1 : 0);

    // Rust blooms, biased to seams and low areas where water sits.
    let rn = billow((x, y) => rustN(x, y), u * 7, v * 7, { octaves: 5 });
    rn = clamp(rn * 1.5 + seam * 0.35 - 0.25, 0, 1);
    const rustAmt = clamp(smoothstep(0.42, 0.8, rn) * rust * 1.6, 0, 1);

    let h = 0.5 + dents * 0.06 + scr * 0.02 - seam * 0.18 + rivet * 0.22 - rustAmt * 0.06;

    let r = tint[0] + dents * 0.05 + scr * 0.03;
    let g = tint[1] + dents * 0.05 + scr * 0.03;
    let b = tint[2] + dents * 0.05 + scr * 0.03;
    r *= 1 - seam * 0.35; g *= 1 - seam * 0.35; b *= 1 - seam * 0.35;

    // Rust colour: orange-brown, and it kills both metalness and gloss.
    const rr = 0.475 + rn * 0.16, rg = 0.265 + rn * 0.085, rb = 0.145 + rn * 0.05;
    r = mix(r, rr, rustAmt); g = mix(g, rg, rustAmt); b = mix(b, rb, rustAmt);

    const rough = clamp(mix(0.34 + Math.abs(scr) * 0.28 + seam * 0.2, 0.94, rustAmt), 0.1, 1);
    const metal = mix(1.0, 0.0, rustAmt);
    return { h, r, g, b, rough, metal };
  };
}

function surfacePaintedMetal(seed, opts = {}) {
  const { color = [0.285, 0.335, 0.385] } = opts;
  const p = makeTileablePerlin2(seed, 24);
  const chip = makeWorley2(seed + 61, 30);
  const scratch = makeTileablePerlin2(seed + 8, 160);
  return (u, v) => {
    const c = chip(u, v);
    // Paint chipping away at cell edges, exposing bare metal underneath.
    const edge = smoothstep(0.18, 0.02, c.f2 - c.f1);
    const wear = warpedFbm((x, y) => p(x, y), u * 9, v * 9, { warp: 0.9, octaves: 4 });
    const chipped = clamp(edge * smoothstep(-0.05, 0.3, wear) * (c.id > 0.35 ? 1 : 0.2), 0, 1);
    const scr = fbm((x, y) => scratch(x, y), u * 200, v * 12, { octaves: 3 });

    let r = color[0] * (1 + wear * 0.22), g = color[1] * (1 + wear * 0.22), b = color[2] * (1 + wear * 0.22);
    const bare = 0.55 + scr * 0.07;
    r = mix(r, bare * 1.02, chipped); g = mix(g, bare, chipped); b = mix(b, bare * 0.98, chipped);

    const h = 0.5 + wear * 0.03 - chipped * 0.12 + scr * 0.012;
    const rough = clamp(mix(0.42 + wear * 0.14, 0.5 + Math.abs(scr) * 0.2, chipped), 0.1, 1);
    return { h, r, g, b, rough, metal: chipped * 0.9 };
  };
}

function surfaceWood(seed) {
  const p = makeTileablePerlin2(seed, 4);            // sampled at u*4
  const fine = makeTileablePerlin2(seed + 13, 14);  // sampled at u*14
  const rng = makeRNG(seed + 2);
  const PLANKS = 7;
  const jit = new Float32Array(PLANKS * 3);
  for (let i = 0; i < PLANKS * 3; i++) jit[i] = rng();
  return (u, v) => {
    const pf = v * PLANKS;
    const pi = Math.floor(pf);
    const fv = pf - pi;
    const gap = 1 - smoothstep(0.0, 0.03, Math.min(fv, 1 - fv));
    const j = jit[((pi % PLANKS) + PLANKS) % PLANKS * 3];
    const j2 = jit[(((pi % PLANKS) + PLANKS) % PLANKS) * 3 + 1];

    // Grain: stretched noise + concentric rings.
    const warp = fbm((x, y) => p(x, y), u * 4, v * 30, { octaves: 4 }) * 0.4;
    // Integer cycles across u, otherwise the grain visibly jumps at the seam.
    const rings = Math.sin(u * Math.PI * 2 * 4 + warp * 8 + j * 20) * 0.5 + 0.5;
    const ringSharp = Math.pow(rings, 3);
    const gr = fbm((x, y) => fine(x, y), u * 14, v * 220, { octaves: 3 });

    let tone = 0.44 + j2 * 0.11 - ringSharp * 0.12 + gr * 0.055;
    let r = tone * 1.24, g = tone * 0.88, b = tone * 0.56;
    r *= 1 - gap * 0.7; g *= 1 - gap * 0.7; b *= 1 - gap * 0.7;

    const h = 0.5 - ringSharp * 0.07 + gr * 0.03 - gap * 0.5;
    const rough = clamp(0.72 + ringSharp * 0.14 + gr * 0.06, 0.4, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

function surfaceTile(seed) {
  const p = makeTileablePerlin2(seed, 100);          // sampled at u*100
  const grime = makeTileablePerlin2(seed + 400, 6);  // sampled at u*6
  const N = 8;
  const rng = makeRNG(seed + 71);
  const jit = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) jit[i] = rng();
  return (u, v) => {
    const tu = u * N, tv = v * N;
    const cx = Math.floor(tu), cy = Math.floor(tv);
    const fu = tu - cx, fv = tv - cy;
    const gw = 0.045;
    const inTile = smoothstep(0, gw, fu) * smoothstep(1, 1 - gw, fu)
                 * smoothstep(0, gw, fv) * smoothstep(1, 1 - gw, fv);
    const j = jit[(((cy % N) + N) % N) * N + (((cx % N) + N) % N)];

    const g = warpedFbm((x, y) => grime(x, y), u * 6, v * 6, { warp: 1.0, octaves: 5 });
    const dirt = clamp(smoothstep(0.0, 0.45, g) * 0.6 + (1 - inTile) * 0.5, 0, 1);
    const spec = fbm((x, y) => p(x, y), u * 100, v * 100, { octaves: 3 });

    let base = 0.615 + j * 0.10 + spec * 0.035;
    let r = base * 1.0, gg = base * 1.005, b = base * 0.98;
    // Grout is darker and rougher.
    r = mix(r * 0.62, r, inTile); gg = mix(gg * 0.62, gg, inTile); b = mix(b * 0.62, b, inTile);
    r *= 1 - dirt * 0.42; gg *= 1 - dirt * 0.44; b *= 1 - dirt * 0.40;

    const h = 0.5 + inTile * 0.10 + spec * 0.01;
    const rough = clamp(mix(0.9, 0.22 + dirt * 0.55 + spec * 0.05, inTile), 0.08, 1);
    return { h, r, g: gg, b, rough, metal: 0 };
  };
}

function surfaceGravel(seed) {
  const w1 = makeWorley2(seed, 22);
  const w2 = makeWorley2(seed + 5, 44);
  const p = makeTileablePerlin2(seed + 88, 80);      // sampled at u*80
  return (u, v) => {
    const a = w1(u, v), b = w2(u, v);
    const big = smoothstep(0.75, 0.0, a.f1);
    const small = smoothstep(0.6, 0.0, b.f1);
    const fine = fbm((x, y) => p(x, y), u * 80, v * 80, { octaves: 4 });
    const h = 0.46 + big * 0.11 + small * 0.055 + fine * 0.022;
    // Per-stone colour from the cell id.
    const idT = a.id;
    let tone = 0.335 + idT * 0.075 + fine * 0.025 + big * 0.03;
    const r = tone * 1.05, g = tone * 1.0, bb = tone * 0.93;
    const rough = clamp(0.88 + fine * 0.08 - big * 0.1, 0.5, 1);
    return { h, r, g, b: bb, rough, metal: 0 };
  };
}

function surfacePlaster(seed) {
  const p = makeTileablePerlin2(seed, 110);        // sampled at u*110
  const trowel = makeTileablePerlin2(seed + 66, 5); // sampled at u*5
  const damage = makeWorley2(seed + 900, 12);
  return (u, v) => {
    const t = warpedFbm((x, y) => trowel(x, y), u * 5, v * 5, { warp: 1.4, octaves: 4 });
    const fine = fbm((x, y) => p(x, y), u * 110, v * 110, { octaves: 4 });
    const d = damage(u, v);
    // Patches where plaster has fallen away.
    const hole = smoothstep(0.34, 0.12, d.f1) * (d.id > 0.72 ? 1 : 0);

    const h = 0.5 + t * 0.06 + fine * 0.03 - hole * 0.35;
    let tone = 0.685 + t * 0.09 + fine * 0.035;
    tone = mix(tone, 0.44, hole);
    const rough = clamp(mix(0.88 + fine * 0.06, 0.95, hole), 0.5, 1);
    return { h, r: tone * 1.01, g: tone * 0.995, b: tone * 0.955, rough, metal: 0 };
  };
}

function surfaceSandbag(seed) {
  const p = makeTileablePerlin2(seed, 32);
  const weave = makeTileablePerlin2(seed + 4, 256);
  return (u, v) => {
    // Woven hessian: two perpendicular sine bands modulated by noise.
    const wu = Math.sin(u * Math.PI * 2 * 120) * 0.5 + 0.5;
    const wv = Math.sin(v * Math.PI * 2 * 120) * 0.5 + 0.5;
    const wv2 = fbm((x, y) => weave(x, y), u * 200, v * 200, { octaves: 2 });
    const cloth = (wu * 0.5 + wv * 0.5) + wv2 * 0.2;
    const dirt = warpedFbm((x, y) => p(x, y), u * 6, v * 6, { warp: 1.0, octaves: 5 });
    const h = 0.5 + cloth * 0.09 + dirt * 0.06;
    let tone = 0.44 + cloth * 0.07 + dirt * 0.09;
    const r = tone * 1.14, g = tone * 1.02, b = tone * 0.72;
    return { h, r, g, b, rough: clamp(0.94 + cloth * 0.04, 0.6, 1), metal: 0 };
  };
}

function surfaceGunMetal(seed) {
  const p = makeTileablePerlin2(seed, 64);
  const scratch = makeTileablePerlin2(seed + 31, 256);
  const specks = makeWorley2(seed + 12, 60);
  return (u, v) => {
    // Fine parkerised / bead-blasted finish with directional wear on edges.
    const grain = fbm((x, y) => p(x, y), u * 180, v * 180, { octaves: 4 });
    const scr = fbm((x, y) => scratch(x, y), u * 400, v * 20, { octaves: 3 });
    const sp = specks(u, v);
    const speck = smoothstep(0.4, 0.05, sp.f1) * (sp.id > 0.7 ? 1 : 0);

    const h = 0.5 + grain * 0.03 + scr * 0.012 + speck * 0.02;
    let tone = 0.215 + grain * 0.05 + Math.abs(scr) * 0.035 + speck * 0.09;
    const rough = clamp(0.44 + grain * 0.16 - Math.abs(scr) * 0.14 - speck * 0.12, 0.12, 0.85);
    return { h, r: tone * 1.0, g: tone * 1.01, b: tone * 1.06, rough, metal: 0.92 };
  };
}

function surfacePolymer(seed) {
  const p = makeTileablePerlin2(seed, 64);
  const stipple = makeWorley2(seed + 3, 90);
  return (u, v) => {
    // Injection-moulded polymer with a stippled grip texture.
    const s = stipple(u, v);
    const bump = smoothstep(0.55, 0.1, s.f1);
    const grain = fbm((x, y) => p(x, y), u * 140, v * 140, { octaves: 3 });
    const h = 0.5 + bump * 0.16 + grain * 0.02;
    const tone = 0.185 + grain * 0.035 + bump * 0.025;
    const rough = clamp(0.62 - bump * 0.12 + grain * 0.06, 0.3, 0.9);
    return { h, r: tone * 1.02, g: tone, b: tone * 0.98, rough, metal: 0.02 };
  };
}

function surfaceCamo(seed) {
  const p = makeTileablePerlin2(seed, 5);           // sampled at u*5
  const p2 = makeTileablePerlin2(seed + 17, 9);     // sampled at u*9
  const weave = makeTileablePerlin2(seed + 5, 300); // sampled at u*300
  const PALETTE = [
    [0.245, 0.255, 0.215],
    [0.360, 0.350, 0.280],
    [0.185, 0.195, 0.170],
    [0.300, 0.275, 0.225],
  ];
  return (u, v) => {
    const a = warpedFbm((x, y) => p(x, y), u * 5, v * 5, { warp: 1.3, octaves: 4 });
    const b = warpedFbm((x, y) => p2(x, y), u * 9, v * 9, { warp: 1.0, octaves: 4 });
    let idx = 0;
    if (a > 0.06) idx = 1;
    if (b > 0.10) idx = 2;
    if (a > 0.06 && b > 0.10) idx = 3;
    const c = PALETTE[idx];
    const w = fbm((x, y) => weave(x, y), u * 300, v * 300, { octaves: 2 });
    const h = 0.5 + w * 0.06;
    const k = 1 + w * 0.22;
    return { h, r: c[0] * k, g: c[1] * k, b: c[2] * k, rough: clamp(0.9 + w * 0.06, 0.6, 1), metal: 0 };
  };
}

const SURFACES = {
  concrete: surfaceConcrete,
  asphalt: surfaceAsphalt,
  brick: surfaceBrick,
  metal: surfaceMetalPanel,
  painted: surfacePaintedMetal,
  wood: surfaceWood,
  tile: surfaceTile,
  gravel: surfaceGravel,
  plaster: surfacePlaster,
  sandbag: surfaceSandbag,
  gunmetal: surfaceGunMetal,
  polymer: surfacePolymer,
  camo: surfaceCamo,
};

// --------------------------------------------------------------- driver ----

/**
 * Generate a full PBR texture set.
 * @returns {{map,normalMap,roughnessMap,metalnessMap,aoMap,size}}
 */
export function generateTextureSet(kind, opts = {}) {
  const {
    size = 512, seed = 1337, repeat = [1, 1],
    normalStrength = 0.95, aoRadius = 4, aoStrength = 1.6,
    surfaceOpts = {}, cache = true,
  } = opts;

  const key = `${kind}|${size}|${seed}|${JSON.stringify(surfaceOpts)}`;
  if (cache && CACHE.has(key)) {
    const c = CACHE.get(key);
    return cloneWithRepeat(c, repeat);
  }

  const factory = SURFACES[kind];
  if (!factory) throw new Error(`Unknown surface kind: ${kind}`);
  const surf = factory(seed, surfaceOpts);

  const N = size * size;
  const height = new Float32Array(N);
  const albedo = new Uint8ClampedArray(N * 4);
  const rough = new Uint8ClampedArray(N * 4);
  const metal = new Uint8ClampedArray(N * 4);

  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const s = surf(x * inv, y * inv);
      height[i] = s.h;
      const i4 = i * 4;
      albedo[i4] = clamp(s.r) * 255;
      albedo[i4 + 1] = clamp(s.g) * 255;
      albedo[i4 + 2] = clamp(s.b) * 255;
      albedo[i4 + 3] = 255;
      const rv = clamp(s.rough) * 255;
      rough[i4] = rv; rough[i4 + 1] = rv; rough[i4 + 2] = rv; rough[i4 + 3] = 255;
      const mv = clamp(s.metal) * 255;
      metal[i4] = mv; metal[i4 + 1] = mv; metal[i4 + 2] = mv; metal[i4 + 3] = 255;
    }
  }

  const normal = heightToNormal(height, size, normalStrength);
  const ao = heightToAO(height, size, aoRadius, aoStrength);

  const set = {
    map: makeTexture(albedo, size, { srgb: true, repeat }),
    normalMap: makeTexture(normal, size, { repeat }),
    roughnessMap: makeTexture(rough, size, { repeat }),
    metalnessMap: makeTexture(metal, size, { repeat }),
    aoMap: makeTexture(ao, size, { repeat }),
    size,
  };
  if (cache) CACHE.set(key, set);
  return cloneWithRepeat(set, repeat);
}

/** Share GPU uploads between users of the same texture but allow per-use tiling. */
function cloneWithRepeat(set, repeat) {
  const out = { size: set.size };
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
    const t = set[k].clone();
    t.needsUpdate = false;              // reuse the parent's GPU upload
    t.repeat.set(repeat[0], repeat[1]);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    out[k] = t;
  }
  return out;
}

export function listSurfaces() { return Object.keys(SURFACES); }
export function registerSurface(name, factory) { SURFACES[name] = factory; }
export function clearTextureCache() { CACHE.clear(); }
