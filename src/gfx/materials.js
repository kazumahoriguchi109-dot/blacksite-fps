import * as THREE from 'three';
import { generateTextureSet } from './textures.js';
import { ALPHA_FIELDS } from './surfaces_extra.js';   // side effect: registers the extra surface kinds

/*
 * Named material registry.
 *
 *     getMaterial('concrete_wall')            -> THREE.MeshStandardMaterial
 *     getMaterial('glass_dirty')              -> THREE.MeshPhysicalMaterial
 *     listMaterials()                         -> string[]
 *
 * Materials are cached on name + options, and the underlying PBR texture sets
 * are cached again inside textures.js on (kind, size, seed, surfaceOpts), so
 * two materials built from the same recipe share one GPU upload. Generation is
 * lazy — a level only pays for the materials it actually asks for.
 *
 * ------------------------------------------------------------------ tiling --
 *
 * There are two ways to get the texture scale right, and you should pick one
 * per mesh and stick to it:
 *
 *  1. WORLD-SPACE UVs (what world/Builder.js does). The geometry's UVs are
 *     already in units of "texture repeats", e.g. `chamferedBox(w,h,d,c,tile)`
 *     divides world metres by `tile`. Leave `repeat` at its default [1,1] and
 *     pass `materialTile(name)` as that `tile`. This is the preferred path: it
 *     keeps density identical across a 0.4 m crate and a 40 m wall, and lets
 *     the builder merge everything into one draw call.
 *
 *  2. UNIT UVs (PlaneGeometry, imported quads, anything mapped 0..1). Pass
 *     `worldSize: [widthM, heightM]` and the repeat is computed for you from
 *     the material's own tile density, or pass `repeat: [u, v]` directly.
 *
 * Texel density target is TARGET_TEXELS_PER_METRE (256 px/m): at the default
 * 512 px map that is a 2 m tile, which is exactly Builder's default. Materials
 * with real-world feature sizes (brick courses, corrugation pitch, chain-link
 * mesh) override that with the tile their pattern actually implies — see the
 * `tile` field of each catalogue entry.
 *
 * --------------------------------------------------------------------- AO ---
 *
 * `aoMap` is sampled through UV channel `AO_UV_CHANNEL` (1 = the `uv1`
 * attribute). Level and prop geometry MUST provide `uv1`; call
 * `ensureAOUVs(geometry)` (or `ensureAOUVsDeep(object3D)`) once after building
 * a geometry and before it is rendered. Builder.finish() already does this for
 * merged level geometry. If you have geometry that genuinely cannot carry a
 * second UV set, call `setMaterialDefaults({ aoChannel: 0 })` at boot and AO
 * will be read from `uv` instead.
 */

// ------------------------------------------------------------------ config --

/** Authoring target: texels of albedo per world metre. */
export const TARGET_TEXELS_PER_METRE = 256;
/** Default map resolution. 512 / 256 px·m⁻¹ = a 2 m tile. */
export const DEFAULT_SIZE = 512;
/** Metres per texture repeat when nothing more specific is known. */
export const DEFAULT_METRES_PER_TILE = DEFAULT_SIZE / TARGET_TEXELS_PER_METRE;   // 2.0
/** UV set the ambient occlusion map is sampled through. */
export const AO_UV_CHANNEL = 1;

const DEFAULTS = {
  size: DEFAULT_SIZE,
  aoChannel: AO_UV_CHANNEL,
  envMapIntensity: 1.0,
  /** Multiplies every material's normalScale — a global "detail" dial. */
  normalScale: 1.0,
};

/** Override the module-wide defaults. Call before any getMaterial(). */
export function setMaterialDefaults(o = {}) {
  Object.assign(DEFAULTS, o);
  if (MATERIAL_CACHE.size) {
    console.warn('[materials] defaults changed after materials were built — ' +
                 'existing cached materials keep the old settings.');
  }
}

// --------------------------------------------------------------- catalogue --

