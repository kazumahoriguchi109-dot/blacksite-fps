import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/*
 * BLACKSITE — physical sky / atmosphere.
 *
 * Pipeline:
 *   1. SKY LUT  (256x128 RGBA16F, equirect-ish, non-linear in elevation)
 *      A real single-scattering atmosphere: Rayleigh + Mie (Henyey-Greenstein)
 *      + ozone absorption, ray-marched with energy-conserving integration and a
 *      cheap isotropic multiple-scattering term. Only re-rendered when the sun
 *      moves, so the per-frame cost of the sky is one texture fetch.
 *   2. DOME     (inverted sphere, BackSide, depthWrite/depthTest off, order -1000)
 *      Samples the LUT, then adds the analytic sun disc (limb-darkened, HDR,
 *      genuinely >1 so the post stack blooms it) and two parallax cloud layers
 *      with light scattering through them.
 *   3. ENV      The same shader re-rendered into a 512x256 equirect target
 *      (no sun disc — the DirectionalLight already carries that energy), fed to
 *      PMREMGenerator for scene.environment / scene.background.
 *
 * Everything the rest of the game needs (sunColor, ambientColor, fogColor,
 * fogColorGround, sunLight.intensity) is derived by evaluating the *same*
 * scattering integral on the CPU, using the *same* constants that are injected
 * into the GLSL, so the lighting can never drift from the sky you can see.
 *
 * The shader outputs raw linear HDR. No tonemapping, no gamma, no toneMapped
 * tricks — PostFX owns ACES.
 */

// ---------------------------------------------------------------------------
// Atmosphere constants. Units are KILOMETRES (keeps float32 well away from the
// catastrophic cancellation you get doing ray/sphere maths at 6.36e6 metres).
// Coefficients after Bruneton / Hillaire.
// ---------------------------------------------------------------------------
const ATMO = {
  Rg: 6360.0,              // planet radius
  Rt: 6460.0,              // atmosphere top
  Hr: 8.0,                 // Rayleigh scale height
  Hm: 1.2,                 // Mie scale height
  betaR: [5.802e-3, 13.558e-3, 33.100e-3],   // Rayleigh scattering, per km
  betaMs: 3.996e-3,        // Mie scattering
  betaMe: 4.440e-3,        // Mie extinction (scattering + absorption)
  mieG: 0.80,              // HG asymmetry
  betaO: [0.650e-3, 1.881e-3, 0.085e-3],     // ozone absorption
  ozoneCenter: 25.0,
  ozoneWidth: 15.0,
  viewSteps: 32,
  lightSteps: 8,
};

// CPU mirror uses fewer steps — it only ever evaluates ~10 directions.
const CPU_VIEW_STEPS = 24;
const CPU_LIGHT_STEPS = 6;

// ---------------------------------------------------------------------------
// Procedural cloud noise, generated once at construction into two textures.
//
// Why textures at all: the silhouette detail the art review asked for is 3-4
// octaves of 3D WORLEY, and worley needs 27 hashed feature points per octave.
// Evaluated in the fragment shader that is ~800 ALU per density sample, ~50
// density samples per cloudy pixel, 1.4M pixels — tens of gigaops per frame,
// which is not a trade, it is a stall. Baked into a small seamless volume it is
// one filtered fetch. Both textures are generated here in JS from a seeded PRNG,
// so this stays a zero-asset build.
//
// The split matters:
//   WEATHER (2D, 26 km tile)  - WHERE cloud is, how big the cells are, how high
//                               the base sits. Tiles far outside the haze range.
//   VOLUME  (3D, ~1.8 km tile) - the silhouette erosion. Tiles inside a single
//                               cloud, which is exactly how every production
//                               volumetric does it: the weather field varying on
//                               top is what stops the repeat from being visible.
// ---------------------------------------------------------------------------

/** Deterministic LCG — the same sky every boot, no asset, no Math.random. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const _smooth = (t) => t * t * (3.0 - 2.0 * t);

/** Seamless 2D value noise on a periodic `C x C` lattice. */
function _lattice2(C, rng) {
  const g = new Float32Array(C * C);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

function _val2(g, C, x, y) {
  const fx = x * C, fy = y * C;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = _smooth(fx - ix), ty = _smooth(fy - iy);
  const x0 = ((ix % C) + C) % C, x1 = (x0 + 1) % C;
  const y0 = ((iy % C) + C) % C, y1 = (y0 + 1) % C;
  const a = g[y0 * C + x0], b = g[y0 * C + x1];
  const c = g[y1 * C + x0], d = g[y1 * C + x1];
  const p = a + (b - a) * tx;
  return p + ((c + (d - c) * tx) - p) * ty;
}

/** Seamless 3D value noise on a periodic `C^3` lattice. */
function _lattice3(C, rng) {
  const g = new Float32Array(C * C * C);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

function _val3(g, C, x, y, z) {
  const fx = x * C, fy = y * C, fz = z * C;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = _smooth(fx - ix), ty = _smooth(fy - iy), tz = _smooth(fz - iz);
  const x0 = ((ix % C) + C) % C, x1 = (x0 + 1) % C;
  const y0 = ((iy % C) + C) % C, y1 = (y0 + 1) % C;
  const z0 = ((iz % C) + C) % C, z1 = (z0 + 1) % C;
  const i000 = (z0 * C + y0) * C, i010 = (z0 * C + y1) * C;
  const i100 = (z1 * C + y0) * C, i110 = (z1 * C + y1) * C;
  const l = (a, b) => a + (b - a) * tx;
  const a0 = l(g[i000 + x0], g[i000 + x1]);
  const b0 = l(g[i010 + x0], g[i010 + x1]);
  const a1 = l(g[i100 + x0], g[i100 + x1]);
  const b1 = l(g[i110 + x0], g[i110 + x1]);
  const f0 = a0 + (b0 - a0) * ty;
  const f1 = a1 + (b1 - a1) * ty;
  return f0 + (f1 - f0) * tz;
}

/**
 * Seamless 3D worley (cellular) distance field, `C` cells across the tile,
 * returned already INVERTED and normalised: 1 at a feature point, 0 between
 * them. That is the packed-spheres field a cumulus crown is made of — the thing
 * value noise fundamentally cannot produce, and the reason the old deck read as
 * smooth putty however hard it was eroded.
 */
function _worley3(N, C, rng) {
  const n = C * C * C;
  const fx = new Float32Array(n), fy = new Float32Array(n), fz = new Float32Array(n);
  for (let i = 0; i < n; i++) { fx[i] = rng(); fy[i] = rng(); fz[i] = rng(); }
  const out = new Float32Array(N * N * N);
  const invN = 1 / N, invC = 1 / C;
  for (let z = 0; z < N; z++) {
    const pz = (z + 0.5) * invN;
    const cz = Math.floor(pz * C);
    for (let y = 0; y < N; y++) {
      const py = (y + 0.5) * invN;
      const cy = Math.floor(py * C);
      const row = (z * N + y) * N;
      for (let x = 0; x < N; x++) {
        const px = (x + 0.5) * invN;
        const cx = Math.floor(px * C);
        let best = 4.0;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = cz + dz, wz = ((nz % C) + C) % C;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy, wy = ((ny % C) + C) % C;
            const base = (wz * C + wy) * C;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, wx = ((nx % C) + C) % C;
              const k = base + wx;
              // Neighbour coordinates stay UNWRAPPED in the distance so the
              // field is genuinely periodic rather than seamed at the border.
              const ax = (nx + fx[k]) * invC - px;
              const ay = (ny + fy[k]) * invC - py;
              const az = (nz + fz[k]) * invC - pz;
              const d2 = ax * ax + ay * ay + az * az;
              if (d2 < best) best = d2;
            }
          }
        }
        // sqrt(best) * C is the distance in cell units; ~1 is the far corner.
        out[row + x] = 1.0 - Math.min(1.0, Math.sqrt(best) * C);
      }
    }
  }
  return out;
}

/**
 * WEATHER map — 512^2 RGBA8, seamless; one tile = cloudCellKm * weatherCells.
 *   R  coverage   — the union of every cloud's footprint: 1 in a core, 0 outside
 *   G  tower      — how far up the slab THIS cloud builds     (per-cloud constant)
 *   B  base       — THIS cloud's condensation level           (per-cloud constant)
 *   A  character  — THIS cloud's density / erosion multiplier (per-cloud constant)
 *
 * This map is SPLATTED, not thresholded out of an fbm, and that is the whole
 * fix for the lattice.
 *
 * A value-noise fbm lives on an axis-aligned periodic lattice. With the base
 * octave carrying half the amplitude (it has to, or the field has no cells at
 * all) the field is a grid of bumps with wiggle on top, and a narrow threshold
 * against a grid of bumps returns a grid of blobs — one blob per lattice cell,
 * spaced exactly one cell apart, all within a factor of ~1.3 in size because
 * they are all the same bump cut at the same height. That is precisely the "row
 * of seven identical lozenges" the review counted, and no amount of domain warp
 * fixes it: a warp of 2 km translates a whole neighbourhood, it does not change
 * the spacing inside one.
 *
 * So clouds are placed as OBJECTS instead. Each is a cluster of 2-5 rotated
 * elliptical lobes, composited by max, with:
 *   - a radius drawn from a heavy-tailed distribution spanning ~7x,
 *   - a position drawn from a rejection sample against a low-frequency airmass
 *     field, so the field has busy banks and clear lanes rather than uniform
 *     scatter,
 *   - its own tower height (correlated with its radius, as convection is),
 *   - its own condensation level, so bases are flat PER CLOUD and staggered,
 *   - its own density/erosion character.
 * There is no lattice anywhere in that, and no two clouds share a shape, a
 * size, a height or a base.
 *
 * The per-cloud channels are written by the same max test that builds coverage,
 * so they are piecewise constant over each cloud with the seams buried where
 * two clouds already overlap; a short blur turns those seams into a 150 m ramp.
 */
