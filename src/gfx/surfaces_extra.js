import {
  makeTileablePerlin2, makeWorley2, fbm, ridged, billow, warpedFbm,
  makeRNG, clamp, smoothstep, mix,
} from './noise.js';
import { registerSurface } from './textures.js';

/*
 * Extra surface kinds for the war-torn industrial/urban set.
 *
 * These plug into src/gfx/textures.js through `registerSurface(name, factory)`.
 * Same contract as the built-ins:
 *
 *     factory(seed, surfaceOpts) -> (u, v) => { h, r, g, b, rough, metal }
 *
 * with u,v in [0,1), colours authored in *sRGB display* values (0..1) and the
 * height field in roughly 0..1 — the driver derives the normal map (Sobel) and
 * the cavity/AO map from `h`, so anything you want lit has to exist in `h`.
 *
 * ------------------------------------------------------------------ notes ---
 *
 * ORIENTATION. `v` increases *upward* on walls (three's PlaneGeometry and the
 * world-space UVs in world/Builder.js both put +V along +Y, and DataTexture is
 * not flipped, so row 0 == v 0 == bottom). Everything gravity-driven here —
 * rust bleed, water streaks, grime — therefore runs toward *decreasing* v.
 *
 * TILEABILITY. `makeTileablePerlin2(seed, period)` wraps its lattice every
 * `period` cells, so a layer only tiles if the coordinate span over u∈[0,1) is
 * an exact multiple of `period`. Sampling at `u * F` therefore wants
 * `period === F` (then every FBM octave, at F·2^i, is also a multiple). The
 * large-scale layers below all follow that rule — they are the ones that would
 * show a seam. Fine grain layers (F in the hundreds) are deliberately allowed to
 * be approximate: a discontinuity at 1/220 of a tile is sub-texel.
 *
 * THREE SCALES. Every surface here layers (1) a domain-warped large scale so a
 * 20 m wall does not read as one repeating stamp, (2) mid-scale structure —
 * ribs, bricks, folds, spalls — and (3) fine grain for the specular break-up.
 */

const TAU = Math.PI * 2;
const frac = (x) => x - Math.floor(x);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Shortest signed delta on a unit torus — keeps radial patterns tileable. */
const wrapDelta = (d) => (d > 0.5 ? d - 1 : d < -0.5 ? d + 1 : d);
/** Distance to the nearest integer, scaled to 0..1 (0 exactly on the line). */
const lineDist = (x) => { const f = frac(x); return (f < 0.5 ? f : 1 - f) * 2; };

// -------------------------------------------------- low-frequency field cache --

/**
 * Bake a band-limited tileable field onto an N×N grid once, then read it back
 * with C1 (smoothstep-weighted bilinear) interpolation.
 *
 * This is the whole reason the surfaces below can afford *many* large-scale
 * condition layers. A `warpedFbm` costs five nested FBMs — call it three times
 * per texel and a 512 px map is 25 M noise evaluations. But a field sampled at
 * 3 cycles per tile carries no information above ~24 cycles, so evaluating it
 * at 64×64 and interpolating is visually identical and ~25x cheaper. Keep the
 * octave count low enough that the field really is band-limited at N/2 (a
 * 3-cycle basis with 3 octaves tops out at 12 cycles, well under the 32 that a
 * 64-grid resolves) — otherwise the top octaves alias into low-frequency mush.
 *
 * C1 interpolation matters because several of these feed the height field, and
 * plain bilinear would put a visible crease at every grid line once the driver
 * runs its Sobel over it.
 */
function coarse(fn, N = 64) {
  const g = new Float32Array(N * N);
  const inv = 1 / N;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) g[y * N + x] = fn(x * inv, y * inv);
  }
  return (u, v) => {
    const fx = u * N, fy = v * N;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const x0 = ((ix % N) + N) % N, y0 = ((iy % N) + N) % N;
    const x1 = (x0 + 1) % N, y1 = (y0 + 1) % N;
    const a = g[y0 * N + x0], b = g[y0 * N + x1];
    const c = g[y1 * N + x0], d = g[y1 * N + x1];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };
}

/** Shorthand: a cached domain-warped FBM at `cycles` per tile. */
function slowWarp(seed, cycles, { warp = 1.2, octaves = 3, N = 64 } = {}) {
  const n = makeTileablePerlin2(seed, cycles);
  return coarse((u, v) => warpedFbm((x, y) => n(x, y), u * cycles, v * cycles,
                                    { warp, octaves }), N);
}

// ------------------------------------------------------------- shared bits --

/**
 * Gravity-driven runoff streaks: sources scattered along u, each bleeding
 * downward (−v) for a random length. Returns 0..1.
 */
function makeStreaks(seed, opts = {}) {
  const { columns = 40, length = 0.6, density = 0.45, width = 0.55 } = opts;
  const wob = makeTileablePerlin2(seed + 3, 8);
  const fine = makeTileablePerlin2(seed + 91, 8);
  const rng = makeRNG(seed + 17);
  const src = new Float32Array(columns);
  const on = new Float32Array(columns);
  const len = new Float32Array(columns);
  const wid = new Float32Array(columns);
  for (let i = 0; i < columns; i++) {
    src[i] = rng(); on[i] = rng(); len[i] = 0.3 + rng() * 1.4; wid[i] = 0.3 + rng() * 0.7;
  }
  return (u, v) => {
    // Wobble the column lookup so runs are not perfectly plumb.
    const w = fbm((x, y) => wob(x, y), u * 8, v * 8, { octaves: 3 }) * 0.014;
    const cf = (u + w) * columns;
    const ci = Math.floor(cf);
    const idx = ((ci % columns) + columns) % columns;
    if (on[idx] > density) return 0;
    const fu = cf - ci;
    let d = src[idx] - v;
    if (d < 0) d += 1;                                   // wrap: runs off the bottom
    const L = length * len[idx];
    const along = (1 - smoothstep(0, L, d)) * smoothstep(0, 0.05, d);
    const half = width * wid[idx] * 0.5;
    const across = 1 - smoothstep(half * 0.45, half, Math.abs(fu - 0.5));
    const grain = fbm((x, y) => fine(x, y), u * 64, v * 8, { octaves: 3 }) * 0.5 + 0.5;
    return sat(along * across * (0.4 + grain * 0.85));
  };
}

/**
 * 45° diamond lattice shared by expanded-metal grate and chain-link fence.
 * `cells` must be an integer: both families then wrap in u and in v.
 */
function makeDiamond(opts = {}) {
  const { cells = 6, barW = 0.22 } = opts;
  return (u, v) => {
    const a = (u + v) * cells, b = (u - v) * cells;
    const da = lineDist(a), db = lineDist(b);
    const sA = 1 - smoothstep(barW * 0.72, barW, da);
    const sB = 1 - smoothstep(barW * 0.72, barW, db);
    // Round cross-section so the strands catch a highlight instead of reading flat.
    const rA = sA > 0 ? Math.sqrt(Math.max(0, 1 - (da / barW) * (da / barW))) : 0;
    const rB = sB > 0 ? Math.sqrt(Math.max(0, 1 - (db / barW) * (db / barW))) : 0;
    // Weave parity — shifting u or v by 1 moves the sum by ±2·cells, so it tiles.
    const over = ((Math.floor(a) + Math.floor(b)) & 1) === 0;
    return { sA, sB, rA, rB, over, mask: Math.max(sA, sB) };
  };
}

/**
 * Running-bond brickwork where every unit is its own brick.
 *
 * The old lattice divided the tile into a perfect grid: N equal columns, N
 * equal rows, one shared mortar width. That is the single tell that made this
 * material read as 2005 wallpaper — a real wall has bricks that differ in
 * length by a good centimetre, courses that wander, and a bond that is only
 * approximately half-lapped.
 *
 * So each course gets its own set of brick lengths (±`lenJitter`, renormalised
 * so the row still spans exactly one tile and therefore still wraps), its own
 * bond phase, and its own vertical wander. A 1024-entry lookup per row turns
 * the variable-width layout back into an O(1) fetch, which is what keeps this
 * affordable at 512 px.
 *
 * Joint widths are given in *real* terms — a 10 mm perp and a 10 mm bed on a
 * 225 x 75 mm module — rather than as a fraction of the cell, so the joint
 * stays a shadow line instead of the fat painted grid it used to be.
 *
 * Returns per texel: the mortar mask, brick-local coordinates, the brick's own
 * width, and four independent hashes for per-unit colour, firing and damage.
 */
function makeBrickCourses(seed, opts = {}) {
  const {
    rows = 28, cols = 12,
    lenJitter = 0.085,      // ±8.5 % on brick length
    perp = 0.0037,          // full perp joint, in u-tile units (10 mm / 2.70 m)
    bed = 0.135,            // full bed joint as a fraction of the course pitch
    wander = 0.11,          // bed-line undulation, in course fractions
  } = opts;
  const rng = makeRNG(seed + 5);
  // Bed lines undulate as a *family* — settlement moves whole panels of
  // brickwork, not individual courses. Making the wander a function of u only
  // is also what keeps it tileable: a per-course constant would put a step at
  // the v seam, because the course at v=1 and the course at v=0 are different
  // courses with different offsets.
  const waveN = makeTileablePerlin2(seed + 811, 3);
  const bedWave = coarse((u) => fbm((x, y) => waveN(x, y), u * 3, 0.5, { octaves: 3 }), 96);
  const LUT = 1024;
  const stride = cols + 1;
  const edges = new Float32Array(rows * stride);
  const lut = new Uint16Array(rows * LUT);
  const phase = new Float32Array(rows);
  const jit = new Float32Array(rows * cols * 4);

  for (let r = 0; r < rows; r++) {
    const w = new Float32Array(cols);
    let sum = 0;
    for (let i = 0; i < cols; i++) { w[i] = 1 + (rng() * 2 - 1) * lenJitter; sum += w[i]; }
    let acc = 0;
    edges[r * stride] = 0;
    for (let i = 0; i < cols; i++) { acc += w[i] / sum; edges[r * stride + i + 1] = acc; }
    edges[r * stride + cols] = 1;
    // Half-lap, plus enough slop that the perps do not line up every other course.
    phase[r] = ((r & 1) * 0.5 + (rng() - 0.5) * 0.30) / cols;
    let k = 0;
    for (let s = 0; s < LUT; s++) {
      const t = (s + 0.5) / LUT;
      while (k < cols - 1 && t >= edges[r * stride + k + 1]) k++;
      lut[r * LUT + s] = k;
    }
  }
  for (let i = 0; i < jit.length; i++) jit[i] = rng();

  return (u, v) => {
    const rowF = v * rows + bedWave(u, 0) * wander;
    const rowI = Math.floor(rowF);
    const r = ((rowI % rows) + rows) % rows;
    const fv = rowF - rowI;

    let uu = u - phase[r];
    uu -= Math.floor(uu);
    const i = lut[r * LUT + ((uu * LUT) | 0)];
    const base = r * stride;
    const e0 = edges[base + i], e1 = edges[base + i + 1];
    const wid = e1 - e0;
    const fu = (uu - e0) / wid;

    const mw = perp * 0.5 / wid;      // half-joint each side of the unit
    const mh = bed * 0.5;
    const brick = smoothstep(0, mw, fu) * smoothstep(1, 1 - mw, fu)
                * smoothstep(0, mh, fv) * smoothstep(1, 1 - mh, fv);
    const jb = (r * cols + i) * 4;
    return {
      brick, fu, fv, wid, row: r, col: i,
      j0: jit[jb], j1: jit[jb + 1], j2: jit[jb + 2], j3: jit[jb + 3],
    };
  };
}

/** Running-bond brick lattice: mortar mask + a stable per-brick index. */
function makeBrickLattice(seed, opts = {}) {
  const { rows = 16, cols = 8, mortarW = 0.055, mortarH = 0.10 } = opts;
  const rng = makeRNG(seed + 5);
  const jit = new Float32Array(rows * cols * 3);
  for (let i = 0; i < jit.length; i++) jit[i] = rng();
  return (u, v) => {
    const rowF = v * rows;
    const row = Math.floor(rowF);
    const colF = u * cols + (((row % 2) + 2) % 2) * 0.5;
    const col = Math.floor(colF);
    const fu = colF - col, fv = rowF - row;
    const brick = smoothstep(0, mortarW, fu) * smoothstep(1, 1 - mortarW, fu)
                * smoothstep(0, mortarH, fv) * smoothstep(1, 1 - mortarH, fv);
    const idx = (((row % rows) + rows) % rows) * cols + (((col % cols) + cols) % cols);
    return { brick, fu, fv, j0: jit[idx * 3], j1: jit[idx * 3 + 1], j2: jit[idx * 3 + 2] };
  };
}

/**
 * Two-scale paint failure, shared by everything painted.
 *
 * The thing that makes procedural chipping look like measles is doing it at one
 * scale: an even sprinkle of speckles. Real paint fails in *sheets* — a patch
 * lets go, and the fine chipping clusters around the edge of that patch. So:
 * big worley cell interiors for the sheets, small ones for the chips, and the
 * chips are weighted by a halo around each sheet. The whole thing is then gated
 * by a domain-warped mask so most of the surface is still painted.
 *
 * Returns { loss, halo, sheet } — `halo` is the thin ring where the topcoat has
 * gone but the primer underneath has not.
 */
function makePaintLoss(seed, opts = {}) {
  const { sheets = 7, chips = 26, amount = 1, bias = 0 } = opts;
  const bigW = makeWorley2(seed + 61, sheets);
  const chipW = makeWorley2(seed + 62, chips);
  const maskN = makeTileablePerlin2(seed + 63, 6);
  const edgeN = makeTileablePerlin2(seed + 64, 32);
  return (u, v) => {
    const m = warpedFbm((x, y) => maskN(x, y), u * 6, v * 6, { warp: 1.1, octaves: 4 });
    const ragged = fbm((x, y) => edgeN(x, y), u * 32, v * 32, { octaves: 4 }) * 0.24;
    const bw = bigW(u, v);
    const d = bw.f1 + ragged;
    // Only a minority of cells fail, and each failure is a patch — not most of
    // the cell. Paint that is 40% gone reads as camouflage, not as wear.
    const sheet = smoothstep(0.34, 0.06, d) * (bw.id > 0.66 ? 1 : 0);
    const halo = smoothstep(0.04, 0.32, d) * smoothstep(0.60, 0.32, d) * (bw.id > 0.66 ? 1 : 0.25);
    const cw = chipW(u, v);
    const chip = smoothstep(0.34, 0.06, cw.f1 + ragged * 0.5) * (cw.id > 0.68 ? 1 : 0);
    const gate = smoothstep(-0.16 - bias, 0.24 - bias, m);
    const loss = sat((sheet + chip * (0.30 + halo * 0.9)) * gate * amount);
    return { loss, halo: sat(halo * gate), sheet: sat(sheet * gate) };
  };
}

