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
function makeConcreteBase(seed) {
  const macroN = makeTileablePerlin2(seed, 4);         // *4  — pour / patch blotching
  const mesoN = makeTileablePerlin2(seed + 41, 16);    // *16 — float and screed marks
  const fineN = makeTileablePerlin2(seed + 91, 96);    // *96 — cement paste grain
  const pores = makeWorley2(seed + 3, 88);             // ~34 mm cells at a 3 m tile
  return (u, v) => {
    const macro = warpedFbm((x, y) => macroN(x, y), u * 4, v * 4, { warp: 1.15, octaves: 5 });
    const meso = fbm((x, y) => mesoN(x, y), u * 16, v * 16, { octaves: 4 });
    const grain = fbm((x, y) => fineN(x, y), u * 96, v * 96, { octaves: 3 });
    const w = pores(u, v);
    // Blowholes: only some cells have one, and they are millimetres deep.
    const pit = smoothstep(0.24, 0.02, w.f1) * (w.id > 0.58 ? 1 : 0.30);
    // Aggregate ghosting just under the skin — tonal only, no relief at all.
    const agg = smoothstep(0.58, 0.92, w.f2 - w.f1);

    const h = 0.5 + macro * 0.026 + meso * 0.013 + grain * 0.010 - pit * 0.042;
    // Spread matters as much as the mean. Flattening the old ±0.2 blotching all
    // the way down left concrete reading as emulsion paint; measured samples
    // sit around σ≈0.03 of value, which is what these coefficients target.
    const tone = 0.515 + macro * 0.095 + meso * 0.078 + grain * 0.034
               - pit * 0.070 + agg * 0.022;
    // Power-floated slab polishes where it is walked and chalks where it is not.
    const polish = smoothstep(0.04, 0.26, macro);
    const rough = clamp(0.86 - polish * 0.22 + Math.abs(grain) * 0.05 - agg * 0.05, 0.42, 1);
    return { h, tone, base: macro, macro, grain, pit, rough };
  };
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
  const base = makeConcreteBase(seed);
  const crackN = makeTileablePerlin2(seed + 55, 6);
  const stainN = makeTileablePerlin2(seed + 771, 3);
  return (u, v) => {
    const c = base(u, v);
    const cr = ridged((x, y) => crackN(x, y), u * 6, v * 6, { octaves: 4 });
    const crack = smoothstep(0.90, 0.99, cr);
    const stain = warpedFbm((x, y) => stainN(x, y), u * 3, v * 3, { warp: 1.3, octaves: 5 });
    const soot = sat(Math.max(0, stain) * 1.6);

    const h = c.h - crack * 0.045;
    let tone = c.tone - crack * 0.040;
    tone *= 1 - soot * 0.09;
    // Cement is faintly warm. One bias only — a surface that is warm in the
    // reds *and* cool in the blues just reads as chromatic noise.
    const r = tone * 1.012, g = tone * 1.0, b = tone * 0.980;
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
 * Red brickwork. Two things sell it and both were previously inverted: fired
 * clay is a *desaturated* red-brown, not a signal red, and the mortar is
 * LIGHTER and far less saturated than the brick. The joint is a 5 mm recess,
 * not a 25 mm trench — that alone was turning every joint black under AO.
 */
function surfaceBrickFine(seed, opts = {}) {
  const lattice = makeBrickLattice(seed, {});
  const grainN = makeTileablePerlin2(seed + 17, 128);
  const weatherN = makeTileablePerlin2(seed, 6);
  const sootN = makeTileablePerlin2(seed + 210, 3);
  const streaks = makeStreaks(seed + 45, { columns: 26, length: 0.55, density: 0.22, width: 0.5 });
  return (u, v) => {
    const L = lattice(u, v);
    const gr = fbm((x, y) => grainN(x, y), u * 128, v * 128, { octaves: 3 });
    const weather = warpedFbm((x, y) => weatherN(x, y), u * 6, v * 6, { warp: 1.0, octaves: 5 });
    const soot = warpedFbm((x, y) => sootN(x, y), u * 3, v * 3, { warp: 1.2, octaves: 4 });

    // --- brick body.
    let br = 0.415 + L.j0 * 0.055, bg = 0.288 + L.j1 * 0.032, bb = 0.252 + L.j2 * 0.028;
    // A handful of over-fired headers — darker, but still brick, not charcoal.
    if (L.j2 > 0.90) { br *= 0.80; bg *= 0.83; bb *= 0.88; }
    br += gr * 0.022; bg += gr * 0.018; bb += gr * 0.016;

    // --- mortar: pale, near-neutral sand/cement. Lighter than the brick, but
    //     only by about 1.45:1 — push it further and the joints start to read
    //     as a printed stencil rather than as mortar.
    const m = 0.500 + gr * 0.030;
    const mr = m, mg = m * 0.992, mb = m * 0.968;

    let r = mix(mr, br, L.brick), g = mix(mg, bg, L.brick), b = mix(mb, bb, L.brick);
    const wash = clamp(0.94 + weather * 0.13, 0.80, 1.08);
    r *= wash; g *= wash; b *= wash;
    // Soot and rain-wash: one-sided, so it only ever darkens.
    const dirt = sat(Math.max(0, soot) * 0.55 + streaks(u, v) * 0.45);
    r *= 1 - dirt * 0.22; g *= 1 - dirt * 0.225; b *= 1 - dirt * 0.21;

    const h = 0.5 + L.brick * 0.036 + gr * 0.011;
    const rough = clamp(mix(0.93, 0.80 + L.j1 * 0.08, L.brick) + gr * 0.04 + dirt * 0.05, 0.45, 1);
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

/** Hessian sandbags: coarse weave, slumped fill, sun-bleached and dusty. */
function surfaceSandbagFine(seed, opts = {}) {
  const { tone: baseTone = 0.365 } = opts;
  const dirtN = makeTileablePerlin2(seed, 6);
  const weaveN = makeTileablePerlin2(seed + 4, 128);
  const slumpN = makeTileablePerlin2(seed + 9, 3);
  return (u, v) => {
    // 72 cycles on a 0.9 m tile ≈ 12 mm threads — coarse enough to survive
    // mipmapping, where the old 120-cycle weave was already aliasing.
    const wu = Math.sin(u * TAU * 72) * 0.5 + 0.5;
    const wv = Math.sin(v * TAU * 72) * 0.5 + 0.5;
    const wn = fbm((x, y) => weaveN(x, y), u * 128, v * 128, { octaves: 3 });
    const cloth = (wu * 0.5 + wv * 0.5) + wn * 0.18;
    const dirt = warpedFbm((x, y) => dirtN(x, y), u * 6, v * 6, { warp: 1.0, octaves: 5 });
    const slump = warpedFbm((x, y) => slumpN(x, y), u * 3, v * 3, { warp: 1.1, octaves: 4 });

    const h = 0.5 + cloth * 0.028 + dirt * 0.016 + slump * 0.022;
    let tone = baseTone + cloth * 0.038 + dirt * 0.085 + slump * 0.050;
    tone *= 1 - sat(Math.max(0, dirt) * 1.4) * 0.15;
    const r = tone * 1.075, g = tone * 1.005, b = tone * 0.820;
    const rough = clamp(0.93 + cloth * 0.04 - Math.max(0, slump) * 0.05, 0.6, 1);
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
  const conc = makeConcreteBase(seed);
  const crackN = makeTileablePerlin2(seed + 55, 8);
  const sootN = makeTileablePerlin2(seed + 220, 4);
  const effN = makeTileablePerlin2(seed + 331, 6);
  const dark = makeStreaks(seed + 12, { columns: 26, length: 0.8, density: 0.5, width: 0.9 });
  const rusty = makeStreaks(seed + 77, { columns: 60, length: 0.55, density: 0.18, width: 0.25 });
  return (u, v) => {
    const c = conc(u, v);
    const cr = ridged((x, y) => crackN(x, y), u * 8, v * 8, { octaves: 4 });
    const crack = smoothstep(0.87, 0.985, cr);
    const soot = warpedFbm((x, y) => sootN(x, y), u * 4, v * 4, { warp: 1.3, octaves: 5 }) * 0.5 + 0.5;
    const eff = warpedFbm((x, y) => effN(x, y), u * 6, v * 6, { warp: 0.9, octaves: 4 });

    const wet = sat(dark(u, v) * stain);
    const rustRun = sat(rusty(u, v) * stain);
    // General grime settling into the pores. Deliberately no height gradient:
    // a "dirtier near the ground" ramp cannot tile, and grounding belongs to
    // the level's vertex darkening / decals, not to a repeating material.
    const grime = sat((soot * 0.85 + wet * 0.8) * stain);
    const bloom = sat(smoothstep(0.10, 0.42, eff) * 0.7);   // efflorescence / lime

    const h = c.h - crack * 0.4 + bloom * 0.012;
    let tone = c.tone - crack * 0.16;
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
  const { color = [0.700, 0.680, 0.640], peel = 0.7 } = opts;
  const lattice = makeBrickLattice(seed, {});
  const grainN = makeTileablePerlin2(seed + 17, 128);
  const wearN = makeTileablePerlin2(seed, 6);
  const loss = makePaintLoss(seed + 300, { sheets: 6, chips: 22, amount: peel });
  const streaks = makeStreaks(seed + 45, { columns: 30, length: 0.7, density: 0.4, width: 0.8 });
  return (u, v) => {
    const L = lattice(u, v);
    const gr = fbm((x, y) => grainN(x, y), u * 128, v * 128, { octaves: 3 });
    const wear = warpedFbm((x, y) => wearN(x, y), u * 6, v * 6, { warp: 1.0, octaves: 5 });

    // --- paint film: comes off in sheets, and never bonded well to the arrises
    //     of the brick in the first place. No height ramp — see the note in
    //     surfaceConcreteStained.
    const P = loss(u, v);
    const arris = (1 - smoothstep(0.0, 0.07, Math.min(L.fu, 1 - L.fu))) * 0.22
                + (1 - smoothstep(0.0, 0.10, Math.min(L.fv, 1 - L.fv))) * 0.16;
    const peeled = sat(P.loss + arris * smoothstep(0.02, 0.40, wear) * peel);

    // --- what is underneath. Same calibration as the bare brick surface:
    //     desaturated fired clay, and mortar that is lighter, not darker.
    let br = 0.415 + L.j0 * 0.055, bg = 0.288 + L.j1 * 0.032, bb = 0.252 + L.j2 * 0.028;
    if (L.j2 > 0.90) { br *= 0.80; bg *= 0.83; bb *= 0.88; }
    const mr = 0.545 + gr * 0.030;
    const sr = mix(mr, br, L.brick), sg = mix(mr * 0.992, bg, L.brick), sb = mix(mr * 0.965, bb, L.brick);

    // --- paint on top; the film sits proud and bridges the mortar joints.
    const film = 1 - peeled;
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
    const darkR = 0.170, darkG = 0.098, darkB = 0.070;
    const orgR = 0.335 + bloom * 0.085, orgG = 0.185 + bloom * 0.042, orgB = 0.112 + bloom * 0.022;
    let rr = mix(darkR, orgR, sat(lifted * 0.8 + flakeEdge * 0.5 + grain * 0.3 + 0.25));
    let rg = mix(darkG, orgG, sat(lifted * 0.8 + flakeEdge * 0.5 + grain * 0.3 + 0.25));
    let rb = mix(darkB, orgB, sat(lifted * 0.8 + flakeEdge * 0.5 + grain * 0.3 + 0.25));
    rr = mix(rr, darkR * 0.7, pit); rg = mix(rg, darkG * 0.7, pit); rb = mix(rb, darkB * 0.7, pit);
    r = mix(r, rr, t); g = mix(g, rg, t); b = mix(b, rb, t);
    // Rust dust washed down the face.
    r = mix(r, orgR * 0.8, st * 0.45 * amount);
    g = mix(g, orgG * 0.8, st * 0.45 * amount);
    b = mix(b, orgB * 0.8, st * 0.45 * amount);
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
    wearAmt = 1.0, rust = 0.55,
  } = opts;
  const loss = makePaintLoss(seed, { sheets: 7, chips: 26, amount: wearAmt });
  const orangeN = makeTileablePerlin2(seed + 90, 8);
  const scratchN = makeTileablePerlin2(seed + 8, 16);
  const dirtN = makeTileablePerlin2(seed + 210, 6);
  const streaks = makeStreaks(seed + 45, { columns: 48, length: 0.5, density: 0.3, width: 0.3 });
  return (u, v) => {
    const L = loss(u, v);
    const scr = fbm((x, y) => scratchN(x, y), u * 192, v * 16, { octaves: 3 });
    const chalk = warpedFbm((x, y) => dirtN(x, y), u * 6, v * 6, { warp: 1.0, octaves: 5 });
    const bloom = billow((x, y) => orangeN(x, y), u * 8, v * 8, { octaves: 4 });

    // Topcoat, chalked by UV and thinned on the high spots. The paint has to
    // stay the dominant read, so this is a gentle fade — the old ±0.28 swing
    // pushed a mid-value topcoat to near-white at the top of its range.
    const fade = 0.90 + chalk * 0.13;
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
    r = mix(r, 0.295, run * 0.45); g = mix(g, 0.170, run * 0.45); b = mix(b, 0.110, run * 0.45);
    const dirt = sat(chalk * 0.45 + 0.15);
    r *= 1 - dirt * 0.18; g *= 1 - dirt * 0.19; b *= 1 - dirt * 0.17;

    // The paint film has real thickness — the loss edge is a visible step, but
    // a 120 µm step, so it belongs in the roughness far more than the normal.
    const h = 0.5 + (1 - bare) * 0.018 + chalk * 0.014 - L.sheet * 0.010 + scr * 0.006;
    const rough = clamp(mix(0.42 + chalk * 0.16, mix(0.5, 0.93, rusty), bare), 0.18, 1);
    return { h, r, g, b, rough, metal: sat(bare * (1 - rusty * 0.92) * 0.9) };
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

export const EXTRA_SURFACES = [
  'concreteFine', 'asphaltFine', 'gravelFine', 'brickFine', 'woodWeathered',
  'plasterFine', 'sandbagFine',
  'corrugated', 'grate', 'chainlink', 'warningStripe', 'roadMarking', 'rubber',
  'tarp', 'rebar', 'glass', 'concreteStained', 'brickPainted', 'plasterDamaged',
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
