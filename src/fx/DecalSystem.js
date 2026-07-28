import * as THREE from 'three';
import { makeRNG, makeTileablePerlin2, fbm, clamp, smoothstep } from '../gfx/noise.js';

/*
 * Projected decals, batched into a single draw call.
 *
 * Geometry is built the classic way (Wolfire / three's DecalGeometry): take the
 * triangles of the surface under the impact, transform them into the projector's
 * box space, clip against the six box planes, project UVs, transform back. The
 * difference here is that nothing allocates: triangles are gathered through the
 * level's BVH (`geometry.boundsTree.shapecast`) into flat scratch buffers, the
 * clipper ping-pongs between two preallocated Float32Arrays, and the result is
 * written into a fixed slot of one big shared BufferGeometry.
 *
 * 256 slots x 144 verts. One Mesh, one MeshStandardMaterial, one draw call, and
 * decals are fully lit + normal-mapped because they ride the standard shader.
 * Per-decal fade lives in a 256x1 float DataTexture read in the vertex shader,
 * so fading 256 decals costs a 4 KB upload rather than a geometry rewrite.
 */

// ------------------------------------------------------------- constants ---

const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;
const TILE = 256;

export const DECAL_TILE = {
  CONCRETE_A: 0,
  CONCRETE_B: 1,
  METAL_A: 2,
  METAL_B: 3,
  WOOD: 4,
  BLOOD_A: 5,
  BLOOD_B: 6,
  SCORCH: 7,
};

const KIND_TILES = {
  concrete: [DECAL_TILE.CONCRETE_A, DECAL_TILE.CONCRETE_B],
  metal: [DECAL_TILE.METAL_A, DECAL_TILE.METAL_B],
  wood: [DECAL_TILE.WOOD],
  blood: [DECAL_TILE.BLOOD_A, DECAL_TILE.BLOOD_B],
  scorch: [DECAL_TILE.SCORCH],
};

const SLOTS = 256;
const VERTS_PER_SLOT = 144;          // 48 triangles of headroom per decal
const CLIP_CAP = 2048;               // verts in each ping-pong clip buffer
const MAX_SRC_TRIS = 192;            // triangles gathered per projection
const BRUTE_FORCE_TRI_LIMIT = 60000; // beyond this, refuse to scan without a BVH

const UV_INSET = 1.5 / TILE;

// ------------------------------------------------------------ atlas gen ----