function buildWeatherTexture(size, cfg) {
  const rng = makeRng(0x51ce7a1);
  const N = size;
  const NN = N * N;
  const data = new Uint8Array(NN * 4);

  const tileKm = Math.max(cfg.tileKm, 4.0);
  const texPerKm = N / tileKm;

  // cov doubles as the dominance key for the three per-cloud channels.
  const cov = new Float32Array(NN);
  const tow = new Float32Array(NN).fill(0.55);
  const bas = new Float32Array(NN).fill(0.50);
  const chr = new Float32Array(NN).fill(0.55);

  // --- airmass -------------------------------------------------------------
  // Where convection is active at all. Three very low octaves (2 / 4 / 7 cells
  // over the whole tile, so 3.5-13 km) used two ways: as a rejection field for
  // cloud placement, and as a multiplier on cloud size. This is what gives the
  // sky composition — banks of big clouds, lanes of small ones, and holes —
  // rather than the featureless even scatter a stationary Poisson process makes.
  const a2 = _lattice2(2, rng), a4 = _lattice2(4, rng), a7 = _lattice2(7, rng);
  const airAt = (x, y) => 0.50 * _val2(a2, 2, x, y)
                        + 0.32 * _val2(a4, 4, x, y)
                        + 0.18 * _val2(a7, 7, x, y);

  // --- cloud population ----------------------------------------------------
  const rMin = Math.max(cfg.radiusMinKm, 0.10) * texPerKm;
  const rMax = Math.max(cfg.radiusMaxKm, cfg.radiusMinKm * 1.5) * texPerKm;
  const ratio = rMax / rMin;
  const logRatio = Math.log(ratio);
  const budget = Math.max(cfg.areaBudget, 0.05) * NN;
  const scatter = Math.max(cfg.lobeScatter, 0.0);

  let area = 0, guard = 0, clouds = 0;
  while (area < budget && guard++ < 40000) {
    const cx = rng() * N, cy = rng() * N;
    const air = airAt(cx / N, cy / N);
    // Rejection sample. Below ~0.32 of the airmass field nothing forms; the
    // ramp above it means the transition from clear lane to cloud bank is a
    // gradient in cloud DENSITY, which is how a real field thins out.
    const p = Math.min(1, Math.max(0, (air - 0.32) / 0.40));
    if (rng() > _smooth(p)) continue;

    // Heavy tail, but not too heavy. A linear draw gives a sky where every
    // cloud is mid-sized, which reads as uniform even though it technically
    // varies; u^3 goes too far the other way — genuine congestus becomes rare
    // enough that a 70-degree frame often contains none, and a frame with no
    // large cloud in it has no scale reference and reads as evenly scattered
    // blobs. u^2.2 keeps ~1 in 6 above half the maximum radius.
    const u = rng();
    const r = Math.min(rMax, rMin * Math.pow(ratio, Math.pow(u, 2.2)) * (0.70 + 0.62 * air));
    const sizeN = Math.min(1, Math.max(0, Math.log(r / rMin) / logRatio));

    area += Math.PI * r * r;
    clouds++;

    // Vertical development tracks width — a wide cumulus is a deep one — but
    // only loosely. The random term is nearly as large as the size term on
    // purpose: with a tight correlation, angular size and shape become the same
    // variable and the sky fills with one squat cap repeated at every scale.
    // Loosened, it carries flat rafts and narrow turrets at the same width.
    // The floor is not cosmetic: a cloud shallower than ~400 m is thinner than
    // three march steps, so the start jitter cannot average over it and it
    // renders as a chalky stippled slab rather than as a cloud.
    // The ceiling is the other half of it: with a purely additive random term a
    // 400 m puff can draw a 1 km tower and renders as a smoke stalk, which is
    // the one silhouette in the population that reads as a bug rather than as
    // a cloud. Convection does not build columns narrower than they are tall.
    const towV = Math.min(1, Math.min(0.30 + 0.85 * sizeN, Math.max(0.24,
      0.22 + 0.52 * Math.pow(sizeN, 0.65) + (rng() - 0.38) * 0.56)));
    const basV = rng();
    const chrV = 0.16 + 0.80 * rng();
    const amp = 0.80 + 0.20 * rng();

    // Per-cloud global aspect and bearing, applied to every lobe of THIS cloud.
    // Without it each cloud is statistically circular — a handful of randomly
    // placed lobes inside a circular envelope averages to a disc — and a sky of
    // discs reads as a rhythm however irregularly they are scattered. With it,
    // some clouds are compact and round and others are long ragged rafts.
    const gAsp = Math.pow(2.0, (rng() - 0.5) * 1.55);   // 0.59 .. 1.70
    const gRot = rng() * Math.PI;
    const gc = Math.cos(gRot), gs = Math.sin(gRot);

    // Big clouds are clusters, small ones are simple. A single lobe is a smooth
    // ellipse and reads as a marshmallow, so the floor is 2.
    const lobes = 2 + Math.round(sizeN * 4 + rng() * 1.6);
    for (let l = 0; l < lobes; l++) {
      const lr = r * (0.40 + 0.52 * rng());
      const off = (r - lr) * scatter * Math.sqrt(rng());
      const oa = rng() * Math.PI * 2;
      const ox = Math.cos(oa) * off * gAsp;
      const oy = Math.sin(oa) * off / gAsp;
      const lx = cx + gc * ox - gs * oy;
      const ly = cy + gs * ox + gc * oy;

      const asp = 0.55 + 0.95 * rng();
      const rot = rng() * Math.PI;
      const ca = Math.cos(rot), sa = Math.sin(rot);
      const ax = lr, ay = lr * asp;
      const invAx = 1 / (ax * ax), invAy = 1 / (ay * ay);
      const ext = Math.max(ax, ay) + 2;

      const iy0 = Math.floor(ly - ext), iy1 = Math.ceil(ly + ext);
      const ix0 = Math.floor(lx - ext), ix1 = Math.ceil(lx + ext);
      for (let y = iy0; y <= iy1; y++) {
        const dy = y + 0.5 - ly;
        const row = ((((y % N) + N) % N)) * N;
        for (let x = ix0; x <= ix1; x++) {
          const dx = x + 0.5 - lx;
          const px = ca * dx + sa * dy;
          const py = -sa * dx + ca * dy;
          const u2 = px * px * invAx + py * py * invAy;
          if (u2 >= 1) continue;
          // Small flat core, then a LINEAR decay to the rim.
          //
          // The obvious profile here is a flat top with a smooth-step shoulder,
          // and it is wrong. A smoothstep shoulder is steep through its middle,
          // so the band of partial density the threshold carves out is ~13% of
          // the cloud's radius — and the 3D erosion below can only MOVE that
          // level set, not invent one, so with a 13% band it moves the outline
          // by a few dozen metres and every cloud renders as a smooth river
          // pebble. That is exactly what the first pass of this rewrite did.
          // A linear ramp gives a constant gradient, so the erosion gets a band
          // ~30% of the radius wide to carve, and the outline comes out ragged.
          const s = amp * Math.min(1.0, (1.0 - Math.sqrt(u2)) * 1.30);
          const i = row + ((((x % N) + N) % N));
          if (s > cov[i]) { cov[i] = s; tow[i] = towV; bas[i] = basV; chr[i] = chrV; }
        }
      }
    }
  }

  // --- outline break -------------------------------------------------------
  // A multiplicative modulation at 1.2 / 0.6 / 0.3 km. This does NOT generate
  // shape — it only wobbles the level set — so it cannot re-impose a lattice of
  // blobs; what it does is stop the thresholded outline from being a smooth
  // ellipse at the band the 3D erosion volume cannot reach. That band matters
  // more than it looks: the erosion volume is a FIXED WORLD SIZE (465 m for its
  // coarsest lobe), so a 700 m puff gets barely one lobe across it and comes
  // out a smooth marshmallow no matter how hard the erosion is driven. This
  // modulation is the only thing that varies the small end of the population.
  {
    const c0 = Math.max(4, Math.round(tileKm / 1.20));
    const g0 = _lattice2(c0, rng), g1 = _lattice2(c0 * 2, rng), g2 = _lattice2(c0 * 4, rng);
    for (let y = 0; y < N; y++) {
      const v = (y + 0.5) / N, row = y * N;
      for (let x = 0; x < N; x++) {
        if (cov[row + x] <= 0.0) continue;
        const uu = (x + 0.5) / N;
        const f = 0.42 * _val2(g0, c0, uu, v)
                + 0.33 * _val2(g1, c0 * 2, uu, v)
                + 0.25 * _val2(g2, c0 * 4, uu, v);
        cov[row + x] *= 0.78 + 0.44 * f;
      }
    }
  }

  // --- soften the per-cloud channel seams ----------------------------------
  // Separable wrapping box blur, radius 3 texels (~150 m). The coverage channel
  // is deliberately NOT blurred: it carries the silhouette.
  {
    const R = 3, W = 2 * R + 1, invW = 1 / W;
    const tmp = new Float32Array(NN);
    const blur = (buf) => {
      for (let y = 0; y < N; y++) {
        const row = y * N;
        let acc = 0;
        for (let k = -R; k <= R; k++) acc += buf[row + (((k % N) + N) % N)];
        for (let x = 0; x < N; x++) {
          tmp[row + x] = acc * invW;
          acc += buf[row + ((x + R + 1) % N)] - buf[row + ((x - R + N) % N)];
        }
      }
      for (let x = 0; x < N; x++) {
        let acc = 0;
        for (let k = -R; k <= R; k++) acc += tmp[(((k % N) + N) % N) * N + x];
        for (let y = 0; y < N; y++) {
          buf[y * N + x] = acc * invW;
          acc += tmp[((y + R + 1) % N) * N + x] - tmp[((y - R + N) % N) * N + x];
        }
      }
    };
    blur(tow); blur(bas); blur(chr);
  }

  for (let i = 0; i < NN; i++) {
    const o = i * 4;
    data[o]     = Math.max(0, Math.min(255, Math.round(cov[i] * 255)));
    data[o + 1] = Math.max(0, Math.min(255, Math.round(tow[i] * 255)));
    data[o + 2] = Math.max(0, Math.min(255, Math.round(bas[i] * 255)));
    data[o + 3] = Math.max(0, Math.min(255, Math.round(chr[i] * 255)));
  }
  buildWeatherTexture.lastCount = clouds;

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;      // NO mipmaps: the march samples under
  tex.magFilter = THREE.LinearFilter;      // non-uniform flow, so implicit LOD
  tex.generateMipmaps = false;             // would be undefined. Distance LOD and
  tex.colorSpace = THREE.NoColorSpace;     // aerial haze handle minification.
  tex.needsUpdate = true;
  return tex;
}

/**
 * VOLUME — 64^3 RGBA8, seamless.
 *   R  3D value-noise fbm            (wispy: shreds the cloud BASE)
 *   G  inverted worley,  3 cells     (~650 m lobes)
 *   B  inverted worley,  6 cells     (~330 m)
 *   A  inverted worley, 12 cells     (~165 m)
 * One fetch therefore buys three octaves of worley; a second fetch at 3.13x with
 * a swizzled axis order buys three more, down to ~50 m — about 1/35 of a cell,
 * which is the detail band the review said was missing.
 */