/*
 * ------------------------------------------------------ calibration notes ---
 *
 * The substrates and surfaces below are authored against two hard budgets, and
 * every number in them is chosen to stay inside those budgets.
 *
 * ALBEDO, in sRGB display values, from measured references:
 *
 *     asphalt          0.20 – 0.28, essentially neutral
 *     concrete         0.45 – 0.60, near-neutral with ONE bias (faintly warm)
 *     red brick        0.32 – 0.42, with the mortar LIGHTER and less saturated
 *     weathered timber 0.28 – 0.38, grey-brown — never orange
 *     gravel           0.28 – 0.38, mild per-stone spread only
 *     rusted steel     0.25 – 0.35, rust dark red-brown rather than orange
 *
 * The spread around each mean is deliberately narrow. Real surfaces vary by
 * *patch* — a repair, a stain, a polished path — not by ±0.2 per stone. Wide
 * per-feature albedo contrast is exactly what makes a procedural surface read
 * as noise instead of as a substance.
 *
 * RELIEF. `h` is on a 0..1 scale where 1.0 would be a step the size of the
 * whole tile. So on a 1.04 m brick tile a 5 mm struck joint is 0.005, not 0.24;
 * on a 4 m road tile a 6 mm chipping is 0.0015. Everything here budgets its
 * *total* height range to ~0.10 and lets albedo and roughness carry the rest.
 * The driver's Sobel multiplies by `normalStrength`, so an over-authored height
 * field cannot be rescued downstream — it has to be right here.
 *
 * ROUGHNESS. Uniform roughness is what makes light slide over a surface without
 * finding it. Each surface below ties roughness to its own low-frequency
 * weathering field: polished where it is walked or driven, matte where dust and
 * chalking settle. That variation is doing more work than the normal map.
 *
 * ANTI-TILING. Every surface's top layer is a domain-warped FBM sampled at 3–6
 * cycles per tile — low frequency relative to the tile, so at 20 m the eye
 * reads big soft patches rather than a stamp. Sampling frequency must equal the
 * basis period or the map will not wrap; see the TILEABILITY note above.
 */

/**
 * Compact concrete substrate, shared by the wall/floor surface, the stained
 * variant and the spalled-rebar variant.
 *
 * The previous version put 11 cm blowholes 0.27 deep into the height field,
 * which is why concrete read as cottage cheese. Real cast concrete has 2–8 mm
 * air pockets and a few millimetres of form texture; the visual interest is in
 * the tonal blotching of the pour and in where the surface has been polished.
 */
function makeConcreteBase(seed, opts = {}) {
  const {
    ties = 0,        // form-tie holes per tile, per axis (0 = none, e.g. a slab)
    lifts = 0,       // pour lifts per tile — horizontal construction joints
    panels = 0,      // formwork panel seams per tile, vertically
    patches = 0,     // patch-repair coverage, 0..1
    tieR = 0.0085,   // tie-hole radius in tile units (25 mm on a 3 m tile)
  } = opts;
  const mesoN = makeTileablePerlin2(seed + 41, 16);    // *16 — float and screed marks
  const fineN = makeTileablePerlin2(seed + 91, 96);    // *96 — cement paste grain
  const pores = makeWorley2(seed + 3, 88);             // ~34 mm cells at a 3 m tile
  // Pour blotching, cached: it is the slowest layer here and by definition the
  // one with the least detail in it.
  const macroF = slowWarp(seed, 4, { warp: 1.15, octaves: 3 });

  // --- formwork. A cast wall is a *made* thing and it shows: the tie holes sit
  //     on the grid the formwork was bolted on, the lift lines are where one
  //     day's pour met the next, and the panel seams are the plywood joints.
  //     None of that survives in a pure noise stack, and its absence is most of
  //     why procedural concrete reads as stucco.
  const trng = makeRNG(seed + 77);
  const tieJit = ties > 0 ? new Float32Array(ties * ties * 3) : null;
  if (tieJit) for (let i = 0; i < tieJit.length; i++) tieJit[i] = trng();
  const liftTone = new Float32Array(Math.max(1, lifts));
  for (let i = 0; i < liftTone.length; i++) liftTone[i] = trng();

  const patchW = patches > 0 ? makeWorley2(seed + 611, 5) : null;
  const patchEdge = patches > 0 ? makeTileablePerlin2(seed + 612, 24) : null;

  return (u, v) => {
    const macro = macroF(u, v);
    const meso = fbm((x, y) => mesoN(x, y), u * 16, v * 16, { octaves: 4 });
    const grain = fbm((x, y) => fineN(x, y), u * 96, v * 96, { octaves: 3 });
    const w = pores(u, v);
    // Blowholes: only some cells have one, and they are millimetres deep.
    const pit = smoothstep(0.24, 0.02, w.f1) * (w.id > 0.58 ? 1 : 0.30);
    // Aggregate ghosting just under the skin — tonal only, no relief at all.
    const agg = smoothstep(0.58, 0.92, w.f2 - w.f1);

    let h = 0.5 + macro * 0.026 + meso * 0.013 + grain * 0.010 - pit * 0.042;
    let tone = 0.515 + macro * 0.095 + meso * 0.078 + grain * 0.034
             - pit * 0.070 + agg * 0.022;
    const polish = smoothstep(0.04, 0.26, macro);
    let rough = clamp(0.86 - polish * 0.22 + Math.abs(grain) * 0.05 - agg * 0.05, 0.42, 1);

    // --- lift lines. Each pour is a different batch of the same mix, so the
    //     bands either side of a joint differ by a few per cent of value — far
    //     more visible on a real wall than any amount of noise.
    let joint = 0;
    if (lifts > 0) {
      const lf = v * lifts;
      const li = Math.floor(lf), lfr = lf - li;
      const batch = liftTone[((li % lifts) + lifts) % lifts];
      tone *= 0.965 + batch * 0.075;
      joint = 1 - smoothstep(0.0, 0.010, Math.min(lfr, 1 - lfr));
      // Grout bleeds out under the shutter and dries as a pale ragged dribble.
      const bleed = smoothstep(0.045, 0.0, lfr) * (0.4 + meso * 0.6);
      h -= joint * 0.016;
      tone -= joint * 0.055;
      tone += bleed * 0.045;
      rough += joint * 0.05;
    }

    // --- plywood panel seams: a shallow proud line where grout ran into the gap.
    if (panels > 0) {
      const pf = frac(u * panels);
      const s = 1 - smoothstep(0.0, 0.007, Math.min(pf, 1 - pf));
      h += s * 0.008;
      tone += s * 0.030;
    }

    // --- form ties. Snapped off flush and mostly never made good, so each one
    //     is a small recess with a rust bleed running down out of it.
    if (ties > 0) {
      const cu = u * ties, cv = v * ties;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      const gi = (((cj % ties) + ties) % ties) * ties + (((ci % ties) + ties) % ties);
      const jx = (tieJit[gi * 3] - 0.5) * 0.22, jy = (tieJit[gi * 3 + 1] - 0.5) * 0.22;
      const du = (cu - ci - 0.5 - jx) / ties, dv = (cv - cj - 0.5 - jy) / ties;
      const d = Math.sqrt(du * du + dv * dv);
      const hole = 1 - smoothstep(tieR * 0.55, tieR, d);
      // Some were dry-packed with mortar afterwards; those read as a pale plug.
      const plug = tieJit[gi * 3 + 2] > 0.55 ? 1 : 0;
      h -= hole * (plug ? 0.010 : 0.055);
      tone = mix(tone, plug ? tone * 1.16 : tone * 0.52, hole);

      // Rust bleed: only from the unplugged ones, running down the face.
      if (!plug) {
        // Distance below this tie, in cell units.
        let below = -(cv - cj - 0.5 - jy);
        if (below < 0) below += 1;
        const across = 1 - smoothstep(tieR * ties * 0.9, tieR * ties * 2.6,
                                      Math.abs(cu - ci - 0.5 - jx));
        const run = smoothstep(0.0, 0.03, below) * (1 - smoothstep(0.05, 0.62, below))
                  * across * (0.55 + meso * 0.8);
        const bleed = sat(run) * smoothstep(0.35, 0.75, tieJit[gi * 3 + 2] + 0.4);
        tone *= 1 - bleed * 0.16;
        rough += bleed * 0.05;
        // Hand the rust colour back so the caller can tint it iron-oxide.
        h -= bleed * 0.002;
        return finish(h, tone, macro, grain, pit, rough, bleed, patchTerm());
      }
    }
    return finish(h, tone, macro, grain, pit, rough, 0, patchTerm());

    // --- patch repairs: a different age and a different mix, feathered in.
    function patchTerm() {
      if (!patchW) return 0;
      const p = patchW(u, v);
      // A worley cell is a polygon, and a chased-out repair is not. The edge
      // noise has to be strong enough to destroy the cell shape outright,
      // otherwise the wall reads as faceted panels.
      const ragged = fbm((x, y) => patchEdge(x, y), u * 24, v * 24, { octaves: 4 }) * 0.42
                   + fbm((x, y) => patchEdge(x, y), u * 96, v * 96, { octaves: 3 }) * 0.10;
      return sat(smoothstep(0.62, 0.24, p.f1 + ragged) * (p.id > 1 - patches ? 1 : 0));
    }
  };

  function finish(h, tone, macro, grain, pit, rough, bleed, patch) {
    if (patch > 0) {
      // A repair is a smoother, greyer, flatter mix than the parent concrete.
      tone = mix(tone, 0.470 + grain * 0.020, patch * 0.85);
      rough = mix(rough, 0.80, patch * 0.7);
      h = mix(h, 0.5 + grain * 0.006, patch * 0.8) + patch * 0.004;
    }
    return { h, tone, base: macro, macro, grain, pit, rough: clamp(rough, 0.4, 1), bleed, patch };
  }
}

/**
 * Compact asphalt substrate, shared by the road surface and by road markings.
 *
 * The thing to get right is that asphalt is a *binder-rich matrix*: at two
 * metres it is a fairly uniform dark grey with a fine aggregate texture, and
 * the large-scale variation comes from patching, staining and tyre polish — not
 * from per-stone albedo. The chippings are embedded, and only stand proud where
 * the bitumen has been scoured or polished off them.
 */
function makeAsphaltBase(seed) {
  const macroN = makeTileablePerlin2(seed + 300, 3);   // *3   — staining, polish, wash
  const midN = makeTileablePerlin2(seed + 17, 12);     // *12  — sweep marks, dust drift
  const aggW = makeWorley2(seed + 12, 104);            // ~48 mm chippings at a 5 m tile
  const gritN = makeTileablePerlin2(seed, 128);        // *128 — binder grain
  const repairW = makeWorley2(seed + 71, 4);           // sealed patches / trench repairs
  const edgeN = makeTileablePerlin2(seed + 88, 24);    // *24  — ragged patch edges
  return (u, v) => {
    const macro = warpedFbm((x, y) => macroN(x, y), u * 3, v * 3, { warp: 1.25, octaves: 5 });
    const mid = fbm((x, y) => midN(x, y), u * 12, v * 12, { octaves: 4 });
    const grit = fbm((x, y) => gritN(x, y), u * 128, v * 128, { octaves: 3 });
    const a = aggW(u, v);

    // --- patching. This is where a road's large-scale variation actually comes
    //     from: a trench reinstatement or a planed-and-inlaid patch is a
    //     different age of bitumen, so a different value and a different gloss.
    //     It is a hard-edged, low-frequency feature, which is exactly what a
    //     smooth FBM cannot supply and what stops the 5 m tile from reading.
    const rp = repairW(u, v);
    const ragged = fbm((x, y) => edgeN(x, y), u * 24, v * 24, { octaves: 4 }) * 0.16;
    const patch = smoothstep(0.62, 0.44, rp.f1 + ragged) * (rp.id > 0.45 ? 1 : 0);
    const patchAge = (rp.id - 0.45) * 1.4;              // fresh (dark) .. old (pale)

    // Aggregate is only exposed where the binder has gone. Some is showing
    // everywhere — a road is never glass — but it opens up in the worn areas.
    const bare = smoothstep(-0.12, 0.16, macro);
    const stone = smoothstep(0.32, 0.05, a.f1) * (0.45 + bare * 0.55);

    const h = 0.5 + stone * 0.030 + grit * 0.012 + macro * 0.016 - patch * 0.010;
    let tone = 0.212 + macro * 0.075 + mid * 0.030 + grit * 0.020 + stone * 0.032;
    tone = mix(tone, 0.208 + patchAge * 0.055 + grit * 0.018 + stone * 0.018, patch);
    // Tyre-polished lanes gloss up; the dusty shoulders stay dead matte; a
    // fresh patch is still fat with binder and glossier than either — but only
    // a little. Past about 0.09 of gloss delta the patch starts mirroring the
    // sky and reads as standing water rather than as new bitumen.
    const rough = clamp(0.87 - smoothstep(0.05, 0.30, macro) * 0.30
                            + smoothstep(0.02, -0.24, macro) * 0.07
                            + Math.abs(grit) * 0.05
                            - patch * (0.09 - patchAge * 0.07), 0.40, 1);
    return { h, tone, stone, fine: grit, macro, patch, rough };
  };
}

/**
 * Impact-shattered glass field, shared by the `glass` surface and its alpha map
 * so the missing shards and the crack lines always agree.
 */
const SHATTER_DEFAULTS = { impacts: 2, radius: 0.36, cells: 9, spokes: 11, holeCut: 0.80 };

