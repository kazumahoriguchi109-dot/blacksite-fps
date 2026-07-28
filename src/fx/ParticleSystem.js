import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { makeTileablePerlin2, fbm, clamp, smoothstep } from '../gfx/noise.js';

/*
 * GPU-fed, CPU-simulated particle pools.
 *
 * Two draw calls total: one instanced quad batch per blend mode (additive for
 * sparks / fire / tracers, premultiplied-normal for smoke / dust / debris /
 * blood). Every particle lives in flat typed arrays — there is not a single
 * per-particle object anywhere in this file, and the update loop allocates
 * nothing.
 *
 * Quads (not THREE.Points) because:
 *   - gl_PointSize is hardware-clamped (~64–1024px) so close smoke would pop,
 *   - point sprites are culled by their *centre*, so big puffs vanish at the
 *     screen edge,
 *   - velocity-aligned stretching (spark streaks, tracers) is impossible.
 *
 * Soft particles: PostFX owns the scene depth attachment, and sampling a depth
 * texture that is currently attached to the bound framebuffer is a feedback
 * loop. So once per frame — during update(), while nothing is bound — we blit
 * the depth buffer into our own half-res linear-Z target. Particles then read
 * *last* frame's depth, which is a frame stale and completely invisible.
 */

// ------------------------------------------------------------- constants ---

export const MODE_ADD = 0;
export const MODE_ALPHA = 1;

const ATLAS_COLS = 4;
const ATLAS_ROWS = 4;
const TILE = 256;

/** Sprite atlas slots. Index = row * 4 + col, rows counted from v = 0 upward. */
export const SPRITE = {
  SMOKE_A: 0,
  SMOKE_B: 1,
  SMOKE_C: 2,
  DUST: 3,

  SPARK: 4,
  STREAK: 5,
  EMBER: 6,
  GLOW: 7,

  FIRE: 8,
  FLASH: 9,
  BLOOD_MIST: 10,
  BLOOD_DROP: 11,

  CHIP_A: 12,
  CHIP_B: 13,
  STAR: 14,
  TRACER: 15,
};

// `RING` was the old name for slot 15 before it became the tracer body. Kept as
// an alias so nothing that still asks for it silently samples a blank tile.
SPRITE.RING = SPRITE.TRACER;

// size-over-life curve shapes
export const CURVE_LINEAR = 0;
export const CURVE_FAST = 1;   // sqrt(t)  — grows quickly then settles (smoke)
export const CURVE_SLOW = 2;   // t*t      — holds then accelerates

const GRAVITY = 9.81;

// -------------------------------------------------------- sprite atlas -----

/**
 * Builds the 4x4 sprite atlas as a raw RGBA byte buffer.
 * DataTexture rather than <canvas> so there is zero premultiply ambiguity in
 * the 2D backing store — what we write is exactly what the sampler reads.
 */