function buildCloudVolume(size) {
  const rng = makeRng(0xc10bdd5);
  const N = size;
  const data = new Uint8Array(N * N * N * 4);

  const l4 = _lattice3(4, rng), l8 = _lattice3(8, rng), l16 = _lattice3(16, rng);
  const w3 = _worley3(N, 3, rng);
  const w6 = _worley3(N, 6, rng);
  const w12 = _worley3(N, 12, rng);

  for (let z = 0; z < N; z++) {
    const pz = (z + 0.5) / N;
    for (let y = 0; y < N; y++) {
      const py = (y + 0.5) / N;
      const row = (z * N + y) * N;
      for (let x = 0; x < N; x++) {
        const px = (x + 0.5) / N;
        const k = row + x;
        const v = (_val3(l4, 4, px, py, pz) * 0.53
                 + _val3(l8, 8, px, py, pz) * 0.30
                 + _val3(l16, 16, px, py, pz) * 0.17);
        const i = k * 4;
        data[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
        data[i + 1] = Math.round(w3[k] * 255);
        data[i + 2] = Math.round(w6[k] * 255);
        data[i + 3] = Math.round(w12[k] * 255);
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Format a JS number as a GLSL float literal (never exponent-only, always a dot). */
function glf(n) {
  let s = Number(n).toPrecision(9);
  if (s.indexOf('e') >= 0 || s.indexOf('E') >= 0) s = Number(n).toFixed(12);
  if (s.indexOf('.') < 0) s += '.0';
  return s;
}
const glv3 = (a) => `vec3(${glf(a[0])}, ${glf(a[1])}, ${glf(a[2])})`;

// ---------------------------------------------------------------------------
// Shared GLSL: constants, densities, phase functions, ray/sphere.
// ---------------------------------------------------------------------------
const ATMO_COMMON = /* glsl */`
  const float PI          = 3.14159265359;
  const float INV_4PI     = 0.0795774715;
  const float RG          = ${glf(ATMO.Rg)};
  const float RT          = ${glf(ATMO.Rt)};
  const float HR          = ${glf(ATMO.Hr)};
  const float HM          = ${glf(ATMO.Hm)};
  const vec3  BETA_R      = ${glv3(ATMO.betaR)};
  const float BETA_MS     = ${glf(ATMO.betaMs)};
  const float BETA_ME     = ${glf(ATMO.betaMe)};
  const vec3  BETA_O      = ${glv3(ATMO.betaO)};
  const float MIE_G       = ${glf(ATMO.mieG)};
  const float OZ_CENTER   = ${glf(ATMO.ozoneCenter)};
  const float OZ_WIDTH    = ${glf(ATMO.ozoneWidth)};

  void densities(float h, out float dR, out float dM, out float dO){
    float hh = max(h, 0.0);
    dR = exp(-hh / HR);
    dM = exp(-hh / HM);
    dO = max(0.0, 1.0 - abs(hh - OZ_CENTER) / OZ_WIDTH);
  }

  float rayleighPhase(float c){
    return 0.05968310365 * (1.0 + c * c);
  }

  float hgPhase(float c, float g){
    float g2 = g * g;
    float d  = max(1.0 + g2 - 2.0 * g * c, 1.0e-4);
    return (1.0 - g2) / (12.566370614 * d * sqrt(d));
  }

  // Far intersection with a sphere of radius R centred on the origin, for a ray
  // that starts inside it. Returns -1.0 if there is no hit.
  float raySphereFar(vec3 ro, vec3 rd, float R){
    float b = dot(ro, rd);
    float c = dot(ro, ro) - R * R;
    float d = b * b - c;
    if (d < 0.0) return -1.0;
    return -b + sqrt(d);
  }

  // Near intersection; negative result means the sphere is behind the ray.
  float raySphereNear(vec3 ro, vec3 rd, float R){
    float b = dot(ro, rd);
    float c = dot(ro, ro) - R * R;
    float d = b * b - c;
    if (d < 0.0) return -1.0;
    return -b - sqrt(d);
  }
`;

// ---------------------------------------------------------------------------
// LUT pass — the actual scattering integral.
// ---------------------------------------------------------------------------
const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const LUT_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;

${ATMO_COMMON}

  uniform vec3  uSunDir;         // normalised, points TOWARD the sun
  uniform float uSkyExposure;
  uniform float uMultiScatter;
  uniform float uAltitude;       // camera altitude, km
  uniform vec3  uGroundAlbedo;
  uniform float uGroundAmbient;

  // Optical depth from p toward the sun. Heights are clamped at 0, so a ray
  // that would pass through the planet saturates to zero transmittance on its
  // own — that gives a soft terminator for free instead of a hard sphere test.
  vec3 sunTransmittance(vec3 p, vec3 sunDir){
    float tTop = raySphereFar(p, sunDir, RT);
    if (tTop <= 0.0) return vec3(1.0);
    float ds = tTop / ${glf(ATMO.lightSteps)};
    float t  = ds * 0.5;
    float odR = 0.0, odM = 0.0, odO = 0.0;
    for (int i = 0; i < ${ATMO.lightSteps}; i++){
      float h = length(p + sunDir * t) - RG;
      float dR, dM, dO;
      densities(h, dR, dM, dO);
      odR += dR * ds;
      odM += dM * ds;
      odO += dO * ds;
      t += ds;
    }
    return exp(-(BETA_R * odR + vec3(BETA_ME * odM) + BETA_O * odO));
  }

  vec3 skyRadiance(vec3 ro, vec3 rd, vec3 sunDir){
    float tGround = raySphereNear(ro, rd, RG);
    bool  hitGround = tGround > 0.0;
    float tMax = hitGround ? tGround : raySphereFar(ro, rd, RT);
    if (tMax <= 0.0) return vec3(0.0);

    float cosT = dot(rd, sunDir);
    float pR = rayleighPhase(cosT);
    float pM = hgPhase(cosT, MIE_G);
    float sunUp = clamp(sunDir.y * 4.0 + 0.15, 0.0, 1.0);

    vec3 L = vec3(0.0);
    vec3 T = vec3(1.0);
    float ds = tMax / ${glf(ATMO.viewSteps)};
    float t  = ds * 0.5;

    for (int i = 0; i < ${ATMO.viewSteps}; i++){
      vec3 p = ro + rd * t;
      float h = length(p) - RG;
      float dR, dM, dO;
      densities(h, dR, dM, dO);

      vec3  scR = BETA_R * dR;
      float scM = BETA_MS * dM;
      vec3  ext = max(BETA_R * dR + vec3(BETA_ME * dM) + BETA_O * dO, vec3(1.0e-9));

      vec3 Tsun = sunTransmittance(p, sunDir);

      // Single scattering + a cheap isotropic multiple-scattering term. The
      // latter is what stops the horizon going unnaturally dark and puts the
      // blue back into the shadow side of the sky.
      vec3 ms = uMultiScatter * INV_4PI * (Tsun * 0.75 + vec3(0.25 * sunUp));
      vec3 S  = (scR * pR + vec3(scM * pM)) * Tsun + (scR + vec3(scM)) * ms;

      vec3 sampleT = exp(-ext * ds);
      L += T * ((S - S * sampleT) / ext);
      T *= sampleT;
      t += ds;
    }

    if (hitGround){
      vec3 p = ro + rd * tMax;
      vec3 n = normalize(p);
      vec3 Tsun = sunTransmittance(p, sunDir);
      float ndl = max(dot(n, sunDir), 0.0);
      L += T * uGroundAlbedo * (Tsun * ndl * 0.31830988 + vec3(uGroundAmbient));
    }

    return L;
  }

  // v is a signed square-root of sin(elevation): packs resolution around the
  // horizon where the gradient actually is.
  vec3 uvToDir(vec2 uv){
    float phi = (uv.x - 0.5) * 2.0 * PI;
    float x   = uv.y * 2.0 - 1.0;
    float mu  = sign(x) * x * x;
    float st  = sqrt(max(0.0, 1.0 - mu * mu));
    return vec3(cos(phi) * st, mu, sin(phi) * st);
  }

  void main(){
    vec3 ro = vec3(0.0, RG + uAltitude, 0.0);
    vec3 rd = uvToDir(vUv);
    vec3 c  = skyRadiance(ro, rd, normalize(uSunDir)) * uSkyExposure;
    gl_FragColor = vec4(max(c, 0.0), 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Dome / env pass — LUT lookup + sun disc + clouds.
// ---------------------------------------------------------------------------
const DOME_VERT = /* glsl */`
  varying vec3 vDir;
  void main(){
    // The dome is recentred on the camera every frame with an identity basis,
    // so object space *is* the world-space view direction.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG_BODY = /* glsl */`
  precision highp float;
  precision highp sampler2D;
  precision highp sampler3D;

  #ifdef SKY_EQUIRECT
    varying vec2 vUv;
  #else
    varying vec3 vDir;
  #endif

${ATMO_COMMON}

  uniform sampler2D uSkyLUT;
  uniform vec3  uSunDir;
  uniform vec3  uSunDiscColor;
  uniform float uSunAngularRadius;
  uniform float uAltitude;
  uniform float uTime;
  uniform float uStarStrength;

  uniform sampler2D uWeather;      // RGBA: coverage, tower, base, character
  uniform sampler3D uNoiseVol;     // RGBA: valueFbm, worley3, worley6, worley12

  uniform vec3  uCloudSunColor;
  uniform vec3  uCloudAmbient;
  uniform vec3  uHorizonColor;
  uniform float uCloudHeight;      // base of the cumulus slab, km
  uniform float uCloudThick;       // slab thickness, km
  uniform float uInvThick;         // 1 / uCloudThick
  uniform float uWeatherScale;     // 1/km — weather tile is 1/uWeatherScale km
  uniform float uVolScale;         // 1/km — volume tile is 1/uVolScale km
  uniform float uCloudVert;        // km the volume's Y axis spans over the slab
  uniform float uCloudTowerMin;    // slab fraction the shallowest cloud reaches
  uniform float uCloudTowerMax;    // slab fraction the deepest cloud reaches
  uniform float uCloudBaseLo;      // slab fraction of the lowest condensation level
  uniform float uCloudBaseSpan;    // slab fraction the condensation level ranges over
  uniform float uCloudThreshold;
  uniform float uCloudOpacity;     // final alpha multiplier
  uniform float uCloudDensity;     // extinction per km at full density
  uniform float uCloudAbsorb;      // self-shadow gain
  uniform float uCloudSilver;      // forward-scatter gain (silver lining)
  uniform float uCloudDetail;      // silhouette erosion strength
  uniform float uCloudShear;       // km the top of the deck leans downwind
  uniform float uCloudFade;        // elevation (sin) at which the deck fades in
  uniform float uCloudSpeed;
  uniform vec2  uCloudWind;
  uniform float uCirrusHeight;
  uniform float uCirrusScale;
  uniform float uCirrusThreshold;
  uniform float uCirrusOpacity;
  uniform float uCirrusSpeed;
  uniform vec2  uCirrusWind;
  uniform float uAerial;

  // ---------------------------------------------------------------- noise ---
  float hash21(vec2 p){
    vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Integer-domain hash for the march dither. The float *0.1031 hashes above
  // are fine for a noise lattice but they correlate badly when fed raw pixel
  // coordinates — neighbouring columns land on nearly the same value, the whole
  // march goes out of phase one column at a time, and the deck comes out
  // covered in vertical scratches. This one scrambles the integer pixel index
  // and has no such structure.
  float pixelHash(vec2 fc, float t){
    uvec3 v = uvec3(uvec2(fc), uint(t));
    uint n = v.x * 1973u + v.y * 9277u + v.z * 26699u;
    n = (n ^ (n >> 15u)) * 2246822519u;
    n = (n ^ (n >> 13u)) * 3266489917u;
    n ^= (n >> 16u);
    return float(n) * (1.0 / 4294967296.0);
  }

  float hash31(vec3 p){
    vec3 p3 = fract(p * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  float vnoise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // Same octave sequence at every depth, normalised so the truncated versions
  // used for the light march stay registered with the full-detail shape.
  float fbm2(vec2 p){
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 2; i++){
      s += a * vnoise(p);
      p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.02;
      a *= 0.5;
    }
    return s / 0.75;
  }

  float fbm3(vec2 p){
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++){
      s += a * vnoise(p);
      p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.02;
      a *= 0.5;
    }
    return s / 0.875;
  }

  // ------------------------------------------------------- cumulus shape ---
  // The deck is a SLAB, built from three separable pieces:
  //   cloudWeather()  2D, slow: WHERE cloud is, how BIG the cells are, how high
  //                   this cell's condensation level sits, how far it towers
  //   cloudBody()     the vertical envelope + the 3D worley silhouette erosion
  //   the march       lights it
  //
  // Splitting weather from body is not tidiness, it is the perf budget. The
  // weather field varies over kilometres, so the sun march can reuse the primary
  // sample's weather and only re-run the cheap part — which is what makes a
  // properly shadowed underside affordable at all.

  // Horizontal sample position, in KILOMETRES, for the slab at normalised
  // height h. Working in km (rather than in pre-scaled cell units) is what lets
  // the noise frequencies be stated as real cloud sizes.
  vec2 cloudUV(vec3 p, float h){
    vec2 q = p.xz + uCloudWind * (uTime * uCloudSpeed);
    // The top of a cumulus leans downwind of its base; uCloudShear is in km.
    return q + uCloudWind * (h * uCloudShear);
  }

  // One fetch, four per-cloud facts. Returns
  //   x  cf     coverage after thresholding — the horizontal silhouette
  //   y  baseH  THIS cloud's condensation level, slab fraction
  //   z  tower  how far up the slab THIS cloud builds AT THIS POINT
  //   w  chr    THIS cloud's character: density and erosion multiplier
  //
  // Everything that used to be derived from the coverage value itself — how
  // tall the cell is, where its base sits — is now a property of the cloud
  // baked into its own channel, and that is what breaks the "identical
  // lozenge" reading. When tower = f(coverage) and coverage is near-binary,
  // every cloud in the sky is exactly the same height and exactly the same
  // vertical profile, so they differ only in outline; the eye reads seven
  // copies. Read from the map, tower spans 4x across the population and is
  // only loosely tied to the outline.
  vec4 cloudWeather(vec2 q){
    vec4 W = texture2D(uWeather, q * uWeatherScale);
    float thr = uCloudThreshold;

    // The ramp is WIDE, and that is deliberate — it is the opposite of what the
    // fbm version needed and it took a render to see why. A splat falloff is
    // steep in space: the whole 1 -> 0 shoulder occupies the outer third of the
    // radius. Threshold it with the narrow ramp an fbm wanted and the partial-
    // density band is ~7% of the cloud's width, so the erosion below — which
    // can only move the level set, not invent one — has nowhere to bite, and
    // every cloud comes back a smooth river pebble with a clean elliptical
    // outline. A wide ramp hands the erosion a band a third of the cloud wide
    // to carve, and the erosion is what puts the hard, complex edge back.
    float cf = smoothstep(thr, thr + 0.26, W.r);

    // A second, wider ramp off the same fetch: 0 at the perimeter, 1 in the
    // core. This is the crown profile. Without it a per-cloud tower height
    // gives every cloud a flat top at its own altitude — a field of mesas —
    // because the height no longer falls off toward the flanks. Weighted only
    // 0.40, though: at 0.62 the height fell away so fast from the core that the
    // result was a smooth dome, and a cumulus flank is nearly vertical.
    float dome = smoothstep(thr, thr + 0.42, W.r);

    return vec4(cf,
                uCloudBaseLo + uCloudBaseSpan * W.b,
                mix(uCloudTowerMin, uCloudTowerMax, W.g) * (0.60 + 0.40 * dome),
                W.a);
  }

  // h is 0 at the base of the slab, 1 at the top. lod winds the fine erosion
  // octaves down with distance and step length. soft is the base ramp width,
  // set from the march's step length by the caller.
  float cloudBody(vec2 q, float h, vec4 cw, float lod, float soft){
    if (cw.x <= 0.002) return 0.0;

    // Height inside THIS cloud, measured from its own base.
    float hn = (h - cw.y) / max(1.0 - cw.y, 0.2);
    if (hn <= 0.0 || hn >= cw.z * 1.02) return 0.0;

    // A cumulus base is genuinely flat and genuinely hard. The ramp cannot be
    // sharper than a march step, though, or the start jitter resolves it per
    // pixel and the deck grows vertical drips off every cloud bottom — which it
    // did, visibly, at a fixed 0.085. So the width is handed down from the
    // march: steep rays take short steps and get a knife-edge base, grazing
    // rays take long ones and get a soft base they cannot alias.
    // ...but never wider than a fraction of THIS cloud's own depth. A 300 m
    // fair-weather puff handed the grazing-ray base width (620 m of slab) never
    // reaches full density at all and renders as a smooth vertical ramp — a
    // marshmallow. Scaling the ramp to the cloud keeps small clouds sharp.
    float base = smoothstep(0.0, min(soft, cw.z * 0.42), hn);
    // Full density up to 55% of the tower, then a rounded shoulder. Ramping
    // from 42% gave a cone: the cloud narrowed all the way from base to apex
    // and the deck read as a field of flames seen from below rather than of
    // masses with flanks and a crown.
    // The shoulder is 60% of the cloud's own depth. A short shoulder gives a
    // flat top, and a flat-topped shallow cloud reads as a bread loaf; the
    // crown of a cumulus is the roundest part of it.
    float top  = 1.0 - smoothstep(cw.z * 0.45, cw.z * 1.06, hn);
    float d = cw.x * base * top;
    if (d <= 0.002) return 0.0;

    // ---- silhouette erosion -------------------------------------------
    // Sampled in a space where Y is a REAL axis scaled to real kilometres
    // (uCloudVert = slab thickness x anisotropy), so the pattern turns over
    // isotropically as you climb. The old deck squashed this axis by ~1.6x,
    // which is literally how you manufacture horizontal striations.
    vec3 vp = vec3(q.x, h * uCloudVert, q.y) * uVolScale;
    vec4 n0 = texture(uNoiseVol, vp);

    // Octave budget is set by the STEP LENGTH, not by taste. A ray steps
    // ~110 m through the deck; carving 40 m notches at that step size is not
    // detail, it is variance, and variance in a raymarch is coherent ALONG the
    // ray — which is why an over-detailed deck comes out covered in radial
    // scratches rather than in grain. So the finest octave here is the 12-cell
    // worley at ~115 m, and its weight is wound down with distance.
    // At lod 0 the fine octaves are DROPPED, not merely down-weighted. The
    // 12-cell worley is a 115 m feature; at 20 km that is 0.33 arc-minutes,
    // well under a pixel, so keeping it at any weight is not detail, it is a
    // per-pixel coin flip on a hard density threshold — which is the chalky
    // speckle that survives on the distant deck.
    float coarse = n0.g * 0.82 + n0.b * 0.18;
    float fine   = n0.g * 0.38 + n0.b * 0.34 + n0.a * 0.28;
    // Averaging independent worley octaves collapses their contrast: three
    // fields of sd ~0.20 average to sd ~0.12, and a 0.12 swing in the erosion
    // field moves the silhouette by a few dozen metres, which is invisible.
    // Re-expanding to the full range is the difference between a carved
    // cauliflower edge and a faint fuzz on an ellipse. The two blends need
    // different gains because they have different variance to start with.
    coarse = clamp((coarse - 0.34) * 1.60, 0.0, 1.0);
    fine   = clamp((fine   - 0.30) * 2.25, 0.0, 1.0);
    float billow = mix(coarse, fine, lod);
    float wisp = clamp((n0.r - 0.33) * 2.40, 0.0, 1.0);
    // Wispy shreds at the base, packed cauliflower at the crown — the classic
    // cumulus erosion split, and the reason a crown reads as lobes rather than
    // as a smooth lens.
    float e = mix(mix(0.5, wisp, lod), billow, smoothstep(0.02, 0.55, hn));

    // Erode the SILHOUETTE, not the interior. remap(d, k*gap, 1, 0, 1) moves
    // the zero crossing — the boundary itself is carved — while leaving d=1
    // exactly 1, so cores stay solid however hard the edges are chewed.
    // Normalising by (1-k) instead, as the previous pass did, scaled the whole
    // field and turned an eroded deck into a translucent smear.
    // The strength is PER CLOUD (cw.w): some are hard-edged cauliflower, some
    // are half dissolved into rag. Two clouds of the same size and height still
    // do not read as the same object if one of them is falling apart.
    // The distance term used to wind the erosion STRENGTH down as well as its
    // frequency, and that is what left the mid-field reading as a scatter of
    // rounded boxes: the coarse taper toward the crown is produced by the
    // erosion eating the low-density shoulder, so weakening it at 8 km leaves
    // a prism with a domed lid. Now that lod 0 selects the smooth coarse
    // octave, full strength at distance is safe and is what gives a cloud 10 km
    // away the same carved profile as one overhead.
    float k = uCloudDetail * (1.22 - 0.46 * cw.w)
                           * mix(0.88, 1.10, smoothstep(0.05, 0.85, hn))
                           * mix(0.92, 1.0, clamp(lod, 0.0, 1.0));
    float gap = min(k * (1.0 - e), 0.96);
    return clamp((d - gap) / (1.0 - gap), 0.0, 1.0);
  }

  // ------------------------------------------------------------- lut fetch --
  vec2 dirToLutUV(vec3 rd){
    vec2 hxz = rd.xz;
    if (dot(hxz, hxz) < 1.0e-12) hxz = vec2(1.0, 0.0);
    float phi = atan(hxz.y, hxz.x);
    float mu  = clamp(rd.y, -1.0, 1.0);
    float u   = phi * 0.15915494 + 0.5;
    float v   = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
    return vec2(u, v);
  }

  // ------------------------------------------------------------- sun disc ---
  vec3 sunDisc(vec3 rd){
    float cosT = clamp(dot(rd, uSunDir), -1.0, 1.0);
    // Mie aureole: the LUT is too coarse to hold the tight forward lobe, so it
    // is re-added analytically here.
    float f = max(cosT, 0.0);
    vec3 glow = uSunDiscColor * (pow(f, 900.0) * 0.30 + pow(f, 42.0) * 0.010);

    float ang = acos(cosT);
    float r   = ang / max(uSunAngularRadius, 1.0e-5);
    if (r > 1.05) return glow;

    // Limb darkening: I(mu) = mu^a, a per channel — blue falls off fastest so
    // the rim of the disc reads warmer than the centre.
    float mu = sqrt(max(0.0, 1.0 - r * r));
    vec3 limb = pow(vec3(max(mu, 0.0)), vec3(0.397, 0.503, 0.652));
    float edge = 1.0 - smoothstep(0.982, 1.02, r);
    return uSunDiscColor * limb * edge + glow;
  }

  vec3 starField(vec3 rd){
    if (uStarStrength <= 0.001 || rd.y < 0.0) return vec3(0.0);
    vec3 q  = rd * 340.0;
    vec3 ci = floor(q);
    vec3 cf = fract(q) - 0.5;
    float h = hash31(ci);
    float bright = smoothstep(0.9955, 1.0, h);
    float s = bright * (1.0 - smoothstep(0.0, 0.34, length(cf)));
    float tw = 0.72 + 0.28 * sin(uTime * 2.7 + h * 137.0);
    return vec3(0.86, 0.90, 1.0) * (s * tw * uStarStrength);
  }

  // --------------------------------------------------------------- clouds ---
  // 36 steps, unchanged, and it is a hard budget: the march measured at parity
  // with the previous build only because the step COUNT did not move. sigma*dt
  // at one step decides whether a pixel can go from clear to opaque in a single
  // sample, and if it can, the start jitter turns that coin flip into speckle.
  // Everything spent on that problem here is spent on the jitter and on the
  // extinction instead of on more samples.
  const int CLOUD_STEPS = 36;
  const int CLOUD_LIGHT_STEPS = 3;

  // Optical depth from p toward the sun. The steps grow geometrically: the lit
  // flank of a cumulus is only a couple of hundred metres deep, so the first
  // sample has to be short or every crown comes out as dark as its core, while
  // the last one still has to reach far enough to shadow a whole billow.
  //
  // The weather terms are passed in rather than refetched: coverage varies over
  // kilometres and this march covers a few hundred metres, so re-running it
  // would buy nothing and cost two texture fetches per step.
  float cloudLightOD(vec3 p, float hn, float dens, vec4 cw, float soft, float jit){
    float ds = uCloudThick * 0.055;
    // Jittered, and less aggressively geometric than before. This march feeds
    // the silver lining through exp(-od), and the forward lobe multiplies it by
    // up to 45 — so any stepping in od comes back as bright ridges running
    // along the sun direction, which in an into-sun shot is a curtain of
    // vertical streaks hanging off every cloud.
    float t = ds * jit * 0.5;
    float od = 0.0;
    for (int i = 0; i < CLOUD_LIGHT_STEPS; i++){
      float sdt = ds * (1.0 + float(i) * 1.3);
      t += sdt * 0.5;
      vec3 sp = p + uSunDir * t;
      float hh = (length(sp) - RG - uCloudHeight) * uInvThick;
      t += sdt * 0.5;
      if (hh > 1.0 || hh < 0.0) continue;
      od += cloudBody(cloudUV(sp, hh), hh, cw, 0.0, soft) * sdt;
    }
    // Plus the column of cloud still above this sample. A few short steps only
    // reach ~0.8 km, so the rest is added analytically — and it is this term,
    // which vanishes at the crown and peaks at the base, that makes an
    // underside read as a distinctly darker, flatter grey than the top.
    od += (1.0 - hn) * (1.0 - hn) * dens * uCloudThick * 1.65;
    return od * uCloudDensity;
  }

  // Energy-conserving multiple-scattering approximation (Wrenninge et al.).
  // Each successive octave sees a lower extinction and a flatter phase, which
  // is the only cheap way to get a 30-optical-depth cumulus to read WHITE on
  // its sunlit crown while its core and underside stay properly dark. Single
  // scattering alone gives exp(-30) — i.e. black — everywhere but the rim.
  float cloudScatter(float od, float ph){
    float sum = 0.0;
    float a = 1.0, bsc = 1.0, pn = ph;
    for (int n = 0; n < 4; n++){
      sum += a * exp(-bsc * od) * pn;
      a *= 0.56;
      bsc *= 0.22;
      pn = mix(pn, 1.0, 0.5);
    }
    return sum;
  }

  vec3 applyClouds(vec3 rd, vec3 sky){
    // The deck is faded out at grazing elevations, where a slab is compressed
    // to a horizontal smear no shaping survives. The cutoff is now 1.1 degrees
    // rather than 2: the deck is marched far enough down a grazing ray to
    // actually reach the horizon, so it can be allowed to recede into the haze
    // instead of being cut off in mid-frame — which was half of why it read as
    // a band hanging across the top rather than as a field.
    float hf = smoothstep(uCloudFade, uCloudFade + 0.055, rd.y);
    if (hf <= 0.001) return sky;

    vec3 ro = vec3(0.0, RG + uAltitude, 0.0);
    vec3 col = sky;
    float cosT = clamp(dot(rd, uSunDir), -1.0, 1.0);

    // --- high cirrus (farther shell, so it parallaxes behind the cumulus) ---
    // Fibrous, and the fibres run ALONG the cirrus wind rather than along the
    // world X axis, so the two decks never look like one sheet.
    if (uCirrusOpacity > 0.001){
      float t2 = raySphereFar(ro, rd, RG + uCirrusHeight);
      // Cirrus sits four times higher than the cumulus, so it survives to a
      // lower elevation before it compresses; it gets its own, lower fade.
      // Cirrus gets a HIGHER floor than the cumulus, not a lower one. A flat
      // shell at 7.4 km seen at 5 degrees is 85 km away and foreshortened ~12:1,
      // and its fibres smear into radial scratches that read as dirt on the
      // lens. Above ~7 degrees it is a cloud again.
      float hf2 = smoothstep(0.105, 0.175, rd.y);
      if (t2 > 0.0 && hf2 > 0.001){
        vec3 p2  = ro + rd * t2;
        vec2 uv2 = p2.xz * uCirrusScale + uCirrusWind * (uTime * uCirrusSpeed);
        vec2 wd  = normalize(uCirrusWind);
        vec2 uvw = vec2(dot(uv2, wd), dot(uv2, vec2(-wd.y, wd.x)));
        float f2 = fbm3(vec2(uvw.x * 0.55, uvw.y * 1.30));
        // Break the combs into separate banks instead of one endless streak.
        float band = fbm2(uvw * 0.21 + vec2(11.3, -4.7));
        f2 = mix(f2, f2 * (0.30 + 1.00 * band), 0.85);
        float d2 = smoothstep(uCirrusThreshold, uCirrusThreshold + 0.30, f2);
        float a2 = d2 * uCirrusOpacity * hf2;
        if (a2 > 0.001){
          // Ice crystals scatter hard forward: cirrus near the sun goes white hot.
          float g2 = hgPhase(cosT, 0.62) * 12.566370614;
          vec3 c2 = uCloudSunColor * (0.46 + 0.22 * uCloudSilver * g2) + uCloudAmbient * 0.55;
          float aer2 = 1.0 - exp(-t2 * uAerial);
          c2 = mix(c2, uHorizonColor, clamp(aer2 * 0.8, 0.0, 1.0));
          col = mix(col, c2, clamp(a2, 0.0, 1.0));
        }
      }
    }

    // --- main cumulus deck: a marched slab -------------------------------
    // A real early-out, not a cosmetic one: at zero opacity the march is
    // skipped entirely rather than run and then multiplied by zero. That is
    // what makes a controlled A/B of the march's cost possible from JS.
    if (uCloudOpacity <= 0.001) return col;

    float tB = raySphereFar(ro, rd, RG + uCloudHeight);
    float tT = raySphereFar(ro, rd, RG + uCloudHeight + uCloudThick);
    if (tT <= 0.0) return col;
    tB = max(tB, 0.0);

    // The step GROWS down the ray. This is not an optimisation, it is the fix
    // for the hard flat tops. A grazing ray's chord through the deck is tens of
    // kilometres, and the previous pass handled that by truncating the chord at
    // a fixed length — but tB and the chord depend only on elevation, so the
    // truncation cut every cloud off along a line of constant elevation. That
    // is a perfectly horizontal edge across the sky, and it sat exactly where a
    // cumulus crown should have been. Growing steps cover the whole chord
    // instead: the near face, where all the silhouette lives, gets 50-150 m,
    // and the tail runs coarse out in the haze where nothing is resolvable.
    // GROW is 3x what it was. The old 0.042 grew the last step to only 2.5x the
    // first, so 36 steps covered 2.5 km of chord at the 0.17 km cap — and a ray
    // at 8 degrees has a 14 km chord through the deck. Everything past 2.5 km
    // was simply not drawn, which is why the deck stopped dead partway down the
    // frame and hung as a band across the top instead of receding to the
    // horizon. At 0.12 the same 36 steps reach 22 km, which is past the range
    // aerial perspective has already dissolved the deck at.
    const float GROW = 0.12;
    const float GSUM = float(CLOUD_STEPS)
                     + GROW * 0.5 * float(CLOUD_STEPS) * float(CLOUD_STEPS - 1);
    float span = tT - tB;
    if (span <= 0.0) return col;
    // sigma*dt at one step decides whether a single sample can take a pixel
    // from clear to opaque, and if it can, the jitter turns that coin flip into
    // speckle. 115 m against the 9/km extinction is sigma*dt ~ 1.0, which is
    // the point where the stratified jitter below can still hide it. The floor
    // stops a near-vertical ray (2 km chord) from spending 36 samples on 60 m
    // steps it cannot see the benefit of. The floor is a budget knob rather
    // than a quality one: a near-vertical ray only has 1.9 km of chord, so it
    // breaks out on t > tT long before step 36 whatever the floor is, and at
    // 50 m it still gets ~20 samples through the slab at 95 m each. Measured,
    // moving it 30 -> 50 m is 1.4 ms off the zenith pose and invisible.
    float dt0 = clamp(span / GSUM, 0.050, 0.115);

    // Two-lobe HG. The wide lobe is the body of the cloud; the tight forward
    // lobe is the silver lining and is gated on a THIN path to the sun below,
    // so it only fires along edges where the sun shines nearly through.
    float phWide = hgPhase(cosT, 0.10) * 12.566370614;
    // Capped. Uncapped this peaks near 95, and multiplied through the silver
    // gain it turns every wobble in the sun march into a blown highlight.
    float phFwd  = min(hgPhase(cosT, 0.82) * 12.566370614, 45.0);

    // Per-pixel start jitter, STRATIFIED over a 2x2 screen block.
    //
    // The previous pass used pure white noise and honestly flagged the residual
    // stipple as unresolved. Pure white noise is the worst available choice
    // here: each pixel draws its offset independently from the whole step, so
    // four adjacent pixels can all land in the same quarter of it and the local
    // mean carries the full per-sample variance. The alternative it rejected —
    // interleaved gradient noise — is fully deterministic and does read as a
    // halftone screen.
    //
    // SCRAMBLED STRATIFICATION is neither of those. A 4x4 Bayer index picks
    // WHICH SIXTEENTH of the step a pixel samples, so the sixteen pixels in
    // every block are guaranteed to cover the step evenly and the variance of
    // the local mean — which is what SMAA, CAS and the eye all actually see —
    // drops by the stratum count. Then two things break the pattern:
    //
    //   1. the index is XORed with a per-BLOCK hash. XOR by a constant is a
    //      permutation of 0..15, so every block still covers all sixteen
    //      strata exactly once, but WHICH pixel gets which stratum is
    //      different in every block. Plain 4x4 Bayer without this reads as a
    //      woven mesh across the whole deck — measurably lower variance than
    //      white noise, visibly worse, exactly as the previous pass warned.
    //   2. the white hash places the sample randomly INSIDE its sixteenth.
    //
    // Both hashes take the frame as a third input, so a static camera dissolves
    // the residue instead of freezing it into the image.
    ivec2 ip = ivec2(gl_FragCoord.xy);
    float fr = floor(uTime * 30.0);
    int b2a = (((ip.x >> 1) & 1) * 2) ^ (((ip.y >> 1) & 1) * 3);
    int b2b = ((ip.x & 1) * 2) ^ ((ip.y & 1) * 3);
    int scr = int(pixelHash(floor(gl_FragCoord.xy * 0.25), fr) * 15.999);
    int strat = (b2a * 4 + b2b) ^ scr;
    float jit = (float(strat) + pixelHash(gl_FragCoord.xy, fr)) * 0.0625;

    // Base ramp width, handed to cloudBody. A cumulus base wants to be a knife
    // edge, but a knife edge sampled at 400 m steps aliases into the vertical
    // drips hanging off every cloud bottom in the previous render. Tie it to
    // the step: ~1.4 steps of slab, floored at a width that still reads flat.
    float soft = clamp(dt0 * uInvThick * 1.4, 0.055, 0.34);

    float t = tB;
    float trans = 1.0;
    vec3  scat = vec3(0.0);
    float lastOD = 0.0;
    float tHit = -1.0;

    // Detail budget. Two independent limits, and the tighter one wins:
    //   - STEP LENGTH. Detail finer than the step is not detail, it is variance,
    //     and variance in a raymarch is coherent along the ray, so it shows up
    //     as radial scratches rather than as grain.
    //   - DISTANCE. Past ~15 km a cumulus billow is a couple of degrees wide and
    //     the fine octaves fall under a pixel.
    // Both thresholds are re-scaled for the new step schedule; lod is a mix
    // weight on channels of a fetch that happens either way, so widening it
    // costs a lerp and nothing else.
    float lod = min(clamp((0.135 - dt0) / 0.075, 0.0, 1.0),
                    clamp(1.0 - (tB - 5.0) / 10.0, 0.0, 1.0));

    for (int i = 0; i < CLOUD_STEPS; i++){
      if (t > tT) break;
      float dt = dt0 * (1.0 + GROW * float(i));
      // The jitter is applied PER STEP and scaled BY that step, not once at the
      // ray start. With a growing step a single start offset spans dt0 while
      // the step at i=20 is 2.1x dt0, so half of every iso-height ring survives
      // — and a surviving ring on a slab is the corduroy the review named.
      // Now essentially the FULL step. The previous pass held it to 0.85
      // because a full-width white jitter hands back all of the debanding as
      // per-pixel variance; stratified, the variance is already down 4x in the
      // local mean, so the last 15% is free and the residual ring goes with it.
      vec3 p = ro + rd * (t + dt * (0.5 + 0.98 * (jit - 0.5)));
      float h = clamp((length(p) - RG - uCloudHeight) * uInvThick, 0.0, 1.0);
      vec2 q = cloudUV(p, h);
      vec4 cw = cloudWeather(q);
      float dens = cloudBody(q, h, cw, lod, soft);
      // Skip the thin fringe the erosion leaves around every cloud. Below this
      // the sample contributes a percent of alpha and a full step of variance,
      // which is the scratchy residue that survives on cloud edges.
      if (dens > 0.018){
        if (tHit < 0.0) tHit = t;
        float hn = clamp((h - cw.y) / max(1.0 - cw.y, 0.2), 0.0, 1.0);
        // Once the ray is five sixths absorbed, the remaining samples move the
        // final colour by a couple of percent, so they reuse the last sun march
        // instead of paying for their own. Deep inside a cumulus that is most
        // of the samples, and the sun march is the single most expensive thing
        // in the shader — this threshold is the cheapest millisecond in it.
        // Per-cloud density character. Some cells are solid and shadow hard,
        // some are half-condensed rag the sun goes straight through — and that
        // difference in VALUE, not just in outline, is a large part of why a
        // real cumulus field never reads as repeated copies of one object.
        float dmul = 0.62 + 1.05 * cw.w;

        float od = lastOD;
        if (trans > 0.17){
          od = cloudLightOD(p, hn, dens, cw, soft, jit) * uCloudAbsorb * dmul;
          lastOD = od;
        }

        float ms = cloudScatter(od, phWide);
        // Silver lining: a hard forward lobe that only survives a THIN path to
        // the sun, so it fires along the rim of a billow and nowhere else.
        float silver = uCloudSilver * phFwd * exp(-od * 0.55) * 0.030;

        // Sky ambient reaches a crown almost unattenuated and a base hardly at
        // all — everything above a base sample is cloud. This gradient, plus
        // the analytic above-column term inside cloudLightOD, is what makes an
        // underside read as flat slate against a white crown instead of the two
        // being the same grey.
        float amb = mix(0.04, 1.02, smoothstep(0.0, 0.72, hn));
        vec3 S = uCloudSunColor * (ms + silver) + uCloudAmbient * amb;

        float sigma = dens * uCloudDensity * dmul;
        float dT = exp(-sigma * dt);
        scat += trans * (1.0 - dT) * S;
        trans *= dT;
        if (trans < 0.030) break;
      }
      t += dt;
    }

    float alpha = (1.0 - trans) * uCloudOpacity * hf;
    if (alpha <= 0.002) return col;

    vec3 c1 = scat / max(1.0 - trans, 1.0e-3);
    // Aerial perspective from the depth the ray actually FIRST hit cloud, not
    // from the slab entry plus half a chord. On a grazing ray the chord is
    // 40 km and the old estimate put every distant cloud 20 km further into the
    // haze than it is, which greyed the far field out of existence — the deck
    // had to stop somewhere, and where it stopped was a band across the sky.
    float aer1 = 1.0 - exp(-max(tHit, tB) * uAerial);
    c1 = mix(c1, uHorizonColor, clamp(aer1, 0.0, 1.0));

    return mix(col, c1, clamp(alpha, 0.0, 1.0));
  }

  void main(){
    #ifdef SKY_EQUIRECT
      float phi   = (vUv.x - 0.5) * 2.0 * PI;
      float theta = (vUv.y - 0.5) * PI;
      float ct    = cos(theta);
      vec3 rd = vec3(cos(phi) * ct, sin(theta), sin(phi) * ct);
    #else
      vec3 rd = normalize(vDir);
    #endif

    vec3 col = texture2D(uSkyLUT, dirToLutUV(rd)).rgb;

    #ifndef SKY_EQUIRECT
      col += sunDisc(rd);
      col += starField(rd);
    #endif

    col = applyClouds(rd, col);

    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`;

// ---------------------------------------------------------------------------
// CPU mirror of the scattering integral.
// Same constants (they come from the same object that generates the GLSL), so
// sunColor / ambientColor / fogColor can never drift from the rendered sky.
// ---------------------------------------------------------------------------
const _od = [0, 0, 0];
const _T = [0, 0, 0];
const _rad = [0, 0, 0];
const _acc = [0, 0, 0];
const _sunT = [0, 0, 0];
const _skyMean = [0, 0, 0];
const _bounce = [0, 0, 0];

/*
 * Quadrature for the ambient fill.
 *
 * The old code sampled the zenith with a 0.36 weight and four points at 31
 * degrees with 0.16 each. The zenith is the single bluest direction in the
 * sky — its Rayleigh path is the shortest, so it is the least whitened — and
 * weighting it that heavily is why the derived fill came out at B:R = 3.5 and
 * every shadow in the game read as pool water.
 *
 * What actually lands on a shadowed surface is the COSINE-WEIGHTED integral
 * over the whole hemisphere: rings of constant elevation phi carry weight
 * sin(phi)cos(phi) dphi dpsi. Midpoint rule in elevation, 4 azimuths per ring
 * offset 45 degrees from the sun bearing so no sample sits inside the Mie
 * aureole (that energy belongs to the DirectionalLight, not to the fill).
 * Weights sum to 1, so the result is E/pi — the mean radiance a lambertian
 * up-facing surface integrates.
 */
const AMBIENT_RINGS = 4;
const AMBIENT_AZIM = 4;
const AMBIENT_ELEV = new Float64Array(AMBIENT_RINGS);
const AMBIENT_W = new Float64Array(AMBIENT_RINGS);
{
  let wsum = 0;
  for (let k = 0; k < AMBIENT_RINGS; k++) {
    const phi = ((k + 0.5) / AMBIENT_RINGS) * (Math.PI * 0.5);
    AMBIENT_ELEV[k] = phi;
    AMBIENT_W[k] = Math.sin(phi) * Math.cos(phi);
    wsum += AMBIENT_W[k];
  }
  for (let k = 0; k < AMBIENT_RINGS; k++) AMBIENT_W[k] /= wsum * AMBIENT_AZIM;
}

function _rayFar(ox, oy, oz, dx, dy, dz, R) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - R * R;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b + Math.sqrt(d);
}

function _rayNear(ox, oy, oz, dx, dy, dz, R) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - R * R;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b - Math.sqrt(d);
}

/** Transmittance from p toward `s` (unit, toward the sun) -> out[3]. */
function _transmittance(px, py, pz, sx, sy, sz, out) {
  const tTop = _rayFar(px, py, pz, sx, sy, sz, ATMO.Rt);
  if (tTop <= 0) { out[0] = out[1] = out[2] = 1; return out; }
  const ds = tTop / CPU_LIGHT_STEPS;
  let t = ds * 0.5, odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < CPU_LIGHT_STEPS; i++) {
    const x = px + sx * t, y = py + sy * t, z = pz + sz * t;
    let h = Math.sqrt(x * x + y * y + z * z) - ATMO.Rg;
    if (h < 0) h = 0;
    odR += Math.exp(-h / ATMO.Hr) * ds;
    odM += Math.exp(-h / ATMO.Hm) * ds;
    const o = 1 - Math.abs(h - ATMO.ozoneCenter) / ATMO.ozoneWidth;
    if (o > 0) odO += o * ds;
    t += ds;
  }
  for (let c = 0; c < 3; c++) {
    _od[c] = ATMO.betaR[c] * odR + ATMO.betaMe * odM + ATMO.betaO[c] * odO;
    out[c] = Math.exp(-_od[c]);
  }
  return out;
}

// ---------------------------------------------------------------------------
export class Sky {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   */
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    /** Every knob worth touching. Call applyParams() after mutating. */
    this.params = {
      // --- atmosphere ---
      skyExposure: 55.0,          // scales LUT radiance into the game's linear range
      multiScatter: 0.45,         // isotropic multiple-scattering boost
      altitude: 0.5,              // observer altitude, km (affects horizon haze)
      groundAlbedo: [0.260, 0.222, 0.180], // warm concrete / dust compound.
                                  // This is not decoration: it is the spectrum
                                  // of every bounce that fills a shadow.
      groundAmbient: 0.06,
      groundBounce: 0.55,         // fraction of a DOWN-facing hemisphere that is
                                  // lit ground rather than the dark underside of
                                  // whatever the surface is attached to

      // --- sun ---
      sunAngularRadiusDeg: 0.42,  // real sun is 0.266; slightly fattened reads better
      sunDiscIntensity: 42.0,     // HDR radiance of the disc — must exceed 1 to bloom
      // A clear-sky single-scattering model with an isotropic multiple-scatter
      // term puts more energy in the sky dome than a real atmosphere does, so
      // the beam has to be raised against it or every shadow drowns in blue.
      // 19 is where the measured key:fill lands in the photographic band.
      sunIntensity: 19.0,         // DirectionalLight intensity at full transmittance
      // The fill is split in two: envIntensity weights the (blue) sky hemisphere
      // carried by the IBL, hemiIntensity weights the (warm) ground bounce
      // derived below. 1.0 on hemiIntensity means "a full hemisphere of exactly
      // the bounce radiance the albedo and the sun imply"; env is under 1
      // because in a walled compound most of the sky is occluded.
      //
      // These three are NOT taste. Measured off the graded render target with
      // the sun toggled off (so the same pixel is compared lit vs in its own
      // cast shadow), at timeOfDay 0.895:
      //     env 0.55 / hemi 0.22 / sun 19  ->  5.46:1 (2.45 stops),
      //                                        shadow B:R 1.17, sunlit B:R 0.85
      // which is inside the 5-8:1 / 1.15-1.25 / 0.80-0.90 target on all three.
      // Moving env and hemi together slides the ratio; moving them against each
      // other slides the shadow's blue:red. env carries most of the fill because
      // an IBL varies with the surface normal, so it gives a character's shaded
      // side actual form — a hemisphere light alone flattens it to a silhouette.
      hemiIntensity: 0.22,
      envIntensity: 0.55,         // scene.environmentIntensity

      // Fog colours are sampled from the sky; these bias them for mood.
      fogColorScale: 0.80,
      fogColorGroundScale: 0.32,

      // --- time of day curve ---
      sunElevationMin: 1.5,       // degrees at t=0 and t=1 (go negative for true twilight)
      sunElevationMax: 68.0,      // degrees at t=0.5
      sunAzimuthStart: 75.0,      // degrees, measured +X toward +Z
      sunAzimuthEnd: 285.0,

      // --- clouds ---
      cloudCoverage: 0.52,        // 0 clear .. 1 overcast. Against a splatted
                                  // weather map this cuts each cloud's own
                                  // falloff, so it trades gap for mass rather
                                  // than adding or removing whole clouds.
      // Nominal cloud size unit, km. Individual clouds are drawn from
      // cloudRadiusMin..Max BELOW, both expressed in these units, so this knob
      // scales the whole population without flattening its spread.
      cloudCellKm: 1.65,
      cloudHeight: 2.05,          // base of the cumulus slab, km
      // 1.85 km of slab against a population whose towers span 0.14-1.0 of it
      // gives cloud depths from 260 m to 1.85 km — a 7x spread. The old 2.70 km
      // slab was deeper but every cloud filled the same 80% of it, so the extra
      // depth bought nothing but the slanted-cylinder silhouette the review saw.
      cloudThickness: 1.85,
      cloudOpacity: 1.0,          // final alpha multiplier
      cloudDensity: 9.0,          // extinction per km at full density. Down from
                                  // 13: sigma*dt at one march step is what turns
                                  // the start jitter into speckle, and the step
                                  // cannot be shortened further inside budget.
      cloudAbsorb: 2.30,          // self-shadow gain (underside vs top)
      cloudDetail: 0.86,          // silhouette erosion strength (x per-cloud)
      // km the top leans downwind of the base. 0.55 over a 2.70 km slab leaned
      // every cloud 11 degrees THE SAME WAY, which is what extruded the whole
      // population into identically-slanted cylinders seen end-on. 0.12 is a
      // real cumulus lean and is not a shape the eye can index on.
      cloudShear: 0.12,
      // Vertical anisotropy of the 3D erosion noise. 1.0 is isotropic — a
      // billow as tall as it is wide. Below 1 stretches the lobes vertically,
      // which is the correct direction for a convective cloud; ABOVE 1 squashes
      // them into horizontal laminations, and that (at an effective 1.6) is
      // half of where the ribbed-plastic corduroy came from.
      cloudBillow: 0.88,
      // Slab fraction the shallowest and the deepest cloud in the population
      // reach. These are now the ends of a per-cloud distribution baked into the
      // weather map, NOT a function of local coverage — which is the single
      // change that stops every cloud being the same height.
      cloudTowerMin: 0.16,
      cloudTowerMax: 1.00,
      // Condensation level, as a slab fraction: each cloud gets its own, flat
      // across its own footprint and staggered against its neighbours.
      cloudBaseLo: 0.0,
      cloudBaseSpan: 0.26,
      cloudFade: 0.020,           // sin(elevation) below which the deck fades
                                  // out. Lower than before: the deck is now
                                  // marched far enough to actually reach the
                                  // horizon, and cutting it at 2 degrees was
                                  // half of why it read as a band up top
      cloudSilver: 2.8,           // forward-scatter gain (silver lining)
      cloudSpeed: 0.018,          // km/s of drift (18 m/s of wind)
      cloudWind: [0.92, 0.39],
      cloudSunBoost: 1.05,        // 1.0 == a white lambertian cloud
      cloudAmbientBoost: 0.55,
      // Weather-map tile, in cloudCellKm units. 16 x 1.65 km = 26 km, which is
      // past the range aerial perspective has already washed everything out at.
      weatherCells: 16.0,
      // --- cloud population, read at construction to bake the weather map ---
      // Radii in cloudCellKm units. 0.24..2.15 is a 9x span, i.e. cloud widths
      // from 0.8 km to 7 km before the coverage threshold cuts them back; the
      // draw is skewed so the population is mostly small with a real tail of
      // congestus. This spread is the whole point — it is what the review meant
      // by "real cumulus over a landscape varies enormously in size".
      cloudRadiusMin: 0.24,
      cloudRadiusMax: 2.15,
      // Total splat area as a fraction of the tile, before overlap. Sets how
      // many clouds get placed — 1.05 lands at 149 clouds over the 26 km tile.
      cloudAreaBudget: 1.05,
      // How far the 2-5 lobes of one cloud scatter inside it, as a fraction of
      // the room available. 0 is a single smooth ellipse; 1 is a loose cluster.
      cloudLobeScatter: 0.92,
      // Repeat period of the erosion volume. 1.40 km puts its three worley
      // octaves at 465 / 235 / 115 m. At the old 1.85 the coarsest lobe was
      // 620 m and the median cloud in the new population is only ~900 m wide,
      // so most clouds got barely one lobe across and came out featureless.
      volumeTileKm: 1.40,
      aerial: 0.030,              // cloud aerial-perspective density, per km.
                                  // Also what dissolves the horizon pebble row:
                                  // a 40 km cloud is 70% haze before it is drawn

      cirrusCoverage: 0.24,
      cirrusScale: 0.040,         // ~2x the cumulus cell size, and drifting at
      cirrusHeight: 7.4,          // a quarter of the speed on a different
      cirrusOpacity: 0.07,        // bearing, so the two decks never move as one
      cirrusSpeed: 0.0022,
      cirrusWind: [0.34, -0.94],  // deliberately not the cumulus bearing

      // --- shadows ---
      shadowMapSize: 4096,
      shadowExtent: 52.0,         // half-width of the ortho frustum, metres
      shadowDistance: 160.0,      // how far back the shadow camera sits
      shadowForwardOffset: 26.0,  // push the focus ahead of the player
      shadowBias: -0.0001,        // depth range is kept tight, so this is small
      shadowNormalBias: 0.04,     // ~1.5 texels at 4096 / 104 m

      // --- env map ---
      envUpdateInterval: 0.25,    // seconds
      envElevationThreshold: 0.4, // degrees of sun movement before a rebuild
      lutWidth: 256,
      lutHeight: 128,
      envSourceWidth: 512,
      envSourceHeight: 256,
    };

    // ---- contract surface -------------------------------------------------
    /** Normalised, points FROM the sun TOWARD the scene. */
    this.sunDirection = new THREE.Vector3(0, -1, 0);
    this.sunColor = new THREE.Color(1, 1, 1);
    this.ambientColor = new THREE.Color(0.2, 0.3, 0.5);
    this.fogColor = new THREE.Color(0.4, 0.5, 0.65);
    this.fogColorGround = new THREE.Color(0.28, 0.3, 0.33);
    this.timeOfDay = 0.935;       // late afternoon: sun at ~15 degrees of elevation

    // ---- internals --------------------------------------------------------
    this._toSun = new THREE.Vector3(0, 1, 0);
    this._sunAzimuth = 0;
    this._sunElevation = 0;
    this._time = 0;
    this._lutDirty = true;
    this._envDirty = true;
    this._shadowProjDirty = true;
    this._sinceLut = 1e3;
    this._sinceEnv = 1e3;
    this._envSunDir = new THREE.Vector3(0, -1, 0);   // forces the first prefilter

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._tmpD = new THREE.Vector3();

    // Procedural cloud noise. ~0.4 s of one-off JS at construction buys the
    // 3-4 octaves of 3D worley the silhouette needs, which is not affordable
    // any other way (see buildCloudVolume). Zero external assets.
    const _p = this.params;
    const _cellKm = Math.max(_p.cloudCellKm, 0.10);
    // 768 rather than 512: one texel is 34 m over a 26 km tile, and the
    // smallest clouds in the population are only ~800 m across. At 512 their
    // outlines and the 300 m break octave both landed near the map's Nyquist
    // and aliased into a chunky, blocky silhouette.
    this._weatherTex = buildWeatherTexture(768, {
      tileKm: _cellKm * Math.max(_p.weatherCells, 2.0),
      radiusMinKm: _p.cloudRadiusMin * _cellKm,
      radiusMaxKm: _p.cloudRadiusMax * _cellKm,
      areaBudget: _p.cloudAreaBudget,
      lobeScatter: _p.cloudLobeScatter,
    });
    this._cloudCount = buildWeatherTexture.lastCount;
    this._volumeTex = buildCloudVolume(64);

    this._buildTargets();
    this._buildMaterials();
    this._buildMesh();
    this._buildLights();

    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._envRT = null;

    this.applyParams();
    this.setTimeOfDay(this.timeOfDay);
    this._renderLUT();
    this._renderEnv();
  }

  // -------------------------------------------------------------- building --
  _buildTargets() {
    const p = this.params;

    this._lutRT = new THREE.WebGLRenderTarget(p.lutWidth, p.lutHeight, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,      // azimuth wraps at +-pi
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    this._envSrcRT = new THREE.WebGLRenderTarget(p.envSourceWidth, p.envSourceHeight, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this._envSrcRT.texture.mapping = THREE.EquirectangularReflectionMapping;
    this._envSrcRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this._quad = new FullScreenQuad(null);
  }

  _buildMaterials() {
    // One uniforms object shared by all three materials: a single source of
    // truth, and inactive uniforms are simply ignored per program.
    this._u = {
      uSkyLUT: { value: this._lutRT.texture },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunDiscColor: { value: new THREE.Vector3(1, 1, 1) },
      uSunAngularRadius: { value: 0.0073 },
      uSkyExposure: { value: 55 },
      uMultiScatter: { value: 0.45 },
      uAltitude: { value: 0.5 },
      uGroundAlbedo: { value: new THREE.Vector3(0.16, 0.14, 0.11) },
      uGroundAmbient: { value: 0.06 },
      uTime: { value: 0 },
      uStarStrength: { value: 0 },

      uWeather: { value: this._weatherTex },
      uNoiseVol: { value: this._volumeTex },

      uCloudSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uCloudAmbient: { value: new THREE.Vector3(0.2, 0.3, 0.5) },
      uHorizonColor: { value: new THREE.Vector3(0.4, 0.45, 0.55) },
      uCloudHeight: { value: 1.9 },
      uCloudThick: { value: 1.55 },
      uInvThick: { value: 1 / 1.55 },
      uWeatherScale: { value: 0.04 },
      uVolScale: { value: 0.55 },
      uCloudVert: { value: 2.7 },
      uCloudTowerMin: { value: 0.16 },
      uCloudTowerMax: { value: 1.0 },
      uCloudBaseLo: { value: 0.0 },
      uCloudBaseSpan: { value: 0.2 },
      uCloudThreshold: { value: 0.54 },
      uCloudOpacity: { value: 1.0 },
      uCloudDensity: { value: 9.0 },
      uCloudAbsorb: { value: 1.5 },
      uCloudDetail: { value: 0.55 },
      uCloudShear: { value: 0.55 },
      uCloudFade: { value: 0.05 },
      uCloudSilver: { value: 1.5 },
      uCloudSpeed: { value: 0.01 },
      uCloudWind: { value: new THREE.Vector2(0.92, 0.39) },
      uCirrusHeight: { value: 7.4 },
      uCirrusScale: { value: 0.11 },
      uCirrusThreshold: { value: 0.6 },
      uCirrusOpacity: { value: 0.22 },
      uCirrusSpeed: { value: 0.0034 },
      uCirrusWind: { value: new THREE.Vector2(0.34, -0.94) },
      uAerial: { value: 0.006 },
    };

    this._lutMat = new THREE.ShaderMaterial({
      name: 'SkyLUT',
      uniforms: this._u,
      vertexShader: FS_VERT,
      fragmentShader: LUT_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this.material = new THREE.ShaderMaterial({
      name: 'SkyDome',
      uniforms: this._u,
      vertexShader: DOME_VERT,
      fragmentShader: SKY_FRAG_BODY,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    this._envMat = new THREE.ShaderMaterial({
      name: 'SkyEquirect',
      uniforms: this._u,
      vertexShader: FS_VERT,
      fragmentShader: '#define SKY_EQUIRECT\n' + SKY_FRAG_BODY,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }

  _buildMesh() {
    // Small radius + depthTest off: the dome can never be clipped by the far
    // plane and never fights with scene geometry, whatever the camera's near/far.
    this._geometry = new THREE.SphereGeometry(10, 32, 16);
    this.mesh = new THREE.Mesh(this._geometry, this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.onBeforeRender = function (renderer, scene, camera) {
      // Recentre on the camera without touching rotation/scale, so object space
      // stays a pure world-space direction (see DOME_VERT).
      this.matrixWorld.copyPosition(camera.matrixWorld);
    };
    this.scene.add(this.mesh);
  }

  _buildLights() {
    const p = this.params;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 4.0);
    this.sunLight.name = 'Sun';
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
    this.sunLight.shadow.bias = p.shadowBias;
    this.sunLight.shadow.normalBias = p.shadowNormalBias;

    this._applyShadowFrustum();

    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, p.hemiIntensity);
    this.hemiLight.name = 'SkyBounce';
    this.hemiLight.color.setRGB(0.28, 0.42, 0.72);
    this.hemiLight.groundColor.setRGB(0.14, 0.12, 0.09);
    this.scene.add(this.hemiLight);
  }

  // ---------------------------------------------------------------- params --
  /** Push `this.params` into uniforms, lights and the shadow camera. */
  applyParams() {
    const p = this.params, u = this._u;

    u.uSkyExposure.value = p.skyExposure;
    u.uMultiScatter.value = p.multiScatter;
    u.uAltitude.value = p.altitude;
    u.uGroundAlbedo.value.set(p.groundAlbedo[0], p.groundAlbedo[1], p.groundAlbedo[2]);
    u.uGroundAmbient.value = p.groundAmbient;
    u.uSunAngularRadius.value = THREE.MathUtils.degToRad(p.sunAngularRadiusDeg);

    const thick = Math.max(p.cloudThickness, 0.05);
    const cell = Math.max(p.cloudCellKm, 0.10);
    u.uCloudHeight.value = p.cloudHeight;
    u.uCloudThick.value = thick;
    u.uInvThick.value = 1.0 / thick;
    // The weather map's base octave is `weatherCells` across its tile, so one
    // cell is one cloud; the uniform is the km -> tile-uv factor.
    u.uWeatherScale.value = 1.0 / (cell * Math.max(p.weatherCells, 2.0));
    u.uVolScale.value = 1.0 / Math.max(p.volumeTileKm, 0.10);
    // Map the slab's normalised height onto real kilometres before it enters
    // the noise, so the erosion is isotropic (x cloudBillow) rather than
    // squashed into layers.
    u.uCloudVert.value = thick * Math.max(p.cloudBillow, 0.05);
    u.uCloudTowerMin.value = p.cloudTowerMin;
    u.uCloudTowerMax.value = p.cloudTowerMax;
    u.uCloudBaseLo.value = p.cloudBaseLo;
    u.uCloudBaseSpan.value = p.cloudBaseSpan;
    u.uCloudThreshold.value = 1.0 - p.cloudCoverage;
    u.uCloudOpacity.value = p.cloudOpacity;
    u.uCloudDensity.value = p.cloudDensity;
    u.uCloudAbsorb.value = p.cloudAbsorb;
    u.uCloudDetail.value = THREE.MathUtils.clamp(p.cloudDetail, 0.0, 0.92);
    u.uCloudShear.value = p.cloudShear;
    u.uCloudFade.value = p.cloudFade;
    u.uCloudSilver.value = p.cloudSilver;
    u.uCloudSpeed.value = p.cloudSpeed;
    u.uCloudWind.value.set(p.cloudWind[0], p.cloudWind[1]);
    u.uCirrusHeight.value = p.cirrusHeight;
    u.uCirrusScale.value = p.cirrusScale;
    u.uCirrusThreshold.value = 1.0 - p.cirrusCoverage;
    u.uCirrusOpacity.value = p.cirrusOpacity;
    u.uCirrusSpeed.value = p.cirrusSpeed;
    u.uCirrusWind.value.set(p.cirrusWind[0], p.cirrusWind[1]);
    u.uAerial.value = p.aerial;

    this.sunLight.shadow.bias = p.shadowBias;
    this.sunLight.shadow.normalBias = p.shadowNormalBias;
    this.scene.environmentIntensity = p.envIntensity;

    // Re-derive everything that is sampled from the scattering function, so a
    // change to skyExposure / multiScatter / altitude moves the lights with it.
    this._deriveLighting();

    this._shadowProjDirty = true;
    this._lutDirty = true;
    this._envDirty = true;
    this._sinceLut = 1e3;
    this._sinceEnv = 1e3;
  }

  /**
   * Tight ortho frustum. near/far hug the focus region rather than starting at
   * the light, which keeps the depth range (and therefore the depth bias needed
   * to fight acne) small enough that peter-panning stays invisible.
   */
  _applyShadowFrustum() {
    const p = this.params;
    const sc = this.sunLight.shadow.camera;
    sc.left = -p.shadowExtent;
    sc.right = p.shadowExtent;
    sc.top = p.shadowExtent;
    sc.bottom = -p.shadowExtent;
    sc.near = Math.max(0.5, p.shadowDistance - p.shadowExtent * 2.0);
    sc.far = p.shadowDistance + p.shadowExtent * 2.0;
    sc.updateProjectionMatrix();
    this._shadowProjDirty = false;
  }

  /** Change the shadow map resolution at runtime (frees the old map). */
  setShadowQuality(size) {
    this.params.shadowMapSize = size;
    const sh = this.sunLight.shadow;
    sh.mapSize.set(size, size);
    if (sh.map) { sh.map.dispose(); sh.map = null; }
    this._shadowProjDirty = true;
  }

  // ------------------------------------------------------------ time of day --
  /**
   * @param {number} t01 0 = dawn, 0.5 = noon, 1 = dusk.
   * Derives the sun vector and everything that depends on it.
   */
  setTimeOfDay(t01) {
    const p = this.params;
    this.timeOfDay = THREE.MathUtils.clamp(t01, 0, 1);

    const arc = Math.sin(Math.PI * this.timeOfDay);
    const elevDeg = p.sunElevationMin + (p.sunElevationMax - p.sunElevationMin) * arc;
    const azDeg = p.sunAzimuthStart + (p.sunAzimuthEnd - p.sunAzimuthStart) * this.timeOfDay;

    const elev = THREE.MathUtils.degToRad(elevDeg);
    const az = THREE.MathUtils.degToRad(azDeg);
    this._sunElevation = elev;
    this._sunAzimuth = az;

    const ce = Math.cos(elev), se = Math.sin(elev);
    this._toSun.set(ce * Math.cos(az), se, ce * Math.sin(az)).normalize();
    this.sunDirection.copy(this._toSun).negate();
    this._u.uSunDir.value.copy(this._toSun);

    this._deriveLighting();

    this._lutDirty = true;
    // Angular move of the sun since the last prefilter — covers azimuth too,
    // which elevation alone misses around noon.
    const moved = this._toSun.dot(this._envSunDir);
    if (moved < Math.cos(THREE.MathUtils.degToRad(p.envElevationThreshold))) this._envDirty = true;
  }

  /** Evaluate the scattering integral on the CPU for the lighting terms. */
  _deriveLighting() {
    const p = this.params;
    const roY = ATMO.Rg + p.altitude;

    // --- direct sun: transmittance along the view->sun ray at the observer ---
    _transmittance(0, roY, 0, this._toSun.x, this._toSun.y, this._toSun.z, _sunT);
    const maxT = Math.max(_sunT[0], _sunT[1], _sunT[2], 1e-5);
    this.sunColor.setRGB(_sunT[0] / maxT, _sunT[1] / maxT, _sunT[2] / maxT);
    this.sunLight.color.copy(this.sunColor);

    const lum = 0.2126 * _sunT[0] + 0.7152 * _sunT[1] + 0.0722 * _sunT[2];
    const above = THREE.MathUtils.smoothstep(this._toSun.y, -0.05, 0.02);
    this.sunLight.intensity = p.sunIntensity * lum * above;

    this._u.uSunDiscColor.value.set(
      _sunT[0] * p.sunDiscIntensity,
      _sunT[1] * p.sunDiscIntensity,
      _sunT[2] * p.sunDiscIntensity,
    );
    // Clouds are lit by the same beam as the ground, so their sun colour is the
    // DirectionalLight's own irradiance turned back into a radiance (E/pi).
    // cloudSunBoost = 1.0 therefore means "a perfectly white lambertian cloud",
    // and the deck can never drift brighter or dimmer than the key light.
    const eBeam = (this.sunLight.intensity / Math.PI) * p.cloudSunBoost;
    this._u.uCloudSunColor.value.set(
      this.sunColor.r * eBeam,
      this.sunColor.g * eBeam,
      this.sunColor.b * eBeam,
    );
    this._u.uStarStrength.value = 1.0 - THREE.MathUtils.smoothstep(this._toSun.y, -0.14, 0.01);

    // --- ambient fill: hemisphere average + ground bounce ---------------
    // Step 1: E_sky / pi, the cosine-weighted mean radiance of the sky dome.
    // See AMBIENT_RINGS above for why this is not a zenith sample.
    _acc[0] = _acc[1] = _acc[2] = 0;
    for (let k = 0; k < AMBIENT_RINGS; k++) {
      const w = AMBIENT_W[k];
      for (let a = 0; a < AMBIENT_AZIM; a++) {
        // +45 deg offset keeps every sample out of the solar aureole.
        this._sampleElevAz(AMBIENT_ELEV[k], (a + 0.5) * (Math.PI * 2 / AMBIENT_AZIM), _rad);
        _acc[0] += _rad[0] * w; _acc[1] += _rad[1] * w; _acc[2] += _rad[2] * w;
      }
    }
    _skyMean[0] = _acc[0]; _skyMean[1] = _acc[1]; _skyMean[2] = _acc[2];

    // Step 2: the bounce. The ground around a shadowed surface is lit by the
    // direct sun AND by that same sky irradiance; groundAlbedo turns the total
    // back into radiance. E_sun uses the DirectionalLight's own intensity, so
    // the bounce can never drift from the key light that produced it.
    // This term is warm (sun transmittance x a warm-grey albedo) and it is the
    // only reason a real shadow is not the colour of the sky.
    const eSun = (this.sunLight.intensity * Math.max(this._toSun.y, 0)) / Math.PI;
    _bounce[0] = p.groundAlbedo[0] * (this.sunColor.r * eSun + _skyMean[0]);
    _bounce[1] = p.groundAlbedo[1] * (this.sunColor.g * eSun + _skyMean[1]);
    _bounce[2] = p.groundAlbedo[2] * (this.sunColor.b * eSun + _skyMean[2]);

    // Step 3: report the fill the renderer ACTUALLY applies, not an idealised
    // one. Two lights carry it — scene.environment (the sky hemisphere, scaled
    // by envIntensity, which is the fraction of it a walled compound leaves
    // visible) and the hemisphere light (the ground bounce). Both are radiances
    // here, so their sum is exactly what a white lambertian surface standing in
    // a cast shadow returns. Nothing downstream has to second-guess it: this is
    // the number, and it moves with the sun because both terms do.
    const kb = THREE.MathUtils.clamp(p.groundBounce, 0, 1);
    this.ambientColor.setRGB(
      p.envIntensity * _skyMean[0] + p.hemiIntensity * _bounce[0],
      p.envIntensity * _skyMean[1] + p.hemiIntensity * _bounce[1],
      p.envIntensity * _skyMean[2] + p.hemiIntensity * _bounce[2],
    );

    // --- fog. Sampled AWAY from the sun on purpose: PostFX adds its own solar
    //     inscatter term on top, so folding the aureole in here double counts. ---
    _acc[0] = _acc[1] = _acc[2] = 0;
    for (let i = 1; i < 4; i++) {
      this._sampleElevAz(0.44, i * Math.PI * 0.5, _rad);
      _acc[0] += _rad[0] / 3; _acc[1] += _rad[1] / 3; _acc[2] += _rad[2] / 3;
    }
    const fs = p.fogColorScale;
    this.fogColor.setRGB(_acc[0] * fs, _acc[1] * fs, _acc[2] * fs);

    _acc[0] = _acc[1] = _acc[2] = 0;
    for (let i = 1; i < 4; i++) {
      this._sampleElevAz(0.045, i * Math.PI * 0.5, _rad);
      _acc[0] += _rad[0] / 3; _acc[1] += _rad[1] / 3; _acc[2] += _rad[2] / 3;
    }
    this._u.uHorizonColor.value.set(_acc[0], _acc[1], _acc[2]);
    const gs = p.fogColorGroundScale;
    this.fogColorGround.setRGB(_acc[0] * gs, _acc[1] * gs * 0.97, _acc[2] * gs * 0.95);

    // --- lights driven by the sky, not by hand-picked constants ---
    // scene.environment already IS the cosine-weighted sky hemisphere: a PMREM
    // irradiance lookup evaluates exactly that integral, in colour, per normal.
    // So the hemisphere light is deliberately NOT a second copy of it — it
    // carries the one term the env map cannot see, the bounce off the sunlit
    // ground. Splitting them this way is what lets the fill be lifted to a
    // photographic 5-8:1 without dragging the whole frame toward cyan.
    const bm = Math.max(_bounce[0], _bounce[1], _bounce[2], 1e-5);
    this.hemiLight.color.setRGB(_bounce[0] / bm, _bounce[1] / bm, _bounce[2] / bm);
    // Downward-facing surfaces see the ground closer and more occluded: same
    // hue, less of it. groundBounce is that occupancy — how much of a
    // down-facing hemisphere is lit ground rather than the dark underside of
    // whatever the surface is attached to.
    this.hemiLight.groundColor.setRGB(
      (_bounce[0] / bm) * kb,
      (_bounce[1] / bm) * kb * 0.94,
      (_bounce[2] / bm) * kb * 0.87,
    );
    // bm is a radiance; a full hemisphere of it is pi * bm of irradiance, which
    // is what a HemisphereLight's colour*intensity actually means. So
    // hemiIntensity = 1.0 is "the shadowed surface sees a whole hemisphere of
    // exactly the bounce the albedo and the sun imply" — a real quantity, not
    // a magic number, and it tracks the sun automatically as the day moves.
    this.hemiLight.intensity = p.hemiIntensity * Math.PI * bm;

    // Clouds are lit from above by the sky, not by the ground bounce, so they
    // take the raw hemisphere mean rather than the shadow-fill mix.
    this._u.uCloudAmbient.value.set(
      _skyMean[0] * p.cloudAmbientBoost,
      _skyMean[1] * p.cloudAmbientBoost,
      _skyMean[2] * p.cloudAmbientBoost,
    );
  }

  /** Sky radiance in a direction given as elevation + azimuth relative to the sun. */
  _sampleElevAz(elev, azOffset, out) {
    const ce = Math.cos(elev), se = Math.sin(elev);
    const az = this._sunAzimuth + azOffset;
    return this._sampleSky(ce * Math.cos(az), se, ce * Math.sin(az), out);
  }

  /**
   * CPU twin of skyRadiance() in LUT_FRAG — same constants, same integration,
   * fewer steps. Returns radiance already scaled by params.skyExposure.
   */
  _sampleSky(dx, dy, dz, out) {
    const p = this.params;
    const oy = ATMO.Rg + p.altitude;
    const sx = this._toSun.x, sy = this._toSun.y, sz = this._toSun.z;

    const tGround = _rayNear(0, oy, 0, dx, dy, dz, ATMO.Rg);
    const hitGround = tGround > 0;
    const tMax = hitGround ? tGround : _rayFar(0, oy, 0, dx, dy, dz, ATMO.Rt);
    if (tMax <= 0) { out[0] = out[1] = out[2] = 0; return out; }

    const cosT = dx * sx + dy * sy + dz * sz;
    const pR = 0.05968310365 * (1 + cosT * cosT);
    const g2 = ATMO.mieG * ATMO.mieG;
    const dd = Math.max(1 + g2 - 2 * ATMO.mieG * cosT, 1e-4);
    const pM = (1 - g2) / (12.566370614 * dd * Math.sqrt(dd));
    const sunUp = THREE.MathUtils.clamp(sy * 4 + 0.15, 0, 1);

    let lr = 0, lg = 0, lb = 0;
    let tr = 1, tg = 1, tb = 1;
    const ds = tMax / CPU_VIEW_STEPS;
    let t = ds * 0.5;

    for (let i = 0; i < CPU_VIEW_STEPS; i++) {
      const px = dx * t, py = oy + dy * t, pz = dz * t;
      let h = Math.sqrt(px * px + py * py + pz * pz) - ATMO.Rg;
      if (h < 0) h = 0;
      const dR = Math.exp(-h / ATMO.Hr);
      const dM = Math.exp(-h / ATMO.Hm);
      let dO = 1 - Math.abs(h - ATMO.ozoneCenter) / ATMO.ozoneWidth;
      if (dO < 0) dO = 0;

      _transmittance(px, py, pz, sx, sy, sz, _T);

      const scM = ATMO.betaMs * dM;
      for (let c = 0; c < 3; c++) {
        const scR = ATMO.betaR[c] * dR;
        const ext = Math.max(ATMO.betaR[c] * dR + ATMO.betaMe * dM + ATMO.betaO[c] * dO, 1e-9);
        const ms = p.multiScatter * 0.0795774715 * (_T[c] * 0.75 + 0.25 * sunUp);
        const S = (scR * pR + scM * pM) * _T[c] + (scR + scM) * ms;
        const st = Math.exp(-ext * ds);
        const contrib = (S - S * st) / ext;
        if (c === 0) { lr += tr * contrib; tr *= st; }
        else if (c === 1) { lg += tg * contrib; tg *= st; }
        else { lb += tb * contrib; tb *= st; }
      }
      t += ds;
    }

    if (hitGround) {
      const px = dx * tMax, py = oy + dy * tMax, pz = dz * tMax;
      const inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
      const ndl = Math.max((px * inv) * sx + (py * inv) * sy + (pz * inv) * sz, 0);
      _transmittance(px, py, pz, sx, sy, sz, _T);
      lr += tr * p.groundAlbedo[0] * (_T[0] * ndl * 0.31830988 + p.groundAmbient);
      lg += tg * p.groundAlbedo[1] * (_T[1] * ndl * 0.31830988 + p.groundAmbient);
      lb += tb * p.groundAlbedo[2] * (_T[2] * ndl * 0.31830988 + p.groundAmbient);
    }

    out[0] = lr * p.skyExposure;
    out[1] = lg * p.skyExposure;
    out[2] = lb * p.skyExposure;
    return out;
  }

  // ------------------------------------------------------------- GPU passes --
  _renderLUT() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this._quad.material = this._lutMat;
    r.setRenderTarget(this._lutRT);
    this._quad.render(r);
    r.setRenderTarget(prev);
    this._lutDirty = false;
    this._sinceLut = 0;
  }

  _renderEnv() {
    if (this._lutDirty) this._renderLUT();
    const r = this.renderer;
    const prev = r.getRenderTarget();

    // 1. sky (no sun disc — the DirectionalLight already carries that energy)
    this._quad.material = this._envMat;
    r.setRenderTarget(this._envSrcRT);
    this._quad.render(r);
    r.setRenderTarget(prev);

    // 2. prefilter. fromEquirectangular() reuses the target we hand it, so this
    //    does not allocate after the first call.
    if (this._envRT === null) {
      this._envRT = this._pmrem.fromEquirectangular(this._envSrcRT.texture);
    } else {
      this._pmrem.fromEquirectangular(this._envSrcRT.texture, this._envRT);
    }

    this.scene.environment = this._envRT.texture;
    this.scene.background = this._envRT.texture;
    this.scene.environmentIntensity = this.params.envIntensity;

    this._envDirty = false;
    this._sinceEnv = 0;
    this._envSunDir.copy(this._toSun);
  }

  // ---------------------------------------------------------------- update --
  /**
   * @param {number} dt seconds
   * @param {object} ctx shared context (camera / postfx are used if present)
   */
  update(dt, ctx) {
    const p = this.params;
    this._time += dt;
    this._sinceLut += dt;
    this._sinceEnv += dt;
    this._u.uTime.value = this._time;

    const camera = (ctx && ctx.camera) || null;
    if (camera) this._updateSunTransform(camera);

    // Feed the post stack. These are plain public fields on PostFX and the sky
    // is their only authority.
    const postfx = ctx && ctx.postfx;
    if (postfx) {
      if (postfx.sunDir) postfx.sunDir.copy(this.sunDirection);
      if (postfx.sunColor) postfx.sunColor.copy(this.sunColor);
      if (postfx.fogColor) postfx.fogColor.copy(this.fogColor);
      if (postfx.fogColorGround) postfx.fogColorGround.copy(this.fogColorGround);
    }

    // Throttled GPU work. The LUT is tiny (256x128) so it can refresh often;
    // the PMREM prefilter is not, so it waits for a material sun move.
    if (this._lutDirty && this._sinceLut > 0.033) this._renderLUT();
    if (this._envDirty && this._sinceEnv > p.envUpdateInterval) this._renderEnv();
  }

  /**
   * Recentre the shadow frustum on the player, snapped to shadow-map texels so
   * the shadow edges do not crawl while walking.
   */
  _updateSunTransform(camera) {
    const p = this.params;

    if (this._shadowProjDirty) this._applyShadowFrustum();

    const focus = this._tmpA;
    const fwd = this._tmpB;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize(); else fwd.set(0, 0, -1);
    focus.copy(camera.position).addScaledVector(fwd, p.shadowForwardOffset);

    // Light-space basis. This matches the basis LightShadow.updateMatrices()
    // ends up with (its lookAt uses world up), so snapping here snaps texels.
    const d = this.sunDirection;
    const right = this._tmpC;
    const up = this._tmpD;
    right.set(0, 1, 0).cross(d);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(d, right).normalize();

    const texel = (2 * p.shadowExtent) / p.shadowMapSize;
    const a = Math.round(focus.dot(right) / texel) * texel;
    const b = Math.round(focus.dot(up) / texel) * texel;
    const c = focus.dot(d);
    focus.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(d, c);

    this.sunLight.target.position.copy(focus);
    this.sunLight.position.copy(focus).addScaledVector(d, -p.shadowDistance);
    this.sunLight.updateMatrixWorld();
    this.sunLight.target.updateMatrixWorld();
  }

  // --------------------------------------------------------------- teardown --
  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.hemiLight);

    if (this.scene.environment === (this._envRT && this._envRT.texture)) this.scene.environment = null;
    if (this.scene.background === (this._envRT && this._envRT.texture)) this.scene.background = null;

    this.sunLight.dispose();
    this.hemiLight.dispose();
    if (this.sunLight.shadow.map) { this.sunLight.shadow.map.dispose(); this.sunLight.shadow.map = null; }

    this._geometry.dispose();
    this.material.dispose();
    this._lutMat.dispose();
    this._envMat.dispose();
    this._lutRT.dispose();
    this._envSrcRT.dispose();
    this._weatherTex.dispose();
    this._volumeTex.dispose();
    this._quad.dispose();
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    this._pmrem.dispose();
  }
}

export default Sky;