function makeShatter(seed, opts = {}) {
  const { impacts, radius, cells, spokes, holeCut } = { ...SHATTER_DEFAULTS, ...opts };
  const w = makeWorley2(seed + 5, cells);
  const rng = makeRNG(seed + 61);
  const cx = new Float32Array(impacts), cy = new Float32Array(impacts);
  for (let i = 0; i < impacts; i++) { cx[i] = rng(); cy[i] = rng(); }
  return (u, v) => {
    let crack = 0, near = 1e9;
    for (let i = 0; i < impacts; i++) {
      const dx = wrapDelta(u - cx[i]), dy = wrapDelta(v - cy[i]);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < near) near = d;
      if (d >= radius) continue;
      // Fade the whole star out well before the wrap point so it stays tileable.
      const fall = 1 - smoothstep(radius * 0.35, radius, d);
      const ang = Math.atan2(dy, dx) / TAU + 0.5;
      const nSpokes = spokes + i * 4;
      const spoke = (1 - smoothstep(0.0, 0.10, lineDist(ang * nSpokes)))
                  * smoothstep(0.006, 0.03, d);
      const ring = (1 - smoothstep(0.0, 0.16, lineDist(d * 13))) * smoothstep(0.03, 0.09, d);
      crack = Math.max(crack, Math.max(spoke, ring * 0.8) * fall);
    }
    // Background shatter cells away from the impacts.
    const c = w(u, v);
    const cell = 1 - smoothstep(0.02, 0.10, c.f2 - c.f1);
    crack = Math.max(crack, cell * smoothstep(radius * 0.55, radius * 1.6, near) * 0.55);
    // Whole cells punched out near an impact.
    const hole = (c.id > holeCut ? 1 : 0) * (1 - smoothstep(radius * 0.30, radius * 0.62, near));
    return { crack: sat(crack), hole: sat(hole * 1.6), id: c.id, near };
  };
}

// ---------------------------------------------------------------- surfaces --

/*
 * ------------------------------------------- recalibrated base substances ---
 *
 * These replace the `concrete` / `asphalt` / `gravel` / `brick` / `wood` /
 * `plaster` / `sandbag` kinds that ship in textures.js. That file is owned by
 * another module, so instead of editing it these register under new kind names
 * and the catalogue in materials.js points at them. See the calibration note
 * further up for the albedo and relief budgets they are authored to.
 */