/*
 * Every entry:
 *   kind          surface kind registered in textures.js
 *   seed          texture seed — also the texture cache key, so two entries
 *                 sharing a seed + kind + surfaceOpts share one texture set
 *   surfaceOpts   passed through to the surface function
 *   gen           normal/AO derivation for this recipe (see the note below)
 *   tile          metres per texture repeat; number, or [u, v] when the
 *                 pattern is anisotropic (brick courses, plank widths, ribs)
 *   roughness     multiplier over roughnessMap (1 = use the map as authored)
 *   metalness     multiplier over metalnessMap
 *   normalScale   tangent-space normal strength
 *   ao            aoMapIntensity
 *   env           envMapIntensity
 *   color         albedo tint (multiplies the map; 0xffffff = untinted)
 *   surface       physical surface tag for footsteps / impact FX
 *   alpha         cut-out spec: { field, alphaTest }
 *   props         extra raw material properties
 *
 * NOTE on `gen`: textures.js keys its cache on (kind, size, seed, surfaceOpts)
 * but *not* on normalStrength/aoRadius/aoStrength. Two entries that share a
 * texture recipe must therefore also share `gen`, or the second one silently
 * gets the first one's normals. `guardRecipe()` below asserts that at runtime.
 */

/*
 * `normalStrength` multiplies a Sobel gradient of the height field, so it is a
 * *relief* dial, not a detail dial: the two together decide how many degrees a
 * texel's normal is allowed to tilt. The surfaces in surfaces_extra.js are now
 * authored to a total height budget of ~0.10 per tile (millimetres to a couple
 * of centimetres of real relief), which means 1.6 here lands a one-texel step
 * at roughly 10° instead of the ~50° the old 2.2-on-0.3-amplitude produced.
 *
 * `aoStrength` reads the same height field, so shrinking the relief also shrank
 * the cavity term — it is raised here to keep the same amount of contact
 * darkening out of a much smaller signal.
 */
const GEN_DEFAULT = { normalStrength: 1.6, aoRadius: 4, aoStrength: 5.0 };