function buildDecalAtlas() {
  const W = ATLAS_COLS * TILE;
  const H = ATLAS_ROWS * TILE;
  const albedo = new Uint8Array(W * H * 4);
  const normalTex = new Uint8Array(W * H * 4);

  const height = new Float32Array(TILE * TILE);
  const rgba = new Float32Array(TILE * TILE * 4);

  const basis = makeTileablePerlin2(0xdeca1, 16);
  const basis2 = makeTileablePerlin2(0xdeca2, 32);

  // Shared grain fields so each tile does not pay for its own FBM.
  const F = 256;
  const grain = new Float32Array(F * F);
  const blotch = new Float32Array(F * F);
  for (let y = 0; y < F; y++) {
    for (let x = 0; x < F; x++) {
      const u = (x / F) * 16;
      const v = (y / F) * 16;
      grain[y * F + x] = fbm(basis2, u * 2, v * 2, { octaves: 4, gain: 0.55 }) * 0.5 + 0.5;
      blotch[y * F + x] = fbm(basis, u * 0.5, v * 0.5, { octaves: 5, gain: 0.6 }) * 0.5 + 0.5;
    }
  }
  const sampleF = (fld, fx, fy) => {
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

  const wrapPi = (a) => {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };

  /**
   * Build a set of radial fracture rays for one tile. The sideways wobble
   * depends only on the radius, so it is baked into a LUT — otherwise this is
   * ~8M sin() calls across the atlas.
   */
  const WOB_LUT = 256;
  const WOB_MAX_R = 1.5;                    // corner of the tile is sqrt(2)
  const WOB_SCALE = WOB_LUT / WOB_MAX_R;
  const makeCracks = (rand, count, maxLen, width, wobble) => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const c = {
        a: (i / count) * Math.PI * 2 + (rand() - 0.5) * (Math.PI * 1.3 / count),
        len: maxLen * (0.45 + rand() * 0.55),
        w: width * (0.5 + rand()),
        wob: wobble * (0.4 + rand()),
        freq: 6 + rand() * 14,
        ph: rand() * 6.283,
        start: rand() * 0.12,
        lut: null,
      };
      const lut = new Float32Array(WOB_LUT + 1);
      for (let j = 0; j <= WOB_LUT; j++) {
        const r = (j / WOB_LUT) * WOB_MAX_R;
        lut[j] = c.a + Math.sin(r * c.freq + c.ph) * c.wob;
      }
      c.lut = lut;
      arr.push(c);
    }
    return arr;
  };

  const crackValue = (cracks, r, th) => {
    let v = 0;
    const li = (r * WOB_SCALE) | 0;
    for (let i = 0; i < cracks.length; i++) {
      const c = cracks[i];
      if (r > c.len || r < c.start) continue;
      const lateral = Math.abs(wrapPi(th - c.lut[li])) * r;
      const taper = 1 - r / c.len;
      const w = c.w * taper + 0.004;
      const s = smoothstep(w, 0, lateral) * smoothstep(c.len, c.len * 0.55, r);
      if (s > v) v = s;
    }
    return v;
  };

  /**
   * @param {number} index    atlas tile index
   * @param {Function} gen    (u, v, r, th, out) -> writes out[0..3] rgba, returns height
   * @param {number} nrmScale normal map strength
   */
  const writeTile = (index, gen, nrmScale) => {
    for (let y = 0; y < TILE; y++) {
      const v = ((y + 0.5) / TILE) * 2 - 1;
      for (let x = 0; x < TILE; x++) {
        const u = ((x + 0.5) / TILE) * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const th = Math.atan2(v, u);
        const i = y * TILE + x;
        const o = i * 4;
        rgba[o] = 0.5; rgba[o + 1] = 0.5; rgba[o + 2] = 0.5; rgba[o + 3] = 0;
        height[i] = gen(u, v, r, th, rgba, o) || 0;
      }
    }

    const col = index % ATLAS_COLS;
    const row = (index / ATLAS_COLS) | 0;
    const ox = col * TILE;
    const oy = row * TILE;

    for (let y = 0; y < TILE; y++) {
      const ym = y > 0 ? y - 1 : 0;
      const yp = y < TILE - 1 ? y + 1 : TILE - 1;
      for (let x = 0; x < TILE; x++) {
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < TILE - 1 ? x + 1 : TILE - 1;
        const i = y * TILE + x;
        const src = i * 4;
        const dst = ((oy + y) * W + (ox + x)) * 4;

        albedo[dst]     = clamp(rgba[src]) * 255;
        albedo[dst + 1] = clamp(rgba[src + 1]) * 255;
        albedo[dst + 2] = clamp(rgba[src + 2]) * 255;
        albedo[dst + 3] = clamp(rgba[src + 3]) * 255;

        // Tangent-space normal from the height field. v grows with the array
        // row (flipY is false on DataTextures), so +Y is "up" in the texture,
        // i.e. standard OpenGL-style green channel.
        const dhx = (height[y * TILE + xp] - height[y * TILE + xm]) * nrmScale;
        const dhy = (height[yp * TILE + x] - height[ym * TILE + x]) * nrmScale;
        let nx = -dhx;
        let ny = -dhy;
        const nz = 1;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv;
        normalTex[dst]     = (nx * 0.5 + 0.5) * 255;
        normalTex[dst + 1] = (ny * 0.5 + 0.5) * 255;
        normalTex[dst + 2] = (nz * inv * 0.5 + 0.5) * 255;
        normalTex[dst + 3] = 255;
      }
    }
  };

  // ---------------------------------------------------- concrete holes -----
  /*
   * The first version of this tile was physically reasonable and completely
   * illegible: the bore was 1.5 cm across (about two pixels at combat range)
   * and the spall was a dusty 0.8 luminance painted onto 0.75-luminance
   * concrete, so a magazine emptied into a wall left it looking clean.
   *
   * A bullet hole has to carry its contrast at 15-40 m, which means the value
   * range inside the tile matters far more than the diameter does: a genuinely
   * black bore, a rim shadow around it, bright freshly-broken aggregate in the
   * crater, and cracks dark enough to survive mipping.
   */
  const concrete = (seed, holeR, crackCount) => {
    const rand = makeRNG(seed);
    const cracks = makeCracks(rand, crackCount, 0.88, 0.070, 0.30);
    const spallJit = makeCracks(rand, 9, 0.6, 0.20, 0.9);
    const gox = rand() * 500;
    const goy = rand() * 500;
    return (u, v, r, th, out, o) => {
      const g = sampleF(grain, (u * 0.9 + 1) * 128 + gox, (v * 0.9 + 1) * 128 + goy);
      const bl = sampleF(blotch, (u * 0.5 + 1) * 128 + gox, (v * 0.5 + 1) * 128 + goy);

      // spalled crater: an irregular ring of freshly broken, lighter aggregate
      const spall = 0.42 + 0.18 * (crackValue(spallJit, r, th) - 0.4) + 0.12 * (bl - 0.5);
      const crater = smoothstep(spall + 0.18, spall - 0.10, r);

      const holeEdge = holeR * (0.82 + 0.30 * g);
      const hole = smoothstep(holeEdge + 0.030, holeEdge - 0.02, r);
      // Soft shadow in the lip of the bore — this is what actually reads as a
      // hole rather than a dark dot once the texture is minified.
      const bore = smoothstep(holeEdge * 2.3, holeEdge * 0.85, r);

      const cr = crackValue(cracks, r, th);

      // mask: crater + cracks, eroded at the rim so it never reads as a disc
      let a = Math.max(crater, cr * 0.92);
      a *= smoothstep(1.0, 0.86, r);
      a = clamp(a * (0.86 + 0.40 * g));
      a = Math.max(a, hole, bore * 0.9);

      // albedo: black bore, shadowed lip, bright dusty spall, dark fractures
      const dust = 0.78 + 0.34 * g + 0.14 * bl;
      let lum = dust;
      lum *= 1 - 0.62 * bore;
      lum *= 1 - cr * 0.86;
      lum *= 1 - hole * 0.985;

      out[o]     = clamp(lum * 1.00);
      out[o + 1] = clamp(lum * 0.975);
      out[o + 2] = clamp(lum * 0.935);
      out[o + 3] = a;

      // height: deep bore, raised crumbled lip, incised cracks
      let h = -hole * 1.35;
      h -= bore * 0.35;
      h += crater * 0.26 * (0.4 + g);
      h -= cr * 0.70;
      h += (g - 0.5) * 0.14 * a;
      return h;
    };
  };
  writeTile(DECAL_TILE.CONCRETE_A, concrete(0xc0ffee, 0.30, 9), 30);
  writeTile(DECAL_TILE.CONCRETE_B, concrete(0x1337c0, 0.26, 12), 30);

  // -------------------------------------------------------- metal holes ----
  const metal = (seed, holeR, burrs) => {
    const rand = makeRNG(seed);
    const petals = makeCracks(rand, burrs, 0.55, 0.16, 0.35);
    const scratches = makeCracks(rand, 6, 0.95, 0.012, 0.10);
    const gox = rand() * 500;
    const goy = rand() * 500;
    return (u, v, r, th, out, o) => {
      const g = sampleF(grain, (u + 1) * 128 + gox, (v + 1) * 128 + goy);

      const tear = crackValue(petals, r, th);
      const dentR = 0.46 + 0.10 * (g - 0.5);
      const dent = smoothstep(dentR, dentR - 0.30, r);

      const holeEdge = holeR * (0.88 + 0.22 * g);
      const hole = smoothstep(holeEdge + 0.022, holeEdge - 0.012, r);
      const bore = smoothstep(holeEdge * 2.1, holeEdge * 0.9, r);

      let a = Math.max(dent * 0.92, tear * 0.9);
      a *= smoothstep(0.98, 0.80, r);
      a = clamp(Math.max(a, hole, bore * 0.85) * (0.88 + 0.28 * g));
      a = Math.max(a, crackValue(scratches, r, th) * 0.35);

      // Bare torn metal is much brighter than the painted surface around it,
      // and the punched hole itself has to go properly black or the decal
      // vanishes against light-painted sheet at any distance.
      const bright = 0.68 + 0.46 * tear + 0.24 * g;
      const rim = smoothstep(holeEdge + 0.10, holeEdge + 0.01, r) * (1 - hole);
      let lum = bright * (0.72 + 0.60 * rim);
      lum *= 1 - bore * 0.50;
      lum *= 1 - hole * 0.99;
      lum *= 0.80 + 0.35 * dent;

      out[o]     = clamp(lum * 1.0);
      out[o + 1] = clamp(lum * 1.0);
      out[o + 2] = clamp(lum * 1.02);
      out[o + 3] = a;

      let h = -hole * 1.2;
      h -= dent * 0.30;
      h += rim * 0.55 + tear * 0.40;      // torn lips curl outward
      h += (g - 0.5) * 0.08 * a;
      return h;
    };
  };
  writeTile(DECAL_TILE.METAL_A, metal(0xbeef01, 0.24, 6), 34);
  writeTile(DECAL_TILE.METAL_B, metal(0xbeef02, 0.21, 8), 34);

  // ------------------------------------------------------------- wood ------
  {
    const rand = makeRNG(0x600d);
    const splinters = makeCracks(rand, 14, 0.95, 0.045, 0.12);
    const gox = rand() * 500;
    const goy = rand() * 500;
    writeTile(DECAL_TILE.WOOD, (u, v, r, th, out, o) => {
      // strong grain anisotropy: splinters run along the fibre direction
      const fibre = sampleF(grain, (u + 1) * 40 + gox, (v + 1) * 300 + goy);
      const g = sampleF(blotch, (u + 1) * 128 + gox, (v + 1) * 128 + goy);

      const sp = crackValue(splinters, r, th) * (0.55 + 0.75 * fibre);
      const holeEdge = 0.28 * (0.85 + 0.3 * g);
      const hole = smoothstep(holeEdge + 0.03, holeEdge - 0.02, r);
      const bore = smoothstep(holeEdge * 2.0, holeEdge * 0.9, r);
      const crater = smoothstep(0.50, 0.20, r) * (0.6 + 0.7 * g);

      let a = clamp(Math.max(crater, sp * 0.95));
      a *= smoothstep(1.0, 0.82, r);
      a = Math.max(a, hole, bore * 0.85);

      // Raw torn wood is lighter and warmer than finished timber; the bore
      // behind it is a black void.
      const lum = (0.64 + 0.38 * fibre + 0.18 * g)
        * (1 - bore * 0.45) * (1 - hole * 0.97);
      out[o]     = clamp(lum * 1.00);
      out[o + 1] = clamp(lum * 0.80);
      out[o + 2] = clamp(lum * 0.54);
      out[o + 3] = a;

      let h = -hole * 1.0 - crater * 0.25;
      h += sp * 0.45;
      h += (fibre - 0.5) * 0.25 * a;
      return h;
    }, 24);
  }

  // ------------------------------------------------------------ blood ------
  const blood = (seed, drips) => {
    const rand = makeRNG(seed);
    const arms = makeCracks(rand, 11, 0.98, 0.13, 0.55);
    const gox = rand() * 500;
    const goy = rand() * 500;
    const drops = [];
    for (let i = 0; i < drips; i++) {
      const a = rand() * 6.283;
      const d = 0.45 + rand() * 0.5;
      drops.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: 0.02 + rand() * 0.055 });
    }
    return (u, v, r, th, out, o) => {
      const bl = sampleF(blotch, (u * 0.8 + 1) * 128 + gox, (v * 0.8 + 1) * 128 + goy);
      const g = sampleF(grain, (u + 1) * 128 + gox, (v + 1) * 128 + goy);

      const core = smoothstep(0.62 + 0.22 * (bl - 0.5), 0.10, r);
      const arm = crackValue(arms, r, th);
      let a = clamp(Math.max(core, arm * 0.9) * (0.72 + 0.55 * bl));
      a = smoothstep(0.18, 0.55, a);

      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        const dx = u - d.x;
        const dy = v - d.y;
        const dd = Math.sqrt(dx * dx + dy * dy);
        a = Math.max(a, smoothstep(d.r, d.r * 0.55, dd));
      }
      a *= smoothstep(1.02, 0.9, r);

      // dark venous red, thinner and brighter at the edges
      const thin = 1 - clamp(a);
      const lum = 0.10 + 0.22 * thin + 0.10 * g;
      out[o]     = clamp(lum * 2.6);
      out[o + 1] = clamp(lum * 0.30);
      out[o + 2] = clamp(lum * 0.26);
      out[o + 3] = clamp(a * 0.96);

      return a * 0.14 + (g - 0.5) * 0.05;
    };
  };
  writeTile(DECAL_TILE.BLOOD_A, blood(0xb100d1, 16), 12);
  writeTile(DECAL_TILE.BLOOD_B, blood(0xb100d2, 22), 12);

  // ----------------------------------------------------------- scorch ------
  {
    const rand = makeRNG(0x5c0c);
    const gox = rand() * 500;
    const goy = rand() * 500;
    const streaks = makeCracks(rand, 16, 1.0, 0.09, 0.6);
    writeTile(DECAL_TILE.SCORCH, (u, v, r, th, out, o) => {
      const bl = sampleF(blotch, (u * 0.7 + 1) * 128 + gox, (v * 0.7 + 1) * 128 + goy);
      const g = sampleF(grain, (u * 1.6 + 1) * 128 + gox, (v * 1.6 + 1) * 128 + goy);
      const st = crackValue(streaks, r, th);

      let a = smoothstep(1.0, 0.05, r) * (0.45 + 0.85 * bl);
      a = Math.max(a, st * smoothstep(1.0, 0.4, r) * 0.7);
      a = clamp(smoothstep(0.14, 0.72, a)) * 0.92;

      const lum = 0.035 + 0.10 * g * (1 - smoothstep(0.6, 0.0, r));
      out[o]     = clamp(lum * 1.1);
      out[o + 1] = clamp(lum * 1.0);
      out[o + 2] = clamp(lum * 0.95);
      out[o + 3] = a;
      return (g - 0.5) * 0.08 * a;
    }, 8);
  }

  const mkTex = (data, srgb) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  return { map: mkTex(albedo, true), normalMap: mkTex(normalTex, false) };
}