/** Cast in-situ concrete: pour blotching, hairline cracking, polished paths. */
function surfaceConcreteFine(seed, opts = {}) {
  const base = makeConcreteBase(seed, opts);
  const crackN = makeTileablePerlin2(seed + 55, 6);
  const stain = slowWarp(seed + 771, 3, { warp: 1.3 });
  return (u, v) => {
    const c = base(u, v);
    const cr = ridged((x, y) => crackN(x, y), u * 6, v * 6, { octaves: 4 });
    const crack = smoothstep(0.90, 0.99, cr);
    const soot = sat(Math.max(0, stain(u, v)) * 1.6);

    const h = c.h - crack * 0.045;
    let tone = c.tone - crack * 0.040;
    tone *= 1 - soot * 0.09;
    // Cement is faintly warm. One bias only — a surface that is warm in the
    // reds *and* cool in the blues just reads as chromatic noise.
    let r = tone * 1.012, g = tone * 1.0, b = tone * 0.980;
    // Rust bleeding out of the snapped form ties. Iron oxide is dark red-brown,
    // and on a pale grey wall a very little of it goes a very long way.
    const bl = c.bleed || 0;
    if (bl > 0) {
      r = mix(r, 0.305 + c.grain * 0.04, bl * 0.60);
      g = mix(g, 0.185 + c.grain * 0.03, bl * 0.60);
      b = mix(b, 0.135 + c.grain * 0.02, bl * 0.55);
    }
    const rough = clamp(c.rough + soot * 0.06 - crack * 0.04, 0.4, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/** Wearing-course asphalt. Uniform dark grey; the story is in the roughness. */
function surfaceAsphaltFine(seed) {
  const base = makeAsphaltBase(seed);
  const crackN = makeTileablePerlin2(seed + 55, 6);
  return (u, v) => {
    const a = base(u, v);
    const cr = ridged((x, y) => crackN(x, y), u * 6, v * 6, { octaves: 4 });
    const crack = smoothstep(0.935, 0.995, cr);
    const h = a.h - crack * 0.040;
    const tone = a.tone - crack * 0.028;
    const r = tone * 0.995, g = tone * 1.0, b = tone * 1.028;   // faintly cool, once
    const rough = clamp(a.rough + crack * 0.06, 0.34, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Compacted ballast. Two grades of stone bedded in fines — the stones sit *in*
 * the surface, so only their crowns are proud, and they are all much the same
 * grey. The previous version gave every cell ±0.17 of albedo and half a tile of
 * height, which is why it read as popcorn.
 */
function surfaceGravelFine(seed, opts = {}) {
  const { tone: baseTone = 0.325 } = opts;
  const bigW = makeWorley2(seed + 1, 40);              // ~50 mm at a 2 m tile
  const smW = makeWorley2(seed + 2, 92);               // ~22 mm chippings
  const fineN = makeTileablePerlin2(seed + 3, 96);
  const dampN = makeTileablePerlin2(seed + 4, 3);
  return (u, v) => {
    const A = bigW(u, v), B = smW(u, v);
    const big = smoothstep(0.62, 0.10, A.f1);
    const small = smoothstep(0.55, 0.08, B.f1);
    const fines = fbm((x, y) => fineN(x, y), u * 96, v * 96, { octaves: 4 });
    // Damp / dry patches: the low-frequency layer that hides the repeat.
    const damp = warpedFbm((x, y) => dampN(x, y), u * 3, v * 3, { warp: 1.2, octaves: 5 });
    const wet = smoothstep(0.02, 0.30, damp);

    const h = 0.5 + big * 0.046 + small * 0.021 + fines * 0.011;

    // Mixed limestone/granite ballast — mid grey with a mild per-stone spread.
    const stoneT = (A.id - 0.5) * 0.075 + (B.id - 0.5) * 0.030;
    let tone = baseTone + stoneT + fines * 0.035 + big * 0.022 + small * 0.010;
    tone *= 1 - wet * 0.16;
    const r = tone * 1.015, g = tone * 1.0, b = tone * 0.975;

    const rough = clamp(0.90 - big * 0.07 - wet * 0.26 + Math.abs(fines) * 0.05, 0.35, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Red brickwork.
 *
 * A tiling texture cannot carry authorship on its own; a tiling texture plus a
 * variation field at a scale much larger than any of its features can. So this
 * is built in two halves.
 *
 * PER UNIT. Every brick gets its own length (see `makeBrickCourses`), its own
 * value, its own position on a fired-clay hue ramp, and its own firing result.
 * Real stock brick from one kiln spans an enormous range — salmon-pink
 * under-burnt units through orange-red to the near-black over-burnt headers
 * that bricklayers used to pick out into diaper patterns. The old version gave
 * every brick the same colour ±0.055 of value, which is why a wall of them read
 * as one flat sheet of red. Some units are also laid a few millimetres proud or
 * shy of the face, a few have spalled faces exposing a paler unweathered core,
 * and a handful are gone entirely.
 *
 * PER WALL. Four low-frequency condition fields — soot, lime bloom, damp and a
 * general wash — run at 2–4 cycles per tile, i.e. one feature per metre or so.
 * They are what makes a 20 m elevation read as sooted at one end, chalked with
 * efflorescence in the middle and damp in a corner, instead of one mottle
 * stamped nine times. Each is cached through `coarse`, which is what makes four
 * of them affordable.
 *
 * MORTAR is lighter and much less saturated than the brick — that relationship
 * is the second-biggest tell after the grid, and it is easy to get backwards
 * because the cavity map darkens every joint anyway.
 */
function surfaceBrickFine(seed, opts = {}) {
  const {
    rows = 28, cols = 12, soot: sootAmt = 1.0, damp: dampAmt = 1.0, spall: spallAmt = 1.0,
  } = opts;
  const lattice = makeBrickCourses(seed, { rows, cols });
  const grainN = makeTileablePerlin2(seed + 17, 128);
  const faceN = makeTileablePerlin2(seed + 61, 32);

  // --- the four per-wall condition fields.
  const wash = slowWarp(seed + 101, 2, { warp: 1.3 });          // general weathering
  const soot = slowWarp(seed + 210, 3, { warp: 1.4 });          // combustion staining
  const eff = slowWarp(seed + 331, 4, { warp: 0.9 });           // efflorescence / lime
  const damp = slowWarp(seed + 447, 2, { warp: 1.1 });          // rising / trapped damp

  const runs = makeStreaks(seed + 45, { columns: 34, length: 0.75, density: 0.30, width: 0.45 });
  const spallW = makeWorley2(seed + 512, 24);

  return (u, v) => {
    const L = lattice(u, v);
    const gr = fbm((x, y) => grainN(x, y), u * 128, v * 128, { octaves: 3 });
    // Face texture of the individual unit: sand-struck creasing, not tile noise.
    const face = fbm((x, y) => faceN(x, y), u * 32, v * 32, { octaves: 3 });

    // ---------------------------------------------------------- per unit ----
    // Value and hue vary independently: `j0` is how hard this one was fired
    // (dark = long in the fire), `j1` walks the clay from salmon to purple.
    const burn = L.j0;
    const hue = L.j1;
    // Values are the red channel; the ramp below takes green and blue down from
    // it, so the finished luma lands around 0.33 — the middle of the 0.32–0.42
    // reference band for weathered red stock.
    let val = 0.545 - burn * 0.195;                 // 0.545 salmon .. 0.35 dark
    // A minority went a long way past temperature — vitrified, near-black, and
    // slightly blue rather than red. Every real wall has a few, but only a few:
    // at one brick in eight they stop being character and become a domino grid.
    const over = smoothstep(0.935, 0.995, L.j2);
    val *= 1 - over * 0.34;
    // ...and a few never got there at all.
    const under = smoothstep(0.10, 0.02, L.j2);
    val *= 1 + under * 0.20;

    // Fired clay ramp. r/g/b ratios from measured stock brick: the red channel
    // leads by roughly 1.6:1 over blue for orange stock, 1.25:1 for the blues.
    const gk = mix(0.640, 0.735, hue) + over * 0.10;
    const bk = mix(0.520, 0.700, hue) + over * 0.22 - under * 0.04;
    let br = val * (1 + face * 0.055 + gr * 0.030);
    let bg = val * gk * (1 + face * 0.048 + gr * 0.026);
    let bb = val * bk * (1 + face * 0.042 + gr * 0.024);

    // ------------------------------------------------------------ mortar ----
    // Sand/cement, pale and near-neutral, with its own per-course batch
    // variation — a wall pointed over several days is never one colour.
    const batch = 0.955 + ((L.row * 7919) % 13) / 13 * 0.09;
    const m = (0.545 + gr * 0.035 + face * 0.020) * batch;
    const mr = m, mg = m * 0.988, mb = m * 0.958;

    // ------------------------------------------------------- unit defects ---
    const sp = spallW(u, v);
    // Spalled face: frost has taken the skin off, exposing a paler, chalkier
    // core. Gate it per *brick*, so damage belongs to a unit rather than
    // floating across the bond.
    const spallGate = smoothstep(0.72, 0.86, L.j3) * spallAmt;
    const spall = sat(smoothstep(0.55, 0.18, sp.f1 + face * 0.35) * spallGate) * L.brick;
    // A very few units have been knocked right out. This has to stay rare *and*
    // ragged: filling a whole brick cell with a flat dark value does not read as
    // a hole, it reads as a domino pip, and at one unit in forty the wall ends
    // up looking like a game board.
    const missing = smoothstep(0.984, 0.997, L.j3) * L.brick * spallAmt
                  * (0.55 + 0.45 * smoothstep(0.85, 0.25, sp.f1 + face * 0.5));
    // Laid proud or shy — the arris catch that gives a wall its texture.
    const set = (L.j2 - 0.5) * 0.020;

    let r = mix(mr, br, L.brick), g = mix(mg, bg, L.brick), b = mix(mb, bb, L.brick);
    // Exposed core is lighter, less saturated and matte.
    r = mix(r, val * 1.42, spall * 0.85);
    g = mix(g, val * gk * 1.50, spall * 0.85);
    b = mix(b, val * bk * 1.55, spall * 0.85);

    // ---------------------------------------------------- per-wall state ----
    const W = wash(u, v);
    // Soot is thresholded hard: a wall is sooted in *places*, and a field that
    // is faintly grubby everywhere just reads as a low-contrast texture.
    const S = sat((soot(u, v) * 2.4 - 0.12) * sootAmt);
    const E = sat(smoothstep(0.06, 0.34, eff(u, v)));
    const D = sat(smoothstep(0.06, 0.34, damp(u, v)) * dampAmt);
    const run = runs(u, v);

    // General exposure wash: bleached where the rain scours, held where it does not.
    const k = clamp(1.005 + W * 0.26, 0.82, 1.22);
    r *= k; g *= k; b *= k;

    // Soot: carbon is neutral and it *covers*, so it pulls everything toward one
    // dark grey rather than just multiplying the brick down.
    const carbon = sat(S * 0.90 + run * 0.60 * sat(S + 0.25));
    r = mix(r, 0.085, carbon * 0.58); g = mix(g, 0.082, carbon * 0.58); b = mix(b, 0.084, carbon * 0.58);

    // Efflorescence: salts wick out and crystallise as a chalky white bloom,
    // strongest on the mortar because that is where the water travels.
    // Kept deliberately partial: at much above this it stops looking like salt
    // coming out of the joints and starts looking like the wall was rendered.
    const bloom = sat(E * (0.45 + (1 - L.brick) * 0.85)) * (1 - carbon * 0.7);
    r = mix(r, 0.760, bloom * 0.42); g = mix(g, 0.755, bloom * 0.42); b = mix(b, 0.740, bloom * 0.42);

    // Damp: wet masonry is darker and *more* saturated, and it goes glossy.
    const wet = D * (1 - bloom * 0.6);
    r *= 1 - wet * 0.20; g *= 1 - wet * 0.26; b *= 1 - wet * 0.28;

    // Missing unit: a recess with the back-up brickwork in shadow behind it —
    // 100 mm deep, so plenty of bounce still gets in. Never black.
    r = mix(r, 0.190 + gr * 0.05, missing);
    g = mix(g, 0.163 + gr * 0.04, missing);
    b = mix(b, 0.150 + gr * 0.04, missing);

    // ------------------------------------------------------------ relief ----
    const h = 0.5
            + L.brick * 0.034                       // face proud of the joint
            + L.brick * set                          // per-unit set in the bond
            + gr * 0.010 + face * 0.008
            - spall * 0.020
            - missing * 0.070
            + bloom * 0.006;

    const rough = clamp(
      mix(0.94, 0.82 + burn * 0.10, L.brick)
      + gr * 0.035 + spall * 0.06 + bloom * 0.05 + carbon * 0.04
      - wet * 0.30,
      0.32, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Weathered softwood boarding.
 *
 * Two failures in the old one: the growth rings were a sharpened sine at four
 * cycles per tile, which crossed with the plank gaps to make a waffle, and the
 * colour was mixed at r×1.24 / b×0.56 — a ratio of 2.2, i.e. plastic orange.
 * Exterior timber that has been out in the weather for a season is a grey-brown
 * with an r/b ratio nearer 1.2, and its grain runs *along* the board.
 */
function surfaceWoodWeathered(seed, opts = {}) {
  const { planks = 7, tone: baseTone = 0.325, silver = 0.7 } = opts;
  const warpN = makeTileablePerlin2(seed, 4);
  const fineN = makeTileablePerlin2(seed + 13, 16);
  const greyN = makeTileablePerlin2(seed + 71, 3);
  const knotW = makeWorley2(seed + 29, 5);
  const rng = makeRNG(seed + 2);
  const jit = new Float32Array(planks * 3);
  for (let i = 0; i < jit.length; i++) jit[i] = rng();
  return (u, v) => {
    const pf = v * planks;
    const pi = Math.floor(pf);
    const fv = pf - pi;
    const idx = ((pi % planks) + planks) % planks;
    const j0 = jit[idx * 3], j1 = jit[idx * 3 + 1];
    // Sawn edge: a 3–4 mm shadow gap between boards, not a trench.
    const gap = 1 - smoothstep(0.0, 0.020, Math.min(fv, 1 - fv));

    // --- fibre runs along the board: stretch the noise hard in v.
    const warp = fbm((x, y) => warpN(x, y), u * 4, v * 32, { octaves: 4 });
    const fibre = fbm((x, y) => fineN(x, y), u * 16, v * 256, { octaves: 4 });
    // Growth rings — integer cycles in u so the seam matches, but warped hard
    // enough that they meander instead of banding. A clean sine here crosses
    // the plank gaps and the result is a waffle: regular in u, regular in v,
    // which is the single most obvious tell that a wood texture is generated.
    const rings = Math.sin(u * TAU * 13 + warp * 16.0 + j0 * TAU) * 0.5 + 0.5;
    const ring = Math.pow(rings, 1.4);

    const k = knotW(u, v);
    const knot = smoothstep(0.20, 0.05, k.f1) * (k.id > 0.82 ? 1 : 0);

    // --- UV bleaching: exposed timber silvers toward neutral grey.
    const gy = warpedFbm((x, y) => greyN(x, y), u * 3, v * 3, { warp: 1.2, octaves: 5 });
    const grey = sat((gy * 1.4 + 0.5)) * silver;

    const tone = baseTone + (j1 - 0.5) * 0.055 - ring * 0.024 + fibre * 0.048 - knot * 0.085;
    let r = tone * 1.085, g = tone * 1.005, b = tone * 0.885;
    // Silvering pulls what is left toward neutral; it does not brighten it.
    r = mix(r, tone * 1.005, grey * 0.75);
    g = mix(g, tone * 1.005, grey * 0.75);
    b = mix(b, tone * 1.000, grey * 0.75);
    r *= 1 - gap * 0.55; g *= 1 - gap * 0.56; b *= 1 - gap * 0.55;

    const h = 0.5 - ring * 0.008 + fibre * 0.018 - gap * 0.070 - knot * 0.018;
    const rough = clamp(0.80 + grey * 0.10 + Math.abs(fibre) * 0.06 - ring * 0.03, 0.5, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/** Sand/cement render: trowel float marks, soiling, the odd knocked-off patch. */
function surfacePlasterFine(seed, opts = {}) {
  const fineN = makeTileablePerlin2(seed, 96);
  const trowelN = makeTileablePerlin2(seed + 66, 4);
  const dirtN = makeTileablePerlin2(seed + 210, 3);
  const damage = makeWorley2(seed + 900, 16);
  return (u, v) => {
    const t = warpedFbm((x, y) => trowelN(x, y), u * 4, v * 4, { warp: 1.3, octaves: 5 });
    const fine = fbm((x, y) => fineN(x, y), u * 96, v * 96, { octaves: 4 });
    const soil = warpedFbm((x, y) => dirtN(x, y), u * 3, v * 3, { warp: 1.1, octaves: 4 });
    const d = damage(u, v);
    // Ragged, and only in a minority of cells — a round dark spot per cell is
    // polka dots, not damage.
    const nick = fbm((x, y) => fineN(x, y), u * 96, v * 96, { octaves: 3 }) * 0.20;
    const hole = smoothstep(0.22, 0.05, d.f1 + nick) * (d.id > 0.88 ? 1 : 0);
    const grime = sat(Math.max(0, soil) * 1.5);

    const h = 0.5 + t * 0.020 + fine * 0.010 - hole * 0.060;
    let tone = 0.585 + t * 0.036 + fine * 0.015;
    tone = mix(tone, 0.475, hole);
    tone *= 1 - grime * 0.13;
    const rough = clamp(mix(0.88 + fine * 0.05, 0.95, hole) + grime * 0.05, 0.5, 1);
    return { h, r: tone * 1.008, g: tone * 1.0, b: tone * 0.978, rough, metal: 0 };
  };
}

/**
 * Hessian sandbags — one texture tile is one bag.
 *
 * The reason these read as "a pile of crackers" is not the weave, it is that
 * `chamferedBox` projects world-space UVs from each box's own corner, so every
 * bag in an emplacement samples the identical patch of an 0.9 m tile: a flat,
 * uniform, tileable mosaic with no form in it at all. Nothing you do to a
 * generic cloth pattern fixes that.
 *
 * So the material is authored to a tile that matches the bag — 0.50 x 0.20 m
 * against a 0.50 x 0.185 m bag face — and the pattern is a *single bag seen
 * face on*: a fill that has slumped so the belly sits below centre, fabric
 * gathered and creased where the box's chamfer strips run, a sewn seam across
 * the top, sun bleaching on everything that faces up and dirt in everything
 * that faces down.
 *
 * The weave then has to follow that form or the whole thing collapses back to a
 * decal. Two things do it: the thread grid is expanded away from the crown, so
 * the courses crowd together toward the silhouette exactly as a real weave
 * foreshortens, and the horizontal threads bow down over the belly. Both warps
 * are chosen so the thread count across the tile stays an *even integer* —
 * otherwise the plain-weave over/under parity flips at the seam and the tile
 * stops wrapping.
 *
 * Everything else is carried by the height field, because the bulge is what the
 * cavity map turns into shading: a bright crown, dark gathered ends, and a
 * genuine shadow line between one bag and the next.
 */
function surfaceSandbagFine(seed, opts = {}) {
  const {
    tone: baseTone = 0.400,
    threadsU = 56, threadsV = 22,     // ~9 mm jute on a 0.50 x 0.20 m tile
    bleach = 1.0,
  } = opts;
  // Thread-grid warp amounts. Chosen so threads * (1 + curve) is an even
  // integer: 56 * (1 + 4/56) = 60, 22 * (1 + 2/22) = 24.
  const curveU = 4 / threadsU, curveV = 2 / threadsV;
  const fuzzN = makeTileablePerlin2(seed + 4, 96);
  const stainN = makeTileablePerlin2(seed + 9, 4);
  const creaseN = makeTileablePerlin2(seed + 33, 3);
  const grit = makeWorley2(seed + 21, 40);
  const stain = coarse((u, v) => warpedFbm((x, y) => stainN(x, y), u * 4, v * 4,
                                           { warp: 1.2, octaves: 3 }), 48);

  return (u, v) => {
    // ---------------------------------------------------------- the form ----
    // Separable so it is exactly zero on all four tile edges; broad powers so
    // the belly is a plateau and the fall-off happens in the last tenth, which
    // is where the chamfer strips of the box actually are.
    const pu = Math.pow(Math.sin(Math.PI * u), 0.55);
    // v skewed by 0.8 puts the crown at v≈0.42 — the fill has slumped.
    const pv = Math.pow(Math.sin(Math.PI * Math.pow(v, 0.8)), 0.62);
    const bulge = pu * pv;

    // ------------------------------------------------------- the fabric -----
    // Expand the thread grid away from the crown: spacing is widest where the
    // cloth faces us and crowds toward the silhouette.
    const wu = u + curveU * (u - 0.5) * (1 - bulge);
    // ...and let the weft sag over the belly.
    const wv = v + curveV * (v - 0.5) * (1 - bulge) - 0.035 * pu * pv;

    const a = wu * threadsU, c = wv * threadsV;
    const ia = Math.floor(a), ic = Math.floor(c);
    const fa = a - ia, fc = c - ic;
    // Round thread cross-sections, and a plain weave: at each crossing one
    // family passes over the other, and they alternate.
    const ta = Math.pow(Math.sin(Math.PI * fa), 0.50);
    const tc = Math.pow(Math.sin(Math.PI * fc), 0.50);
    const over = ((ia + ic) & 1) === 0;
    const top = over ? ta : tc;
    const under = over ? tc : ta;
    // Centred on zero so the weave modulates about the mean rather than
    // brightening the whole bag.
    const cloth = (top * 0.80 + under * 0.32) - 0.52;
    // Broken fibres standing off the surface.
    const fuzz = fbm((x, y) => fuzzN(x, y), u * 96, v * 96, { octaves: 3 });

    // ------------------------------------------------------- the details ----
    // Sewn closure across the top of the bag: a doubled hem, a stitch line, and
    // the puckered ridge of fabric standing above it.
    const hem = (1 - smoothstep(0.028, 0.060, Math.abs(v - 0.885)))
              * smoothstep(0.02, 0.10, u) * smoothstep(0.98, 0.90, u);
    const stitch = (1 - smoothstep(0.15, 0.45, lineDist(u * threadsU * 0.5)))
                 * (1 - smoothstep(0.008, 0.020, Math.abs(v - 0.885)));
    const ruffle = smoothstep(0.885, 1.0, v)
                 * (0.5 + 0.5 * Math.sin(u * TAU * 9 + 1.3)) * pu;
    // Gathered fabric at the sewn ends: creases pulling into both corners.
    const endU = smoothstep(0.20, 0.03, u) + smoothstep(0.80, 0.97, u);
    const gather = sat(endU) * (0.35 + 0.65 * (1 - smoothstep(0.0, 0.55,
                     lineDist((v - 0.42) * 6))));
    // Slack folds where the bag has been dropped and settled. Ridged noise, not
    // a periodic line family — evenly spaced diagonals across every bag read as
    // corduroy, which is a worse tell than no folds at all.
    const cr = ridged((x, y) => creaseN(x, y), u * 3, v * 3, { octaves: 3 });
    const fold = smoothstep(0.70, 0.96, cr) * smoothstep(0.15, 0.55, bulge) * (1 - hem);

    // ----------------------------------------------------------- shading ----
    // Crevice: everything the bulge does not reach is the gap to the next bag,
    // and that gap is what separates one bag from its neighbours. It has to be
    // emphatic — this is the single edge that turns a mosaic back into a stack.
    const crevice = Math.pow(1 - smoothstep(0.0, 0.55, bulge), 1.4);
    // Bleaching: hessian goes pale and grey where the sun lands, which on a
    // stacked wall is the top third of every bag and the crown of the belly.
    const up = sat(smoothstep(0.34, 0.92, v) * 0.90 + bulge * 0.22) * bleach;
    const soil = sat(stain(u, v) * 1.5 + 0.35);
    const g2 = grit(u, v);
    const dust = smoothstep(0.55, 0.05, g2.f1) * (g2.id > 0.55 ? 1 : 0.25);

    // The form goes almost entirely into the height field, not into albedo.
    //
    // chamferedBox gives each face its own planar projection — the front face
    // reads (x, y), the ends read (z, y), the top and bottom read (x, z) — and
    // a 72 mm chamfer on a 185 mm bag means most of what you see is chamfer
    // strip, not face. Paint a high-contrast bag *into the albedo* and those
    // three projections disagree: the crown lands on one strip and the crevice
    // on the next, and an emplacement turns into a heap of hard-edged khaki
    // shards. Relief has no such problem, because a normal and a cavity term
    // are shading cues that stay plausible whichever way the strip is facing.
    let tone = baseTone
             + cloth * 0.075 + fuzz * 0.032
             + bulge * 0.024                       // the belly catches the light
             - crevice * 0.030                     // and the gap loses it
             - fold * 0.026 + hem * 0.014 - gather * 0.016;
    // Ground-in dirt, strongest low down and in everything below the crown.
    tone *= 1 - sat(soil * 0.62 + crevice * 0.30) * 0.30;

    // Buff jute; UV takes the yellow out of it long before it takes the value.
    let r = tone * 1.120, g = tone * 1.010, b = tone * 0.735;
    const pale = tone * 1.12;
    r = mix(r, pale * 1.010, up * 0.60);
    g = mix(g, pale * 0.995, up * 0.60);
    b = mix(b, pale * 0.925, up * 0.60);
    // Dry dust sitting on the weave.
    r += dust * 0.045; g += dust * 0.042; b += dust * 0.034;

    // Relief. These amplitudes are set by *slope*, not by size, because the
    // driver's Sobel only sees the per-texel difference: the belly rises 0.105
    // over 160 texels and the weave rises 0.004 over three, so the weave is
    // still the stronger normal even at a twenty-fifth of the amplitude. Get
    // that ratio wrong — which the old numbers did, at 0.028 of weave against
    // 0.022 of slump — and the bag has no form at all, only cloth.
    const h = 0.5
            + bulge * 0.105                        // the bag itself
            + cloth * 0.0040 + fuzz * 0.0016
            + hem * 0.010 + stitch * 0.0025 + ruffle * 0.010
            - gather * 0.024 - fold * 0.012
            - crevice * 0.055;

    const rough = clamp(0.93 + fuzz * 0.05 - up * 0.05 + crevice * 0.04
                        - cloth * 0.04, 0.65, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Corrugated roofing/siding steel: sinusoidal profile, purlin screws, and rust
 * that bleeds *down* the sheet and pools in the channels where water sits.
 */
function surfaceCorrugated(seed, opts = {}) {
  const { period = 6, rust = 0.55, tint = [0.392, 0.405, 0.418] } = opts;
  const dentN = makeTileablePerlin2(seed, 6);
  const grainN = makeTileablePerlin2(seed + 7, 16);
  const rustN = makeTileablePerlin2(seed + 401, 8);
  const spangle = makeWorley2(seed + 55, 34);
  const streaks = makeStreaks(seed + 88, { columns: 44, length: 0.85, density: 0.55, width: 0.5 });
  const SCREW_ROWS = [0.25, 0.75];
  return (u, v) => {
    // --- profile: sine ribs, slightly flattened on the crowns like real sheet.
    const s = Math.sin(u * TAU * period);
    const profile = Math.sign(s) * Math.pow(Math.abs(s), 0.8);
    const valley = smoothstep(-0.35, -1.0, s);
    const crest = smoothstep(0.45, 1.0, s);

    // --- large scale: panel dents and buckling.
    const dent = warpedFbm((x, y) => dentN(x, y), u * 6, v * 6, { warp: 0.8, octaves: 4 });
    // --- fine: rolled-in mill grain, stretched along the rib direction (v).
    const grain = fbm((x, y) => grainN(x, y), u * 48, v * 208, { octaves: 3 });
    const sp = spangle(u, v);
    const zinc = smoothstep(0.65, 0.15, sp.f1) * (sp.id > 0.5 ? 1 : 0.35);

    // --- purlin screws on the crowns.
    let screw = 0;
    for (let i = 0; i < SCREW_ROWS.length; i++) {
      const dv = wrapDelta(v - SCREW_ROWS[i]);
      if (Math.abs(dv) > 0.02) continue;
      const du = wrapDelta(frac(u * period) - 0.25) / period;
      const d = Math.sqrt(du * du + dv * dv);
      screw = Math.max(screw, 1 - smoothstep(0.007, 0.011, d));
    }

    // --- rust: channels + streaks + blooms, biased downward.
    const bloom = billow((x, y) => rustN(x, y), u * 8, v * 8, { octaves: 5 });
    const st = streaks(u, v);
    const rustAmt = sat(smoothstep(0.40, 0.80,
      bloom * 1.15 + valley * 0.10 + st * 0.40 - 0.06) * rust * 1.15);

    // Relief budget: a 200 mm-pitch profile is ~18 mm deep, i.e. 0.015 of a
    // 1.2 m tile. The old 0.30 amplitude — with a normalStrength of 3.6 and a
    // normalScale of 1.6 on top — produced normals so steep that the three
    // channels aliased independently at grazing angles, which is exactly what
    // the rainbow moiré was. Amplitude is the fix; the specular-AA pass is not.
    let h = 0.5 + profile * 0.115 + dent * 0.022 + grain * 0.008
          + screw * 0.030 - rustAmt * 0.018 * (0.5 + bloom);

    let r = tint[0] + dent * 0.035 + zinc * 0.022 + grain * 0.014;
    let g = tint[1] + dent * 0.035 + zinc * 0.022 + grain * 0.014;
    let b = tint[2] + dent * 0.035 + zinc * 0.024 + grain * 0.014;
    // Ambient dirt collects in the channels — but a rib is not a shadow, and
    // baking a hard light/dark band per rib into the albedo is what made a
    // warehouse wall read as a barcode.
    const dirt = valley * 0.085 + st * 0.06;
    r *= 1 - dirt; g *= 1 - dirt * 1.02; b *= 1 - dirt * 0.98;
    r += crest * 0.014; g += crest * 0.014; b += crest * 0.014;

    const rr = 0.315 + bloom * 0.11, rg = 0.175 + bloom * 0.058, rb = 0.110 + bloom * 0.032;
    r = mix(r, rr, rustAmt); g = mix(g, rg, rustAmt); b = mix(b, rb, rustAmt);
    r = mix(r, 0.13, screw * 0.3); g = mix(g, 0.13, screw * 0.3); b = mix(b, 0.14, screw * 0.3);

    const rough = clamp(mix(0.52 + Math.abs(grain) * 0.22 + valley * 0.14 - crest * 0.10,
                            0.93, rustAmt), 0.20, 1);
    const metal = mix(0.95, 0.04, rustAmt * 0.92);
    return { h, r, g, b, rough, metal };
  };
}

/**
 * Expanded-metal grate. Deliberately low relief — the openings are cut by the
 * alpha map (see `ALPHA_FIELDS.grate`), the height field only rounds the strands.
 */
function surfaceGrate(seed, opts = {}) {
  const { cells = 6, barW = 0.22, rust = 0.45 } = opts;
  const dia = makeDiamond({ cells, barW });
  const wearN = makeTileablePerlin2(seed, 6);
  const grainN = makeTileablePerlin2(seed + 23, 128);
  const rustN = makeTileablePerlin2(seed + 77, 8);
  return (u, v) => {
    const d = dia(u, v);
    const mask = d.mask;
    const wear = warpedFbm((x, y) => wearN(x, y), u * 6, v * 6, { warp: 1.0, octaves: 4 });
    const grain = fbm((x, y) => grainN(x, y), u * 128, v * 128, { octaves: 3 });
    const bloom = billow((x, y) => rustN(x, y), u * 8, v * 8, { octaves: 4 });
    // Crossings are where water sits and rust starts.
    const cross = sat(d.sA * d.sB * 1.4);
    const rustAmt = sat(smoothstep(0.40, 0.78, bloom * 1.2 + cross * 0.35 + wear * 0.2) * rust * 1.6);

    const round = Math.max(d.rA, d.rB);
    const h = 0.42 + mask * 0.10 + round * 0.10 + cross * 0.05 + grain * 0.012;

    // Walked-on grate: bare shiny steel on the raised edges, grime everywhere else.
    let tone = 0.235 + wear * 0.04 + grain * 0.025 + round * 0.060;
    let r = tone, g = tone * 1.0, b = tone * 1.05;
    const rr = 0.315 + bloom * 0.10, rg = 0.175 + bloom * 0.052, rb = 0.108 + bloom * 0.028;
    r = mix(r, rr, rustAmt); g = mix(g, rg, rustAmt); b = mix(b, rb, rustAmt);

    const rough = clamp(mix(0.48 - round * 0.16 + Math.abs(grain) * 0.2, 0.94, rustAmt), 0.14, 1);
    const metal = mix(0.94, 0.05, rustAmt * 0.9) * mask;
    return { h, r, g, b, rough, metal };
  };
}

/**
 * Chain-link fence: thin galvanised wire on the same diamond lattice, woven
 * over/under. Almost all of the tile is open — the alpha map does the work.
 */
function surfaceChainlink(seed, opts = {}) {
  const { cells = 7, barW = 0.075, rust = 0.3 } = opts;
  const dia = makeDiamond({ cells, barW });
  const wearN = makeTileablePerlin2(seed, 6);
  const grainN = makeTileablePerlin2(seed + 31, 8);
  const rustN = makeTileablePerlin2(seed + 92, 8);
  return (u, v) => {
    const d = dia(u, v);
    // The "over" strand of each crossing sits proud of the "under" one.
    const front = d.over ? d.sA : d.sB;
    const back = d.over ? d.sB : d.sA;
    const roundF = d.over ? d.rA : d.rB;
    const roundB = d.over ? d.rB : d.rA;
    const mask = Math.max(front, back);

    const wear = warpedFbm((x, y) => wearN(x, y), u * 6, v * 6, { warp: 1.0, octaves: 4 });
    const grain = fbm((x, y) => grainN(x, y), u * 40, v * 256, { octaves: 3 });
    const bloom = billow((x, y) => rustN(x, y), u * 8, v * 8, { octaves: 4 });
    const rustAmt = sat(smoothstep(0.44, 0.80, bloom * 1.2 + wear * 0.22) * rust * 1.7);

    const h = 0.45 + back * (0.05 + roundB * 0.05) + front * (0.10 + roundF * 0.10);

    let tone = 0.455 + roundF * 0.10 + wear * 0.04 + grain * 0.04 - back * (1 - front) * 0.06;
    let r = tone * 0.99, g = tone, b = tone * 1.04;
    const rr = 0.320 + bloom * 0.10, rg = 0.180 + bloom * 0.052, rb = 0.112 + bloom * 0.028;
    r = mix(r, rr, rustAmt); g = mix(g, rg, rustAmt); b = mix(b, rb, rustAmt);

    const rough = clamp(mix(0.32 - roundF * 0.10 + Math.abs(grain) * 0.2, 0.92, rustAmt), 0.10, 1);
    const metal = mix(0.96, 0.05, rustAmt * 0.9) * mask;
    return { h, r, g, b, rough, metal };
  };
}

/**
 * Diagonal hazard stripes over steel. Heavily chipped: the paint has been
 * knocked off every edge and corner, and what is left is chalked and filthy.
 */
function surfaceWarningStripe(seed, opts = {}) {
  const {
    stripes = 4,
    colA = [0.660, 0.505, 0.135],     // safety yellow — pigment, not a gamut edge
    colB = [0.085, 0.080, 0.076],     // near-black
    chipping = 1.0,
  } = opts;
  const edgeN = makeTileablePerlin2(seed + 4, 64);
  const wearN = makeTileablePerlin2(seed, 6);
  const loss = makePaintLoss(seed + 700, { sheets: 8, chips: 30, amount: chipping, bias: 0.12 });
  const chips2 = makeWorley2(seed + 62, 58);
  const scratchN = makeTileablePerlin2(seed + 8, 16);
  const grimeN = makeTileablePerlin2(seed + 210, 8);
  return (u, v) => {
    // --- stripe pattern. Integer `stripes` on (u+v) keeps the 45° angle tileable.
    const wobble = fbm((x, y) => edgeN(x, y), u * 64, v * 64, { octaves: 3 }) * 0.012;
    const t = frac((u + v) * stripes + wobble);
    // 1 on the dark half of the cycle, with a stencil-soft edge at both ends.
    const isB = smoothstep(0.492, 0.510, t) * (1 - smoothstep(0.990, 1.0, t));

    // --- paint failure: sheets first, then impact pitting on top. This is the
    //     most abused paint on the map, so `bias` pushes the failure gate open.
    const wear = warpedFbm((x, y) => wearN(x, y), u * 6, v * 6, { warp: 1.1, octaves: 5 });
    const P = loss(u, v);
    const c2 = chips2(u, v);
    const pit = smoothstep(0.26, 0.04, c2.f1) * (c2.id > 0.74 ? 1 : 0);
    const chipped = sat(P.loss + pit * 0.85 * chipping);
    const scr = fbm((x, y) => scratchN(x, y), u * 192, v * 16, { octaves: 3 });
    const grime = warpedFbm((x, y) => grimeN(x, y), u * 8, v * 8, { warp: 0.9, octaves: 4 }) * 0.5 + 0.5;

    // --- colour: paint, then bare steel through the chips, then grime on top.
    const fade = 0.88 + wear * 0.13;
    let r = mix(colA[0], colB[0], isB) * fade;
    let g = mix(colA[1], colB[1], isB) * fade;
    let b = mix(colA[2], colB[2], isB) * fade;
    const steel = 0.335 + scr * 0.075 + wear * 0.04;
    r = mix(r, steel * 1.0, chipped);
    g = mix(g, steel * 1.0, chipped);
    b = mix(b, steel * 1.06, chipped);
    const dirt = sat(grime * 0.5 + chipped * 0.15);
    r *= 1 - dirt * 0.34; g *= 1 - dirt * 0.35; b *= 1 - dirt * 0.32;

    const h = 0.5 + wear * 0.014 - chipped * 0.030 + scr * 0.008 - pit * 0.020;
    const rough = clamp(mix(0.52 + grime * 0.22 + wear * 0.08,
                            0.44 + Math.abs(scr) * 0.20, chipped), 0.16, 1);
    return { h, r, g, b, rough, metal: chipped * 0.88 };
  };
}

/**
 * Worn road paint over asphalt. Designed to be applied to a thin strip mesh —
 * the paint fills the tile with a ragged, feathered edge and the asphalt reads
 * through wherever the traffic has taken it off.
 */
function surfaceRoadMarking(seed, opts = {}) {
  const { color = [0.845, 0.845, 0.815], coverage = 0.62, beads = 0.5 } = opts;
  const asph = makeAsphaltBase(seed + 500);
  const wearN = makeTileablePerlin2(seed, 6);
  const edgeN = makeTileablePerlin2(seed + 12, 32);
  const tread = makeWorley2(seed + 9, 7);
  const beadN = makeWorley2(seed + 44, 120);
  return (u, v) => {
    const a = asph(u, v);

    // --- paint mask: large blotchy wear + tyre-track scrub + ragged edges.
    const wear = warpedFbm((x, y) => wearN(x, y), u * 6, v * 6, { warp: 1.2, octaves: 5 });
    const ragged = fbm((x, y) => edgeN(x, y), u * 32, v * 32, { octaves: 4 }) * 0.09;
    const tr = tread(u, v);
    // Wheel-scrubbed patches: a few big bald areas, not an even mottle.
    const scrub = smoothstep(0.80, 0.24, tr.f1 + ragged * 0.4) * (tr.id > 0.66 ? 1 : 0);
    const feather = smoothstep(0.0, 0.055, v + ragged) * smoothstep(1.0, 1.0 - 0.055, v + ragged);
    let paint = smoothstep(0.42 - coverage * 0.45, 0.62 - coverage * 0.45, wear * 0.5 + 0.5);
    paint = sat(paint * feather * (1 - scrub * 0.85));
    // The paint film is thin but it does sit on top and it does fill the voids.
    const filled = paint * (1 - smoothstep(0.0, 0.18, a.stone));

    const bd = beadN(u, v);
    const bead = smoothstep(0.45, 0.05, bd.f1) * (bd.id > 0.6 ? 1 : 0) * beads * paint;

    const dirt = 0.82 + wear * 0.20;
    let r = mix(a.tone * 1.00, color[0] * dirt + bead * 0.10, paint);
    let g = mix(a.tone * 0.99, color[1] * dirt + bead * 0.10, paint);
    let b = mix(a.tone * 1.02, color[2] * dirt + bead * 0.11, paint);

    const h = a.h * (1 - filled * 0.55) + filled * 0.30 + bead * 0.02;
    // Fresh paint with glass beads is duller than wet asphalt but not flat.
    const rough = clamp(mix(a.rough, 0.62 - bead * 0.22 + Math.abs(wear) * 0.08, paint), 0.2, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/** Moulded rubber: matte, pebbled, dust in the crevices, optional stud tread. */
function surfaceRubber(seed, opts = {}) {
  const { tone = 0.072, tread = 0.35, dust = 0.5 } = opts;
  const pebble = makeWorley2(seed + 2, 70);
  const micro = makeTileablePerlin2(seed + 31, 128);
  const bigN = makeTileablePerlin2(seed, 6);
  const crackN = makeTileablePerlin2(seed + 15, 8);
  const dia = makeDiamond({ cells: 4, barW: 0.34 });
  return (u, v) => {
    const p = pebble(u, v);
    const bump = smoothstep(0.75, 0.08, p.f1) * (0.5 + p.id * 0.5);
    const grain = fbm((x, y) => micro(x, y), u * 128, v * 128, { octaves: 3 });
    const big = warpedFbm((x, y) => bigN(x, y), u * 6, v * 6, { warp: 1.0, octaves: 5 });
    // Perished rubber crazes into a fine ridged network.
    const craze = ridged((x, y) => crackN(x, y), u * 8, v * 8, { octaves: 4 });
    const crack = smoothstep(0.88, 0.99, craze);
    const t = dia(u, v).mask * tread;

    const h = 0.5 + bump * 0.055 + grain * 0.015 + big * 0.02 + t * 0.09 - crack * 0.06;
    // Dust settles in everything below the local average.
    const dustAmt = sat((0.5 - bump) * dust + crack * 0.5 * dust + big * 0.15);
    let base = tone * (1 + big * 0.55 + grain * 0.3) + t * 0.012;
    let r = base + dustAmt * 0.085;
    let g = base + dustAmt * 0.082;
    let b = base + dustAmt * 0.075;
    const rough = clamp(0.86 + dustAmt * 0.10 - bump * 0.10 + grain * 0.05, 0.5, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Tarpaulin. The fold structure is domain-warped ridged noise — creases that
 * branch and run instead of the uniform wrinkle field plain FBM gives you —
 * over a coarse PVC weave, with abrasion whitening on the crease peaks.
 */
function surfaceTarp(seed, opts = {}) {
  const { color = [0.185, 0.235, 0.185], wearAmt = 0.6 } = opts;
  const warpN = makeTileablePerlin2(seed, 4);
  const foldN = makeTileablePerlin2(seed + 27, 8);
  const weaveN = makeTileablePerlin2(seed + 3, 256);
  const grimeN = makeTileablePerlin2(seed + 700, 6);
  const holes = makeWorley2(seed + 66, 14);
  return (u, v) => {
    // --- domain warp, then ridged: gives long branching creases.
    const qx = fbm((x, y) => warpN(x, y), u * 4, v * 4, { octaves: 3 });
    const qy = fbm((x, y) => warpN(x, y), u * 4 + 5.2, v * 4 + 1.3, { octaves: 3 });
    const fold = ridged((x, y) => foldN(x, y), u * 8 + qx * 1.5, v * 8 + qy * 1.5, { octaves: 4 });
    const crease = smoothstep(0.55, 0.96, fold);
    const slack = fbm((x, y) => warpN(x, y), u * 4, v * 4, { octaves: 4 });

    // --- coarse woven scrim: two perpendicular thread families.
    const tw = Math.sin(u * TAU * 128) * 0.5 + 0.5;
    const tv = Math.sin(v * TAU * 128) * 0.5 + 0.5;
    const noiseW = fbm((x, y) => weaveN(x, y), u * 256, v * 256, { octaves: 2 });
    const weave = (tw * 0.5 + tv * 0.5) + noiseW * 0.25;

    // --- wear: creases abrade white, torn eyelets, dirt in the troughs.
    const hl = holes(u, v);
    const tear = smoothstep(0.26, 0.10, hl.f1) * (hl.id > 0.86 ? 1 : 0);
    const abrasion = sat(crease * wearAmt * (0.5 + weave * 0.5));
    const grime = warpedFbm((x, y) => grimeN(x, y), u * 6, v * 6, { warp: 1.2, octaves: 5 }) * 0.5 + 0.5;

    const h = 0.5 + slack * 0.11 + crease * 0.075 + weave * 0.022 - tear * 0.25;
    const lit = 1 + slack * 0.28 + crease * 0.18;
    let r = color[0] * lit, g = color[1] * lit, b = color[2] * lit;
    // Abraded PVC goes chalky and pale.
    r = mix(r, r * 0.55 + 0.42, abrasion * 0.75);
    g = mix(g, g * 0.55 + 0.42, abrasion * 0.75);
    b = mix(b, b * 0.55 + 0.40, abrasion * 0.75);
    const dirt = sat(grime * 0.55 - crease * 0.25);
    r *= 1 - dirt * 0.30; g *= 1 - dirt * 0.31; b *= 1 - dirt * 0.28;
    r = mix(r, 0.055, tear); g = mix(g, 0.05, tear); b = mix(b, 0.05, tear);

    const rough = clamp(0.66 + dirt * 0.22 + abrasion * 0.20 - crease * 0.10, 0.3, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Spalled reinforced concrete: shell damage has blown patches off the face and
 * the rebar cage underneath is exposed and rusting. The rust bleeds down out of
 * each patch and stains the sound concrete below it.
 */
function surfaceRebar(seed, opts = {}) {
  const { bars = 5, barR = 0.013, spall = 0.55 } = opts;
  const conc = makeConcreteBase(seed);
  const spallN = makeWorley2(seed + 33, 5);
  const edgeN = makeTileablePerlin2(seed + 8, 16);
  const rustN = makeTileablePerlin2(seed + 401, 8);
  const streaks = makeStreaks(seed + 12, { columns: 32, length: 0.5, density: 0.4, width: 0.7 });
  return (u, v) => {
    const c = conc(u, v);

    // --- spalled patches: big worley cells, ragged edges, only some of them.
    const sp = spallN(u, v);
    const ragged = fbm((x, y) => edgeN(x, y), u * 16, v * 16, { octaves: 4 }) * 0.18;
    const patch = sat(smoothstep(0.62, 0.30, sp.f1 + ragged) * (sp.id > (1 - spall) ? 1 : 0));
    const lip = smoothstep(0.30, 0.62, sp.f1 + ragged) * smoothstep(0.75, 0.55, sp.f1 + ragged);

    // --- rebar cage: two families of deformed bar on a grid.
    const du = Math.abs(wrapDelta(frac(u * bars) - 0.5)) / bars;
    const dv = Math.abs(wrapDelta(frac(v * bars) - 0.5)) / bars;
    const barU = 1 - smoothstep(barR * 0.7, barR, dv);   // horizontal bars
    const barV = 1 - smoothstep(barR * 0.7, barR, du);   // vertical bars
    const roundU = barU > 0 ? Math.sqrt(Math.max(0, 1 - (dv / barR) * (dv / barR))) : 0;
    const roundV = barV > 0 ? Math.sqrt(Math.max(0, 1 - (du / barR) * (du / barR))) : 0;
    // Deformation ribs along each bar.
    const ribU = (Math.sin(u * TAU * 96) * 0.5 + 0.5) * barU;
    const ribV = (Math.sin(v * TAU * 96) * 0.5 + 0.5) * barV;
    const barMask = sat(Math.max(barU, barV)) * patch;
    const barRound = Math.max(roundU * barU, roundV * barV);
    const rib = Math.max(ribU, ribV);

    // --- rust on the bar, and bleeding down the wall from every patch.
    const bloom = billow((x, y) => rustN(x, y), u * 8, v * 8, { octaves: 4 });
    const bleed = sat(streaks(u, v) * smoothstep(0.0, 0.35, patch + lip * 0.5) * 1.4
                    + patch * 0.25);

    // Height: the patch floor is set back, the bar stands in the void. A 40 mm
    // spall on a 1.6 m tile is 0.025; a 26 mm bar standing in it is 0.016.
    const h = c.h - patch * 0.055 + barMask * (0.030 + barRound * 0.015 + rib * 0.006)
            + lip * 0.010;

    // Colour: sound face, then the darker unweathered core inside the patch,
    // then the bar, then rust staining over everything.
    let tone = c.tone;
    tone = mix(tone, tone * 0.78, patch);            // shadowed, fresher break
    let r = tone * 1.012, g = tone * 1.0, b = tone * 0.980;
    const rustCol = [0.325 + bloom * 0.11, 0.180 + bloom * 0.055, 0.108 + bloom * 0.030];
    r = mix(r, rustCol[0] * (0.8 + rib * 0.35), barMask);
    g = mix(g, rustCol[1] * (0.8 + rib * 0.35), barMask);
    b = mix(b, rustCol[2] * (0.8 + rib * 0.35), barMask);
    const stain = sat(bleed * 0.9);
    r = mix(r, rustCol[0] * 0.85, stain * 0.7);
    g = mix(g, rustCol[1] * 0.85, stain * 0.7);
    b = mix(b, rustCol[2] * 0.9, stain * 0.7);

    const rough = clamp(mix(mix(c.rough, 0.95, patch * 0.4), 0.82, barMask), 0.4, 1);
    return { h, r, g, b, rough, metal: barMask * 0.55 };
  };
}

/**
 * Glass. Mostly a clean, very smooth dielectric — the interest is entirely in
 * what is *on* it: dust film, gravity-driven grime runs, splatter, and (in the
 * broken variant) an impact star with shards missing.
 */
function surfaceGlass(seed, opts = {}) {
  const {
    broken = false, tint = [0.60, 0.66, 0.63], grime = 0.6, shatter: shatterOpts = {},
  } = opts;
  const dustN = makeTileablePerlin2(seed, 6);
  const filmN = makeTileablePerlin2(seed + 41, 32);
  const spots = makeWorley2(seed + 7, 40);
  const streaks = makeStreaks(seed + 21, { columns: 52, length: 0.9, density: 0.6, width: 0.4 });
  const shatter = broken ? makeShatter(seed, shatterOpts) : null;
  return (u, v) => {
    const dust = warpedFbm((x, y) => dustN(x, y), u * 6, v * 6, { warp: 1.1, octaves: 5 }) * 0.5 + 0.5;
    const film = fbm((x, y) => filmN(x, y), u * 32, v * 32, { octaves: 4 });
    const sp = spots(u, v);
    const splat = smoothstep(0.42, 0.06, sp.f1) * (sp.id > 0.62 ? 1 : 0);
    const run = streaks(u, v);
    const dirt = sat((dust * 0.75 + film * 0.2 + run * 0.55 + splat * 0.7) * grime);

    let h = 0.5 + dirt * 0.010 + splat * 0.008;
    // Glass is dark in albedo — almost all of what you see is reflection.
    let r = tint[0] * 0.12, g = tint[1] * 0.12, b = tint[2] * 0.12;
    const grimeCol = 0.30 + dust * 0.22;
    r = mix(r, grimeCol * 1.00, dirt * 0.8);
    g = mix(g, grimeCol * 0.99, dirt * 0.8);
    b = mix(b, grimeCol * 0.94, dirt * 0.8);
    let rough = clamp(0.045 + dirt * 0.55 + splat * 0.2, 0.02, 1);

    if (shatter) {
      const s = shatter(u, v);
      // Crushed glass along a crack is bright and completely diffuse.
      const cr = s.crack;
      h -= cr * 0.05;
      r = mix(r, 0.62, cr * 0.85); g = mix(g, 0.66, cr * 0.85); b = mix(b, 0.68, cr * 0.85);
      rough = clamp(mix(rough, 0.72, cr * 0.9), 0.02, 1);
      // Cull-out regions are handled by the alpha map; darken them so any
      // mis-set alphaTest still reads as a hole rather than a bright pane.
      const hole = s.hole;
      r *= 1 - hole * 0.9; g *= 1 - hole * 0.9; b *= 1 - hole * 0.9;
      h -= hole * 0.1;
    }
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Concrete with the full weathering pass: soot, efflorescence, rust runoff from
 * fixings above, and a dirt gradient rising off the ground.
 */
function surfaceConcreteStained(seed, opts = {}) {
  const { stain = 1.0 } = opts;
  const conc = makeConcreteBase(seed, opts);
  const crackN = makeTileablePerlin2(seed + 55, 8);
  const sootF = slowWarp(seed + 220, 4, { warp: 1.3 });
  const effF = slowWarp(seed + 331, 6, { warp: 0.9 });
  const dark = makeStreaks(seed + 12, { columns: 26, length: 0.8, density: 0.5, width: 0.9 });
  const rusty = makeStreaks(seed + 77, { columns: 60, length: 0.55, density: 0.18, width: 0.25 });
  return (u, v) => {
    const c = conc(u, v);
    const cr = ridged((x, y) => crackN(x, y), u * 8, v * 8, { octaves: 4 });
    const crack = smoothstep(0.87, 0.985, cr);
    const soot = sootF(u, v) * 0.5 + 0.5;
    const eff = effF(u, v);

    const wet = sat(dark(u, v) * stain);
    const rustRun = sat(rusty(u, v) * stain + (c.bleed || 0) * 0.9);
    // General grime settling into the pores. Deliberately no height gradient:
    // a "dirtier near the ground" ramp cannot tile, and grounding belongs to
    // the level's vertex darkening / decals, not to a repeating material.
    const grime = sat((soot * 0.85 + wet * 0.8) * stain);
    const bloom = sat(smoothstep(0.10, 0.42, eff) * 0.7);   // efflorescence / lime

    // A hairline crack is a hairline: the 0.4 that used to be here was eight
    // times the entire relief budget of the surface and gouged black canyons
    // through the normal map.
    const h = c.h - crack * 0.045 + bloom * 0.012;
    let tone = c.tone - crack * 0.06;
    tone *= 1 - grime * 0.42;
    tone = mix(tone, 0.72, bloom * 0.55);
    let r = tone * 1.02, g = tone * 1.0, b = tone * 0.965;
    r *= 1 - grime * 0.03; b *= 1 + grime * 0.05;              // grime skews cool
    r = mix(r, 0.36 + c.grain * 0.05, rustRun * 0.8);
    g = mix(g, 0.185 + c.grain * 0.03, rustRun * 0.8);
    b = mix(b, 0.095 + c.grain * 0.02, rustRun * 0.8);

    const rough = clamp(c.rough + grime * 0.06 - wet * 0.16 + bloom * 0.05, 0.4, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/** Painted brickwork: a coat of paint that bridges the mortar and is peeling. */
function surfaceBrickPainted(seed, opts = {}) {
  const { color = [0.700, 0.680, 0.640], peel = 0.7, rows = 28, cols = 12 } = opts;
  const lattice = makeBrickCourses(seed, { rows, cols });
  const grainN = makeTileablePerlin2(seed + 17, 128);
  const wearF = slowWarp(seed, 6, { warp: 1.0 });
  const loss = makePaintLoss(seed + 300, { sheets: 6, chips: 22, amount: peel });
  const streaks = makeStreaks(seed + 45, { columns: 30, length: 0.7, density: 0.4, width: 0.8 });
  return (u, v) => {
    const L = lattice(u, v);
    const gr = fbm((x, y) => grainN(x, y), u * 128, v * 128, { octaves: 3 });
    const wear = wearF(u, v);

    // --- paint film: comes off in sheets, and never bonded well to the arrises
    //     of the brick in the first place. No height ramp — see the note in
    //     surfaceConcreteStained.
    const P = loss(u, v);
    const arris = (1 - smoothstep(0.0, 0.10, Math.min(L.fu, 1 - L.fu))) * 0.42
                + (1 - smoothstep(0.0, 0.14, Math.min(L.fv, 1 - L.fv))) * 0.34;
    const peeled = sat(P.loss + arris * smoothstep(-0.10, 0.34, wear) * peel);

    // --- what is underneath. Same per-unit model as the bare brick surface:
    //     value from how hard the unit was fired, hue walking the clay ramp,
    //     and mortar that is lighter and less saturated, not darker.
    const val = (0.470 - L.j0 * 0.185) * (1 - smoothstep(0.88, 0.99, L.j2) * 0.42);
    const gk = mix(0.640, 0.735, L.j1), bk = mix(0.520, 0.700, L.j1);
    const br = val * (1 + gr * 0.030), bg = val * gk, bb = val * bk;
    const mr = 0.545 + gr * 0.030;
    const sr = mix(mr, br, L.brick), sg = mix(mr * 0.992, bg, L.brick), sb = mix(mr * 0.965, bb, L.brick);

    // --- paint on top; the film sits proud and bridges the mortar joints. It is
    //     a thin coat brushed onto an absorbent, textured substrate, though, not
    //     a laminate: the units still ghost through it. Without that the wall
    //     comes out as featureless grey emulsion and the bond disappears
    //     entirely, which is a worse lie than an unpainted wall would be.
    const film = (1 - peeled) * 0.92;
    const fade = 0.86 + wear * 0.24;
    let r = mix(sr, color[0] * fade, film);
    let g = mix(sg, color[1] * fade, film);
    let b = mix(sb, color[2] * fade, film);

    const dirtRun = sat(streaks(u, v) * 0.9 + Math.max(0, wear) * 0.3);
    r *= 1 - dirtRun * 0.30; g *= 1 - dirtRun * 0.31; b *= 1 - dirtRun * 0.29;

    // 5 mm joint on a 1.04 m tile — the joint is a shadow line, not a canyon.
    const h = 0.5 + L.brick * 0.034 + gr * 0.012 + film * 0.008 - peeled * 0.008;
    const rough = clamp(mix(mix(0.94, 0.80, L.brick) + gr * 0.05,
                            0.60 + wear * 0.10, film), 0.35, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Blown-out plaster: whole areas have come off the wall and the blockwork
 * behind is showing, with a scrim of cracks and water damage over the rest.
 */
function surfacePlasterDamaged(seed, opts = {}) {
  const { damage = 1.0 } = opts;
  const lattice = makeBrickLattice(seed + 3, { rows: 12, cols: 6, mortarW: 0.06, mortarH: 0.11 });
  const trowelN = makeTileablePerlin2(seed + 66, 6);
  const fineN = makeTileablePerlin2(seed, 110);
  const holes = makeWorley2(seed + 900, 6);
  const holes2 = makeWorley2(seed + 901, 13);
  const crackN = makeTileablePerlin2(seed + 21, 8);
  const edgeN = makeTileablePerlin2(seed + 12, 32);
  const streaks = makeStreaks(seed + 5, { columns: 24, length: 0.75, density: 0.45, width: 1.0 });
  return (u, v) => {
    const trowel = warpedFbm((x, y) => trowelN(x, y), u * 6, v * 6, { warp: 1.4, octaves: 4 });
    const fine = fbm((x, y) => fineN(x, y), u * 110, v * 110, { octaves: 4 });
    // Edge break-up. A worley cell is a circle; render does not fall off a wall
    // in circles, so the edge noise has to be strong enough to destroy the cell
    // shape entirely — otherwise the wall reads as polka dots at any distance.
    const ragged = fbm((x, y) => edgeN(x, y), u * 32, v * 32, { octaves: 4 }) * 0.34;

    // --- two scales of loss: big fallen areas plus scattered knocks. Both
    //     gates used to open on roughly half their cells, which put render loss
    //     over more than half the wall and read as evenly-spaced polka dots
    //     rather than as damage. Render comes off where it was already bad —
    //     a minority of places, with very ragged edges.
    const hA = holes(u, v), hB = holes2(u, v);
    const big = smoothstep(0.58, 0.22, hA.f1 + ragged * 1.5) * (hA.id > 0.70 ? 1 : 0);
    const small = smoothstep(0.34, 0.10, hB.f1 + ragged) * (hB.id > 0.86 ? 1 : 0);
    const lost = sat((big + small * 0.85) * damage);
    // Feathered lip where the render is about to let go.
    const lip = sat(smoothstep(0.28, 0.60, hA.f1 + ragged) * smoothstep(0.80, 0.58, hA.f1 + ragged));

    // --- crack scrim over the intact render.
    const cr = ridged((x, y) => crackN(x, y), u * 8, v * 8, { octaves: 5 });
    const crack = smoothstep(0.86, 0.98, cr) * (1 - lost);

    // --- substrate: dense concrete blockwork, near-neutral and mid-value.
    const L = lattice(u, v);
    // Blockwork is only a little darker than the render over it — a 1.5:1 step
    // is what turns each lost patch into a black spot instead of a shadow.
    const sub = 0.450 + L.j0 * 0.050 + fine * 0.028;
    const sr = mix(sub * 0.96, sub * 1.06, L.brick);
    const sg = mix(sub * 0.955, sub * 1.03, L.brick);
    const sb = mix(sub * 0.93, sub * 0.99, L.brick);

    // --- render coat.
    let tone = 0.585 + trowel * 0.048 + fine * 0.022;
    let r = tone * 1.008, g = tone * 1.0, b = tone * 0.972;
    const stain = sat(streaks(u, v) * 0.9 + Math.max(0, trowel) * 0.45);
    r *= 1 - stain * 0.26; g *= 1 - stain * 0.27; b *= 1 - stain * 0.24;
    r -= crack * 0.075; g -= crack * 0.075; b -= crack * 0.070;
    r = mix(r, sr, lost); g = mix(g, sg, lost); b = mix(b, sb, lost);
    // Dust of fallen plaster smeared around each hole.
    r += lip * 0.035; g += lip * 0.034; b += lip * 0.032;

    // A 15 mm render coat on a 2.4 m tile is a 0.006 step. Give it a little
    // more than that so the lost areas still read, but nowhere near the
    // quarter-of-a-tile cliff this used to author.
    const subH = 0.470 + L.brick * 0.030 + fine * 0.015;
    const rendH = 0.5 + trowel * 0.020 + fine * 0.014 - crack * 0.075;
    const h = mix(rendH, subH - 0.020, lost) + lip * 0.010;
    const rough = clamp(mix(0.88 + fine * 0.06 + stain * 0.04, 0.95, lost), 0.5, 1);
    return { h, r, g, b, rough, metal: 0 };
  };
}

/**
 * Heavily rusted steel plate.
 *
 * The built-in `metal` kind gates its rust behind a threshold its noise rarely
 * reaches, so `rust: 0.95` still comes out looking like clean panel. This is the
 * real thing: three scales of corrosion — broad blooms, mid-scale scale plates
 * that have lifted and flaked away, and fine pitting — plus perforation where
 * the plate has rusted right through, and runoff down the face.
 */
function surfaceRustedMetal(seed, opts = {}) {
  const {
    panels = 3, tint = [0.335, 0.348, 0.365], amount = 1.0, holes = 0.35,
  } = opts;
  const bloomN = makeTileablePerlin2(seed + 401, 6);
  const plateW = makeWorley2(seed + 12, 16);
  const pitW = makeWorley2(seed + 33, 64);
  const grainN = makeTileablePerlin2(seed + 7, 128);
  const rivets = makeWorley2(seed + 21, panels * 2);
  const streaks = makeStreaks(seed + 88, { columns: 36, length: 0.9, density: 0.6, width: 0.7 });
  return (u, v) => {
    // --- panel seams and rivets, same language as the clean plate.
    const pu = u * panels, pv = v * panels;
    const seam = 1 - smoothstep(0.0, 0.035,
      Math.min(Math.abs(pu - Math.round(pu)), Math.abs(pv - Math.round(pv))));
    const rv = rivets(u, v);
    const rivet = smoothstep(0.16, 0.06, rv.f1) * (rv.id > 0.45 ? 1 : 0);

    // --- 1: broad corrosion blooms (the large scale that kills tiling).
    const bloom = warpedFbm((x, y) => bloomN(x, y), u * 6, v * 6, { warp: 1.2, octaves: 5 }) * 0.5 + 0.5;
    const st = streaks(u, v);
    const corrosion = sat((bloom * 1.35 + seam * 0.30 + st * 0.35 - 0.30) * amount);

    // --- 2: scale plates. Lifted flakes with a hard edge and a fresher pit under.
    const pl = plateW(u, v);
    const plate = smoothstep(0.62, 0.30, pl.f1) * (pl.id > 0.35 ? 1 : 0);
    const lifted = sat(plate * smoothstep(0.15, 0.55, corrosion));
    const flakeEdge = smoothstep(0.30, 0.62, pl.f1) * smoothstep(0.80, 0.58, pl.f1) * lifted;

    // --- 3: fine pitting, and the odd hole right through.
    const pt = pitW(u, v);
    const pit = smoothstep(0.55, 0.10, pt.f1) * (pt.id > 0.45 ? 1 : 0) * corrosion;
    const perf = smoothstep(0.28, 0.06, pt.f1) * (pt.id > 0.95 ? 1 : 0)
               * smoothstep(0.6, 0.95, corrosion) * holes;
    const grain = fbm((x, y) => grainN(x, y), u * 128, v * 128, { octaves: 4 });

    // Millimetre relief: a lifted scale plate stands ~2 mm off a plate that is
    // itself 3 mm thick. On a 2.2 m tile that is 0.001 — these numbers are
    // already generous, and the old ones (0.45 for a perforation) were not
    // relief at all, they were a hole punched through the normal map.
    const h = 0.5 - seam * 0.075 + rivet * 0.10
            + lifted * 0.028 - flakeEdge * 0.016 - pit * 0.045 - perf * 0.20
            + grain * 0.014 - corrosion * 0.012;

    // --- colour ramp: bare steel -> dark oxide -> red scale -> pale dust.
    let r = tint[0] + grain * 0.035, g = tint[1] + grain * 0.035, b = tint[2] + grain * 0.035;
    const t = sat(corrosion * 1.1);
    // Iron oxide is a dark RED-BROWN. The bright orange everyone reaches for is
    // freshly-wetted rust on clean steel, and it never covers a whole plate.
    // Chroma matters as much as value here. This surface is also what dresses
    // every rolling hoop and chime on the drums, and those are 25–35 mm bands
    // read against a painted body — at that width a saturated orange-brown
    // stops being corrosion and becomes a stripe. Weathered oxide in daylight
    // is a low-chroma iron brown: r/b around 1.9 for the dark scale and 2.3 for
    // the fresh bloom, not the 2.4/3.0 this used to author.
    const darkR = 0.168, darkG = 0.110, darkB = 0.089;
    const orgR = 0.305 + bloom * 0.075, orgG = 0.192 + bloom * 0.040, orgB = 0.132 + bloom * 0.024;
    const ramp = sat(lifted * 0.8 + flakeEdge * 0.5 + grain * 0.3 + 0.12);
    let rr = mix(darkR, orgR, ramp);
    let rg = mix(darkG, orgG, ramp);
    let rb = mix(darkB, orgB, ramp);
    rr = mix(rr, darkR * 0.7, pit); rg = mix(rg, darkG * 0.7, pit); rb = mix(rb, darkB * 0.7, pit);
    r = mix(r, rr, t); g = mix(g, rg, t); b = mix(b, rb, t);
    // Rust dust washed down the face.
    r = mix(r, orgR * 0.82, st * 0.45 * amount);
    g = mix(g, orgG * 0.82, st * 0.45 * amount);
    b = mix(b, orgB * 0.86, st * 0.45 * amount);
    r *= 1 - perf * 0.85; g *= 1 - perf * 0.85; b *= 1 - perf * 0.85;

    const rough = clamp(mix(0.46 + Math.abs(grain) * 0.2, 0.95 + pit * 0.04, t), 0.20, 1);
    const metal = mix(0.95, 0.03, sat(t * 1.05));
    return { h, r, g, b, rough, metal };
  };
}

/**
 * Painted structural steel — a real three-coat system, which is what sells it:
 * topcoat, red-oxide primer showing in a ring wherever the topcoat has let go,
 * and bare/rusting steel in the middle of the failures. Rust then bleeds down
 * out of every breach.
 */
function surfacePaintedSteel(seed, opts = {}) {
  const {
    color = [0.145, 0.225, 0.335],
    primer = [0.375, 0.185, 0.135],
    wearAmt = 1.0, rust = 0.55, sheets = 15, chips = 42,
  } = opts;
  // Failure scale, not failure amount, is what decides whether this reads as
  // wear or as livery. At `sheets: 7` a lost patch is 230 mm across on a 1.6 m
  // tile — wider than the gap between a drum's rolling hoops — so a single
  // sheet of rust becomes a full horizontal stripe wrapped round the barrel.
  // At 15 it is 105 mm: still an obvious patch on a container door, but small
  // enough that several of them land inside every band of a drum instead of
  // one of them covering a whole band.
  const loss = makePaintLoss(seed, { sheets, chips, amount: wearAmt });
  const orangeN = makeTileablePerlin2(seed + 90, 8);
  const scratchN = makeTileablePerlin2(seed + 8, 16);
  const dirtN = makeTileablePerlin2(seed + 210, 12);
  const dentN = makeTileablePerlin2(seed + 311, 5);
  const streaks = makeStreaks(seed + 45, { columns: 48, length: 0.5, density: 0.3, width: 0.3 });
  return (u, v) => {
    const L = loss(u, v);
    const scr = fbm((x, y) => scratchN(x, y), u * 192, v * 16, { octaves: 3 });
    const chalk = fbm((x, y) => dirtN(x, y), u * 12, v * 12, { octaves: 4 });
    const bloom = billow((x, y) => orangeN(x, y), u * 8, v * 8, { octaves: 4 });
    // Panel dents: relief only, never colour. Drums and plant get knocked about
    // constantly, and a dent is a shading event, not a paint event.
    const dent = fbm((x, y) => dentN(x, y), u * 5, v * 5, { octaves: 4 });

    // Topcoat, chalked by UV and thinned on the high spots.
    //
    // This fade is deliberately tiny, and the field it rides on is deliberately
    // *high* frequency. Painted steel is applied to things far smaller than a
    // texture tile — a 200 L drum is 0.59 m across a 1.6 m tile, its rolling
    // hoops are 35 mm bands — and every one of those parts is a separate
    // cylinder that samples its own narrow strip of V. A low-frequency albedo
    // swing therefore does not read as weathering at all: each strip lands on a
    // different patch and the drum comes out banded in four colours like a
    // novelty barrel. One drum is one colour. The interest has to come from
    // chipping, dents and rust, all of which are small enough to appear *within*
    // every strip rather than to differ between them.
    const fade = 0.955 + chalk * 0.055;
    let r = color[0] * fade, g = color[1] * fade, b = color[2] * fade;
    // Brush/roller drag marks.
    r += scr * 0.012; g += scr * 0.012; b += scr * 0.014;

    // Primer ring: topcoat gone, primer intact.
    const ring = sat(L.halo * 0.9 - L.sheet * 0.6);
    r = mix(r, primer[0], ring); g = mix(g, primer[1], ring); b = mix(b, primer[2], ring);

    // Bare steel / rust in the middle of a failure.
    const bare = sat(L.loss);
    const rusty = sat(bare * smoothstep(0.30, 0.75, bloom * 1.2 + chalk * 0.3) * rust * 1.6);
    const steel = 0.335 + scr * 0.07;
    r = mix(r, steel, bare); g = mix(g, steel, bare); b = mix(b, steel * 1.05, bare);
    r = mix(r, 0.325 + bloom * 0.085, rusty);
    g = mix(g, 0.180 + bloom * 0.045, rusty);
    b = mix(b, 0.110 + bloom * 0.024, rusty);

    // Runoff below the breaches, plus general grime.
    const run = sat(streaks(u, v) * rust);
    r = mix(r, 0.295, run * 0.26); g = mix(g, 0.172, run * 0.26); b = mix(b, 0.118, run * 0.26);
    const dirt = sat(chalk * 0.40 + 0.15);
    r *= 1 - dirt * 0.10; g *= 1 - dirt * 0.105; b *= 1 - dirt * 0.095;

    // The paint film has real thickness — the loss edge is a visible step, but
    // a 120 µm step, so it belongs in the roughness far more than the normal.
    // The dent, by contrast, is millimetres and belongs entirely here.
    const h = 0.5 + (1 - bare) * 0.018 + dent * 0.030 + chalk * 0.008
            - L.sheet * 0.010 + scr * 0.006;
    const rough = clamp(mix(0.42 + chalk * 0.12 + Math.abs(dent) * 0.08,
                            mix(0.5, 0.93, rusty), bare), 0.18, 1);
    return { h, r, g, b, rough, metal: sat(bare * (1 - rusty * 0.92) * 0.9) };
  };
}

/**
 * Backdrop facade — the 180–350 m skyline ring.
 *
 * The ring buildings used `concrete_wall`, whose 3 m tile is far below a pixel
 * at that range. Every detail averaged out and they resolved as flat pale
 * slabs — the "untextured greybox skyline" a review kept flagging. The problem
 * was never that they lacked a texture; it was that they lacked one at a scale
 * the distance preserves.
 *
 * So author for the range instead. A building reads as a building because of
 * its fenestration, and nothing else survives 250 m of aerial perspective. At
 * that distance ~6.6 px covers a metre, so a 2.4 m window is ~16 px — a strong,
 * countable rhythm. Everything here is therefore built at window scale and up:
 * bay grid, spandrels, per-window value scatter, a few voids where the glass is
 * gone. No fine grain at all; it would only alias.
 *
 * Tile is 12 m, giving a 4 x 3 bay grid of ~3 m floors — a plain commercial
 * block, which is what the silhouette wants to be.
 */
function surfaceDistantFacade(seed, o = {}) {
  const rnd = makeRNG(seed);
  const BAYS = o.bays ?? 4;             // windows across one 12 m tile
  const FLOORS = o.floors ?? 3;         // floors per tile -> 4 m floor-to-floor
  const lit = o.lit ?? 0.0;             // fraction of windows showing interior

  // Per-window constants, drawn once. A window's identity has to be stable
  // across the whole texture, so this cannot be noise sampled per texel.
  const N = BAYS * FLOORS;
  const wDark = new Float32Array(N);    // how black the opening reads
  const wSky = new Float32Array(N);     // how much sky it bounces back
  const wGone = new Uint8Array(N);      // glass blown out entirely
  const wBoard = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    wDark[i] = 0.10 + rnd() * 0.16;
    wSky[i] = rnd() * rnd();            // squared: mostly dull, a few bright
    wGone[i] = rnd() < 0.14 ? 1 : 0;
    wBoard[i] = rnd() < 0.08 ? 1 : 0;
  }

  // One large-scale field for blotchy weathering across the whole elevation.
  const grime = makeTileablePerlin2(seed ^ 0x51ab, 2);
  const bayTint = makeTileablePerlin2(seed ^ 0x2f70, BAYS);

  // Window opening as a fraction of its bay. Piers are wider than spandrels on
  // a real frame, so the horizontal margin is the larger of the two.
  const WX = 0.30, WY = 0.22;

  return (u, v) => {
    const bu = u * BAYS, bv = v * FLOORS;
    const bi = Math.floor(bu), bj = Math.floor(bv);
    const fu = bu - bi, fv = bv - bj;
    const idx = (bj * BAYS + bi) % N;

    // Distance inside the bay, 0 at the window edge, 1 at its centre.
    const inX = (Math.min(fu, 1 - fu) - WX * 0.5) / (0.5 - WX * 0.5);
    const inY = (Math.min(fv, 1 - fv) - WY * 0.5) / (0.5 - WY * 0.5);
    const win = Math.min(inX, inY);                     // >0 inside the opening
    const open = smoothstep(0.0, 0.10, win);            // soft reveal edge

    const g = fbm(grime, u * 2, v * 2, 3, 0.5);
    const tint = bayTint(bu, 0.5) * 0.5 + 0.5;

    // --- concrete frame ---------------------------------------------------
    // Slightly warmer and lighter than the near-field concrete: 250 m of air
    // does that, and matching the near value makes the ring read as a cutout
    // pasted at the horizon rather than as distance.
    let base = 0.50 + tint * 0.06 + g * 0.05;
    // Spandrel panels sit marginally proud and catch more sky.
    const spandrel = 1 - smoothstep(0.0, 0.18, Math.abs(inY));
    base += spandrel * 0.025;
    let r = base * 1.02, gg = base * 1.00, b = base * 0.95;

    // Grime bleeding down from each sill — the strongest large-scale cue that
    // a facade has been standing outdoors, and it survives any distance.
    const belowSill = fv < 0.5 ? smoothstep(0.5, 0.14, fv) : 0;
    const streak = belowSill * (0.35 + 0.65 * fbm(grime, u * 26, v * 6, 2, 0.5));
    r -= streak * 0.10; gg -= streak * 0.10; b -= streak * 0.085;

    let h = 0.62 + spandrel * 0.05 + g * 0.03;
    let rough = 0.86 + g * 0.06;

    // --- the opening ------------------------------------------------------
    if (open > 0) {
      const dark = wDark[idx];
      // Sky bounce is strongest at the top of the pane, where the glass sees
      // more of the dome. That vertical gradient is what stops a window grid
      // from reading as a row of identical black stamps.
      const skyGrad = wSky[idx] * (0.35 + 0.65 * sat(fv * 2 - 0.2));
      let wr, wg, wb;
      if (wBoard[idx]) {
        wr = 0.30; wg = 0.27; wb = 0.23;                // ply over the opening
        h = mix(h, 0.60, open); rough = mix(rough, 0.92, open);
      } else if (wGone[idx]) {
        // No glass: a true void, only the soffit of the reveal catching light.
        wr = wg = wb = dark * 0.45;
        h = mix(h, 0.30, open); rough = mix(rough, 0.95, open);
      } else {
        wr = dark * 0.9 + skyGrad * 0.42;
        wg = dark * 0.95 + skyGrad * 0.48;
        wb = dark * 1.15 + skyGrad * 0.60;              // glass skews blue
        if (lit > 0 && wSky[idx] > 1 - lit) {
          wr += 0.30; wg += 0.24; wb += 0.12;
        }
        h = mix(h, 0.44, open); rough = mix(rough, 0.22, open);
      }
      r = mix(r, wr, open); gg = mix(gg, wg, open); b = mix(b, wb, open);
    }

    return { h, r: sat(r), g: sat(gg), b: sat(b), rough: clamp(rough, 0.1, 1), metal: 0 };
  };
}

// ------------------------------------------------------------ registration --

// Recalibrated replacements for the built-in kinds. Registered under their own
// names rather than shadowing `concrete` / `asphalt` / … so that anything still
// asking textures.js for the originals keeps getting them.
registerSurface('concreteFine', surfaceConcreteFine);
registerSurface('asphaltFine', surfaceAsphaltFine);
registerSurface('gravelFine', surfaceGravelFine);
registerSurface('brickFine', surfaceBrickFine);
registerSurface('woodWeathered', surfaceWoodWeathered);
registerSurface('plasterFine', surfacePlasterFine);
registerSurface('sandbagFine', surfaceSandbagFine);

registerSurface('corrugated', surfaceCorrugated);
registerSurface('grate', surfaceGrate);
registerSurface('chainlink', surfaceChainlink);
registerSurface('warningStripe', surfaceWarningStripe);
registerSurface('roadMarking', surfaceRoadMarking);
registerSurface('rubber', surfaceRubber);
registerSurface('tarp', surfaceTarp);
registerSurface('rebar', surfaceRebar);
registerSurface('glass', surfaceGlass);
registerSurface('concreteStained', surfaceConcreteStained);
registerSurface('brickPainted', surfaceBrickPainted);
registerSurface('plasterDamaged', surfacePlasterDamaged);
registerSurface('rustedMetal', surfaceRustedMetal);
registerSurface('paintedSteel', surfacePaintedSteel);
registerSurface('distantFacade', surfaceDistantFacade);

export const EXTRA_SURFACES = [
  'concreteFine', 'asphaltFine', 'gravelFine', 'brickFine', 'woodWeathered',
  'plasterFine', 'sandbagFine',
  'corrugated', 'grate', 'chainlink', 'warningStripe', 'roadMarking', 'rubber',
  'tarp', 'rebar', 'glass', 'concreteStained', 'brickPainted', 'plasterDamaged',
  'distantFacade',
  'rustedMetal', 'paintedSteel',
];

// -------------------------------------------------------------- alpha maps --

/*
 * Cut-out fields for the surfaces that are not solid. Each is
 * `(seed, opts) => (u,v) => alpha` and is built from *the same* pattern
 * generator as the matching surface above, so the opacity always lines up with
 * the shading — pass the identical `surfaceOpts` to both.
 *
 * materials.js turns these into DataTextures and wires them to `alphaMap` with
 * `alphaTest`, which is cheaper than blending and casts correct shadows.
 */
export const ALPHA_FIELDS = {
  /** Solid where an expanded-metal strand is, open in the diamonds. */
  grate(seed, opts = {}) {
    const { cells = 6, barW = 0.22 } = opts;
    const dia = makeDiamond({ cells, barW });
    const nick = makeWorley2(seed + 91, 14);
    return (u, v) => {
      const m = dia(u, v).mask;
      // A few strands are bent or missing entirely.
      const n = nick(u, v);
      const gone = smoothstep(0.30, 0.12, n.f1) * (n.id > 0.93 ? 1 : 0);
      return sat(m - gone);
    };
  },

  /** Thin woven wire — almost all open. */
  chainlink(seed, opts = {}) {
    const { cells = 7, barW = 0.075 } = opts;
    const dia = makeDiamond({ cells, barW });
    const cut = makeWorley2(seed + 44, 10);
    return (u, v) => {
      const m = dia(u, v).mask;
      // Someone has been through this fence with cutters.
      const c = cut(u, v);
      const gone = smoothstep(0.42, 0.18, c.f1) * (c.id > 0.88 ? 1 : 0);
      return sat(m - gone);
    };
  },

  /** Panes knocked out around the impact points; the cracks stay solid. */
  glass(seed, opts = {}) {
    const shatter = makeShatter(seed, opts.shatter || {});
    return (u, v) => {
      const s = shatter(u, v);
      return sat(1 - s.hole + s.crack * 0.25);
    };
  },
};

/** Build the alpha field that matches a registered surface, if it has one. */
export function getAlphaField(name, seed, surfaceOpts = {}) {
  const f = ALPHA_FIELDS[name];
  return f ? f(seed, surfaceOpts) : null;
}