/** @type {Record<string, object>} */
const CATALOGUE = {

  // ---------------------------------------------------------------- concrete
  concrete_wall: {
    kind: 'concreteFine', seed: 1101, tile: 3.0,
    roughness: 1.0, metalness: 0.0, normalScale: 0.70, ao: 0.90, env: 1.0,
    surface: 'concrete',
    note: 'Cast in-situ shuttered concrete. The bread-and-butter wall material. ' +
          'sRGB albedo sits in 0.41–0.60; the relief is form texture and 3 mm ' +
          'blowholes, which is why normalScale is well under 1.',
  },
  concrete_floor: {
    kind: 'concreteFine', seed: 1107, tile: 2.5,
    roughness: 1.02, metalness: 0.0, normalScale: 0.50, ao: 0.80, env: 0.9,
    surface: 'concrete',
    note: 'Power-floated slab — flatter than the wall, so a softer normal.',
  },
  concrete_stained: {
    kind: 'concreteStained', seed: 1123, tile: 3.0,
    surfaceOpts: { stain: 1.0 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.70, ao: 0.95, env: 0.9,
    surface: 'concrete',
    note: 'Soot, efflorescence, rust runoff and splash-back off the ground.',
  },
  rebar_concrete: {
    kind: 'rebar', seed: 12101, tile: 1.6,
    surfaceOpts: { bars: 5, barR: 0.013, spall: 0.55 },
    gen: { normalStrength: 1.8, aoRadius: 5, aoStrength: 4.5 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.85, ao: 1.0, env: 0.95,
    surface: 'concrete',
    note: 'Shell damage: spalled patches with the rusting cage exposed.',
  },

  // ------------------------------------------------------------------ ground
  asphalt_road: {
    kind: 'asphaltFine', seed: 2201, tile: 5.0,
    gen: { normalStrength: 1.5, aoRadius: 4, aoStrength: 4.5 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.55, ao: 0.85, env: 0.85,
    surface: 'asphalt',
    note: 'Wide tile — road surfaces are the easiest place to spot repetition, ' +
          'and a calm surface shows its repeat far more readily than a busy ' +
          'one, so the 5 m tile went up with the contrast coming down. At 2 m ' +
          'this should read as uniform dark grey with fine aggregate; all the ' +
          'large-scale variation is patching, staining and tyre polish.',
  },
  gravel: {
    kind: 'gravelFine', seed: 9901, tile: 2.0,
    roughness: 1.0, metalness: 0.0, normalScale: 0.65, ao: 0.95, env: 0.8,
    surface: 'gravel',
    note: '~50 mm ballast bedded in fines. Per-stone albedo spread is ±0.03, ' +
          'not ±0.17 — that spread was the whole reason it read as popcorn.',
  },
  road_marking: {
    kind: 'roadMarking', seed: 15101, tile: [1.6, 0.5],
    surfaceOpts: { color: [0.700, 0.700, 0.675], coverage: 0.62, beads: 0.5 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.50, ao: 0.9, env: 0.85,
    surface: 'asphalt',
    props: { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 },
    note: 'For a thin strip laid over the road: the paint feathers out at v=0 ' +
          'and v=1, so keep repeat V at 1 and only tile along the line.',
  },

  // ------------------------------------------------------------------- brick
  brick_red: {
    kind: 'brickFine', seed: 3301, tile: [1.72, 1.04],   // 8 × 215 mm, 16 × 65 mm
    roughness: 1.0, metalness: 0.0, normalScale: 0.75, ao: 0.85, env: 0.9,
    surface: 'brick',
    note: 'Tile is set from real brick dimensions so courses read at true scale. ' +
          'Brick body ~0.33 sRGB, mortar ~0.54 — the mortar is LIGHTER and much ' +
          'less saturated than the brick, and the joint is a 5 mm recess.',
  },
  brick_painted: {
    kind: 'brickPainted', seed: 3317, tile: [1.72, 1.04],
    surfaceOpts: { color: [0.640, 0.630, 0.605], peel: 0.45 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.65, ao: 0.85, env: 0.95,
    surface: 'brick',
    note: 'Whitewashed brick, peeling from the bottom up.',
  },

  // ----------------------------------------------------------------- plaster
  plaster_white: {
    kind: 'plasterFine', seed: 4401, tile: 2.5,
    roughness: 1.0, metalness: 0.0, normalScale: 0.55, ao: 0.80, env: 1.0,
    surface: 'plaster',
  },
  plaster_damaged: {
    kind: 'plasterDamaged', seed: 4417, tile: 2.4,   // 6 × 400 mm blocks behind
    surfaceOpts: { damage: 1.0 },
    gen: { normalStrength: 1.7, aoRadius: 5, aoStrength: 4.5 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.75, ao: 1.0, env: 0.9,
    surface: 'plaster',
    note: 'Render blown off in patches, blockwork showing through.',
  },

  // ------------------------------------------------------------------- metal
  metal_panel: {
    kind: 'metal', seed: 5501, tile: 2.0,
    surfaceOpts: { tint: [0.415, 0.435, 0.455], rust: 0.22, panels: 4 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.65, ao: 0.9, env: 1.0,
    surface: 'metal',
  },
  metal_rusted: {
    kind: 'rustedMetal', seed: 5517, tile: 2.2,
    surfaceOpts: { tint: [0.335, 0.348, 0.365], amount: 1.0, panels: 3, holes: 0.35 },
    gen: { normalStrength: 1.8, aoRadius: 5, aoStrength: 4.5 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.80, ao: 1.0, env: 0.9,
    surface: 'metal',
    note: 'Blooms + lifted scale plates + pitting, perforated where it is worst. ' +
          'The built-in `metal` kind cannot reach this look — its rust gate is ' +
          'above what its noise produces — so this is its own surface. Rust is ' +
          'authored dark red-brown (~0.18–0.33); bright orange is wet rust on ' +
          'clean steel and never covers a whole plate.',
  },
  sheet_metal_bare: {
    kind: 'metal', seed: 5531, tile: 1.6,
    surfaceOpts: { tint: [0.505, 0.525, 0.550], rust: 0.05, panels: 2 },
    roughness: 0.95, metalness: 1.0, normalScale: 0.55, ao: 0.85, env: 1.25,
    surface: 'metal',
    note: 'Clean rolled steel — for freshly cut plate, ducting, weapon furniture.',
  },
  corrugated_roof: {
    kind: 'corrugated', seed: 11101, tile: [1.2, 2.4],   // 200 mm pitch, 1.2 m purlins
    surfaceOpts: { period: 6, rust: 0.55 },
    gen: { normalStrength: 1.5, aoRadius: 6, aoStrength: 3.6 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.70, ao: 0.9, env: 1.0,
    surface: 'metal',
    note: 'Ribs run along V; rust streaks run down-V with gravity. The rainbow ' +
          'moiré at grazing angles was normalScale 1.6 × normalStrength 3.6 on ' +
          'a ±0.30 sine — steep enough that the three normal channels aliased ' +
          'independently under mip selection. The profile is now ±0.115 and the ' +
          'two multipliers are a third of what they were.',
  },
  metal_grate: {
    kind: 'grate', seed: 5602, tile: 1.2,               // 6 diamonds → 200 mm mesh
    surfaceOpts: { cells: 6, barW: 0.22, rust: 0.45 },
    gen: { normalStrength: 2.0, aoRadius: 3, aoStrength: 4.0 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.85, ao: 1.0, env: 1.15,
    surface: 'metal',
    alpha: { field: 'grate', alphaTest: 0.5 },
    props: { side: THREE.DoubleSide },
    note: 'Walkway / vent grating. Cut out by alphaTest so it shadows correctly. ' +
          'Keeps more relief than the flat surfaces — a 3 mm strand on a 200 mm ' +
          'mesh genuinely is a round bar, not a painted line.',
  },
  chainlink: {
    kind: 'chainlink', seed: 14101, tile: 0.4,          // 7 diamonds → 57 mm mesh
    surfaceOpts: { cells: 7, barW: 0.075, rust: 0.3 },
    gen: { normalStrength: 1.8, aoRadius: 2, aoStrength: 3.4 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.85, ao: 0.8, env: 1.2,
    surface: 'metal',
    alpha: { field: 'chainlink', alphaTest: 0.35 },
    props: { side: THREE.DoubleSide },
    note: 'Low alphaTest: the wire is thin, and mipmaps eat thin coverage first.',
  },

  // --------------------------------------------------------------- painted
  painted_steel_blue: {
    kind: 'paintedSteel', seed: 6601, tile: 1.6,
    surfaceOpts: { color: [0.145, 0.225, 0.335], wearAmt: 0.40, rust: 0.32 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.50, ao: 0.9, env: 1.05,
    surface: 'metal',
    note: 'Three-coat system — topcoat, red-oxide primer in the halo, steel/rust ' +
          'in the middle of each failure. That layering is what stops procedural ' +
          'chipping reading as white speckle. The paint has to stay the dominant ' +
          'read, so wearAmt is deliberately low: chipping should be sparse and ' +
          'small, not camouflage.',
  },
  painted_steel_yellow: {
    kind: 'paintedSteel', seed: 6613, tile: 1.6,
    surfaceOpts: { color: [0.530, 0.420, 0.155], wearAmt: 0.45, rust: 0.35 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.50, ao: 0.9, env: 1.05,
    surface: 'metal',
  },
  warning_stripe: {
    kind: 'warningStripe', seed: 16101, tile: 0.8,      // 4 stripes → 140 mm bands
    surfaceOpts: { stripes: 4, chipping: 0.5 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.45, ao: 0.95, env: 1.05,
    surface: 'metal',
    note: 'Hazard banding for kerbs, bollards, plant and door frames.',
  },

  // ------------------------------------------------------------------- wood
  wood_plank: {
    kind: 'woodWeathered', seed: 7701, tile: [2.4, 1.4],  // 7 planks → 200 mm boards
    roughness: 1.0, metalness: 0.0, normalScale: 0.60, ao: 0.85, env: 0.9,
    surface: 'wood',
    note: 'Exterior softwood after a season out: grey-brown at ~0.30–0.36 sRGB ' +
          'with an r/b ratio near 1.2. Anything near 2.0 reads as orange plastic.',
  },
  wood_crate: {
    // Deliberately the same texture recipe as wood_plank — a tighter tile alone
    // reads as a different, smaller-section timber. (Same kind + seed +
    // surfaceOpts means one shared texture upload, so `gen` must match too.)
    kind: 'woodWeathered', seed: 7701, tile: [1.0, 0.62],  // 7 slats → 90 mm
    roughness: 1.02, metalness: 0.0, normalScale: 0.55, ao: 0.85, env: 0.9,
    color: 0xf0ece5,
    surface: 'wood',
    note: 'The old 0xe8dcc6 tint plus the built-in wood surface is what made ' +
          'crates read as orange plastic waffle; the tint is now a 6 % lift, ' +
          'and the grain no longer crosses the slat gaps into a grid.',
  },

  // ------------------------------------------------------------------- misc
  tile_floor: {
    kind: 'tile', seed: 8801, tile: 2.4,                // 8 tiles → 300 mm
    gen: { normalStrength: 1.4, aoRadius: 4, aoStrength: 4.0 },
    roughness: 0.95, metalness: 0.0, normalScale: 0.30, ao: 0.85, env: 1.2,
    surface: 'tile',
    note: 'Polished ceramic: low normalScale, high env — it is a mirror at grazing angles.',
  },
  sandbag: {
    kind: 'sandbagFine', seed: 10101, tile: 0.9,
    roughness: 1.0, metalness: 0.0, normalScale: 0.60, ao: 0.90, env: 0.75,
    surface: 'sandbag',
  },
  rubber: {
    kind: 'rubber', seed: 17101, tile: 0.8,
    surfaceOpts: { tone: 0.072, tread: 0.35, dust: 0.5 },
    gen: { normalStrength: 1.5, aoRadius: 4, aoStrength: 4.0 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.60, ao: 0.95, env: 0.55,
    surface: 'rubber',
    note: 'Tyres, matting, hose. Very dark albedo — keep env low or it goes grey.',
  },
  tarp: {
    kind: 'tarp', seed: 18101, tile: 2.0,
    surfaceOpts: { color: [0.185, 0.235, 0.185], wearAmt: 0.6 },
    gen: { normalStrength: 1.7, aoRadius: 5, aoStrength: 4.0 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.75, ao: 1.0, env: 0.8,
    surface: 'rubber',
    props: { side: THREE.DoubleSide },
  },

  // ------------------------------------------------------------------ glass
  glass_dirty: {
    kind: 'glass', seed: 13101, tile: 1.5,
    surfaceOpts: { broken: false, grime: 0.6 },
    gen: { normalStrength: 1.2, aoRadius: 3, aoStrength: 1.6 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.30, ao: 0.6, env: 1.6,
    surface: 'glass',
    physical: true,
    props: {
      transparent: true, opacity: 0.34, depthWrite: false,
      side: THREE.DoubleSide, ior: 1.52, specularIntensity: 1.0,
    },
  },
  glass_broken: {
    kind: 'glass', seed: 13117, tile: 1.5,
    surfaceOpts: { broken: true, grime: 0.7 },
    gen: { normalStrength: 1.6, aoRadius: 3, aoStrength: 2.2 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.55, ao: 0.8, env: 1.4,
    surface: 'glass',
    physical: true,
    alpha: { field: 'glass', alphaTest: 0.5 },
    props: {
      transparent: true, opacity: 0.42, depthWrite: true,
      side: THREE.DoubleSide, ior: 1.52, specularIntensity: 1.0,
    },
    note: 'alphaTest punches the missing shards; opacity handles the rest.',
  },

  // ----------------------------------------------- weapons / kit (from base)
  gunmetal: {
    kind: 'gunmetal', seed: 19101, tile: 0.25,
    gen: { normalStrength: 1.6, aoRadius: 4, aoStrength: 4.0 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.50, ao: 0.9, env: 1.3,
    surface: 'metal',
  },
  polymer: {
    kind: 'polymer', seed: 19201, tile: 0.20,
    gen: { normalStrength: 1.6, aoRadius: 4, aoStrength: 3.0 },
    roughness: 1.0, metalness: 1.0, normalScale: 0.60, ao: 0.9, env: 0.9,
    surface: 'rubber',
  },
  camo: {
    kind: 'camo', seed: 19301, tile: 1.2,
    gen: { normalStrength: 1.6, aoRadius: 4, aoStrength: 3.5 },
    roughness: 1.0, metalness: 0.0, normalScale: 0.40, ao: 0.9, env: 0.8,
    surface: 'sandbag',
  },
};

const FALLBACK = 'concrete_wall';

// -------------------------------------------------------------- tiling API --

/**
 * Repeat vector for a surface of a given world size, at a chosen tile density.
 * Use for geometry with 0..1 UVs; geometry built with world-space UVs should
 * leave `repeat` alone and bake `materialTile(name)` into the UVs instead.
 *
 * @param {number} widthM        surface width in metres
 * @param {number} heightM       surface height in metres
 * @param {number|number[]} metresPerTile  metres per repeat (or [u, v])
 * @param {{snap?:boolean}} o    snap:true rounds to whole repeats so adjacent
 *                               faces of a box line up at the seam
 * @returns {[number, number]}
 */
export function worldRepeat(widthM, heightM, metresPerTile = DEFAULT_METRES_PER_TILE, o = {}) {
  const [tu, tv] = Array.isArray(metresPerTile)
    ? metresPerTile : [metresPerTile, metresPerTile];
  let ru = widthM / (tu || DEFAULT_METRES_PER_TILE);
  let rv = heightM / (tv || DEFAULT_METRES_PER_TILE);
  if (o.snap) { ru = Math.max(1, Math.round(ru)); rv = Math.max(1, Math.round(rv)); }
  return [ru, rv];
}

/** Metres per texture repeat for a material — feed this to Builder's `tile`. */
export function materialTile(name) {
  const e = CATALOGUE[name];
  return e ? e.tile : DEFAULT_METRES_PER_TILE;
}

/** Texels of albedo per world metre at the current settings — a sanity check. */
export function texelDensity(name, size = DEFAULTS.size) {
  const t = materialTile(name);
  const [tu, tv] = Array.isArray(t) ? t : [t, t];
  return [size / tu, size / tv];
}

// ------------------------------------------------------------------ AO UVs --

/**
 * `aoMap` is sampled through UV channel 1, which means the geometry needs a
 * `uv1` attribute. Copies `uv` into `uv1` when it is missing.
 *
 * Every piece of level and prop geometry must go through this (or be built by
 * world/Builder.js, which already does it) before it is rendered, otherwise the
 * AO term samples an attribute that is not there.
 *
 * @param {THREE.BufferGeometry} geometry  modified in place
 * @returns {THREE.BufferGeometry} the same geometry, for chaining
 */
export function ensureAOUVs(geometry) {
  if (!geometry || !geometry.attributes) return geometry;
  const uv = geometry.attributes.uv;
  if (uv && !geometry.attributes.uv1) {
    // Share the buffer: uv1 is identical to uv, there is no reason to duplicate it.
    geometry.setAttribute('uv1', uv);
  }
  return geometry;
}

/** ensureAOUVs over every mesh in a subtree. */
export function ensureAOUVsDeep(object3D) {
  object3D?.traverse?.((o) => { if (o.geometry) ensureAOUVs(o.geometry); });
  return object3D;
}

// ------------------------------------------------------------- alpha maps ---

const ALPHA_CACHE = new Map();

/**
 * Build (or fetch) the cut-out map that matches a surface pattern.
 *
 * Pass the *same* seed and surfaceOpts you gave `generateTextureSet`, otherwise
 * the holes will not line up with the shading. Returns a DataTexture suitable
 * for `material.alphaMap`; the value is written to every channel, so it works
 * whichever channel three samples.
 *
 * @param {'grate'|'chainlink'|'glass'} field
 * @returns {THREE.DataTexture}
 */
export function generateAlphaMap(field, opts = {}) {
  const { size = DEFAULTS.size, seed = 1337, repeat = [1, 1], surfaceOpts = {} } = opts;
  const key = `${field}|${size}|${seed}|${stableString(surfaceOpts)}`;
  if (ALPHA_CACHE.has(key)) return cloneAlpha(ALPHA_CACHE.get(key), repeat);

  const factory = ALPHA_FIELDS[field];
  if (!factory) throw new Error(`[materials] unknown alpha field: ${field}`);
  const fn = factory(seed, surfaceOpts);

  const data = new Uint8ClampedArray(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = fn(x * inv, y * inv);
      const v = (a < 0 ? 0 : a > 1 ? 1 : a) * 255;
      const i = (y * size + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = v;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  ALPHA_CACHE.set(key, tex);
  return cloneAlpha(tex, repeat);
}

/** Share the upload, vary only the repeat — same trick textures.js uses. */
function cloneAlpha(tex, repeat) {
  const t = tex.clone();
  t.needsUpdate = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  return t;
}

// ---------------------------------------------------------------- registry --

const MATERIAL_CACHE = new Map();
const RECIPE_GUARD = new Map();
let warnedAO = false;

/**
 * Fetch a named material. Cached on name + options, so calling it per-mesh is
 * free after the first time.
 *
 * @param {string} name  see listMaterials()
 * @param {object} [opts]
 *   size          map resolution (default 512)
 *   seed          override the catalogue seed (gives an independent variation)
 *   repeat        [u, v] texture repeat — for 0..1 UV geometry
 *   worldSize     [w, h] in metres; computes `repeat` at the material's density
 *   tile          override metres-per-repeat used by `worldSize`
 *   color         albedo tint
 *   roughness / metalness / normalScale / envMapIntensity / aoMapIntensity
 *   aoChannel     UV set for the aoMap (default 1)
 *   side, transparent, opacity, alphaTest, flatShading, vertexColors, ...
 *   props         any further raw THREE material properties
 * @returns {THREE.MeshStandardMaterial|THREE.MeshPhysicalMaterial}
 */
export function getMaterial(name, opts = {}) {
  let entry = CATALOGUE[name];
  if (!entry) {
    console.warn(`[materials] unknown material "${name}" — falling back to ${FALLBACK}.`);
    entry = CATALOGUE[FALLBACK];
    name = FALLBACK;
  }

  const key = `${name}|${stableString(opts)}`;
  const hit = MATERIAL_CACHE.get(key);
  if (hit) return hit;

  const size = opts.size ?? DEFAULTS.size;
  const seed = opts.seed ?? entry.seed;
  const surfaceOpts = { ...(entry.surfaceOpts || {}), ...(opts.surfaceOpts || {}) };
  const gen = { ...GEN_DEFAULT, ...(entry.gen || {}) };
  const repeat = resolveRepeat(entry, opts);

  guardRecipe(entry.kind, size, seed, surfaceOpts, gen, name);

  const set = generateTextureSet(entry.kind, {
    size, seed, repeat, surfaceOpts,
    normalStrength: gen.normalStrength,
    aoRadius: gen.aoRadius,
    aoStrength: gen.aoStrength,
  });

  const Ctor = entry.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const mat = new Ctor();
  mat.name = name;

  // ---- maps. All five share one repeat, so the transforms stay in lockstep.
  mat.map = set.map;
  mat.normalMap = set.normalMap;
  mat.roughnessMap = set.roughnessMap;
  mat.metalnessMap = set.metalnessMap;
  mat.aoMap = set.aoMap;

  const aoChannel = opts.aoChannel ?? DEFAULTS.aoChannel;
  mat.aoMap.channel = aoChannel;
  if (aoChannel === 1 && !warnedAO) {
    warnedAO = true;
    console.info('[materials] aoMap uses UV channel 1 — geometry needs `uv1`. ' +
                 'Call ensureAOUVs(geometry) if you are not using world/Builder.js.');
  }

  // ---- scalars. The maps carry the detail; these are the global multipliers.
  mat.roughness = clamp01(opts.roughness ?? entry.roughness ?? 1.0);
  mat.metalness = clamp01(opts.metalness ?? entry.metalness ?? 0.0);
  const ns = (opts.normalScale ?? entry.normalScale ?? 1.0) * DEFAULTS.normalScale;
  mat.normalScale = new THREE.Vector2(ns, ns);
  mat.normalMapType = THREE.TangentSpaceNormalMap;
  mat.aoMapIntensity = opts.aoMapIntensity ?? entry.ao ?? 1.0;
  mat.envMapIntensity = opts.envMapIntensity ?? entry.env ?? DEFAULTS.envMapIntensity;
  mat.color = new THREE.Color(opts.color ?? entry.color ?? 0xffffff);

  // ---- cut-outs. alphaTest, not blending: cheaper, sorts for free, and the
  //      shadow pass picks the alphaMap up automatically.
  const alphaSpec = entry.alpha;
  if (alphaSpec) {
    mat.alphaMap = generateAlphaMap(alphaSpec.field, { size, seed, repeat, surfaceOpts });
    mat.alphaTest = opts.alphaTest ?? alphaSpec.alphaTest ?? 0.5;
  }

  Object.assign(mat, entry.props || {});
  Object.assign(mat, opts.props || {});
  for (const k of PASSTHROUGH) if (opts[k] !== undefined) mat[k] = opts[k];

  mat.userData.materialName = name;
  mat.userData.surface = entry.surface || 'concrete';
  mat.userData.tile = entry.tile;
  mat.userData.repeat = repeat;

  MATERIAL_CACHE.set(key, mat);
  return mat;
}

const PASSTHROUGH = [
  'side', 'shadowSide', 'transparent', 'opacity', 'alphaTest', 'depthWrite',
  'flatShading', 'vertexColors', 'wireframe', 'dithering', 'premultipliedAlpha',
  'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'toneMapped',
];

/** Every material name in the catalogue. */
export function listMaterials() {
  return Object.keys(CATALOGUE).sort();
}

/** Read-only view of a catalogue entry — tile, surface tag, tuning, notes. */
export function getMaterialSpec(name) {
  const e = CATALOGUE[name];
  return e ? { name, ...e, gen: { ...GEN_DEFAULT, ...(e.gen || {}) } } : null;
}

/**
 * Build a set of materials up front — for a loading screen, so the first frame
 * of gameplay does not stall on texture generation.
 * @param {string[]} [names] defaults to the whole catalogue
 */
export function preloadMaterials(names = listMaterials(), opts = {}) {
  const out = [];
  for (const n of names) out.push(getMaterial(n, opts));
  return out;
}

/**
 * As preloadMaterials, but yields to the event loop between each one so a
 * loading screen can actually paint. Generation is ~0.2–1.8 s per material at
 * 512 px, so a synchronous preload of the whole catalogue locks the tab for
 * twenty seconds; this does not.
 *
 * @param {string[]} names
 * @param {(done:number, total:number, name:string)=>void} [onProgress]
 */
export async function preloadMaterialsAsync(names = listMaterials(), onProgress, opts = {}) {
  for (let i = 0; i < names.length; i++) {
    getMaterial(names[i], opts);
    onProgress?.(i + 1, names.length, names[i]);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Drop every cached material and its textures. */
export function disposeMaterials() {
  for (const mat of MATERIAL_CACHE.values()) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap']) {
      mat[k]?.dispose?.();
    }
    mat.dispose();
  }
  MATERIAL_CACHE.clear();
  for (const t of ALPHA_CACHE.values()) t.dispose();
  ALPHA_CACHE.clear();
  RECIPE_GUARD.clear();
}

// ----------------------------------------------------------------- helpers --

function resolveRepeat(entry, opts) {
  if (opts.repeat) return opts.repeat;
  if (opts.worldSize) {
    return worldRepeat(opts.worldSize[0], opts.worldSize[1],
                       opts.tile ?? entry.tile, { snap: opts.snapRepeat });
  }
  // Default: the geometry's UVs already carry the tiling (Builder's world-space
  // UVs), so one repeat per UV unit is correct.
  return [1, 1];
}

/**
 * textures.js does not include the normal/AO derivation in its cache key, so
 * two entries sharing (kind, size, seed, surfaceOpts) must share `gen` too.
 * Catch it here rather than wondering later why a material's relief is wrong.
 */
function guardRecipe(kind, size, seed, surfaceOpts, gen, name) {
  const k = `${kind}|${size}|${seed}|${stableString(surfaceOpts)}`;
  const sig = `${gen.normalStrength}|${gen.aoRadius}|${gen.aoStrength}`;
  const prev = RECIPE_GUARD.get(k);
  if (prev === undefined) { RECIPE_GUARD.set(k, `${sig}|${name}`); return; }
  if (prev.split('|').slice(0, 3).join('|') !== sig) {
    console.warn(`[materials] "${name}" shares texture recipe ${k} with ` +
                 `"${prev.split('|')[3]}" but wants different normal/AO settings ` +
                 `(${sig} vs ${prev}). The cached set wins — give it its own seed.`);
  }
}

/** Order-independent stringify so option objects hash consistently. */
function stableString(o) {
  if (o === null || typeof o !== 'object') return String(o);
  if (Array.isArray(o)) return `[${o.map(stableString).join(',')}]`;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${k}:${stableString(o[k])}`).join(',')}}`;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