function buildSpriteAtlas() {
  const W = ATLAS_COLS * TILE;
  const H = ATLAS_ROWS * TILE;
  const data = new Uint8Array(W * H * 4);

  // Two shared noise fields, generated once and reused by every cloudy tile.
  // Generating FBM per-tile would be ~1M octave evaluations; this is 130k.
  const F = 256;
  const basisA = makeTileablePerlin2(0x5eed01, 8);
  const basisB = makeTileablePerlin2(0x5eed02, 16);
  const fieldA = new Float32Array(F * F);
  const fieldB = new Float32Array(F * F);
  for (let y = 0; y < F; y++) {
    for (let x = 0; x < F; x++) {
      const u = (x / F) * 8;
      const v = (y / F) * 8;
      fieldA[y * F + x] = fbm(basisA, u, v, { octaves: 5, gain: 0.55 }) * 0.5 + 0.5;
      fieldB[y * F + x] = fbm(basisB, u * 2, v * 2, { octaves: 4, gain: 0.5 }) * 0.5 + 0.5;
    }
  }

  const sampleField = (fld, fx, fy) => {
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const x0 = ((ix % F) + F) % F;
    const y0 = ((iy % F) + F) % F;
    const x1 = (x0 + 1) % F;
    const y1 = (y0 + 1) % F;
    const a = fld[y0 * F + x0];
    const b = fld[y0 * F + x1];
    const c = fld[y1 * F + x0];
    const d = fld[y1 * F + x1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };

  const out = new Float32Array(4);

  const writeTile = (index, fn) => {
    const col = index % ATLAS_COLS;
    const row = (index / ATLAS_COLS) | 0;
    const ox = col * TILE;
    const oy = row * TILE;
    for (let y = 0; y < TILE; y++) {
      const v = ((y + 0.5) / TILE) * 2 - 1;
      for (let x = 0; x < TILE; x++) {
        const u = ((x + 0.5) / TILE) * 2 - 1;
        out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 0;
        fn(u, v, out);
        // Hard-guarantee a transparent tile border: mip levels blend
        // neighbouring tiles together, and a sprite that reaches the edge
        // would bleed into the tile next door at distance.
        out[3] *= smoothstep(0.995, 0.90, Math.abs(u) > Math.abs(v) ? Math.abs(u) : Math.abs(v));
        const p = ((oy + y) * W + (ox + x)) * 4;
        data[p]     = clamp(out[0]) * 255;
        data[p + 1] = clamp(out[1]) * 255;
        data[p + 2] = clamp(out[2]) * 255;
        data[p + 3] = clamp(out[3]) * 255;
      }
    }
  };

  // ---- cloudy tiles (smoke / dust / blood mist) ----------------------------
  const cloud = (opts) => (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    const nA = sampleField(fieldA, (u * opts.sc + opts.ox) * F * 0.5, (v * opts.sc + opts.oy) * F * 0.5);
    const nB = sampleField(fieldB, (u * opts.sc2 + opts.ox2) * F * 0.5, (v * opts.sc2 + opts.oy2) * F * 0.5);

    const disc = smoothstep(1.0, 0.04, r);
    let d = disc * (opts.base + opts.noise * nA) - opts.cut;
    d = smoothstep(0.0, opts.soft, d);
    d *= smoothstep(1.02, 0.62, r);          // guarantee a clean tile border
    o[3] = clamp(d * opts.alpha);

    // Real internal structure: two noise octaves plus a soft top light so the
    // puff reads as volume instead of a gradient blob.
    let lum = opts.lumBase + opts.lumA * nA + opts.lumB * nB;
    lum *= 0.74 + 0.30 * (v * 0.5 + 0.5);
    lum = clamp(lum, 0.05, 1.0);
    o[0] = lum * opts.tintR;
    o[1] = lum * opts.tintG;
    o[2] = lum * opts.tintB;
  };

  writeTile(SPRITE.SMOKE_A, cloud({
    sc: 0.85, ox: 0.31, oy: 0.77, sc2: 1.9, ox2: 2.7, oy2: 0.4,
    base: 0.34, noise: 0.90, cut: 0.10, soft: 0.55, alpha: 0.95,
    lumBase: 0.30, lumA: 0.30, lumB: 0.42, tintR: 1, tintG: 1, tintB: 1,
  }));
  writeTile(SPRITE.SMOKE_B, cloud({
    sc: 1.15, ox: 3.11, oy: 1.63, sc2: 2.4, ox2: 0.9, oy2: 4.2,
    base: 0.30, noise: 1.00, cut: 0.12, soft: 0.50, alpha: 0.95,
    lumBase: 0.26, lumA: 0.34, lumB: 0.44, tintR: 1, tintG: 0.99, tintB: 0.97,
  }));
  writeTile(SPRITE.SMOKE_C, cloud({
    sc: 1.55, ox: 5.42, oy: 2.19, sc2: 3.3, ox2: 6.1, oy2: 1.1,
    base: 0.22, noise: 1.05, cut: 0.14, soft: 0.44, alpha: 0.80,
    lumBase: 0.32, lumA: 0.28, lumB: 0.44, tintR: 1, tintG: 1, tintB: 1,
  }));
  writeTile(SPRITE.DUST, cloud({
    sc: 2.35, ox: 1.77, oy: 4.05, sc2: 4.6, ox2: 3.3, oy2: 2.2,
    base: 0.40, noise: 0.78, cut: 0.09, soft: 0.62, alpha: 0.72,
    lumBase: 0.44, lumA: 0.26, lumB: 0.34, tintR: 1, tintG: 0.985, tintB: 0.95,
  }));
  writeTile(SPRITE.BLOOD_MIST, cloud({
    sc: 1.75, ox: 7.13, oy: 0.55, sc2: 3.9, ox2: 2.2, oy2: 5.5,
    base: 0.26, noise: 1.05, cut: 0.15, soft: 0.40, alpha: 0.92,
    lumBase: 0.42, lumA: 0.32, lumB: 0.30, tintR: 1, tintG: 0.86, tintB: 0.84,
  }));

  // ---- spark streak: fills the quad lengthwise so geometric stretch works --
  writeTile(SPRITE.SPARK, (u, v, o) => {
    const across = clamp(1 - Math.abs(u));
    const along = clamp(1 - Math.abs(v));
    const body = Math.pow(across, 3.2) * Math.pow(along, 0.85);
    const core = Math.pow(clamp(1 - Math.abs(u) * 3.4), 3.0) * Math.pow(along, 0.55);
    const a = clamp(body * 0.55 + core * 0.95);
    o[3] = a;
    const l = clamp(0.62 + core * 0.55);
    o[0] = l; o[1] = l; o[2] = l;
  });

  // Wider, dimmer halo streak — the tracer's outer glow. Weighted toward the
  // head (v = +1) to match the TRACER body it sits behind.
  writeTile(SPRITE.STREAK, (u, v, o) => {
    const t = clamp(v * 0.5 + 0.5);
    const across = clamp(1 - Math.abs(u));
    const along = Math.pow(t, 0.85) * (0.28 + 0.72 * Math.exp(-(1 - t) * 2.6));
    o[3] = Math.pow(across, 1.9) * along * 0.55;
    o[0] = 0.9; o[1] = 0.9; o[2] = 0.9;
  });

  writeTile(SPRITE.EMBER, (u, v, o) => {
    const r2 = u * u + v * v;
    o[3] = clamp(Math.exp(-r2 * 8.5) + 0.20 * Math.exp(-r2 * 1.7));
    o[0] = 1; o[1] = 1; o[2] = 1;
  });

  writeTile(SPRITE.GLOW, (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    o[3] = Math.pow(clamp(1 - r), 2.5);
    o[0] = 1; o[1] = 1; o[2] = 1;
  });

  // ---- fire blob: ragged silhouette, baked white-hot core -> orange rim ----
  writeTile(SPRITE.FIRE, (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    const nA = sampleField(fieldA, (u * 1.3 + 4.4) * F * 0.5, (v * 1.3 + 6.1) * F * 0.5);
    const nB = sampleField(fieldB, (u * 2.9 + 1.2) * F * 0.5, (v * 2.9 + 3.9) * F * 0.5);
    let d = smoothstep(1.0, 0.06, r) * (0.38 + 0.92 * nA);
    d = smoothstep(0.14, 0.72, d);
    d *= smoothstep(1.02, 0.68, r);
    o[3] = clamp(d);
    const hot = Math.pow(clamp(1 - smoothstep(0.0, 0.72, r * 1.15)), 1.4) * (0.72 + 0.5 * nB);
    o[0] = clamp(1.0);
    o[1] = clamp(0.40 + 0.58 * hot);
    o[2] = clamp(0.08 + 0.78 * hot * hot);
  });

  // ---- impact / muzzle flash: spiked star with a blown-out core -----------
  writeTile(SPRITE.FLASH, (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    const ang = Math.atan2(v, u);
    const spike = 0.52 + 0.30 * Math.cos(ang * 6.0 + 0.7) + 0.18 * Math.cos(ang * 11.0 - 2.1);
    const rr = r / Math.max(0.18, 0.34 + 0.66 * spike);
    let a = Math.pow(clamp(1 - rr), 2.3) * 0.85;
    a += 0.95 * Math.exp(-r * r * 26.0);
    o[3] = clamp(a);
    const hot = Math.exp(-r * r * 9.0);
    o[0] = 1;
    o[1] = clamp(0.66 + 0.34 * hot);
    o[2] = clamp(0.34 + 0.66 * hot);
  });

  // ---- blood droplet: wet ellipse with a specular glint -------------------
  writeTile(SPRITE.BLOOD_DROP, (u, v, o) => {
    const du = u / 0.56;
    const dv = (v - 0.08) / 0.86;
    const d = Math.sqrt(du * du + dv * dv);
    o[3] = smoothstep(1.0, 0.72, d);
    const gx = u + 0.22;
    const gy = v - 0.30;
    const glint = Math.exp(-(gx * gx + gy * gy) * 22.0);
    const l = clamp(0.52 + 0.55 * glint + 0.18 * (1 - d));
    o[0] = l; o[1] = l * 0.94; o[2] = l * 0.92;
  });

  // ---- debris chips: irregular convex silhouettes with facet shading ------
  const chip = (radii, lx, ly) => (u, v, o) => {
    const r = Math.sqrt(u * u + v * v);
    let ang = Math.atan2(v, u) / (Math.PI * 2);
    if (ang < 0) ang += 1;
    const n = radii.length;
    const f = ang * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    const R = radii[i0] + (radii[i1] - radii[i0]) * (t * t * (3 - 2 * t));
    o[3] = smoothstep(R, R - 0.055, r);
    // fake a lit facet so chips read as solid geometry, not soft blobs
    const nd = clamp(0.5 + 0.5 * (u * lx + v * ly) / Math.max(0.15, r), 0, 1);
    const l = clamp(0.30 + 0.70 * nd * nd);
    o[0] = l; o[1] = l * 0.99; o[2] = l * 0.97;
  };
  writeTile(SPRITE.CHIP_A, chip([0.86, 0.62, 0.78, 0.55, 0.83, 0.66, 0.74], -0.7, 0.71));
  writeTile(SPRITE.CHIP_B, chip([0.58, 0.84, 0.61, 0.88, 0.52, 0.79], 0.62, 0.78));

  // ---- 4-point star flare -------------------------------------------------
  writeTile(SPRITE.STAR, (u, v, o) => {
    const a = Math.exp(-Math.abs(u) * 20.0) * Math.exp(-v * v * 2.6)
            + Math.exp(-Math.abs(v) * 20.0) * Math.exp(-u * u * 2.6)
            + Math.exp(-(u * u + v * v) * 38.0);
    o[3] = clamp(a);
    o[0] = 1; o[1] = 1; o[2] = 1;
  });

  // ---- tracer body --------------------------------------------------------
  // The stretch path in the vertex shader lays the quad along the velocity with
  // corner.y = +0.5 leading, so texture v = +1 is the HEAD of the streak. The
  // tile is therefore deliberately asymmetric: a hot, slightly bulged head that
  // tapers to nothing at the tail, which is what stops a tracer reading as a
  // uniform hairline.
  writeTile(SPRITE.TRACER, (u, v, o) => {
    const t = clamp(v * 0.5 + 0.5);              // 0 = tail, 1 = head
    // The streak narrows toward the tail as well as fading.
    const w = 0.20 + 0.80 * Math.pow(t, 0.55);
    const across = clamp(1 - Math.abs(u) / w);
    const body = Math.pow(across, 2.2);
    const core = Math.pow(clamp(1 - Math.abs(u) / (w * 0.34)), 1.8);
    // Energy along the streak: most of it in the leading third.
    const along = Math.pow(t, 1.15) * (0.30 + 0.70 * Math.exp(-(1 - t) * 3.6));
    const du = u / 0.16;
    const dv = (v - 0.80) / 0.24;
    const head = Math.exp(-(du * du + dv * dv) * 1.8);
    const a = clamp((body * 0.42 + core * 0.92) * along + head * 0.85);
    o[3] = a;
    const l = clamp(0.50 + 0.55 * core * along + 0.75 * head);
    o[0] = l; o[1] = l; o[2] = l;
  });

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;     // masks + linear luminance, not albedo
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.premultiplyAlpha = false;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------- shaders -----

const PARTICLE_VERT = /* glsl */`
  precision highp float;

  attribute vec3 iPos;
  attribute vec3 iVel;
  attribute vec4 iColor;
  attribute vec4 iParams;      // x = size, y = rotation, z = sprite index, w = stretch

  uniform vec2 uCell;          // 1/cols, 1/rows
  uniform float uCols;
  uniform float uInset;

  varying vec2 vUv;
  varying vec4 vColor;
  varying float vViewZ;

  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 corner = position.xy;               // quad spans -0.5 .. 0.5
    float s = iParams.x;
    vec2 off;

    if (iParams.w > 0.0001) {
      // Velocity-aligned stretch. Foreshorten by how much of the velocity
      // survives projection so a tracer fired away from the camera collapses
      // into a dot instead of staying full length.
      vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
      float vl = length(vv);
      vec2 d = vv.xy;
      float dl = length(d);
      vec2 dir = dl > 1e-5 ? d / dl : vec2(0.0, 1.0);
      vec2 perp = vec2(-dir.y, dir.x);
      float fore = vl > 1e-5 ? dl / vl : 0.0;
      float len = s + iParams.w * fore;
      off = perp * (corner.x * s) + dir * (corner.y * len);
    } else {
      float c = cos(iParams.y);
      float sn = sin(iParams.y);
      off = vec2(corner.x * c - corner.y * sn, corner.x * sn + corner.y * c) * s;
    }

    mv.xy += off;
    vViewZ = -mv.z;
    vColor = iColor;

    vec2 lp = (corner + 0.5) * (1.0 - 2.0 * uInset) + uInset;
    float idx = iParams.z;
    float col = mod(idx, uCols);
    float row = floor(idx / uCols);
    vUv = (vec2(col, row) + lp) * uCell;

    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  precision highp float;
  precision highp sampler2D;

  uniform sampler2D uMap;
  uniform sampler2D uDepth;    // half-res LINEAR view-space Z from last frame
  uniform vec2 uRes;
  uniform float uSoft;
  uniform float uSoftOn;
  uniform float uIntensity;

  varying vec2 vUv;
  varying vec4 vColor;
  varying float vViewZ;

  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * vColor.a * uIntensity;
    if (a < 0.0025) discard;

    if (uSoftOn > 0.5) {
      float sceneZ = texture2D(uDepth, gl_FragCoord.xy / uRes).r;
      a *= clamp((sceneZ - vViewZ) / uSoft, 0.0, 1.0);
      if (a < 0.0025) discard;
    }

    // Premultiplied output: both pools set material.premultipliedAlpha = true,
    // which makes additive = ONE/ONE and normal = ONE/ONE_MINUS_SRC_ALPHA, so
    // there is no dark-fringe term either way.
    gl_FragColor = vec4(t.rgb * vColor.rgb * a, a);
  }
`;

const DEPTH_COPY_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DEPTH_COPY_FRAG = /* glsl */`
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D tDepth;
  uniform float uNear;
  uniform float uFar;
  varying vec2 vUv;
  void main() {
    float d = texture2D(tDepth, vUv).r;
    float z = d * 2.0 - 1.0;
    float lin = (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
    gl_FragColor = vec4(lin, 0.0, 0.0, 1.0);
  }
`;

// ----------------------------------------------------------------- pool ----

/** One blend mode's worth of particles. Pure struct-of-arrays. */
class Pool {
  constructor(capacity) {
    const n = capacity;
    this.cap = n;

    // ---- simulation state (struct of arrays, never boxed) ----
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.lifeMax = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.curve = new Uint8Array(n);
    this.rot = new Float32Array(n);
    this.rotVel = new Float32Array(n);
    this.r0 = new Float32Array(n); this.g0 = new Float32Array(n); this.b0 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.r1 = new Float32Array(n); this.g1 = new Float32Array(n); this.b1 = new Float32Array(n);
    this.a1 = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.stretch = new Float32Array(n);
    this.bounce = new Float32Array(n);
    this.groundY = new Float32Array(n);
    this.turb = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.fadeIn = new Float32Array(n);
    this.sprite = new Float32Array(n);

    // ---- free list / alive list ----
    this.free = new Uint16Array(n);
    this.freeTop = n;
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.alive = new Uint16Array(n);
    this.aliveCount = 0;

    // ---- instance attribute buffers ----
    this.iPos = new Float32Array(n * 3);
    this.iVel = new Float32Array(n * 3);
    this.iColor = new Float32Array(n * 4);
    this.iParams = new Float32Array(n * 4);
  }

  /** Grab a slot; when saturated, stomp the oldest live particle. */
  acquire() {
    if (this.freeTop > 0) {
      const i = this.free[--this.freeTop];
      this.alive[this.aliveCount++] = i;
      return i;
    }
    return this.alive[0];
  }
}

// ------------------------------------------------------- ParticleSystem ----

export class ParticleSystem {
  /**
   * @param {object} ctx  shared context (scene is required; postfx optional)
   * @param {object} [opts] { additive, alpha } pool capacities
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.time = 0;

    this.capacities = {
      additive: opts.additive ?? 4096,
      alpha: opts.alpha ?? 4096,
    };

    this.atlas = buildSpriteAtlas();

    this.root = new THREE.Group();
    this.root.name = 'FX.Particles';
    this.root.frustumCulled = false;
    ctx?.scene?.add(this.root);

    this.pools = [
      new Pool(this.capacities.additive),
      new Pool(this.capacities.alpha),
    ];
    this.materials = [];
    this.meshes = [];

    this._buildBatch(MODE_ADD, THREE.AdditiveBlending, 0.30, 3);
    this._buildBatch(MODE_ALPHA, THREE.NormalBlending, 0.55, 2);

    // ---- soft-particle depth copy ----
    this._depthRT = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RedFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this._depthCopyMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        uNear: { value: 0.1 },
        uFar: { value: 500 },
      },
      vertexShader: DEPTH_COPY_VERT,
      fragmentShader: DEPTH_COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this._depthQuad = new FullScreenQuad(this._depthCopyMat);
    this._depthW = 0;
    this._depthH = 0;

    // ---- the one reusable spawn descriptor ----
    this._d = {
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      sprite: SPRITE.SMOKE_A,
      size: 0.1, sizeEnd: 0.1, curve: CURVE_LINEAR,
      r: 1, g: 1, b: 1, a: 1,
      r2: 1, g2: 1, b2: 1, a2: 0,
      life: 1,
      drag: 0, grav: 0,
      rot: 0, rotVel: 0,
      stretch: 0,
      bounce: 0, groundY: -1e9,
      turb: 0, fadeIn: 0.06,
    };
  }

  _buildBatch(mode, blending, softMetres, renderOrder) {
    const pool = this.pools[mode];
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.5,  0.5, 0,
      -0.5,  0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const mk = (arr, item) => {
      const a = new THREE.InstancedBufferAttribute(arr, item);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('iPos', mk(pool.iPos, 3));
    geo.setAttribute('iVel', mk(pool.iVel, 3));
    geo.setAttribute('iColor', mk(pool.iColor, 4));
    geo.setAttribute('iParams', mk(pool.iParams, 4));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.atlas },
        uDepth: { value: null },
        uRes: { value: new THREE.Vector2(1, 1) },
        uSoft: { value: softMetres },
        uSoftOn: { value: 0 },
        uIntensity: { value: 1 },
        uCell: { value: new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS) },
        uCols: { value: ATLAS_COLS },
        uInset: { value: 1.5 / TILE },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.name = mode === MODE_ADD ? 'FX.Particles.Additive' : 'FX.Particles.Alpha';
    this.root.add(mesh);

    this.materials[mode] = mat;
    this.meshes[mode] = mesh;
    pool.geometry = geo;
  }

  /** Reset and return the shared spawn descriptor. Fill it, then call emit(). */
  begin() {
    const d = this._d;
    d.x = 0; d.y = 0; d.z = 0;
    d.vx = 0; d.vy = 0; d.vz = 0;
    d.sprite = SPRITE.SMOKE_A;
    d.size = 0.1; d.sizeEnd = 0.1; d.curve = CURVE_LINEAR;
    d.r = 1; d.g = 1; d.b = 1; d.a = 1;
    d.r2 = 1; d.g2 = 1; d.b2 = 1; d.a2 = 0;
    d.life = 1;
    d.drag = 0; d.grav = 0;
    d.rot = 0; d.rotVel = 0;
    d.stretch = 0;
    d.bounce = 0; d.groundY = -1e9;
    d.turb = 0; d.fadeIn = 0.06;
    return d;
  }

  /** Commit the descriptor into a pool. Allocation-free. */
  emit(mode) {
    const p = this.pools[mode];
    const d = this._d;
    const i = p.acquire();

    p.px[i] = d.x; p.py[i] = d.y; p.pz[i] = d.z;
    p.vx[i] = d.vx; p.vy[i] = d.vy; p.vz[i] = d.vz;
    p.life[i] = d.life;
    p.lifeMax[i] = d.life > 1e-5 ? d.life : 1e-5;
    p.size0[i] = d.size;
    p.size1[i] = d.sizeEnd;
    p.curve[i] = d.curve;
    p.rot[i] = d.rot;
    p.rotVel[i] = d.rotVel;
    p.r0[i] = d.r; p.g0[i] = d.g; p.b0[i] = d.b; p.a0[i] = d.a;
    p.r1[i] = d.r2; p.g1[i] = d.g2; p.b1[i] = d.b2; p.a1[i] = d.a2;
    p.drag[i] = d.drag;
    p.grav[i] = d.grav;
    p.stretch[i] = d.stretch;
    p.bounce[i] = d.bounce;
    p.groundY[i] = d.groundY;
    p.turb[i] = d.turb;
    p.phase[i] = (i * 0.61803398875) * 6.2831853;
    p.fadeIn[i] = d.fadeIn > 1e-4 ? d.fadeIn : 1e-4;
    p.sprite[i] = d.sprite;
    return i;
  }

  get liveCount() {
    return this.pools[MODE_ADD].aliveCount + this.pools[MODE_ALPHA].aliveCount;
  }

  // ------------------------------------------------------------- update ----

  update(dt, ctx) {
    this.time += dt;
    this._refreshDepth(ctx);
    this._simulate(this.pools[MODE_ADD], dt);
    this._simulate(this.pools[MODE_ALPHA], dt);
  }

  /**
   * Blit PostFX's depth attachment into our own target, linearised. Runs while
   * no render target of PostFX's is bound, so there is no feedback loop.
   */
  _refreshDepth(ctx) {
    const postfx = ctx?.postfx;
    const renderer = ctx?.renderer;
    const depthTex = postfx?.depthTexture;
    const camera = ctx?.camera;

    if (!postfx || !renderer || !depthTex || !camera || !postfx.width || !postfx.height) {
      this.materials[MODE_ADD].uniforms.uSoftOn.value = 0;
      this.materials[MODE_ALPHA].uniforms.uSoftOn.value = 0;
      return;
    }

    const w = Math.max(1, postfx.width >> 1);
    const h = Math.max(1, postfx.height >> 1);
    if (w !== this._depthW || h !== this._depthH) {
      this._depthRT.setSize(w, h);
      this._depthW = w;
      this._depthH = h;
    }

    const u = this._depthCopyMat.uniforms;
    u.tDepth.value = depthTex;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;

    const prevTarget = renderer.getRenderTarget();
    const prevActiveCube = renderer.getActiveCubeFace?.();
    renderer.setRenderTarget(this._depthRT);
    this._depthQuad.render(renderer);
    renderer.setRenderTarget(prevTarget, prevActiveCube);

    for (let m = 0; m < 2; m++) {
      const mu = this.materials[m].uniforms;
      mu.uDepth.value = this._depthRT.texture;
      mu.uRes.value.set(postfx.width, postfx.height);
      mu.uSoftOn.value = 1;
    }
  }

  /** The hot loop. Flat arrays only — no objects, no allocation, no GC. */
  _simulate(p, dt) {
    const t = this.time;
    const iPos = p.iPos;
    const iVel = p.iVel;
    const iCol = p.iColor;
    const iPar = p.iParams;
    const alive = p.alive;

    let k = 0;
    let n = p.aliveCount;

    while (k < n) {
      const i = alive[k];

      const life = p.life[i] - dt;
      if (life <= 0) {
        p.life[i] = 0;
        alive[k] = alive[--n];
        p.free[p.freeTop++] = i;
        continue;
      }
      p.life[i] = life;

      const age = 1 - life / p.lifeMax[i];

      // --- forces -----------------------------------------------------------
      let vx = p.vx[i];
      let vy = p.vy[i] - GRAVITY * p.grav[i] * dt;
      let vz = p.vz[i];

      const turb = p.turb[i];
      if (turb > 0) {
        const w = t * 2.35 + p.phase[i];
        vx += Math.sin(w) * turb * dt;
        vy += Math.sin(w * 0.71 + 1.7) * turb * 0.45 * dt;
        vz += Math.cos(w * 1.13) * turb * dt;
      }

      const drag = p.drag[i];
      if (drag > 0) {
        let damp = 1 - drag * dt;
        if (damp < 0) damp = 0;
        vx *= damp; vy *= damp; vz *= damp;
      }

      let px = p.px[i] + vx * dt;
      let py = p.py[i] + vy * dt;
      let pz = p.pz[i] + vz * dt;

      // --- ground plane bounce (sparks, chips, embers) ----------------------
      const bounce = p.bounce[i];
      if (bounce > 0) {
        const gy = p.groundY[i];
        if (py < gy && vy < 0) {
          py = gy + (gy - py) * 0.25;
          vy = -vy * bounce;
          vx *= 0.62;
          vz *= 0.62;
          p.bounce[i] = bounce * 0.62;
          p.rotVel[i] *= -0.55;
          if (p.bounce[i] < 0.06) p.bounce[i] = 0;
        }
      }

      p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
      p.px[i] = px; p.py[i] = py; p.pz[i] = pz;

      const rot = p.rot[i] + p.rotVel[i] * dt;
      p.rot[i] = rot;

      // --- size over life ---------------------------------------------------
      const curve = p.curve[i];
      const st = curve === CURVE_FAST ? Math.sqrt(age) : (curve === CURVE_SLOW ? age * age : age);
      const size = p.size0[i] + (p.size1[i] - p.size0[i]) * st;

      // --- colour + alpha over life ----------------------------------------
      let alpha = p.a0[i] + (p.a1[i] - p.a0[i]) * age;
      const fi = p.fadeIn[i];
      if (age < fi) alpha *= age / fi;
      if (alpha < 0) alpha = 0;

      const r = p.r0[i] + (p.r1[i] - p.r0[i]) * age;
      const g = p.g0[i] + (p.g1[i] - p.g0[i]) * age;
      const b = p.b0[i] + (p.b1[i] - p.b0[i]) * age;

      // --- write instance data (dense, in alive order) ----------------------
      const o3 = k * 3;
      const o4 = k * 4;
      iPos[o3] = px; iPos[o3 + 1] = py; iPos[o3 + 2] = pz;
      iVel[o3] = vx; iVel[o3 + 1] = vy; iVel[o3 + 2] = vz;
      iCol[o4] = r; iCol[o4 + 1] = g; iCol[o4 + 2] = b; iCol[o4 + 3] = alpha;
      iPar[o4] = size; iPar[o4 + 1] = rot; iPar[o4 + 2] = p.sprite[i]; iPar[o4 + 3] = p.stretch[i];

      k++;
    }

    p.aliveCount = n;

    const geo = p.geometry;
    geo.instanceCount = n;
    if (n > 0) {
      const aPos = geo.attributes.iPos;
      const aVel = geo.attributes.iVel;
      const aCol = geo.attributes.iColor;
      const aPar = geo.attributes.iParams;
      aPos.clearUpdateRanges(); aPos.addUpdateRange(0, n * 3); aPos.needsUpdate = true;
      aVel.clearUpdateRanges(); aVel.addUpdateRange(0, n * 3); aVel.needsUpdate = true;
      aCol.clearUpdateRanges(); aCol.addUpdateRange(0, n * 4); aCol.needsUpdate = true;
      aPar.clearUpdateRanges(); aPar.addUpdateRange(0, n * 4); aPar.needsUpdate = true;
    }
  }

  /** Global multiplier on every particle's alpha. 1 = authored intensity. */
  setIntensity(v) {
    this.materials[MODE_ADD].uniforms.uIntensity.value = v;
    this.materials[MODE_ALPHA].uniforms.uIntensity.value = v;
  }

  clear() {
    for (let m = 0; m < 2; m++) {
      const p = this.pools[m];
      p.aliveCount = 0;
      p.freeTop = p.cap;
      for (let i = 0; i < p.cap; i++) p.free[i] = p.cap - 1 - i;
      p.geometry.instanceCount = 0;
    }
  }

  dispose() {
    this.root.parent?.remove(this.root);
    for (let m = 0; m < 2; m++) {
      this.pools[m].geometry.dispose();
      this.materials[m].dispose();
    }
    this.atlas.dispose();
    this._depthRT.dispose();
    this._depthCopyMat.dispose();
    this._depthQuad.dispose();
  }
}

export default ParticleSystem;