// ------------------------------------------------------------- system ------

export class DecalSystem {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.slots = opts.slots ?? SLOTS;
    this.vertsPerSlot = opts.vertsPerSlot ?? VERTS_PER_SLOT;
    this.projectorDepth = opts.projectorDepth ?? 0.55;   // fraction of decal size
    this.surfaceOffset = opts.surfaceOffset ?? 0.006;    // metres along the normal

    const tex = buildDecalAtlas();
    this.map = tex.map;
    this.normalMap = tex.normalMap;

    const total = this.slots * this.vertsPerSlot;
    this._pos = new Float32Array(total * 3);
    this._nrm = new Float32Array(total * 3);
    this._uv = new Float32Array(total * 2);
    const slotAttr = new Float32Array(total);
    for (let s = 0; s < this.slots; s++) {
      for (let v = 0; v < this.vertsPerSlot; v++) slotAttr[s * this.vertsPerSlot + v] = s;
    }

    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this._pos, 3); pa.setUsage(THREE.DynamicDrawUsage);
    const na = new THREE.BufferAttribute(this._nrm, 3); na.setUsage(THREE.DynamicDrawUsage);
    const ua = new THREE.BufferAttribute(this._uv, 2); ua.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('normal', na);
    geo.setAttribute('uv', ua);
    geo.setAttribute('aSlot', new THREE.BufferAttribute(slotAttr, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    // Slots fill in ring order, so we only ever have to submit the prefix of
    // the buffer that has actually been written.
    geo.setDrawRange(0, 0);
    this._highWater = 0;
    this.geometry = geo;

    // per-decal fade, read in the vertex shader
    this._fadeData = new Float32Array(this.slots * 4);
    this._fadeTex = new THREE.DataTexture(
      this._fadeData, this.slots, 1, THREE.RGBAFormat, THREE.FloatType,
    );
    this._fadeTex.minFilter = THREE.NearestFilter;
    this._fadeTex.magFilter = THREE.NearestFilter;
    this._fadeTex.generateMipmaps = false;
    this._fadeTex.needsUpdate = true;

    const mat = new THREE.MeshStandardMaterial({
      map: this.map,
      normalMap: this.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughness: 0.86,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      alphaTest: 0.0,
    });
    const fadeTex = this._fadeTex;
    const slotCount = this.slots;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDecalFade = { value: fadeTex };
      shader.uniforms.uDecalCount = { value: slotCount };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute float aSlot;
          uniform sampler2D uDecalFade;
          uniform float uDecalCount;
          varying float vDecalFade;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vDecalFade = texture2D(uDecalFade, vec2((aSlot + 0.5) / uDecalCount, 0.5)).r;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDecalFade;')
        .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n\tdiffuseColor.a *= vDecalFade;');
    };
    mat.customProgramCacheKey = () => 'blacksite-decal';
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'FX.Decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    ctx?.scene?.add(this.mesh);

    // ---- slot bookkeeping ----
    this._active = new Uint8Array(this.slots);
    this._age = new Float32Array(this.slots);
    this._life = new Float32Array(this.slots);
    this._fadeIn = new Float32Array(this.slots);
    this._fadeOut = new Float32Array(this.slots);
    this._cursor = 0;
    this._fadeDirty = true;
    this.count = 0;

    // ---- preallocated scratch (nothing below allocates at runtime) ----
    this._bufA = new Float32Array(CLIP_CAP * 6);
    this._bufB = new Float32Array(CLIP_CAP * 6);
    this._triNormal = new THREE.Vector3();
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._e0 = new THREE.Vector3();
    this._e1 = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._quatRoll = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 0, 1);
    this._proj = new THREE.Matrix4();
    this._projInv = new THREE.Matrix4();
    this._meshInv = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._localBox = new THREE.Box3();
    this._size = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._rand = makeRNG(0x0deca1);
    this._offs = new Int32Array(3);
    this._ds = new Float64Array(3);
    this._gatherMatrix = new THREE.Matrix4();

    this._srcCount = 0;             // verts currently in _bufA during gather
    this._gatherNormal = new THREE.Vector3();

    // bound once so shapecast does not allocate closures per call
    this._boundsCb = (box) => box.intersectsBox(this._localBox);
    this._triCb = (tri) => {
      this._collectTriangle(tri);
      return this._srcCount >= MAX_SRC_TRIS * 3;   // true stops traversal
    };
  }

  // ------------------------------------------------------------- public ----

  /**
   * Project a decal onto the world.
   * @param {THREE.Vector3} point   impact point (world)
   * @param {THREE.Vector3} normal  surface normal (world, unit)
   * @param {string} kind           'concrete' | 'metal' | 'wood' | 'blood' | 'scorch'
   * @param {number} size           decal width/height in metres
   * @param {object} [opts]         { roll, life, fadeOut, target, allowFallback, tile }
   * @returns {number} slot index, or -1 if nothing was projected
   */
  spawn(point, normal, kind = 'concrete', size = 0.18, opts = null) {
    if (!point || !normal) return -1;

    const tiles = KIND_TILES[kind] || KIND_TILES.concrete;
    const tile = opts?.tile ?? tiles[(this._rand() * tiles.length) | 0];
    const roll = opts?.roll ?? this._rand() * Math.PI * 2;
    const life = opts?.life ?? 45;
    const fadeOut = opts?.fadeOut ?? 5;
    const allowFallback = opts?.allowFallback ?? true;

    // --- projector basis: +Z maps to the surface normal, random roll ---------
    this._tmp.copy(normal);
    if (this._tmp.lengthSq() < 1e-8) return -1;
    this._tmp.normalize();
    this._quat.setFromUnitVectors(this._up, this._tmp);
    this._quatRoll.setFromAxisAngle(this._tmp, roll);
    this._quat.premultiply(this._quatRoll);

    const depth = size * this.projectorDepth;
    this._size.set(size, size, depth);
    this._proj.makeRotationFromQuaternion(this._quat);
    this._proj.setPosition(point.x, point.y, point.z);
    this._projInv.copy(this._proj).invert();

    // --- gather candidate triangles into projector space --------------------
    this._srcCount = 0;
    this._gatherNormal.copy(this._tmp);
    const target = opts?.target ?? this.ctx?.world?.collider ?? null;
    if (target) this._gather(target, point, size, depth);

    if (this._srcCount === 0) {
      if (!allowFallback) return -1;
      this._makeFallbackQuad(size);
    }

    // --- clip against the six projector planes ------------------------------
    let src = this._bufA;
    let dst = this._bufB;
    let count = this._srcCount;
    const half = [this._size.x * 0.5, this._size.y * 0.5, this._size.z * 0.5];
    for (let axis = 0; axis < 3; axis++) {
      for (let s = 0; s < 2; s++) {
        count = this._clip(src, count, dst, axis, s === 0 ? 1 : -1, half[axis]);
        const t = src; src = dst; dst = t;
        if (count === 0) return -1;
      }
    }

    // --- write into a slot --------------------------------------------------
    const slot = this._takeSlot();
    this._writeSlot(slot, src, count, tile);

    this._active[slot] = 1;
    this._age[slot] = 0;
    this._life[slot] = life;
    this._fadeIn[slot] = 0.05;
    this._fadeOut[slot] = Math.min(fadeOut, life * 0.9);
    this._fadeData[slot * 4] = 0;
    this._fadeDirty = true;
    return slot;
  }

  update(dt) {
    let dirty = false;
    let live = 0;
    for (let s = 0; s < this.slots; s++) {
      if (!this._active[s]) continue;
      const age = this._age[s] + dt;
      this._age[s] = age;
      const life = this._life[s];

      let a;
      if (age >= life) {
        this._active[s] = 0;
        a = 0;
      } else {
        a = 1;
        const fi = this._fadeIn[s];
        if (age < fi) a = age / fi;
        const rem = life - age;
        const fo = this._fadeOut[s];
        if (rem < fo) a *= rem / fo;
        live++;
      }
      if (this._fadeData[s * 4] !== a) {
        this._fadeData[s * 4] = a;
        dirty = true;
      }
    }
    this.count = live;
    if (dirty || this._fadeDirty) {
      this._fadeTex.needsUpdate = true;
      this._fadeDirty = false;
    }
  }

  clear() {
    for (let s = 0; s < this.slots; s++) {
      this._active[s] = 0;
      this._fadeData[s * 4] = 0;
    }
    this._pos.fill(0);
    this.geometry.attributes.position.needsUpdate = true;
    this._fadeTex.needsUpdate = true;
    this.count = 0;
    this._cursor = 0;
    this._highWater = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.map.dispose();
    this.normalMap.dispose();
    this._fadeTex.dispose();
  }

  // ------------------------------------------------------------ internals --

  /** Ring allocation: the slot we come back to is by construction the oldest. */
  _takeSlot() {
    const s = this._cursor;
    this._cursor = (this._cursor + 1) % this.slots;
    return s;
  }

  _gather(mesh, point, size, depth) {
    const geometry = mesh.geometry;
    if (!geometry || !geometry.attributes || !geometry.attributes.position) return;

    // conservative world-space query box around the projector
    const radius = 0.5 * Math.sqrt(size * size * 2 + depth * depth);
    this._box.min.set(point.x - radius, point.y - radius, point.z - radius);
    this._box.max.set(point.x + radius, point.y + radius, point.z + radius);

    mesh.updateWorldMatrix?.(true, false);
    this._meshInv.copy(mesh.matrixWorld).invert();
    this._localBox.copy(this._box).applyMatrix4(this._meshInv);

    this._gatherMatrix.copy(mesh.matrixWorld);

    const bvh = geometry.boundsTree;
    if (bvh && typeof bvh.shapecast === 'function') {
      bvh.shapecast({
        intersectsBounds: this._boundsCb,
        intersectsTriangle: this._triCb,
      });
      return;
    }

    // No BVH: brute force, but only for geometry small enough to justify it.
    const pos = geometry.attributes.position;
    const index = geometry.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    if (triCount > BRUTE_FORCE_TRI_LIMIT) return;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      this._v0.fromBufferAttribute(pos, i0);
      this._v1.fromBufferAttribute(pos, i1);
      this._v2.fromBufferAttribute(pos, i2);
      // cheap local-space AABB reject
      if (Math.min(this._v0.x, this._v1.x, this._v2.x) > this._localBox.max.x) continue;
      if (Math.max(this._v0.x, this._v1.x, this._v2.x) < this._localBox.min.x) continue;
      if (Math.min(this._v0.y, this._v1.y, this._v2.y) > this._localBox.max.y) continue;
      if (Math.max(this._v0.y, this._v1.y, this._v2.y) < this._localBox.min.y) continue;
      if (Math.min(this._v0.z, this._v1.z, this._v2.z) > this._localBox.max.z) continue;
      if (Math.max(this._v0.z, this._v1.z, this._v2.z) < this._localBox.min.z) continue;
      this._pushTriangle(this._v0, this._v1, this._v2);
      if (this._srcCount >= MAX_SRC_TRIS * 3) return;
    }
  }

  _collectTriangle(tri) {
    if (this._srcCount >= MAX_SRC_TRIS * 3) return;
    this._v0.copy(tri.a);
    this._v1.copy(tri.b);
    this._v2.copy(tri.c);
    this._pushTriangle(this._v0, this._v1, this._v2);
  }

  /** Local-space triangle -> world -> projector space, into _bufA. */
  _pushTriangle(a, b, c) {
    const m = this._gatherMatrix;
    a.applyMatrix4(m);
    b.applyMatrix4(m);
    c.applyMatrix4(m);

    this._e0.subVectors(b, a);
    this._e1.subVectors(c, a);
    this._triNormal.crossVectors(this._e0, this._e1);
    const len = this._triNormal.length();
    if (len < 1e-12) return;
    this._triNormal.multiplyScalar(1 / len);

    // Reject faces that point away from (or perpendicular to) the projector so
    // a decal on a wall does not smear across the floor it meets.
    if (this._triNormal.dot(this._gatherNormal) < 0.2) return;

    a.applyMatrix4(this._projInv);
    b.applyMatrix4(this._projInv);
    c.applyMatrix4(this._projInv);

    const buf = this._bufA;
    let o = this._srcCount * 6;
    const nx = this._triNormal.x;
    const ny = this._triNormal.y;
    const nz = this._triNormal.z;
    buf[o] = a.x; buf[o + 1] = a.y; buf[o + 2] = a.z; buf[o + 3] = nx; buf[o + 4] = ny; buf[o + 5] = nz; o += 6;
    buf[o] = b.x; buf[o + 1] = b.y; buf[o + 2] = b.z; buf[o + 3] = nx; buf[o + 4] = ny; buf[o + 5] = nz; o += 6;
    buf[o] = c.x; buf[o + 1] = c.y; buf[o + 2] = c.z; buf[o + 3] = nx; buf[o + 4] = ny; buf[o + 5] = nz;
    this._srcCount += 3;
  }

  /** Two triangles filling the projector's XY plane at z = 0. */
  _makeFallbackQuad(size) {
    const h = size * 0.5;
    const buf = this._bufA;
    const n = this._gatherNormal;
    // in projector space the surface normal is +Z; store world normal for lighting
    const put = (i, x, y) => {
      const o = i * 6;
      buf[o] = x; buf[o + 1] = y; buf[o + 2] = 0;
      buf[o + 3] = n.x; buf[o + 4] = n.y; buf[o + 5] = n.z;
    };
    put(0, -h, -h); put(1, h, -h); put(2, h, h);
    put(3, -h, -h); put(4, h, h); put(5, -h, h);
    this._srcCount = 6;
  }

  /**
   * Sutherland–Hodgman clip of a triangle soup against one axis-aligned plane
   * of the projector box. Operates on flat [px,py,pz,nx,ny,nz] vertices.
   */
  _clip(src, srcCount, dst, axis, sign, half) {
    let out = 0;
    const offs = this._offs;
    const ds = this._ds;

    for (let i = 0; i < srcCount; i += 3) {
      const o0 = i * 6;
      const o1 = o0 + 6;
      const o2 = o0 + 12;
      const d0 = src[o0 + axis] * sign - half;
      const d1 = src[o1 + axis] * sign - half;
      const d2 = src[o2 + axis] * sign - half;
      const out0 = d0 > 0 ? 1 : 0;
      const out1 = d1 > 0 ? 1 : 0;
      const out2 = d2 > 0 ? 1 : 0;
      const total = out0 + out1 + out2;

      if (total === 3) continue;              // wholly outside, drop it

      if (total === 0) {                       // wholly inside, pass through
        if (out + 3 > CLIP_CAP) return out;
        out = this._copyVert(src, o0, dst, out);
        out = this._copyVert(src, o1, dst, out);
        out = this._copyVert(src, o2, dst, out);
        continue;
      }

      offs[0] = o0; offs[1] = o1; offs[2] = o2;
      ds[0] = d0; ds[1] = d1; ds[2] = d2;

      if (total === 1) {
        // One vertex (k) outside. The survivor is the quad
        //   [ clip(k->a), a, b, clip(k->b) ]
        // in the original winding; emit it as two triangles.
        const k = out0 ? 0 : (out1 ? 1 : 2);
        const ia = (k + 1) % 3;
        const ib = (k + 2) % 3;
        if (out + 6 > CLIP_CAP) return out;

        const q0 = out;
        out = this._lerpVert(src, offs[k], offs[ia], ds[k], ds[ia], dst, out);   // q0
        out = this._copyVert(src, offs[ia], dst, out);                            // q1
        const q2 = out;
        out = this._copyVert(src, offs[ib], dst, out);                            // q2
        // second triangle: q0, q2, clip(k->b)
        out = this._copyVert(dst, q0 * 6, dst, out);
        out = this._copyVert(dst, q2 * 6, dst, out);
        out = this._lerpVert(src, offs[k], offs[ib], ds[k], ds[ib], dst, out);
        continue;
      }

      // total === 2: only vertex k survives -> one smaller triangle
      const k = out0 ? (out1 ? 2 : 1) : 0;
      const ia = (k + 1) % 3;
      const ib = (k + 2) % 3;
      if (out + 3 > CLIP_CAP) return out;
      out = this._copyVert(src, offs[k], dst, out);
      out = this._lerpVert(src, offs[k], offs[ia], ds[k], ds[ia], dst, out);
      out = this._lerpVert(src, offs[ib], offs[k], ds[ib], ds[k], dst, out);
    }
    return out;
  }

  _copyVert(src, srcOff, dst, dstIndex) {
    const o = dstIndex * 6;
    dst[o] = src[srcOff];
    dst[o + 1] = src[srcOff + 1];
    dst[o + 2] = src[srcOff + 2];
    dst[o + 3] = src[srcOff + 3];
    dst[o + 4] = src[srcOff + 4];
    dst[o + 5] = src[srcOff + 5];
    return dstIndex + 1;
  }

  _lerpVert(src, oA, oB, dA, dB, dst, dstIndex) {
    const t = dA / (dA - dB);
    const o = dstIndex * 6;
    for (let q = 0; q < 6; q++) dst[o + q] = src[oA + q] + t * (src[oB + q] - src[oA + q]);
    return dstIndex + 1;
  }

  _writeSlot(slot, buf, count, tile) {
    const vps = this.vertsPerSlot;
    let n = Math.min(count, vps);
    n -= n % 3;

    const base = slot * vps;
    const pos = this._pos;
    const nrm = this._nrm;
    const uv = this._uv;

    const sx = this._size.x;
    const sy = this._size.y;
    const col = tile % ATLAS_COLS;
    const row = (tile / ATLAS_COLS) | 0;
    const off = this.surfaceOffset;
    const m = this._proj.elements;

    for (let v = 0; v < n; v++) {
      const s = v * 6;
      const px = buf[s], py = buf[s + 1], pz = buf[s + 2];
      const nx = buf[s + 3], ny = buf[s + 4], nz = buf[s + 5];

      // projector space -> world (this._proj is a rigid transform)
      const wx = m[0] * px + m[4] * py + m[8] * pz + m[12];
      const wy = m[1] * px + m[5] * py + m[9] * pz + m[13];
      const wz = m[2] * px + m[6] * py + m[10] * pz + m[14];

      const d3 = (base + v) * 3;
      pos[d3] = wx + nx * off;
      pos[d3 + 1] = wy + ny * off;
      pos[d3 + 2] = wz + nz * off;
      nrm[d3] = nx; nrm[d3 + 1] = ny; nrm[d3 + 2] = nz;

      let lu = 0.5 + px / sx;
      let lv = 0.5 + py / sy;
      lu = lu < 0 ? 0 : (lu > 1 ? 1 : lu);
      lv = lv < 0 ? 0 : (lv > 1 ? 1 : lv);
      lu = UV_INSET + lu * (1 - 2 * UV_INSET);
      lv = UV_INSET + lv * (1 - 2 * UV_INSET);

      const d2 = (base + v) * 2;
      uv[d2] = (col + lu) / ATLAS_COLS;
      uv[d2 + 1] = (row + lv) / ATLAS_ROWS;
    }

    // collapse the unused tail of the slot into degenerate triangles at 0,0,0
    if (n < vps) {
      pos.fill(0, (base + n) * 3, (base + vps) * 3);
      nrm.fill(0, (base + n) * 3, (base + vps) * 3);
      uv.fill(0, (base + n) * 2, (base + vps) * 2);
    }

    const a = this.geometry.attributes;
    a.position.addUpdateRange(base * 3, vps * 3); a.position.needsUpdate = true;
    a.normal.addUpdateRange(base * 3, vps * 3); a.normal.needsUpdate = true;
    a.uv.addUpdateRange(base * 2, vps * 2); a.uv.needsUpdate = true;

    if (slot >= this._highWater) {
      this._highWater = slot + 1;
      this.geometry.setDrawRange(0, this._highWater * vps);
    }
  }
}

export default DecalSystem;
