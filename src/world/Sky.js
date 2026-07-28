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
 *   R  coverage field, large cells   (congestus scale)
 *   G  coverage field, small cells   (fair-weather puff scale)
 *   B  region field: which of the two dominates + a coverage bias
 *   A  condensation-level wobble; also the domain-warp partner of B
 * R and G are two independent fbms of different cell size. Blending between
 * them with the slow B field is what gives SCALE VARIATION — one quarter of the
 * sky carrying 2 km towers and another carrying 1 km puffs — for no extra fetch.
 */
function buildWeatherTexture(size) {
  const rng = makeRng(0x51ce7a1);
  const N = size;
  const data = new Uint8Array(N * N * 4);

  const mk = (cells, oct, rngRef) => {
    const ls = [];
    for (let o = 0; o < oct; o++) ls.push({ C: cells << o, g: _lattice2(cells << o, rngRef) });
    return ls;
  };
  const fbm = (ls, amps, x, y) => {
    let s = 0, w = 0;
    for (let o = 0; o < ls.length; o++) { s += amps[o] * _val2(ls[o].g, ls[o].C, x, y); w += amps[o]; }
    return s / w;
  };

  const AMP = [0.52, 0.26, 0.14, 0.08];
  const chans = [
    mk(13, 4, rng),   // R: 13 cells across the tile — congestus scale
    mk(19, 4, rng),   // G: ~1.5x finer — fair-weather puffs. Not finer than
                      // that: the erosion below chews ~300 m off every edge,
                      // and a 0.9 km cell does not survive it as a cloud, only
                      // as a wisp.
    mk(3, 2, rng),    // B: region — which of the two dominates
    mk(5, 2, rng),    // A: condensation-level wobble + warp partner
  ];

  // A summed fbm clusters hard around 0.5, so a threshold picked against it is
  // a knife edge: 0.60 selects a fifth of the sky and 0.80 selects none of it,
  // which is exactly how the first pass came out as a dozen lonely puffs.
  // Stretching each channel to its own full range makes cloudCoverage mean what
  // it says — 0.5 really is half the sky — and gives the flanks somewhere to go.
  const buf = new Float32Array(N * N);
  for (let c = 0; c < 4; c++) {
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < N; y++) {
      const v = (y + 0.5) / N;
      for (let x = 0; x < N; x++) {
        const s = fbm(chans[c], AMP, (x + 0.5) / N, v);
        buf[y * N + x] = s;
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
    }
    const inv = 1 / Math.max(hi - lo, 1e-6);
    for (let i = 0; i < N * N; i++) {
      data[i * 4 + c] = Math.max(0, Math.min(255, Math.round((buf[i] - lo) * inv * 255)));
    }
  }

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

  uniform sampler2D uWeather;      // RGBA: covBig, covSmall, region, baseLevel
  uniform sampler3D uNoiseVol;     // RGBA: valueFbm, worley3, worley6, worley12

  uniform vec3  uCloudSunColor;
  uniform vec3  uCloudAmbient;
  uniform vec3  uHorizonColor;
  uniform float uCloudHeight;      // base of the cumulus slab, km
  uniform float uCloudThick;       // slab thickness, km
  uniform float uInvThick;         // 1 / uCloudThick
  uniform float uWeatherScale;     // 1/km — weather tile is 1/uWeatherScale km
  uniform float uWeatherWarp;      // domain-warp amplitude, weather-tile units
  uniform float uVolScale;         // 1/km — volume tile is 1/uVolScale km
  uniform float uCloudVert;        // km the volume's Y axis spans over the slab
  uniform float uCloudTowerMin;    // slab fraction a thin cell reaches
  uniform float uCloudTowerMax;    // slab fraction a solid cell reaches
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

  // The warp/region fetch, taken ONCE per ray. It is sampled at 0.53x the
  // coverage frequency, so its period is ~47 km and it changes by nothing at
  // all across the ~5 km chord a ray takes through the deck. Hoisting it out of
  // the march halves the texture traffic of the whole shader, and that is what
  // pays for the step count the deck actually needs.
  vec4 cloudRegion(vec2 q){
    return texture2D(uWeather, q * (uWeatherScale * 0.53) + vec2(0.37, 0.11));
  }

  void cloudWeather(vec2 q, vec4 lo, out float cf, out float baseH, out float tower){
    // Domain warp. The region fetch's own low-frequency channels are the warp
    // vector, so it costs nothing extra, and it is what stops the coverage
    // lattice from reading as the row of identical repeated pebbles the review
    // found along the horizon: cell outlines wander instead of sitting on a grid.
    vec2 warp = (lo.ba - vec2(0.5)) * uWeatherWarp;
    vec4 W = texture2D(uWeather, q * uWeatherScale + warp);

    // SCALE VARIATION. R and G are two independent coverage fbms of different
    // cell size; the slow region field picks which dominates, so one part of
    // the sky carries 2 km congestus and another carries 1 km fair-weather
    // puffs. Blending baked fields costs one lerp — warping the UV by a spatial
    // scale factor would be the obvious alternative and it shears badly once
    // the UV is tens of tiles from the origin.
    // The blend is deliberately near-BINARY. Two independent fbms averaged at
    // m=0.5 have half the variance of either, and a coverage field with half
    // the variance never crosses its threshold — that is how a "scale
    // variation" mix turned the whole sky into one thin filamentary veil with
    // no cores in it at all. Regions pick a field; only the seams blend.
    float m   = smoothstep(0.44, 0.56, lo.b);
    float cov = mix(W.r, W.g, m);

    // Regions that pick the SMALL field also get a lower threshold, so they
    // carry more, smaller clouds rather than fewer, thinner ones — scale
    // variation, not coverage variation.
    float thr = uCloudThreshold + (0.5 - lo.b) * 0.15;
    // A narrow ramp is what gives a cumulus its near-vertical flanks. Widen it
    // and the field spends most of its area on the ramp instead of on either
    // side of it — which is a milky half-density veil over the whole sky, not
    // a cloud. Squared again on top, so between cumulus it is genuinely clear.
    cf = smoothstep(thr, thr + 0.085, cov);
    cf = cf * cf * (3.0 - 2.0 * cf);

    // The condensation level wanders. A laser-flat deck bottom at exactly h=0
    // across the whole sky is the single loudest tell that a cloud layer is a
    // shader; real bases are flat PER CLOUD and staggered between clouds.
    baseH = 0.02 + 0.15 * W.a;

    // Vertical development: deep coverage towers, thin coverage stays a puff.
    // Kept linear and floored well above zero — squaring it made the cloud
    // height track the coverage gradient so closely that every cell came out a
    // smooth cone instead of a mass with flanks and a crown.
    tower = mix(uCloudTowerMin, uCloudTowerMax, cf);
  }

  // h is 0 at the base of the slab, 1 at the top. lod > 0.5 adds the second
  // volume fetch (three more worley octaves); the sun march and distant rays
  // run without it, where those octaves are below a pixel anyway.
  float cloudBody(vec2 q, float h, float cf, float baseH, float tower, float lod){
    if (cf <= 0.002) return 0.0;

    // Height inside THIS cell, measured from its own base.
    float hn = (h - baseH) / max(1.0 - baseH, 0.2);
    if (hn <= 0.0 || hn >= 1.0) return 0.0;

    // A cumulus base is genuinely flat and genuinely hard — that part of the
    // old render was not the problem. What made it read as a lens was that the
    // OUTLINE was smooth at every height. So: keep the base ramp sharp, and let
    // the 3D erosion below carve the perimeter instead.
    // The base ramp cannot be sharper than a march step or the jitter resolves
    // it per pixel and the deck grows vertical drips off every cloud bottom.
    // 0.085 of the slab is ~290 m, which is about two steps and still reads as
    // a flat base from the ground.
    float base = smoothstep(0.0, 0.085, hn);
    // Full density up to 60% of the tower, then a rounded shoulder. Ramping
    // from 42% gave a cone: the cloud narrowed all the way from base to apex
    // and the deck read as a field of flames seen from below rather than of
    // masses with flanks and a crown.
    float top  = 1.0 - smoothstep(tower * 0.60, tower * 1.05, hn);
    float d = cf * base * top;
    if (d <= 0.002) return 0.0;

    // ---- silhouette erosion -------------------------------------------
    // Sampled in a space where Y is a REAL axis scaled to real kilometres
    // (uCloudVert = slab thickness x anisotropy), so the pattern turns over
    // isotropically as you climb. The old deck squashed this axis by ~1.6x,
    // which is literally how you manufacture horizontal striations.
    vec3 vp = vec3(q.x, h * uCloudVert, q.y) * uVolScale;
    vec4 n0 = texture(uNoiseVol, vp);

    // Octave budget is set by the STEP LENGTH, not by taste. A ray steps
    // ~190 m through the deck; carving 50 m notches at that step size is not
    // detail, it is variance, and variance in a raymarch is coherent ALONG the
    // ray — which is why an over-detailed deck comes out covered in radial
    // scratches rather than in grain. So the finest octave here is the 12-cell
    // worley at ~155 m, and its weight is wound down further with distance.
    // Silhouette octaves still add up: 2 km cells and four coverage octaves
    // from the weather map, then 620 / 310 / 155 m from the volume.
    float billow = mix(n0.g * 0.62 + n0.b * 0.38,
                       n0.g * 0.46 + n0.b * 0.34 + n0.a * 0.20, lod);
    // Wispy shreds at the base, packed cauliflower at the crown — the classic
    // cumulus erosion split, and the reason a crown reads as lobes rather than
    // as a smooth lens.
    float e = mix(mix(0.5, n0.r, lod), billow, smoothstep(0.02, 0.55, hn));

    // Erode the SILHOUETTE, not the interior. remap(d, k*gap, 1, 0, 1) moves
    // the zero crossing — the boundary itself is carved — while leaving d=1
    // exactly 1, so cores stay solid however hard the edges are chewed.
    // Normalising by (1-k) instead, as the previous pass did, scaled the whole
    // field and turned an eroded deck into a translucent smear.
    float k = uCloudDetail * mix(0.88, 1.10, smoothstep(0.05, 0.85, hn))
                           * mix(0.70, 1.0, clamp(lod, 0.0, 1.0));
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
  // 36 steps is not extravagance. sigma*dt at one step decides whether a pixel
  // can go from clear to opaque in a single sample, and if it can, the start
  // jitter turns that coin flip into per-pixel speckle across the whole deck.
  // Halving the step length is the only thing that actually removes it.
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
  float cloudLightOD(vec3 p, float hn, float dens, float cf, float baseH, float tower, float jit){
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
      od += cloudBody(cloudUV(sp, hh), hh, cf, baseH, tower, 0.0) * sdt;
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
    // The deck is fully faded out at grazing elevations. A slab viewed at 2
    // degrees is compressed by ~30:1 in elevation, which is exactly the
    // "horizontal smear" the art review saw — no amount of shaping survives it,
    // so the honest fix is to stop drawing it there and let the haze take over.
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
    const float GROW = 0.042;
    const float GSUM = float(CLOUD_STEPS)
                     + GROW * 0.5 * float(CLOUD_STEPS) * float(CLOUD_STEPS - 1);
    float span = tT - tB;
    if (span <= 0.0) return col;
    // Cap the first step at 170 m. sigma*dt at one step decides whether a
    // single sample can take a pixel from clear to opaque, and if it can, the
    // jitter turns that coin flip into speckle. The cap does truncate a grazing
    // chord at ~10 km — but a grazing ray through a deck this dense has already
    // hit the transmittance break long before then, so the cut only exists
    // where the deck is thin enough for it to be invisible.
    float dt0 = min(span / GSUM, 0.17);
    if (dt0 <= 0.0) return col;

    // Two-lobe HG. The wide lobe is the body of the cloud; the tight forward
    // lobe is the silver lining and is gated on a THIN path to the sun below,
    // so it only fires along edges where the sun shines nearly through.
    float phWide = hgPhase(cosT, 0.10) * 12.566370614;
    // Capped. Uncapped this peaks near 95, and multiplied through the silver
    // gain it turns every wobble in the sun march into a blown highlight.
    float phFwd  = min(hgPhase(cosT, 0.82) * 12.566370614, 45.0);

    // Per-pixel start jitter, over the FULL step. This is the fix for the
    // corduroy: a few dozen samples across a slab band into iso-height rings,
    // and the old jitter only spanned 0.4 of a step, so 60% of every ring
    // survived as a coherent stripe.
    //
    // The dither is deliberately WHITE, not interleaved-gradient. IGN has the
    // lower variance of the two, but its error is spatially structured, and a
    // structured error at this sample count reads as a halftone screen over the
    // whole deck — measurably better, visibly worse. White noise of the same
    // amplitude reads as grain, which is what the post chain is already full of.
    // Rolled per frame so a static camera dissolves the residue. The hash takes
    // time as a genuine THIRD input rather than as an offset on the pixel
    // coordinate: fed 2D, this hash family correlates along a column, and a
    // jitter that is constant down a column puts the whole march out of phase
    // one column at a time — vertical scratches, not grain.
    float jit = pixelHash(gl_FragCoord.xy, floor(uTime * 30.0));
    float t = tB;
    float trans = 1.0;
    vec3  scat = vec3(0.0);
    float lastOD = 0.0;
    vec4  region = cloudRegion(cloudUV(ro + rd * (tB + span * 0.5), 0.5));

    // Detail budget. Two independent limits, and the tighter one wins:
    //   - STEP LENGTH. Detail finer than the step is not detail, it is variance,
    //     and variance in a raymarch is coherent along the ray, so it shows up
    //     as radial scratches rather than as grain.
    //   - DISTANCE. Past ~8 km a cumulus billow is a couple of degrees wide and
    //     the fine octaves fall under a pixel.
    // Winding the octaves down is also most of the shader's distance LOD, worth
    // roughly 25 fps on a wide shot.
    float lod = min(clamp((0.26 - dt0) / 0.15, 0.0, 1.0),
                    clamp(1.0 - (tB - 3.0) / 5.0, 0.0, 1.0));

    for (int i = 0; i < CLOUD_STEPS; i++){
      if (t > tT) break;
      float dt = dt0 * (1.0 + GROW * float(i));
      // The jitter is applied PER STEP and scaled BY that step, not once at the
      // ray start. With a growing step a single start offset spans dt0 while
      // the step at i=20 is 2.1x dt0, so half of every iso-height ring survives
      // — and a surviving ring on a slab is the corduroy the review named.
      // 0.85 of a step, centred. A full-width jitter fully decorrelates the
      // banding but hands back all of that error as per-pixel variance; at 85%
      // the residual ring is below the noise floor and the speckle is a sixth
      // lower. The last 15% is not worth what it costs.
      vec3 p = ro + rd * (t + dt * (0.5 + 0.85 * (jit - 0.5)));
      float h = clamp((length(p) - RG - uCloudHeight) * uInvThick, 0.0, 1.0);
      vec2 q = cloudUV(p, h);
      float cf, baseH, tower;
      cloudWeather(q, region, cf, baseH, tower);
      float dens = cloudBody(q, h, cf, baseH, tower, lod);
      // Skip the thin fringe the erosion leaves around every cloud. Below this
      // the sample contributes a percent of alpha and a full step of variance,
      // which is the scratchy residue that survives on cloud edges.
      if (dens > 0.018){
        float hn = clamp((h - baseH) / max(1.0 - baseH, 0.2), 0.0, 1.0);
        // Once the ray is nine tenths absorbed, the remaining samples move the
        // final colour by under a percent, so they reuse the last sun march
        // instead of paying for their own. Deep inside a cumulus that is most
        // of the samples, and the sun march is the single most expensive thing
        // in the shader.
        float od = lastOD;
        if (trans > 0.10){
          od = cloudLightOD(p, hn, dens, cf, baseH, tower, jit) * uCloudAbsorb;
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

        float sigma = dens * uCloudDensity;
        float dT = exp(-sigma * dt);
        scat += trans * (1.0 - dT) * S;
        trans *= dT;
        if (trans < 0.015) break;
      }
      t += dt;
    }

    float alpha = (1.0 - trans) * uCloudOpacity * hf;
    if (alpha <= 0.002) return col;

    vec3 c1 = scat / max(1.0 - trans, 1.0e-3);
    float aer1 = 1.0 - exp(-(tB + min(span, 12.0) * 0.5) * uAerial);
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
      cloudCoverage: 0.40,        // 0 clear .. 1 overcast
      // Cell size, km. A cumulus congestus is TALLER THAN WIDE — the previous
      // deck ran 2.7 km cells against a 2.7 km slab that only ever filled two
      // thirds of its height, so every cell came out a squat lens. 1.95 km of
      // width against 3.4 km of depth is the congestus proportion.
      cloudCellKm: 2.50,
      cloudHeight: 2.35,          // base of the cumulus slab, km
      cloudThickness: 2.70,       // slab depth — this is what gives them form
      cloudOpacity: 1.0,          // final alpha multiplier
      cloudDensity: 13.0,         // extinction per km at full density
      cloudAbsorb: 2.65,          // self-shadow gain (underside vs top)
      cloudDetail: 0.72,          // silhouette erosion strength
      cloudShear: 0.55,           // km the top leans downwind of the base
      // Vertical anisotropy of the 3D erosion noise. 1.0 is isotropic — a
      // billow as tall as it is wide. Below 1 stretches the lobes vertically,
      // which is the correct direction for a convective cloud; ABOVE 1 squashes
      // them into horizontal laminations, and that (at an effective 1.6) is
      // half of where the ribbed-plastic corduroy came from.
      cloudBillow: 0.95,
      // How far up the slab a cell tows, between thin coverage and solid. A
      // congestus is roughly as tall as it is wide, not three times as tall —
      // letting every solid cell reach the full slab depth turned the deck into
      // a field of flames seen from below.
      cloudTowerMin: 0.34,
      cloudTowerMax: 0.80,
      cloudFade: 0.036,           // sin(elevation) below which the deck fades
                                  // out — grazing rays compress the slab into
                                  // exactly the horizontal smear we are fixing
      cloudSilver: 2.8,           // forward-scatter gain (silver lining)
      cloudSpeed: 0.018,          // km/s of drift (18 m/s of wind)
      cloudWind: [0.92, 0.39],
      cloudSunBoost: 1.05,        // 1.0 == a white lambertian cloud
      cloudAmbientBoost: 0.55,
      // Weather-map tile, in cell widths. 13 cells x 1.95 km = 25 km, which is
      // past the range aerial perspective has already washed everything out at.
      weatherCells: 13.0,
      weatherWarp: 0.085,         // domain warp, in weather-tile units (~2 km)
      volumeTileKm: 1.85,         // repeat period of the erosion volume
      aerial: 0.028,              // cloud aerial-perspective density, per km.
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
    this._weatherTex = buildWeatherTexture(512);
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
      uWeatherWarp: { value: 0.09 },
      uVolScale: { value: 0.55 },
      uCloudVert: { value: 2.7 },
      uCloudTowerMin: { value: 0.42 },
      uCloudTowerMax: { value: 0.92 },
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
    u.uWeatherWarp.value = p.weatherWarp;
    u.uVolScale.value = 1.0 / Math.max(p.volumeTileKm, 0.10);
    // Map the slab's normalised height onto real kilometres before it enters
    // the noise, so the erosion is isotropic (x cloudBillow) rather than
    // squashed into layers.
    u.uCloudVert.value = thick * Math.max(p.cloudBillow, 0.05);
    u.uCloudTowerMin.value = p.cloudTowerMin;
    u.uCloudTowerMax.value = p.cloudTowerMax;
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
