import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { generateTextureSet } from '../gfx/textures.js';

/*
 * Hostile soldier.
 *
 * Three things carry this: the silhouette, the pose blending, and the fact
 * that the thing is not allowed to be instantly lethal.
 *
 * SILHOUETTE — a capsule with a gun reads as a prototype at any distance.
 * The body is assembled from primitives at real proportions (1.78 m crown,
 * 0.23 head, 0.60 torso, 0.44 upper leg, 0.42 lower leg) and given the
 * outline cues a player actually identifies at 40 m: the flare of a helmet,
 * the square mass of a plate carrier, pouches breaking the chest line, the
 * diagonal of a slung rifle. Geometry is built once at module scope and
 * shared by every enemy in the pool; only the Object3D hierarchy is per-agent.
 *
 * ANIMATION — no skeletal data, no clips. A phase accumulator drives the gait;
 * legs counter-rotate, arms oppose, the pelvis and chest twist against each
 * other, the head is stabilised against both. Aim, crouch, stagger and death
 * are separate pose layers blended in with exponential damping, so nothing
 * ever snaps between states.
 *
 * COMBAT — reaction time, a wind-up before the first round, accuracy that
 * only converges the longer they hold line of sight, real reloads, and a
 * firing permission ("token") owned by the director. An enemy without a
 * token can suppress but cannot kill you. That single rule is the difference
 * between a firefight and a firing squad.
 */

// ============================================================== constants ===

export const STATE = {
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  SEARCH: 'search',
  ENGAGE: 'engage',
  SUPPRESS: 'suppress',
  REPOSITION: 'reposition',
  COVER: 'cover',
  RETREAT: 'retreat',
  DEAD: 'dead',
};

const TAU = Math.PI * 2;

const TUNE = {
  health: 100,
  eyeStand: 1.60,
  eyeCrouch: 1.15,

  walkSpeed: 2.0,
  patrolSpeed: 1.5,
  runSpeed: 4.6,
  combatSpeed: 3.2,
  accel: 16,
  turnRate: 7.0,

  // sensing
  viewDistance: 78,
  fovCos: -0.15,          // ~99 deg half-angle: wide, but not omniscient
  reactionMin: 0.25,
  reactionMax: 0.40,
  memory: 7.5,            // seconds a last-known position stays actionable

  // gunnery
  magSize: 30,
  reloadTime: 2.6,
  burstMin: 3,
  burstMax: 5,
  shotInterval: 0.095,
  windUp: 0.26,           // shouldering the weapon before the first round
  burstGapMin: 0.55,
  burstGapMax: 1.45,
  damage: 10.5,
  suppressDamageScale: 0.20,
  range: 70,
  // Cone half-angle in radians: cold, then after holding LoS for `aimTime`.
  spreadCold: 0.115,
  spreadWarm: 0.034,
  aimTime: 2.2,
  hitRadius: 0.46,        // effective torso radius for the miss/hit decision

  // morale
  retreatHealth: 0.28,
  coverPeekMin: 1.1,
  coverPeekMax: 2.6,
  repositionAfter: 6.0,

  corpseTime: 22,
  sinkTime: 1.4,
};

// Bone-local hit sphere layout. Rebuilt in world space every tick.
const ZONE_DEF = [
  { bone: 'head', ox: 0, oy: 0.115, oz: 0, r: 0.12, zone: 'head' },
  { bone: 'chest', ox: 0, oy: 0.40, oz: 0, r: 0.26, zone: 'chest' },
  { bone: 'hips', ox: 0, oy: 0.04, oz: 0, r: 0.20, zone: 'chest' },
  { bone: 'upperArmL', ox: 0, oy: -0.15, oz: 0, r: 0.11, zone: 'limb' },
  { bone: 'upperArmR', ox: 0, oy: -0.15, oz: 0, r: 0.11, zone: 'limb' },
  { bone: 'foreArmL', ox: 0, oy: -0.14, oz: 0, r: 0.10, zone: 'limb' },
  { bone: 'foreArmR', ox: 0, oy: -0.14, oz: 0, r: 0.10, zone: 'limb' },
  { bone: 'thighL', ox: 0, oy: -0.22, oz: 0, r: 0.12, zone: 'limb' },
  { bone: 'thighR', ox: 0, oy: -0.22, oz: 0, r: 0.12, zone: 'limb' },
  { bone: 'shinL', ox: 0, oy: -0.21, oz: 0, r: 0.10, zone: 'limb' },
  { bone: 'shinR', ox: 0, oy: -0.21, oz: 0, r: 0.10, zone: 'limb' },
];

// ========================================================= shared assets ===

let SHARED = null;

const _m4 = new THREE.Matrix4();
const _qq = new THREE.Quaternion();
const _ee = new THREE.Euler();
const _pv = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _fallAxis = new THREE.Vector3();

// Per-frame pose scratch, shared across the whole pool (single-threaded, and
// only ever live inside one _animate call).
const _gripL = new Float32Array(5);
const _gripR = new Float32Array(5);

/** Tilt at which a falling body is considered to have hit the ground. */
const FLAT_ANGLE = 1.5;

/** Transform a primitive into body-local space. Never use negative scale. */
function put(g, px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _ee.set(rx, ry, rz, 'XYZ');
  _qq.setFromEuler(_ee);
  _m4.compose(_pv.set(px, py, pz), _qq, _sv.set(sx, sy, sz));
  g.applyMatrix4(_m4);
  return g;
}

const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d, 1, 1, 1);
const sphG = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const cylG = (rt, rb, h, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s, 1);
const capG = (r, h, cs = 4, rs = 9) => new THREE.CapsuleGeometry(r, h, cs, rs);
const torG = (r, t, s = 6, ts = 12) => new THREE.TorusGeometry(r, t, s, ts);

function merge(list) {
  const g = BufferGeometryUtils.mergeGeometries(list, false);
  if (!g) throw new Error('[ai] enemy geometry merge failed');
  // aoMap samples uv1; every primitive here has uv, so mirror it.
  if (g.attributes.uv && !g.attributes.uv1) {
    g.setAttribute('uv1', g.attributes.uv.clone());
  }
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function material(kind, seed, repeat, color, extra) {
  const set = generateTextureSet(kind, { size: 256, seed, repeat });
  const m = new THREE.MeshStandardMaterial({
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.roughnessMap,
    metalnessMap: set.metalnessMap,
    aoMap: set.aoMap,
    roughness: 1,
    metalness: 1,
    color: color ?? 0xffffff,
    ...extra,
  });
  m.name = `enemy_${kind}`;
  return m;
}

/*
 * Character-only lighting and albedo trim.
 *
 * Two injections, both cheap and both confined to enemies — the terrain must
 * not get them or the separation they buy is cancelled out.
 *
 *  1. ALBEDO RE-KEY (after <map_fragment>). The camo tile is authored dark
 *     (linear albedo 0.03-0.11, i.e. darker than the asphalt it is standing on)
 *     and its pattern swings a full stop of value at a spatial frequency finer
 *     than anything in the level. Both of those are backwards: a character has
 *     to be the *simplest* thing on screen and it has to sit at a different
 *     value from the terrain.
 *
 *     So the tile is flattened toward its own mean (uCon, about the measured
 *     gamma-space pivot uPivot) and then the whole surface is re-keyed with
 *     gain/lift. uCon is the important one — it is what turns "high-frequency
 *     noise that destroys the silhouette" into a uniform with a bit of
 *     variation in it. Done in a rough gamma-2 space so the numbers mean what
 *     they would mean in an image editor instead of being swallowed by the
 *     linear curve.
 *
 *     uTint then rotates hue at constant luma. This matters more than it
 *     sounds: measured, this level's ground runs hue 33-35 and the old uniform
 *     sat at hue 39 — no hue separation at all, so the figure had only value to
 *     work with, and there is no single value that beats both sunlit asphalt
 *     (0.23) and asphalt in shadow (0.11). Pushing the uniform to olive puts a
 *     second, independent axis between the man and the ground, which is why it
 *     survives when a cloud crosses the sun.
 *
 *  2. RIM (into totalEmissiveRadiance, so it goes through fog and exposure
 *     like real light and is not multiplied down by AO). A Fresnel term biased
 *     toward the upward-facing side: the sky is the brightest thing in this
 *     level, so an edge light keyed off it reads as physical rather than as a
 *     cartoon outline, and it draws the whole silhouette — helmet flare,
 *     shoulder line, weapon, boots — out of whatever is behind it.
 */
const RIM_CACHE_KEY = 'blacksite_char_rim_v2';

function characterShader(m, o) {
  const u = {
    uRimColor: { value: new THREE.Color(o.rimColor ?? 0x9fb4c8) },
    uRimAmt: { value: o.rimAmt ?? 0.5 },
    uRimPow: { value: o.rimPow ?? 2.6 },
    uSat: { value: o.sat ?? 1 },
    uLift: { value: o.lift ?? 0 },
    uGain: { value: o.gain ?? 1 },
    uCon: { value: o.con ?? 1 },
    uPivot: { value: o.pivot ?? 0.235 },
    uTint: { value: new THREE.Color(...(o.tint ?? [1, 1, 1])) },
  };
  m.userData.charUniforms = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uRimColor;
uniform float uRimAmt;
uniform float uRimPow;
uniform float uSat;
uniform float uLift;
uniform float uGain;
uniform float uCon;
uniform float uPivot;
uniform vec3 uTint;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec3 pc = sqrt( max( diffuseColor.rgb, vec3( 0.0 ) ) );
  float plum = dot( pc, vec3( 0.2126, 0.7152, 0.0722 ) );
  pc = mix( vec3( plum ), pc, uSat );
  pc = ( pc - uPivot ) * uCon + uPivot;
  pc = clamp( pc * uGain + uLift, 0.0, 1.0 ) * uTint;
  diffuseColor.rgb = pc * pc;
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 rimN = normalize( normal );
  float rimF = 1.0 - clamp( dot( rimN, normalize( vViewPosition ) ), 0.0, 1.0 );
  rimF = pow( rimF, uRimPow );
  float rimSky = 0.26 + 0.74 * clamp( rimN.y * 0.70 + 0.52, 0.0, 1.0 );
  totalEmissiveRadiance += uRimColor * ( rimF * uRimAmt * rimSky );
}`);
  };
  m.customProgramCacheKey = () => RIM_CACHE_KEY;
  return m;
}

// ------------------------------------------------------- contact shadow ---

let BLOB = null;

/**
 * A projected blob under the feet. Without it a body reads as pasted onto the
 * frame rather than standing on the ground — the engine's shadow cascade is
 * too coarse at this scale to give a soldier a contact point of his own.
 * Unlit and unfogged on purpose: a fogged blob turns *pale* at range, which is
 * the exact opposite of grounding.
 */
function blobAssets() {
  if (BLOB) return BLOB;
  const N = 64, data = new Uint8Array(N * N * 4);
  // Flat opaque core out to 0.36 m, then a short penumbra to the 0.50 m edge.
  // The old profile started falling off at the centre, so by the time it had
  // been through fog, bloom and the tone curve there was no single pixel dark
  // enough to register as contact — it read as a smudge, which is exactly the
  // complaint. Occlusion under a boot is nearly binary; draw it that way.
  const CORE = 0.52;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = ((x + 0.5) / N) * 2 - 1;
      const v = ((y + 0.5) / N) * 2 - 1;
      const r = Math.min(1, Math.sqrt(u * u + v * v));
      const a = r <= CORE ? 1 : Math.pow(1 - (r - CORE) / (1 - CORE), 1.6);
      const i = (y * N + x) * 4;
      const b = Math.round(THREE.MathUtils.clamp(a, 0, 1) * 255);
      data[i] = data[i + 1] = data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  const geo = new THREE.CircleGeometry(0.42, 20).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x040609,
    alphaMap: tex,
    transparent: true,
    opacity: 0.60,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  mat.name = 'enemy_contact';
  BLOB = { geo, mat };
  return BLOB;
}

/** Build (once) every geometry and material the enemy pool shares. */
function shared() {
  if (SHARED) return SHARED;

  // VALUE PLAN. Three tiers, and they are the whole reason a figure reads at
  // 20 m: a light uniform (linear albedo ~0.15, comfortably above the 0.05-0.08
  // asphalt), dark load-bearing gear across the chest and on the head, and dark
  // boots. Light limbs / dark chest block / dark helmet is the pattern every
  // shipped shooter uses, because two hard value edges inside the outline
  // survive when the outline itself is only thirty pixels wide.
  //
  // Repeat drops 0.85 -> 0.26. At 0.85 a camo blob was about 4 cm across, which
  // at 12 m is two pixels — pure noise, and noise at a finer scale than the
  // level's own materials. At 0.26 a blob is ~13 cm, so it reads as a pattern
  // on a uniform rather than as static, and `con` throws away most of its
  // contrast on top of that.
  const mats = {
    camo: characterShader(material('camo', 0x51D0, [0.26, 0.26], 0xffffff), {
      rimColor: 0x9db2c6, rimAmt: 0.26, rimPow: 3.2,
      sat: 0.88, pivot: 0.235, con: 0.40, gain: 1.34, lift: 0.068,
      // Measured: this tint lands the uniform at hue ~55, saturation ~0.30,
      // against ground at hue 33 / saturation 0.15. Three times this much was
      // tried and it made a highlighter-green soldier — which is a worse
      // version of the "green smudge" the review already objected to. The point
      // is a *different* colour family from the terrain, not a loud one.
      tint: [0.945, 1.022, 0.890],
    }),
    gear: characterShader(material('polymer', 0x2A17, [0.55, 0.55], 0x4c4e52), {
      rimColor: 0xa4b8cc, rimAmt: 0.24, rimPow: 3.4,
      sat: 1.0, pivot: 0.30, con: 0.55, gain: 0.95, lift: 0.0,
    }),
    // The face is its own material only because it is the one surface that
    // must never go to black. A helmeted, masked head lit from behind reads as
    // a hole in the silhouette otherwise, and a hole is what the eye calls
    // "unfinished". Lifted balaclava, brighter rim, so the brow, goggles and
    // jaw stay separable at conversational range.
    face: characterShader(material('polymer', 0x2A17, [0.55, 0.55], 0x9ea099, {
      // A floor under the face. The helmet brim self-shadows everything below
      // it, so with the sun anywhere behind the agent the face receives almost
      // nothing and collapses to black — which is precisely the "dark slab
      // where a face should be" read. This is the cheapest honest fix: a small
      // cool bounce term that only this one surface gets.
      emissive: 0x2c333a,
    }), {
      rimColor: 0xbccbd8, rimAmt: 0.32, rimPow: 2.8,
      sat: 0.9, pivot: 0.30, con: 0.6, gain: 1.0, lift: 0.042,
    }),
    // The plate carrier, its pouches, and the helmet shell all share this. It
    // is the *dark* tier and it is deliberately near-flat: a hard, quiet value
    // break across the chest and around the head is what says "kit on a man"
    // at a distance where no individual pouch is more than a pixel. Making it
    // busy would just re-introduce the problem the camo had.
    vest: characterShader(material('polymer', 0x2A17, [0.6, 0.6], 0x41443e), {
      rimColor: 0xa8bacc, rimAmt: 0.15, rimPow: 3.4,
      sat: 0.9, pivot: 0.30, con: 0.45, gain: 0.80, lift: 0.0,
      tint: [0.90, 1.02, 0.94],
    }),
    // Metalness is 1 here, so there is almost no diffuse to lift and an
    // over-strong rim turns the weapon into white plastic. Keep it modest —
    // just enough to draw the barrel line out of a dark background.
    // Deliberately a mid grey rather than a dark one. The weapon has to cross
    // the dark plate carrier on its way out of the torso outline; if it is the
    // same value as the carrier, the half of the rifle that is in front of the
    // chest disappears and only the tips read. A mid value separates from both
    // the dark gear and the light uniform.
    gun: characterShader(material('gunmetal', 0x77B3, [0.8, 0.8], 0x9fa5ad), {
      rimColor: 0xc4d4e4, rimAmt: 0.30, rimPow: 2.8,
      sat: 1.0, pivot: 0.35, con: 0.7, gain: 1.0, lift: 0.035,
    }),
  };

  const geo = {};

  // ---- helmet ----
  // A smooth dome is a bicycle helmet. What makes a combat helmet identifiable
  // in outline is that the shell is not the widest thing on it: a shell edge
  // flares proud all the way round, a brow brim projects forward over the
  // goggles, an NVG mount stands up off the front, and a strap comes down past
  // the jaw. Those four break the dome into something with a top, a front and a
  // bottom at any resolution, so it stops reading as a ball.
  geo.helmet = merge([
    put(new THREE.SphereGeometry(0.130, 16, 12, 0, TAU, 0, Math.PI * 0.60),
      0, 0.104, 0.004, 0, 0, 0, 1.0, 0.98, 1.05),
    // shell edge: 2.5 cm proud of the dome, flattened, so the helmet has a hard
    // horizontal line under it instead of curving straight into the head
    put(torG(0.142, 0.018, 5, 14), 0, 0.036, 0.004, Math.PI / 2, 0, 0, 1, 0.62, 1.03),
    put(boxG(0.250, 0.026, 0.090), 0, 0.043, -0.108, -0.20),   // brow brim, tipped down
    put(boxG(0.150, 0.086, 0.098), 0, 0.070, 0.120),           // rear counterweight
    put(boxG(0.072, 0.058, 0.060), 0, 0.150, -0.096),          // NVG mount base
    put(boxG(0.034, 0.086, 0.034), 0, 0.202, -0.086, 0.26),    // NVG arm, stood up
    put(boxG(0.022, 0.036, 0.170), -0.128, 0.092, -0.005),     // left rail
    put(boxG(0.022, 0.036, 0.170), 0.128, 0.092, -0.005),      // right rail
    put(boxG(0.026, 0.100, 0.020), -0.107, -0.020, -0.040, 0.30, 0, 0.22),  // strap L
    put(boxG(0.026, 0.100, 0.020), 0.107, -0.020, -0.040, 0.30, 0, -0.22),  // strap R
    put(boxG(0.072, 0.030, 0.038), 0, -0.062, -0.062),         // chin cup
  ]);

  // ---- head: balaclava skull, brow, jaw, goggles, neck ----
  // The neck column is long and plugs down into the chest, because the torso
  // yoke below has been dropped to expose ~6 cm of it. A helmet resting
  // directly on the shoulders is the single loudest "this is a toy" cue there
  // is, and it costs eight triangles to fix.
  geo.head = merge([
    put(sphG(0.096, 12, 10), 0, 0.098, 0.004, 0, 0, 0, 0.94, 1.06, 1.0),
    put(boxG(0.132, 0.062, 0.122), 0, 0.052, -0.014),           // mid face
    put(boxG(0.112, 0.052, 0.104), 0, 0.014, -0.020, 0.22),     // jaw, tapered back
    put(sphG(0.030, 8, 6), 0, 0.026, -0.074, 0, 0, 0, 1.6, 1.0, 0.8), // mask front
    put(boxG(0.028, 0.052, 0.036), 0, 0.070, -0.082, 0.35),     // nose bridge
    put(sphG(0.026, 8, 6), -0.052, 0.052, -0.062, 0, 0, 0, 1.0, 0.9, 0.9), // cheek L
    put(sphG(0.026, 8, 6), 0.052, 0.052, -0.062, 0, 0, 0, 1.0, 0.9, 0.9),  // cheek R
    // Curved goggle band rather than a flat slab. A cylinder laid across the
    // brow carries a moving specular streak and takes the rim strongly, which
    // is what turns "dark rectangle where a face goes" into a readable face.
    put(cylG(0.036, 0.036, 0.190, 12), 0, 0.114, -0.062, 0, 0, Math.PI / 2, 1, 1, 0.60),
    put(boxG(0.205, 0.020, 0.030), 0, 0.140, -0.052),           // goggle strap band
    put(cylG(0.026, 0.026, 0.03, 8), -0.090, 0.112, -0.048, 0, 0, Math.PI / 2),
    put(cylG(0.026, 0.026, 0.03, 8), 0.090, 0.112, -0.048, 0, 0, Math.PI / 2),
    put(cylG(0.050, 0.060, 0.170, 10), 0, -0.070, 0.006),       // neck
  ]);

  // ---- torso: ribcage, abdomen, one continuous shoulder yoke, pack hump ----
  // The yoke is a single wide ellipsoid rather than a sphere stuck on each
  // side. Two spheres on a box gives you two hard seams at the exact place a
  // player's eye goes first; one mass wide enough to swallow each arm's own
  // deltoid cap gives you a shoulder line instead.
  //
  // It is also wider than it was (0.250 -> 0.272 half-width) and the collar has
  // dropped 2 cm. Wide-at-the-top / narrow-at-the-hips is the proportion the
  // eye actually uses to call a shape human at thirty pixels, and the dropped
  // collar is what leaves a throat between the yoke and the jaw — a helmet
  // resting straight on the shoulders is the loudest "toy" cue there is.
  geo.torso = merge([
    put(cylG(0.150, 0.134, 0.30, 14), 0, 0.400, 0, 0, 0, 0, 1, 1, 0.72),
    put(cylG(0.134, 0.124, 0.24, 14), 0, 0.160, 0, 0, 0, 0, 1, 1, 0.76),
    put(sphG(1, 18, 11), 0, 0.458, -0.004, 0, 0, 0, 0.272, 0.112, 0.132),
    put(sphG(1, 12, 8), 0, 0.488, 0.004, 0, 0, 0, 0.150, 0.062, 0.106), // trapezius
    put(torG(0.058, 0.017, 5, 12), 0, 0.522, 0.004, Math.PI / 2, 0, 0, 1, 1.0, 1),
    put(sphG(0.112, 10, 8), 0, 0.395, 0.086, 0, 0, 0, 1.05, 1.30, 0.55),
  ]);

  // ---- plate carrier: faceted plates that wrap the chest, then pouches ----
  // Three facets a side instead of one slab, inset so the rear face of every
  // panel is *inside* the ribcage — the carrier now sits on the man rather
  // than hovering in front of him — and every pouch stands proud of the plate
  // so the chest silhouette is broken up instead of being one flat rectangle.
  geo.vest = merge([
    put(boxG(0.152, 0.320, 0.040), 0, 0.392, -0.100),                  // front centre
    put(boxG(0.106, 0.300, 0.040), -0.110, 0.390, -0.082, 0, 0.44, 0), // front left wrap
    put(boxG(0.106, 0.300, 0.040), 0.110, 0.390, -0.082, 0, -0.44, 0), // front right wrap
    put(boxG(0.168, 0.340, 0.040), 0, 0.398, 0.100),                   // rear centre
    put(boxG(0.100, 0.320, 0.040), -0.116, 0.396, 0.082, 0, -0.42, 0),
    put(boxG(0.100, 0.320, 0.040), 0.116, 0.396, 0.082, 0, 0.42, 0),
    put(cylG(0.152, 0.146, 0.130, 14), 0, 0.248, 0, 0, 0, 0, 1, 1, 0.78), // cummerbund
    put(boxG(0.076, 0.048, 0.250), -0.098, 0.514, 0.000, 0.06),        // shoulder strap L
    put(boxG(0.076, 0.048, 0.250), 0.098, 0.514, 0.000, 0.06),         // shoulder strap R
    // Deltoid protectors. They stand 2.7 cm proud of the arm, which takes the
    // shoulder line out to 0.575 m — the widest thing on the figure by a clear
    // margin, and dark, so the top of the silhouette is a definite horizontal
    // bar rather than a soft shrug.
    put(boxG(0.105, 0.072, 0.205), -0.235, 0.486, -0.004, 0, 0, 0.26),
    put(boxG(0.105, 0.072, 0.205), 0.235, 0.486, -0.004, 0, 0, -0.26),
    put(boxG(0.074, 0.140, 0.058), -0.083, 0.298, -0.148),             // mag pouch 1
    put(boxG(0.074, 0.140, 0.058), 0.000, 0.300, -0.154),              // mag pouch 2
    put(boxG(0.074, 0.140, 0.058), 0.083, 0.298, -0.148),              // mag pouch 3
    put(boxG(0.076, 0.028, 0.016), -0.083, 0.372, -0.150),             // pouch flap 1
    put(boxG(0.076, 0.028, 0.016), 0.000, 0.374, -0.156),
    put(boxG(0.076, 0.028, 0.016), 0.083, 0.372, -0.150),
    put(boxG(0.118, 0.084, 0.046), -0.012, 0.482, -0.142),             // admin pouch
    put(boxG(0.078, 0.150, 0.066), 0.148, 0.405, 0.096),               // radio
    put(cylG(0.009, 0.009, 0.12, 6), 0.170, 0.535, 0.096),             // antenna
    put(sphG(0.036, 8, 6), -0.146, 0.318, -0.096),                     // grenade
    put(sphG(0.036, 8, 6), 0.146, 0.318, -0.096),
    put(boxG(0.112, 0.098, 0.052), 0.112, 0.182, -0.120, 0, 0, -0.2),  // dump pouch
    put(boxG(0.090, 0.062, 0.050), -0.128, 0.196, -0.104, 0, 0.3, 0),  // utility pouch
    // Sling across the chest, corner to corner. One long diagonal inside a
    // rectangle is worth more at range than any amount of pouch detail.
    put(boxG(0.044, 0.400, 0.024), -0.052, 0.400, -0.128, 0, 0, 0.62),
    put(boxG(0.044, 0.330, 0.024), 0.070, 0.410, 0.116, 0, 0, -0.55),
  ]);

  // ---- pelvis: hips, belt, drop leg pouch ----
  geo.pelvis = merge([
    put(cylG(0.142, 0.128, 0.20, 12), 0, -0.075, 0, 0, 0, 0, 1, 1, 0.78),
    put(torG(0.132, 0.021, 5, 14), 0, 0.005, 0, Math.PI / 2, 0, 0, 1, 0.80, 1),
    put(boxG(0.062, 0.075, 0.05), 0.128, -0.055, -0.055),
    put(boxG(0.062, 0.075, 0.05), -0.128, -0.055, -0.055),
  ]);

  // ---- limbs (upper arm 0.29, forearm 0.27, thigh 0.44, shin 0.42) ----
  // The deltoid cap is small enough (0.062) to live entirely inside the torso
  // yoke at the shoulder pivot, so the arm emerges from the shoulder mass
  // instead of butting against it.
  geo.upperArm = merge([
    put(capG(0.053, 0.180, 4, 9), 0, -0.150, 0),
    put(sphG(0.062, 10, 8), 0, -0.006, 0, 0, 0, 0, 1.04, 1.0, 1.04),
  ]);

  // ---- hand: palm, four curled fingers, thumb ----
  // Built at the end of the forearm so the grip centre lands at y -0.30, which
  // is the point the arm IK below is solved against. Arms that end in squared
  // stumps are the first thing that goes at 4 m.
  const hand = [
    put(sphG(0.040, 8, 6), 0, -0.262, -0.002, 0, 0, 0, 1.0, 0.85, 0.95),   // wrist
    put(boxG(0.050, 0.086, 0.076), 0, -0.294, -0.008, -0.24),              // palm
    put(capG(0.0140, 0.030, 2, 6), 0, -0.326, -0.036, 0, 0, Math.PI / 2),  // index
    put(capG(0.0140, 0.030, 2, 6), 0, -0.334, -0.060, 0, 0, Math.PI / 2),  // middle
    put(capG(0.0128, 0.028, 2, 6), 0, -0.329, -0.082, 0, 0, Math.PI / 2),  // ring
    put(capG(0.0116, 0.026, 2, 6), 0, -0.314, -0.100, 0, 0, Math.PI / 2),  // little
    put(capG(0.0150, 0.040, 2, 6), 0.019, -0.300, -0.058, 0, 0, 1.15),     // thumb
  ];
  geo.foreArm = merge([
    put(capG(0.044, 0.150, 4, 8), 0, -0.118, 0),
    put(sphG(0.050, 8, 6), 0, -0.006, -0.006),                 // elbow pad
    put(boxG(0.058, 0.062, 0.062), 0, -0.222, -0.006),         // glove cuff
    ...hand,
  ]);

  // The thigh now stops just short of the knee pivot at -0.44 and the joint
  // ball lives on the *shin*, centred on that pivot — a sphere at the axis of
  // rotation cannot interpenetrate anything no matter how far the knee bends,
  // which is exactly what the old cuff (which overhung the joint by 3.5 cm)
  // could not say.
  geo.thigh = merge([
    put(capG(0.084, 0.280, 4, 10), 0, -0.208, 0),
    put(boxG(0.092, 0.070, 0.030), 0, -0.330, -0.070),         // thigh pocket
  ]);
  geo.shin = merge([
    put(sphG(0.070, 10, 8), 0, 0, 0, 0, 0, 0, 1.0, 1.0, 0.95), // knee ball
    put(boxG(0.098, 0.100, 0.048), 0, -0.028, -0.062, 0.15),   // knee pad
    put(capG(0.058, 0.240, 4, 9), 0, -0.200, 0),
    put(sphG(0.052, 8, 6), 0, -0.150, 0.030, 0, 0, 0, 1.0, 1.5, 0.8), // calf
    put(cylG(0.064, 0.052, 0.095, 9), 0, -0.368, 0),           // bloused cuff
  ]);
  geo.boot = merge([
    put(boxG(0.108, 0.052, 0.165), 0, -0.045, -0.020),
    put(boxG(0.100, 0.040, 0.100), 0, -0.064, -0.118),         // toe
    put(boxG(0.094, 0.038, 0.070), 0, -0.058, 0.062),          // heel
    put(boxG(0.098, 0.045, 0.132), 0, -0.008, -0.010),         // ankle cuff
  ]);

  // ---- rifle: built along -Z, origin at the pistol grip ----
  // Deliberately over-featured for its pixel count. Everything that sticks out
  // of the bore line — magazine, optic, stock, angled grip — is silhouette,
  // and silhouette is the only part of a weapon that survives past 8 m.
  geo.rifle = merge([
    put(boxG(0.054, 0.092, 0.300), 0, 0.020, -0.055),          // receiver
    put(boxG(0.052, 0.060, 0.265), 0, 0.022, -0.305),          // handguard
    put(cylG(0.021, 0.021, 0.250, 8), 0, 0.024, -0.312, Math.PI / 2, 0, 0),
    put(cylG(0.0135, 0.0135, 0.215, 8), 0, 0.026, -0.525, Math.PI / 2, 0, 0),
    put(boxG(0.030, 0.060, 0.034), 0, 0.052, -0.452),          // gas block / front sight
    put(cylG(0.028, 0.028, 0.105, 9), 0, 0.026, -0.650, Math.PI / 2, 0, 0), // flash hider
    put(boxG(0.042, 0.118, 0.050), 0, -0.062, 0.030, 0.26),    // pistol grip
    put(boxG(0.040, 0.195, 0.080), 0, -0.106, -0.096, -0.16),  // magazine
    put(boxG(0.030, 0.030, 0.070), 0, -0.192, -0.112, -0.16),  // mag floorplate
    put(boxG(0.048, 0.072, 0.190), 0, 0.012, 0.160),           // stock tube
    put(boxG(0.056, 0.112, 0.038), 0, 0.006, 0.266),           // buttpad
    put(boxG(0.046, 0.026, 0.150), 0, 0.070, 0.150),           // cheek riser
    put(boxG(0.044, 0.052, 0.115), 0, 0.088, -0.135),          // optic body
    put(cylG(0.026, 0.026, 0.052, 9), 0, 0.092, -0.196, Math.PI / 2, 0, 0),
    put(cylG(0.026, 0.026, 0.040, 9), 0, 0.092, -0.072, Math.PI / 2, 0, 0),
    put(boxG(0.052, 0.020, 0.120), 0, 0.062, -0.135),          // rail riser
    put(boxG(0.032, 0.030, 0.032), 0, 0.074, -0.012),          // charging handle
    put(boxG(0.064, 0.014, 0.058), 0.031, 0.038, -0.030),      // ejection port
    put(boxG(0.026, 0.088, 0.030), 0, -0.036, -0.296, -0.42),  // angled fore grip
    put(torG(0.014, 0.005, 4, 8), 0.029, 0.020, 0.100, 0, Math.PI / 2, 0), // sling loop
  ]);

  SHARED = { mats, geo };
  return SHARED;
}

// =============================================================== helpers ===

/** Framerate-independent exponential approach. */
function approach(cur, target, rate, dt) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Yaw for a THREE object whose local forward is -Z. */
function yawFromDir(dx, dz) { return Math.atan2(-dx, -dz); }

// ================================================================= Enemy ===

export class Enemy {
  /**
   * @param {import('./AIDirector.js').AIDirector} director
   * @param {number} id
   * @param {import('./Navigation.js').NavPath} path
   */
  constructor(director, id, path) {
    this.director = director;
    this.id = id;
    this.path = path;
    this.rng = director?.rng ?? Math.random;

    this.root = new THREE.Group();
    this.root.name = `enemy${id}`;
    this.root.visible = false;
    /** Ballistics.explode() reads `position` before `root.position` — same object. */
    this.position = this.root.position;

    this.active = false;
    this.alive = false;
    this.health = 0;
    this.maxHealth = TUNE.health;

    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.yaw = 0;
    this.yawTarget = 0;
    this.crouch = 0;
    this.crouchTarget = 0;

    this.velocity = new THREE.Vector3();
    this.desired = new THREE.Vector3();
    this.separation = new THREE.Vector3();

    // --- perception ---
    this.hasLos = false;
    this.losTime = 0;
    this.noLosTime = 999;
    this.sinceSeen = 999;
    this.alerted = false;
    this.reaction = 0;
    this.lastKnown = new THREE.Vector3();
    this.hasLastKnown = false;
    this.distToPlayer = 999;
    this.suspicion = 0;

    // --- gunnery ---
    this.ammo = TUNE.magSize;
    this.reloadTimer = 0;
    this.reloadStage = 0;
    this.burstLeft = 0;
    this.fireTimer = 0;
    this.windUp = 0;
    this.burstGap = 0;
    this.token = false;
    this.shotsFired = 0;
    this.aimQuality = 0;
    this.flinch = 0;

    // --- tactics ---
    this.coverIndex = -1;
    this.coverSlot = new THREE.Vector3();
    this.inCover = false;
    this.peekTimer = 0;
    this.tacticTimer = 0;
    this.moveGoal = new THREE.Vector3();
    this.hasMoveGoal = false;
    this.repathTimer = 0;
    this.stuckTimer = 0;
    this.lastProgress = new THREE.Vector3();

    // --- animation ---
    this.gait = 0;
    this.moveAmt = 0;
    this.runAmt = 0;
    this.aimW = 0;
    this.aimWTarget = 0;
    this.aimPose = 0;
    this.shoulder = 0;
    this.aimPitch = 0;
    this.aimYaw = 0;
    this.staggerX = 0; this.staggerZ = 0;
    this.staggerVX = 0; this.staggerVZ = 0;
    this.recoil = 0;
    this.deadW = 0;
    // Ragdoll-lite: a single tip-over axis with real angular momentum, rather
    // than two Euler terms — composed Euler angles never reach flat.
    this.fallAngle = 0;
    this.fallVel = 0;
    this.fallDirX = 0;
    this.fallDirZ = 1;
    this.deathTime = 0;
    this.limp = new Float32Array(12);
    this.corpseTimer = 0;

    this._buildBody();

    // --- preallocated hit zones (mutated in place, never rebuilt) ---
    this.hitZones = [];
    this._zoneBones = [];
    for (const d of ZONE_DEF) {
      this.hitZones.push({ center: new THREE.Vector3(), radius: d.r, zone: d.zone });
      this._zoneBones.push(this.bones[d.bone]);
    }
    // Contract compatibility: { head, chest, limbs } view onto the same spheres.
    this.hitBoxes = {
      head: this.hitZones[0],
      chest: this.hitZones[1],
      limbs: this.hitZones.slice(3),
    };

    this._s = {
      v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
      v4: new THREE.Vector3(), muzzle: new THREE.Vector3(), end: new THREE.Vector3(),
      eye: new THREE.Vector3(), tgt: new THREE.Vector3(), n: new THREE.Vector3(),
    };
  }

  // ---------------------------------------------------------------- body ---

  _buildBody() {
    const { mats, geo } = shared();
    const B = {};

    const mesh = (g, m, cast) => {
      const o = new THREE.Mesh(g, m);
      o.castShadow = !!cast;
      o.receiveShadow = true;
      o.matrixAutoUpdate = false;   // static within its bone; never moves
      return o;
    };

    B.body = new THREE.Group();
    this.root.add(B.body);

    B.hips = new THREE.Group();
    B.hips.position.y = 0.935;
    B.body.add(B.hips);
    B.hips.add(mesh(geo.pelvis, mats.camo, true));

    B.chest = new THREE.Group();
    B.hips.add(B.chest);
    B.chest.add(mesh(geo.torso, mats.camo, true));
    B.chest.add(mesh(geo.vest, mats.vest, true));

    // Head sits on a real neck: the yoke tops out at chest y 0.570, the collar
    // ring at 0.539, and the jaw starts at 0.653 — so 8 cm of throat is visible
    // from every angle, with the helmet's chin strap crossing it.
    B.neck = new THREE.Group();
    B.neck.position.y = 0.652;
    B.chest.add(B.neck);

    B.head = new THREE.Group();
    B.neck.add(B.head);
    B.head.add(mesh(geo.head, mats.face, false));
    // The helmet is gear, not uniform. Putting it on the dark tier costs
    // nothing (it was already its own mesh) and buys the single clearest
    // read on the figure: a dark head above light shoulders.
    B.head.add(mesh(geo.helmet, mats.vest, true));

    for (const side of [-1, 1]) {
      const S = side < 0 ? 'L' : 'R';
      const sh = new THREE.Group();
      // Pivot dropped to the middle of the deltoid so the arm's cap stays
      // buried inside the torso yoke through the full swing.
      sh.position.set(side * 0.196, 0.470, 0);
      B.chest.add(sh);
      sh.add(mesh(geo.upperArm, mats.camo, true));
      B['upperArm' + S] = sh;

      const el = new THREE.Group();
      el.position.y = -0.29;
      sh.add(el);
      el.add(mesh(geo.foreArm, mats.camo, true));
      B['foreArm' + S] = el;

      // Hips 2 cm wider each side. At 0.098 the thigh capsules (r 0.084) were
      // 2.8 cm apart — the two legs read as one column and the figure had no
      // base. At 0.118 there is a real gap of light between them, and negative
      // space between the legs is one of the strongest "this is a person"
      // signals the eye has.
      const hip = new THREE.Group();
      hip.position.set(side * 0.118, 0, 0);
      B.hips.add(hip);
      hip.add(mesh(geo.thigh, mats.camo, true));
      B['thigh' + S] = hip;

      const kn = new THREE.Group();
      kn.position.y = -0.44;
      hip.add(kn);
      kn.add(mesh(geo.shin, mats.camo, true));
      B['shin' + S] = kn;

      const an = new THREE.Group();
      an.position.y = -0.42;
      kn.add(an);
      an.add(mesh(geo.boot, mats.gear, false));
      B['ankle' + S] = an;
    }

    // Weapon rides the chest, so wherever the upper body points, so does the
    // muzzle. Far more robust than hanging it off an un-IK'd hand — instead the
    // hands are solved *onto* the weapon (see GRIP_READY / GRIP_AIM).
    B.mount = new THREE.Group();
    B.chest.add(B.mount);
    B.mount.add(mesh(geo.rifle, mats.gun, true));

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.026, -0.700);
    B.mount.add(this.muzzle);

    // Contact shadow. Parented to the root, not the body, so it stays flat on
    // the floor while the torso leans, crouches and finally falls over.
    const blob = blobAssets();
    this.shadow = new THREE.Mesh(blob.geo, blob.mat);
    this.shadow.position.y = 0.022;
    this.shadow.castShadow = false;
    this.shadow.receiveShadow = false;
    this.shadow.matrixAutoUpdate = false;
    this.shadow.renderOrder = -1;
    this.shadow.updateMatrix();
    this._shadowScale = 1;
    this.root.add(this.shadow);

    // Leg bones cached in order [L, R]. The pose loop used to index B by a
    // concatenated name every frame, which allocates a string per joint per
    // agent per tick; update() is not allowed to allocate.
    this._legs = [
      { thigh: B.thighL, shin: B.shinL, ankle: B.ankleL },
      { thigh: B.thighR, shin: B.shinR, ankle: B.ankleR },
    ];

    this.bones = B;
  }

  // ------------------------------------------------------------- spawning ---

  spawn(pos, yaw) {
    this.active = true;
    this.alive = true;
    this.health = this.maxHealth;
    this.root.visible = true;
    this.root.position.copy(pos);
    this.yaw = this.yawTarget = yaw ?? this.rng() * TAU;
    this.root.rotation.set(0, this.yaw, 0);

    this.state = STATE.PATROL;
    this.stateTime = 0;
    this.velocity.set(0, 0, 0);
    this.crouch = this.crouchTarget = 0;

    this.hasLos = false;
    this.losTime = 0;
    this.noLosTime = 999;
    this.sinceSeen = 999;
    this.alerted = false;
    this.reaction = 0;
    this.hasLastKnown = false;
    this.suspicion = 0;

    this.ammo = TUNE.magSize;
    this.reloadTimer = 0;
    this.reloadStage = 0;
    this.burstLeft = 0;
    this.fireTimer = 0;
    this.windUp = 0;
    this.burstGap = 0.4 + this.rng() * 0.8;
    this.token = false;
    this.aimQuality = 0;
    this.flinch = 0;
    this.shotsFired = 0;
    this.peekTimer = 0;
    this.distToPlayer = 999;

    this.coverIndex = -1;
    this.inCover = false;
    this.hasMoveGoal = false;
    this.repathTimer = 0;
    this.stuckTimer = 0;
    this.tacticTimer = 0;
    this.lastProgress.copy(pos);
    this.path.reset();

    this.gait = this.rng() * TAU;
    this.moveAmt = 0; this.runAmt = 0;
    this.aimW = 0; this.aimWTarget = 0; this.aimPose = 0; this.shoulder = 0;
    this.aimPitch = 0; this.aimYaw = 0;
    this.staggerX = this.staggerZ = this.staggerVX = this.staggerVZ = 0;
    this.recoil = 0;
    this.deadW = 0; this.deathTime = 0;
    this.fallAngle = 0; this.fallVel = 0;
    this.fallDirX = 0; this.fallDirZ = 1;
    this.corpseTimer = 0;
    // Pooled agents are reused: a corpse's blob is scaled up ~2x, and without
    // this the respawned soldier renders one frame standing on a crater.
    this._shadowScale = 1;
    this.shadow.scale.set(1, 1, 1);
    this.shadow.updateMatrix();
    this.bones.body.quaternion.identity();
    this.bones.body.position.set(0, 0, 0);
    this.bones.body.rotation.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    this._refreshZones();
  }

  despawn() {
    this.active = false;
    this.alive = false;
    this.root.visible = false;
    this.path.reset();
    if (this.coverIndex >= 0) { this.director?.releaseCover(this.coverIndex, this); this.coverIndex = -1; }
  }

  // ------------------------------------------------------------- sensing ---

  /**
   * Full line-of-sight test. Expensive (one BVH shapecast) — the director
   * calls this on a rotating subset of agents, never on everyone every tick.
   */
  senseNow(ctx) {
    const p = ctx.player;
    const nav = this.director?.nav;
    if (!p || !nav || !this.alive) return;

    // Eye height must be continuous in the crouch weight. A threshold here
    // makes line of sight flicker on and off as an agent eases into a crouch
    // behind a low wall, and the FSM then oscillates engage/suppress forever.
    const eyeY = this.root.position.y
      + THREE.MathUtils.lerp(TUNE.eyeStand, TUNE.eyeCrouch, this.crouch);
    const pEyeY = p.position.y + (p.crouching ? 1.02 : 1.55);

    const dx = p.position.x - this.root.position.x;
    const dz = p.position.z - this.root.position.z;
    const flat = Math.sqrt(dx * dx + dz * dz);
    this.distToPlayer = flat;

    let visible = false;
    if (!p.dead && flat < TUNE.viewDistance) {
      // Facing check first — it is free, and rejects most of the pool.
      const inv = flat > 1e-4 ? 1 / flat : 0;
      const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
      const dot = (dx * inv) * fwdX + (dz * inv) * fwdZ;
      // Alerted soldiers are allowed to check their flanks.
      const cone = this.alerted ? -0.55 : TUNE.fovCos;
      if (dot > cone || flat < 4.5) {
        visible = nav.rayClear(
          this.root.position.x, eyeY, this.root.position.z,
          p.position.x, pEyeY, p.position.z
        );
        // Second probe at the chest catches a player behind a low wall whose
        // head is exposed and vice versa.
        if (!visible && flat < 45) {
          visible = nav.rayClear(
            this.root.position.x, eyeY, this.root.position.z,
            p.position.x, p.position.y + 0.95, p.position.z
          );
        }
      }
    }

    if (visible) {
      this.hasLos = true;
      this.sinceSeen = 0;
      this.noLosTime = 0;
      this.lastKnown.set(p.position.x, p.position.y, p.position.z);
      this.hasLastKnown = true;
      if (!this.alerted) { this.alerted = true; this.reaction = this._reactionTime(); }
    } else {
      this.hasLos = false;
    }
  }

  _reactionTime() {
    return TUNE.reactionMin + this.rng() * (TUNE.reactionMax - TUNE.reactionMin);
  }

  /** Called by the director when something audible happens nearby. */
  onNoise(x, y, z, strength) {
    if (!this.alive) return;
    this.suspicion = Math.min(1, this.suspicion + strength);
    if (!this.hasLastKnown || this.sinceSeen > 1.5) {
      this.lastKnown.set(x, y, z);
      this.hasLastKnown = true;
    }
    if (!this.alerted && this.suspicion > 0.45) {
      this.alerted = true;
      this.reaction = this._reactionTime();
      if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);
    }
  }

  // ================================================================ update ==

  update(dt, ctx) {
    if (!this.active) return;

    if (!this.alive) { this._updateCorpse(dt, ctx); return; }

    this.stateTime += dt;
    this.sinceSeen += dt;
    this.noLosTime = this.hasLos ? 0 : this.noLosTime + dt;
    this.losTime = this.hasLos ? this.losTime + dt : 0;
    this.suspicion = Math.max(0, this.suspicion - dt * 0.22);
    this.flinch = Math.max(0, this.flinch - dt * 1.6);
    this.reaction = Math.max(0, this.reaction - dt);
    this.repathTimer -= dt;
    this.tacticTimer -= dt;

    // Range is needed every tick by the FSM and gunnery; the expensive part of
    // perception (the LoS raycast) is what gets staggered, not this.
    if (ctx.player) {
      const dx = ctx.player.position.x - this.root.position.x;
      const dz = ctx.player.position.z - this.root.position.z;
      this.distToPlayer = Math.sqrt(dx * dx + dz * dz);
      // Line of sight decays if nobody has re-tested it recently.
      if (this.sinceSeen > 0.5) this.hasLos = false;
    }

    this._think(dt, ctx);
    this._locomote(dt, ctx);
    this._gunnery(dt, ctx);
    this._animate(dt, ctx);

    this.root.updateMatrixWorld(true);
    this._refreshZones();
  }

  // ------------------------------------------------------------------ FSM ---

  _setState(s) {
    if (this.state === s) return;
    // Cover claims survive only in the states that are actually using them.
    if (this.coverIndex >= 0 && !COVER_KEEP.has(s)) {
      this.director?.releaseCover(this.coverIndex, this);
      this.coverIndex = -1;
      this.inCover = false;
    }
    this.state = s;
    this.stateTime = 0;
  }

  _think(dt, ctx) {
    const p = ctx.player;
    const hp01 = this.health / this.maxHealth;

    // Death of the player ends everything gracefully.
    if (!p || p.dead) {
      if (this.state !== STATE.PATROL && this.state !== STATE.IDLE) this._setState(STATE.PATROL);
    }

    // Global overrides -----------------------------------------------------
    // Badly hurt: break contact. Gated on the tactic timer so a wounded agent
    // does not burn the director's whole cover-query budget every tick.
    if (hp01 < TUNE.retreatHealth && this.state !== STATE.RETREAT
        && this.stateTime > 0.4 && this.tacticTimer <= 0) {
      this.tacticTimer = 2.5 + this.rng() * 2;
      if (this._pickCover(ctx, true)) this._setState(STATE.RETREAT);
    }

    switch (this.state) {
      // ------------------------------------------------------------ idle --
      case STATE.IDLE: {
        this.hasMoveGoal = false;
        this.crouchTarget = 0;
        this.aimWTarget = 0;
        if (this.alerted) { this._setState(STATE.ALERT); break; }
        if (this.stateTime > 2.5 + this.rng() * 4) this._setState(STATE.PATROL);
        break;
      }

      // ---------------------------------------------------------- patrol --
      case STATE.PATROL: {
        this.crouchTarget = 0;
        this.aimWTarget = 0;
        if (this.alerted) { this._setState(STATE.ALERT); break; }
        if (!this.hasMoveGoal || this.path.done) {
          if (this.tacticTimer <= 0) {
            this.tacticTimer = 0.5;
            if (!this._pickWander(ctx, 16)) this._setState(STATE.IDLE);
          }
        }
        if (this.stateTime > 26) this._setState(STATE.IDLE);
        break;
      }

      // ----------------------------------------------------------- alert --
      case STATE.ALERT: {
        // Orient toward the disturbance, weapon coming up, then commit.
        this.hasMoveGoal = false;
        this.aimWTarget = 0.55;
        if (this.hasLastKnown) {
          this.yawTarget = yawFromDir(
            this.lastKnown.x - this.root.position.x,
            this.lastKnown.z - this.root.position.z
          );
        }
        if (this.hasLos && this.reaction <= 0) { this._setState(STATE.ENGAGE); break; }
        if (this.stateTime > 0.55 + this.rng() * 0.5) {
          this._setState(this.hasLastKnown ? STATE.SEARCH : STATE.PATROL);
        }
        break;
      }

      // ---------------------------------------------------------- search --
      case STATE.SEARCH: {
        this.aimWTarget = 0.75;
        this.crouchTarget = 0;
        if (this.hasLos && this.reaction <= 0) { this._setState(STATE.ENGAGE); break; }
        if (this.hasLastKnown) {
          const d = this._flatDist(this.lastKnown);
          if (d > 1.8) {
            this._moveTo(ctx, this.lastKnown, false);
          } else if (this.tacticTimer <= 0) {
            this.tacticTimer = 1.2 + this.rng();
            this._pickWander(ctx, 9);
          }
        }
        if (this.stateTime > TUNE.memory + 5 || this.sinceSeen > 22) {
          this.alerted = false;
          this.hasLastKnown = false;
          this._setState(STATE.PATROL);
        }
        break;
      }

      // ---------------------------------------------------------- engage --
      case STATE.ENGAGE: {
        this.aimWTarget = 1;
        this.yawTarget = this._yawToTarget();

        if (!this.hasLos) {
          if (this.noLosTime > 0.8) {
            this._setState(this.ammo > 4 && this.sinceSeen < 3.5 ? STATE.SUPPRESS : STATE.SEARCH);
          }
          break;
        }

        // Reloading or out of permission? Get behind something. The dwell
        // guard matters: without it, an agent that pops out of cover and
        // instantly loses its firing token snaps straight back the same tick,
        // which reads as a twitch rather than a decision.
        const wantCover = (this.reloadTimer > 0 || !this.token || this.flinch > 0.35
                           || this.health < this.maxHealth * 0.6);
        if (!this.inCover && wantCover && this.stateTime > 0.7 && this.tacticTimer <= 0) {
          this.tacticTimer = 1.4 + this.rng();
          if (this._pickCover(ctx, false)) { this._setState(STATE.COVER); break; }
        }

        // Been static and exposed too long — move, do not stand and trade.
        if (this.stateTime > TUNE.repositionAfter && this.tacticTimer <= 0) {
          this.tacticTimer = 2.0;
          if (this._pickFlank(ctx)) { this._setState(STATE.REPOSITION); break; }
        }

        // A shallow combat crouch shrinks the profile and reads as deliberate.
        // Kept shallow on purpose: a deep crouch out in the open drops the
        // eyeline below sandbag height and the agent blinds itself.
        this.crouchTarget = (this.distToPlayer > 9 && this.distToPlayer < 26 && this.token) ? 0.30 : 0;
        break;
      }

      // -------------------------------------------------------- suppress --
      case STATE.SUPPRESS: {
        this.aimWTarget = 1;
        if (this.hasLastKnown) {
          this.yawTarget = yawFromDir(
            this.lastKnown.x - this.root.position.x,
            this.lastKnown.z - this.root.position.z
          );
        }
        this.hasMoveGoal = false;
        if (this.hasLos && this.reaction <= 0) { this._setState(STATE.ENGAGE); break; }
        if (this.stateTime > 2.2 || this.ammo <= 2) this._setState(STATE.SEARCH);
        break;
      }

      // ----------------------------------------------------- take cover ---
      case STATE.COVER: {
        this.aimWTarget = this.hasLos ? 1 : 0.7;
        const d = this._flatDist(this.coverSlot);
        if (d > 1.0) {
          this.inCover = false;
          this._moveTo(ctx, this.coverSlot, true);
          if (this.stateTime > 9) { this._setState(STATE.ENGAGE); }
        } else {
          if (!this.inCover) {
            this.inCover = true;
            // Time spent behind the object before popping out again.
            this.peekTimer = TUNE.coverPeekMin
              + this.rng() * (TUNE.coverPeekMax - TUNE.coverPeekMin);
          }
          this.hasMoveGoal = false;
          this.yawTarget = this._yawToTarget();
          // Hunker while reloading, pop out when ready and permitted.
          this.crouchTarget = (this.reloadTimer > 0 || !this.token) ? 0.9 : 0.15;
          this.peekTimer -= dt;
          if (this.peekTimer <= 0 && this.token && this.reloadTimer <= 0) {
            this._setState(STATE.ENGAGE);
            // Commit to being out of cover long enough to actually shoot.
            this.tacticTimer = 1.6 + this.rng() * 1.4;
          }
          if (this.stateTime > 12 && !this.hasLos) this._setState(STATE.SEARCH);
        }
        break;
      }

      // ----------------------------------------------------- reposition ---
      case STATE.REPOSITION: {
        this.aimWTarget = 0.8;
        this.crouchTarget = 0;
        const d = this._flatDist(this.moveGoal);
        if (d < 1.2 || this.stateTime > 7) {
          this._setState(this.hasLos ? STATE.ENGAGE : STATE.SEARCH);
          break;
        }
        this._moveTo(ctx, this.moveGoal, true);
        // Only give up once the planner has had a chance to answer — testing
        // `path.done` on entry just reads the previous state's stale path.
        if (this.stateTime > 0.6 && (!this.path.valid || this.path.done)) {
          this._setState(this.hasLos ? STATE.ENGAGE : STATE.SEARCH);
        }
        break;
      }

      // -------------------------------------------------------- retreat ---
      case STATE.RETREAT: {
        this.aimWTarget = 0.35;
        this.crouchTarget = 0;
        const d = this._flatDist(this.coverSlot);
        if (d < 1.1 || this.stateTime > 8) {
          this._setState(STATE.COVER);
        } else {
          this._moveTo(ctx, this.coverSlot, true);
        }
        break;
      }
      default: break;
    }
  }

  _yawToTarget() {
    const t = this.hasLos || !this.hasLastKnown
      ? (this.director?.ctx?.player?.position ?? this.lastKnown)
      : this.lastKnown;
    return yawFromDir(t.x - this.root.position.x, t.z - this.root.position.z);
  }

  _flatDist(v) {
    const dx = v.x - this.root.position.x, dz = v.z - this.root.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // ------------------------------------------------------------- tactics ---

  /** Wander to a random reachable point within `radius`. */
  _pickWander(ctx, radius) {
    const nav = this.director?.nav;
    if (!nav?.ready) return false;
    const s = this._s;
    for (let i = 0; i < 5; i++) {
      const a = this.rng() * TAU;
      const r = radius * (0.35 + this.rng() * 0.65);
      const x = this.root.position.x + Math.cos(a) * r;
      const z = this.root.position.z + Math.sin(a) * r;
      if (!nav.isWalkableAt(x, z)) continue;
      s.v1.set(x, nav.sampleFloorAt(x, z), z);
      this.moveGoal.copy(s.v1);
      this.hasMoveGoal = true;
      this.repathTimer = 0;
      return true;
    }
    return false;
  }

  /**
   * Score the level's cover points and commit to the best one.
   * A point is worth using if it is close, if standing behind it actually
   * breaks line of sight to the player, and if it is not already claimed.
   * Only the top few candidates get a raycast — the rest are rejected on
   * cheap geometry.
   */
  _pickCover(ctx, away) {
    const dir = this.director;
    const nav = dir?.nav;
    const pts = ctx.world?.coverPoints;
    if (!nav?.ready || !pts || !pts.length || !ctx.player) return false;
    if (!dir.takeCoverSlot()) return false;

    const s = this._s;
    const me = this.root.position;
    const pp = ctx.player.position;
    const pEyeY = pp.y + (ctx.player.crouching ? 1.02 : 1.55);

    let best = -1, bestScore = -1e9;
    let bestX = 0, bestZ = 0, bestY = 0;
    let probes = 0;

    // Sample a rotating window so 16 agents don't all evaluate the same points.
    const n = pts.length;
    const start = (this.id * 7 + (dir.tick | 0)) % n;
    const stride = Math.max(1, Math.floor(n / 22));

    for (let k = 0; k < n; k += stride) {
      const idx = (start + k) % n;
      if (dir.isCoverClaimed(idx, this)) continue;
      const c = pts[idx];

      const dxm = c.x - me.x, dzm = c.z - me.z;
      const dm = Math.sqrt(dxm * dxm + dzm * dzm);
      if (dm > (away ? 34 : 22) || dm < 1.0) continue;

      const dxp = c.x - pp.x, dzp = c.z - pp.z;
      const dp = Math.sqrt(dxp * dxp + dzp * dzp);
      if (dp < 5.0) continue;                       // do not hide in his lap
      if (away && dp < this.distToPlayer * 0.9) continue;

      // The slot is on the far side of the object from the player.
      const inv = dp > 1e-4 ? 1 / dp : 0;
      const sx = c.x + dxp * inv * 0.95;
      const sz = c.z + dzp * inv * 0.95;
      if (!nav.isWalkableAt(sx, sz)) continue;
      const sy = nav.sampleFloorAt(sx, sz);
      if (!(sy === sy)) continue;

      let score = -dm * 0.55 - Math.abs(dp - (away ? 32 : 17)) * 0.30;
      // Prefer cover that keeps us pointed at the fight.
      if (!away) {
        const toP = (-dxp * inv) * (dxm / (dm || 1)) + (-dzp * inv) * (dzm / (dm || 1));
        score += toP * 3.0;
      }
      if (score < bestScore) continue;

      // Only now is it worth a raycast: does standing there actually break LoS?
      if (probes < 3) {
        probes++;
        const blocked = !nav.rayClear(sx, sy + 1.35, sz, pp.x, pEyeY, pp.z);
        score += blocked ? 7.0 : -3.5;
      }
      if (score > bestScore) {
        bestScore = score; best = idx; bestX = sx; bestZ = sz; bestY = sy;
      }
    }

    if (best < 0) return false;
    if (this.coverIndex >= 0) dir.releaseCover(this.coverIndex, this);
    dir.claimCover(best, this);
    this.coverIndex = best;
    this.coverSlot.set(bestX, bestY, bestZ);
    this.peekTimer = 0;
    this.repathTimer = 0;
    this.inCover = false;
    return true;
  }

  /** A point off to one side of the player — the enemy tries to change angle. */
  _pickFlank(ctx) {
    const nav = this.director?.nav;
    const p = ctx.player;
    if (!nav?.ready || !p) return false;
    const me = this.root.position;
    const dx = me.x - p.position.x, dz = me.z - p.position.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const side = this.rng() < 0.5 ? 1 : -1;
    const base = Math.atan2(dz, dx);
    for (let i = 0; i < 4; i++) {
      const a = base + side * (0.6 + i * 0.35);
      const r = THREE.MathUtils.clamp(d * (0.8 + this.rng() * 0.4), 7, 30);
      const x = p.position.x + Math.cos(a) * r;
      const z = p.position.z + Math.sin(a) * r;
      if (!nav.isWalkableAt(x, z)) continue;
      this.moveGoal.set(x, nav.sampleFloorAt(x, z), z);
      this.hasMoveGoal = true;
      this.repathTimer = 0;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------- locomotion ---

  _moveTo(ctx, goal, urgent) {
    const nav = this.director?.nav;
    if (!nav?.ready) return;
    this.moveGoal.copy(goal);
    this.hasMoveGoal = true;

    const drift = this.path.valid
      ? this.path.goal.distanceToSquared(goal) : Infinity;
    const needs = !this.path.valid || this.path.done || drift > 4.0
      || this.repathTimer <= 0 || this.stuckTimer > 1.2;

    if (needs) {
      const r = nav.requestPath(this.root.position, goal, this.path, urgent);
      if (r === 'ok') {
        this.repathTimer = 0.9 + this.rng() * 0.7;
        this.stuckTimer = 0;
      } else if (r === 'fail') {
        this.repathTimer = 1.4;
        this.path.reset();
      }
      // 'busy' — keep the old path and try again next tick.
    }
  }

  _locomote(dt, ctx) {
    const nav = this.director?.nav;
    const s = this._s;
    const pos = this.root.position;

    // --- desired direction ------------------------------------------------
    let wantX = 0, wantZ = 0, speed = 0;
    if (this.hasMoveGoal && this.path.valid && !this.path.done && nav?.ready) {
      this.path.current(s.v1);
      let dx = s.v1.x - pos.x, dz = s.v1.z - pos.z;
      let d = Math.sqrt(dx * dx + dz * dz);
      const arrive = this.path.index >= this.path.count - 1 ? 0.55 : 0.85;
      if (d < arrive) {
        this.path.advance();
        if (!this.path.done) {
          this.path.current(s.v1);
          dx = s.v1.x - pos.x; dz = s.v1.z - pos.z;
          d = Math.sqrt(dx * dx + dz * dz);
        }
      }
      if (!this.path.done && d > 1e-3) {
        wantX = dx / d; wantZ = dz / d;
        speed = this._moveSpeed();
      }
    } else if (this.hasMoveGoal && !this.path.valid) {
      // No path yet — steer straight at it so they don't stand still looking
      // stupid while the planner is backed up.
      const dx = this.moveGoal.x - pos.x, dz = this.moveGoal.z - pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.7) { wantX = dx / d; wantZ = dz / d; speed = this._moveSpeed() * 0.7; }
    }

    // --- grid-based wall avoidance (no raycasts) --------------------------
    if (speed > 0 && nav?.ready && !nav.clearAhead(pos.x, pos.z, wantX, wantZ, 0.75)) {
      let ok = false;
      for (const a of TURN_TRIES) {
        const c = Math.cos(a), sn = Math.sin(a);
        const nx2 = wantX * c - wantZ * sn, nz2 = wantX * sn + wantZ * c;
        if (nav.clearAhead(pos.x, pos.z, nx2, nz2, 0.75)) {
          wantX = nx2; wantZ = nz2; ok = true; break;
        }
      }
      if (!ok) speed = 0;
    }

    // --- integrate --------------------------------------------------------
    // Separation is added after the steering solve, which means it can shove
    // an agent that had a clear path straight into a wall. The grid is
    // therefore a hard constraint on the final step, not just an advisory:
    // a body may never end a tick on a cell it is not allowed to stand on.
    const tx = wantX * speed + this.separation.x;
    const tz = wantZ * speed + this.separation.z;
    const k = 1 - Math.exp(-TUNE.accel * dt);
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;

    const nextX = pos.x + this.velocity.x * dt;
    const nextZ = pos.z + this.velocity.z * dt;

    if (!nav?.ready) {
      pos.x = nextX; pos.z = nextZ;
    } else if (!nav.isWalkableAt(pos.x, pos.z)) {
      // Started off-mesh (spawned badly, or shoved by a pile-up): walk back to
      // the last footprint we know was legal.
      pos.x = approach(pos.x, this.lastProgress.x, 10, dt);
      pos.z = approach(pos.z, this.lastProgress.z, 10, dt);
      this.velocity.multiplyScalar(0.4);
    } else if (nav.isWalkableAt(nextX, nextZ)) {
      pos.x = nextX; pos.z = nextZ;
      this.lastProgress.x = nextX; this.lastProgress.z = nextZ;
    } else if (nav.isWalkableAt(nextX, pos.z)) {
      pos.x = nextX; this.velocity.z *= 0.15;      // slide along Z-facing wall
      this.lastProgress.x = nextX;
    } else if (nav.isWalkableAt(pos.x, nextZ)) {
      pos.z = nextZ; this.velocity.x *= 0.15;      // slide along X-facing wall
      this.lastProgress.z = nextZ;
    } else {
      this.velocity.multiplyScalar(0.25);          // cornered
    }

    // --- ground clamp from the nav grid, not a raycast --------------------
    if (nav?.ready) {
      const fy = nav.sampleFloorAt(pos.x, pos.z);
      if (fy === fy) { pos.y = approach(pos.y, fy, 14, dt); this.lastProgress.y = fy; }
    }

    // --- stuck detection --------------------------------------------------
    const moving = speed > 0.1;
    const actual = Math.hypot(this.velocity.x, this.velocity.z);
    this.stuckTimer = (moving && actual < speed * 0.25) ? this.stuckTimer + dt : 0;

    // --- facing -----------------------------------------------------------
    if (!this.hasLos && this.state !== STATE.ENGAGE && this.state !== STATE.SUPPRESS
        && this.state !== STATE.COVER && moving) {
      this.yawTarget = yawFromDir(wantX, wantZ);
    }
    const turn = 1 - Math.exp(-TUNE.turnRate * dt);
    this.yaw += angleDelta(this.yaw, this.yawTarget) * turn;
    this.root.rotation.y = this.yaw;

    // --- crouch / gait weights -------------------------------------------
    this.crouch = approach(this.crouch, this.crouchTarget, 6, dt);
    const sp = actual;
    this.moveAmt = approach(this.moveAmt, THREE.MathUtils.clamp(sp / TUNE.walkSpeed, 0, 1), 7, dt);
    this.runAmt = approach(this.runAmt,
      THREE.MathUtils.clamp((sp - TUNE.walkSpeed) / (TUNE.runSpeed - TUNE.walkSpeed), 0, 1), 5, dt);
    this.separation.set(0, 0, 0);
  }

  _moveSpeed() {
    switch (this.state) {
      case STATE.PATROL: return TUNE.patrolSpeed;
      case STATE.SEARCH: return TUNE.walkSpeed * 1.35;
      case STATE.RETREAT: return TUNE.runSpeed;
      case STATE.COVER: return TUNE.runSpeed * 0.92;
      case STATE.REPOSITION: return TUNE.combatSpeed;
      default: return TUNE.combatSpeed * 0.7;
    }
  }

  // ------------------------------------------------------------- gunnery ---

  _gunnery(dt, ctx) {
    const p = ctx.player;
    if (!p) return;

    this.recoil = approach(this.recoil, 0, 11, dt);

    // --- reload -----------------------------------------------------------
    if (this.reloadTimer > 0) {
      const before = this.reloadTimer;
      this.reloadTimer -= dt;
      if (this.reloadStage === 0 && before > TUNE.reloadTime * 0.62 && this.reloadTimer <= TUNE.reloadTime * 0.62) {
        this.reloadStage = 1;
        ctx.audio?.play?.('magOut', { position: this.root.position, volume: 0.5 });
      } else if (this.reloadStage === 1 && this.reloadTimer <= TUNE.reloadTime * 0.26) {
        this.reloadStage = 2;
        ctx.audio?.play?.('magIn', { position: this.root.position, volume: 0.5 });
      }
      if (this.reloadTimer <= 0) {
        this.ammo = TUNE.magSize;
        this.reloadStage = 0;
        ctx.audio?.play?.('boltForward', { position: this.root.position, volume: 0.45 });
      }
      return;
    }
    if (this.ammo <= 0) {
      this.reloadTimer = TUNE.reloadTime;
      this.reloadStage = 0;
      this.burstLeft = 0;
      ctx.audio?.play?.('reloadRustle', { position: this.root.position, volume: 0.4 });
      return;
    }

    // --- may we shoot at all? --------------------------------------------
    const engaging = this.state === STATE.ENGAGE || this.state === STATE.SUPPRESS
                  || (this.state === STATE.COVER && this.inCover && this.hasLos);
    if (!engaging || p.dead || this.reaction > 0) { this.burstLeft = 0; return; }

    const suppressing = this.state === STATE.SUPPRESS || !this.hasLos;
    if (suppressing && !this.hasLastKnown) { this.burstLeft = 0; return; }
    if (this.distToPlayer > TUNE.range) { this.burstLeft = 0; return; }

    // Aim converges the longer they hold the target. First contact is sloppy.
    const warm = THREE.MathUtils.clamp(this.losTime / TUNE.aimTime, 0, 1);
    this.aimQuality = warm * (1 - this.flinch * 0.7) * (1 + this.crouch * 0.14);

    // --- burst pacing -----------------------------------------------------
    if (this.burstLeft > 0) {
      this.fireTimer -= dt;
      if (this.windUp > 0) { this.windUp -= dt; return; }
      if (this.fireTimer <= 0) {
        this._fire(dt, ctx, suppressing);
        this.fireTimer = TUNE.shotInterval * (0.86 + this.rng() * 0.3);
        this.burstLeft--;
        if (this.burstLeft <= 0) {
          const gapScale = this.token ? 1 : 2.1;
          this.burstGap = (TUNE.burstGapMin + this.rng() * (TUNE.burstGapMax - TUNE.burstGapMin)) * gapScale;
        }
      }
      return;
    }

    this.burstGap -= dt;
    if (this.burstGap > 0) return;
    // Non-token enemies are allowed to shoot, but only to keep the pressure
    // on — the director decides who is actually permitted to kill you.
    if (!this.token && !suppressing && this.rng() < 0.80) { this.burstGap = 0.5; return; }
    if (!this.director?.requestFireSlot(this)) { this.burstGap = 0.18; return; }

    this.burstLeft = TUNE.burstMin + ((this.rng() * (TUNE.burstMax - TUNE.burstMin + 1)) | 0);
    this.burstLeft = Math.min(this.burstLeft, this.ammo);
    this.windUp = TUNE.windUp * (this.shotsFired === 0 ? 1.6 : 1.0);
    this.fireTimer = 0;
  }

  _fire(dt, ctx, suppressing) {
    const p = ctx.player;
    const s = this._s;
    this.ammo--;
    this.shotsFired++;
    this.recoil = Math.min(0.9, this.recoil + 0.42);

    this.muzzle.updateWorldMatrix(true, false);
    s.muzzle.setFromMatrixPosition(this.muzzle.matrixWorld);

    // Where they think the target is.
    const aimAt = s.tgt;
    if (this.hasLos) {
      aimAt.set(p.position.x, p.position.y + (p.crouching ? 0.62 : 1.02), p.position.z);
    } else {
      aimAt.copy(this.lastKnown);
      aimAt.y += 1.0;
    }

    const dx = aimAt.x - s.muzzle.x, dy = aimAt.y - s.muzzle.y, dz = aimAt.z - s.muzzle.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

    // Cone half-angle from aim quality, widened by suppression and movement.
    let spread = THREE.MathUtils.lerp(TUNE.spreadCold, TUNE.spreadWarm, this.aimQuality);
    if (suppressing) spread *= 2.6;
    if (this.moveAmt > 0.4) spread *= 1.45;
    spread *= 1 + this.flinch * 1.2;

    // Sample a point on the disc of miss-distance at the target's range.
    const off = spread * dist;
    const a = this.rng() * TAU;
    const r = Math.sqrt(this.rng()) * off;
    // Horizontal error is more forgiving than vertical: shots that sail high
    // read as "suppressed" rather than "the AI cannot aim".
    let ex = Math.cos(a) * r;
    let ey = Math.sin(a) * r * 1.35 + off * 0.25;

    // Orthonormal basis around the shot direction. `right` is horizontal
    // (i x worldUp), `up` closes the frame; both are unit length.
    const ix = dx / dist, iy = dy / dist, iz = dz / dist;
    let rx = iz, rz = -ix;
    const rl = Math.sqrt(rx * rx + rz * rz);
    if (rl < 1e-5) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
    // up = right x forward  (right.y is 0)
    const ux = -rz * iy;
    const uy = rz * ix - rx * iz;
    const uz = rx * iy;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;

    s.end.set(
      aimAt.x + rx * ex + (ux / ul) * ey,
      aimAt.y + (uy / ul) * ey,
      aimAt.z + rz * ex + (uz / ul) * ey
    );

    // --- feedback ---------------------------------------------------------
    ctx.fx?.muzzleFlash?.(this.muzzle.matrixWorld, 0.9);
    ctx.fx?.tracer?.(s.muzzle, s.end, 900);
    ctx.audio?.play?.('rifleFire', { position: s.muzzle, volume: 0.85 });
    this.director?.onShotFired(this, ctx);

    // --- did it connect? --------------------------------------------------
    if (!this.hasLos || suppressing) return;
    const miss = Math.sqrt(ex * ex + ey * ey);
    const bodyR = TUNE.hitRadius * (p.crouching ? 0.78 : 1.0);
    if (miss > bodyR) return;

    let dmg = TUNE.damage;
    if (!this.token) dmg *= TUNE.suppressDamageScale;
    // Falloff — a rifle at 60 m should not hit like one at 8 m.
    if (dist > 30) dmg *= THREE.MathUtils.lerp(1, 0.55, Math.min(1, (dist - 30) / 40));
    p.applyDamage?.(dmg, s.muzzle);
  }

  // ------------------------------------------------------------- damage ----

  /**
   * @param {number} amount
   * @param {'head'|'chest'|'limb'} zone
   * @param {THREE.Vector3} dir  travel direction of the round
   */
  applyDamage(amount, zone, dir) {
    if (!this.active || !this.alive) return;
    const ctx = this.director?.ctx;
    const s = this._s;

    // A rifle round to an unarmoured head ends it. Anything less and the
    // player learns that headshots are optional, which they must never be.
    let dmg = amount;
    if (zone === 'head') dmg = Math.max(amount, this.maxHealth + 1);
    else if (zone === 'limb') dmg = amount;

    this.health -= dmg;

    // Blood at the zone that was actually struck.
    const zi = zone === 'head' ? 0 : (zone === 'limb' ? 3 : 1);
    s.v1.copy(this.hitZones[zi].center);
    if (dir) s.n.copy(dir).negate().normalize(); else s.n.set(0, 1, 0);
    s.v1.addScaledVector(s.n, this.hitZones[zi].radius * 0.85);
    ctx?.fx?.bloodImpact?.(s.v1, s.n);

    // Flinch: a spring impulse pushed along the round's travel direction.
    if (dir) {
      const local = Math.atan2(dir.x, dir.z);
      const rel = angleDelta(this.yaw + Math.PI, local);
      const mag = THREE.MathUtils.clamp(dmg / 45, 0.1, 0.85);
      this.staggerVX += Math.cos(rel) * mag * 9;
      this.staggerVZ += Math.sin(rel) * mag * 9;
    }
    this.flinch = Math.min(1, this.flinch + THREE.MathUtils.clamp(dmg / 40, 0.15, 0.8));

    // Being shot at is information.
    if (!this.alerted) { this.alerted = true; this.reaction = this._reactionTime() * 0.6; }
    this.suspicion = 1;
    if (ctx?.player && !this.hasLastKnown) {
      this.lastKnown.copy(ctx.player.position);
      this.hasLastKnown = true;
    }
    this.director?.onEnemyHurt(this, dmg, dir);

    if (this.health <= 0) this._die(dir, zone, ctx);
    else if (this.state === STATE.IDLE || this.state === STATE.PATROL) this._setState(STATE.ALERT);
  }

  _die(dir, zone, ctx) {
    this.health = 0;
    this.alive = false;
    this.state = STATE.DEAD;
    this.deathTime = 0;
    this.corpseTimer = 0;
    this.burstLeft = 0;
    this.path.reset();
    this.hasMoveGoal = false;

    // Ragdoll-lite: the body tips over about the feet, along the direction the
    // round was travelling, with the initial angular velocity scaled by where
    // it hit. Gravity does the rest.
    let dx = dir ? dir.x : 0, dz = dir ? dir.z : 0;
    let l = Math.sqrt(dx * dx + dz * dz);
    if (l < 1e-3) {
      const a = this.rng() * TAU;
      dx = Math.cos(a); dz = Math.sin(a); l = 1;
    }
    this.fallDirX = dx / l;
    this.fallDirZ = dz / l;
    this.fallAngle = 0;
    this.fallVel = (zone === 'head' ? 1.5 : 0.75) + this.rng() * 0.7;
    // Small random joint offsets so no two bodies land in the same shape.
    for (let i = 0; i < this.limp.length; i++) this.limp[i] = (this.rng() - 0.5) * 0.7;

    ctx?.audio?.play?.('enemyDeath', { position: this.root.position });
    ctx?.hud?.killfeed?.('YOU', 'HOSTILE', 'rifle', zone === 'head');
    if (this.coverIndex >= 0) { this.director?.releaseCover(this.coverIndex, this); this.coverIndex = -1; }
    this.director?.onEnemyKilled(this);
  }

  _updateCorpse(dt, ctx) {
    this.deathTime += dt;
    this.deadW = approach(this.deadW, 1, 9, dt);

    // Tipping torque grows as the centre of mass swings past the feet, then
    // the ground catches the body and a stiff damped spring settles it flat.
    if (this.fallAngle < FLAT_ANGLE) {
      this.fallVel += 5.8 * Math.sin(this.fallAngle + 0.25) * dt;
      this.fallVel *= Math.exp(-0.7 * dt);
    } else {
      const k = 95, c = 14;
      this.fallVel += (-k * (this.fallAngle - FLAT_ANGLE) - c * this.fallVel) * dt;
    }
    this.fallAngle = THREE.MathUtils.clamp(this.fallAngle + this.fallVel * dt, 0, FLAT_ANGLE + 0.16);

    // Residual slide, then friction.
    this.root.position.x += this.velocity.x * dt;
    this.root.position.z += this.velocity.z * dt;
    this.velocity.multiplyScalar(Math.exp(-6 * dt));

    const nav = this.director?.nav;
    if (nav?.ready) {
      const fy = nav.sampleFloorAt(this.root.position.x, this.root.position.z);
      if (fy === fy) this.root.position.y = approach(this.root.position.y, fy, 10, dt);
    }

    this._animate(dt, ctx);

    this.corpseTimer += dt;
    if (this.corpseTimer > TUNE.corpseTime) {
      const t = (this.corpseTimer - TUNE.corpseTime) / TUNE.sinkTime;
      this.root.position.y -= dt * 0.55;
      if (t >= 1) this.despawn();
    }
    this.root.updateMatrixWorld(true);
  }

  // ----------------------------------------------------------- animation ---

  _animate(dt, ctx) {
    const B = this.bones;
    const dead = this.deadW;
    const live = 1 - dead;

    // --- gait phase -------------------------------------------------------
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const stride = THREE.MathUtils.lerp(1.05, 1.85, this.runAmt);
    if (speed > 0.15) this.gait += (speed / stride) * TAU * dt;
    else this.gait += dt * 1.1;              // idle breathing keeps time moving
    if (this.gait > TAU) this.gait -= TAU;

    const ph = this.gait;
    const sinP = Math.sin(ph), cosP = Math.cos(ph);
    const m = this.moveAmt;
    const run = this.runAmt;
    const cr = this.crouch;

    // --- pose weights -----------------------------------------------------
    this.aimW = approach(this.aimW, this.aimWTarget, 5.5, dt);
    const aim = this.aimW * live;

    // --- stagger spring ---------------------------------------------------
    const k = 120, c = 15;
    this.staggerVX += (-k * this.staggerX - c * this.staggerVX) * dt;
    this.staggerVZ += (-k * this.staggerZ - c * this.staggerVZ) * dt;
    this.staggerX += this.staggerVX * dt;
    this.staggerZ += this.staggerVZ * dt;
    const stagX = THREE.MathUtils.clamp(this.staggerX, -0.55, 0.55) * live;
    const stagZ = THREE.MathUtils.clamp(this.staggerZ, -0.55, 0.55) * live;

    // --- aim direction (upper body points at the target) -------------------
    if (aim > 0.001) {
      const t = this.hasLos && ctx?.player ? ctx.player.position : this.lastKnown;
      const ty = this.hasLos && ctx?.player
        ? ctx.player.position.y + (ctx.player.crouching ? 0.62 : 1.02)
        : this.lastKnown.y + 1.0;
      const dx = t.x - this.root.position.x;
      const dz = t.z - this.root.position.z;
      const dy = ty - (this.root.position.y + 1.35);
      const flat = Math.sqrt(dx * dx + dz * dz);
      this.aimPitch = approach(this.aimPitch,
        THREE.MathUtils.clamp(Math.atan2(dy, Math.max(0.4, flat)), -0.75, 0.75), 9, dt);
      this.aimYaw = approach(this.aimYaw,
        THREE.MathUtils.clamp(angleDelta(this.yaw, yawFromDir(dx, dz)), -0.7, 0.7), 9, dt);
    } else {
      this.aimPitch = approach(this.aimPitch, 0, 5, dt);
      this.aimYaw = approach(this.aimYaw, 0, 5, dt);
    }

    // --- crouch geometry (hip forward, knee back, drop the pelvis) ---------
    // The leg is 0.86 m hip-to-ankle. Bending the hip by `crHip` and the knee
    // by twice that keeps the shin's lower end under the hip, so the pelvis
    // drop is exactly the foreshortening — derive it rather than guess, or the
    // boots sink through the floor at partial crouch weights.
    const crHip = 1.05 * cr;
    const crKnee = 2 * crHip;

    // --- fighting stance --------------------------------------------------
    // A soldier who has stopped walking does not stand to attention. He stands
    // with a wide base, weak-side foot forward, toes turned out, knees soft and
    // his weight over the front foot. Heels together and bolt upright is the
    // posture of a shop mannequin and it is the single cue that makes a figure
    // read as a prop instead of a threat — worse, a symmetrical stick is also
    // the least informative shape possible about which way somebody is facing.
    // It fades out as the gait fades in, so this costs nothing while walking.
    const st = (1 - m) * (1 - cr * 0.5) * live;
    const stSplay = 0.125 * st;      // knees and toes turned out
    const stStride = 0.155 * st;     // weak-side (left) foot forward
    const stKnee = 0.27 * st;
    const stHip = 0.10 * st;
    // Lean at the ankles, not by folding the spine — the boots counter-rotate
    // below so the soles stay flat on the ground.
    const lean0 = (0.100 - 0.038 * aim) * st;

    // --- legs -------------------------------------------------------------
    const swing = (0.52 + run * 0.34) * m;
    const kneeAmp = (0.55 + run * 0.55) * m;
    let lowestDrop = 0, holdLow = 0;
    for (let i = 0; i < 2; i++) {
      const L = this._legs[i];
      const o = i === 0 ? 0 : Math.PI;
      const out = i === 0 ? -1 : 1;
      const sp = Math.sin(ph + o);
      const hipA = sp * swing + crHip + 0.04 * m + stHip + out * -stStride;
      // Knee only bends on the recovery half of the stride.
      const bend = Math.max(0, -Math.sin(ph + o - 0.65)) * kneeAmp + 0.10 * m + crKnee + stKnee;
      const ankA = THREE.MathUtils.clamp(-(hipA - bend) * 0.85, -0.65, 0.65)
                 + Math.max(0, Math.sin(ph + o + 0.9)) * 0.35 * m;

      // How far this ankle sits below the hip pivot, for the planting pass —
      // once for the live pose, and once with the gait terms taken back out.
      // The second one is the *held* part of the pose (crouch plus stance),
      // and it has to be compensated exactly rather than damped, because any
      // error in a pose that is being held is permanent hover.
      const drop = Math.cos(stSplay)
        * (0.44 * Math.cos(hipA) + 0.42 * Math.cos(hipA - bend));
      if (drop > lowestDrop) lowestDrop = drop;

      const hipH = crHip + stHip - out * stStride;
      const bendH = crKnee + stKnee;
      const dropH = Math.cos(stSplay)
        * (0.44 * Math.cos(hipH) + 0.42 * Math.cos(hipH - bendH));
      if (dropH > holdLow) holdLow = dropH;

      // Death targets stay close to straight: a dropped body is a roughly
      // planar shape, and folded limbs are what push knees through the floor.
      const li = i * 3;
      L.thigh.rotation.x = THREE.MathUtils.lerp(hipA, 0.12 + this.limp[li] * 0.45, dead);
      L.thigh.rotation.z = THREE.MathUtils.lerp(out * stSplay, this.limp[li] * 0.35, dead);
      L.shin.rotation.x = THREE.MathUtils.lerp(-bend, -0.28 + this.limp[li + 1] * 0.4, dead);
      L.ankle.rotation.x = THREE.MathUtils.lerp(ankA - lean0, this.limp[li + 2] * 0.35, dead);
      L.ankle.rotation.y = THREE.MathUtils.lerp(out * stSplay * 1.5, 0, dead);
    }

    // --- pelvis / body ----------------------------------------------------
    const bobY = Math.sin(ph * 2) * (0.020 + run * 0.016) * m;
    const sway = cosP * 0.028 * m;
    const flatness = this.fallAngle / FLAT_ANGLE;

    // Plant the feet. A bent leg is shorter than a straight one, so the pelvis
    // has to come down by exactly the foreshortening of whichever leg is
    // reaching lowest, or the boots hover. The crouch part is applied in full
    // (it is a held pose and any error is permanent); the striding part is
    // damped, standing in for the ankle roll and pelvic tilt this rig has no
    // joints for — at full extension it would otherwise pogo.
    const holdDrop = Math.max(0, 0.86 - holdLow);
    const gaitDrop = Math.max(0, (0.86 - lowestDrop) - holdDrop);
    const plant = holdDrop + gaitDrop * 0.55;

    // Once dead, lift as the body goes flat: the pivot is at the feet, not the
    // centre of mass, so a flat body would otherwise lie inside the floor.
    B.body.position.y = THREE.MathUtils.lerp(
      bobY - plant, -0.04 + flatness * 0.26, dead) + Math.abs(stagX) * -0.03;

    if (dead > 0.001) {
      // Rotate about a single horizontal axis so the body genuinely reaches
      // flat. `up x fallDir` tilts the body's up vector toward the direction
      // the round was travelling.
      _fallAxis.set(this.fallDirZ, 0, -this.fallDirX);
      if (_fallAxis.lengthSq() < 1e-8) _fallAxis.set(1, 0, 0);
      else _fallAxis.normalize();
      B.body.quaternion.setFromAxisAngle(_fallAxis, this.fallAngle * dead);
    } else {
      B.body.rotation.set(lean0, 0, sway);
    }

    B.hips.rotation.y = THREE.MathUtils.lerp(sinP * 0.11 * m, 0, dead);
    B.hips.rotation.x = THREE.MathUtils.lerp(0.03 * m + cr * 0.10, this.limp[6] * 0.2, dead);

    // --- chest: counter-rotate against the hips, then layer the aim in -----
    // Only half the ankle lean is given back at the chest, so the shoulders
    // finish forward of the hips — that offset is what makes the stance read as
    // braced rather than as a plank tipped over.
    const lean = (0.05 + run * 0.16) * m + cr * 0.20 - lean0 * 0.5;
    const chestYaw = THREE.MathUtils.lerp(
      -sinP * 0.15 * m + this.aimYaw * aim, this.limp[6] * 0.4, dead);
    const chestPitch = THREE.MathUtils.lerp(
      lean + this.aimPitch * aim + stagX * 0.55 - this.recoil * 0.05,
      0.10 + this.limp[7] * 0.25, dead);
    B.chest.rotation.y = chestYaw;
    B.chest.rotation.x = chestPitch;
    B.chest.rotation.z = THREE.MathUtils.lerp(-sinP * 0.045 * m + stagZ * 0.5, this.limp[8] * 0.3, dead);

    // --- head: stabilised against both twists, then looks where they aim ---
    const headYaw = THREE.MathUtils.lerp(
      -(B.hips.rotation.y + chestYaw) * 0.7 + this.aimYaw * aim * 0.45,
      this.limp[9] * 0.8, dead);
    B.head.rotation.y = headYaw;
    B.head.rotation.x = THREE.MathUtils.lerp(
      -chestPitch * 0.75 - lean0 * 0.55 + this.aimPitch * aim * 0.4
        + Math.sin(ph * 2) * 0.012 * m,
      0.22 + this.limp[10] * 0.35, dead);
    B.head.rotation.z = THREE.MathUtils.lerp(-sway * 0.6, this.limp[11] * 0.5, dead);

    // --- arms: both hands stay on the weapon for as long as he is alive ----
    // The old rig faded the arms out to a relaxed swing whenever the agent was
    // not actively engaging, which meant a patrolling hostile walked around
    // with his hands empty and a rifle floating near his hip — at 12 m that
    // silhouette is a civilian. There is now exactly one live pose family, and
    // `aimPose` fades it between low ready and shouldered. Both ends are
    // solved so the hands land on the weapon rather than near it.
    // Weapon comes up to fire and settles back to the ready carry afterwards.
    // This is the other half of the silhouette problem: a rifle shouldered and
    // pointed at the camera is, by construction, a shape with no width — no
    // pose work can rescue it. An agent who shoulders only when he is about to
    // shoot spends most of his time in the READY carry instead, which is 0.64 m
    // of weapon straight across the torso, and the moment he does come up is
    // now a telegraph the player can act on. `windUp` fires 0.26-0.42 s before
    // the first round, so he is fully shouldered by the time it leaves.
    if (this.burstLeft > 0 || this.windUp > 0 || this.recoil > 0.06) this.shoulder = 1.25;
    else this.shoulder = Math.max(0, this.shoulder - dt);
    const wantAim = this.aimWTarget > 0.9 && (this.shoulder > 0 || this.distToPlayer < 7);
    this.aimPose = approach(this.aimPose, wantAim ? 1 : 0, 6.5, dt);
    const ap = this.aimPose;
    // A little residual gait in the shoulders so the carry is not rigid.
    const armBob = sinP * 0.055 * m * (1 - ap * 0.55);
    for (let i = 0; i < 5; i++) {
      _gripL[i] = THREE.MathUtils.lerp(GRIP_READY.l[i], GRIP_AIM.l[i], ap);
      _gripR[i] = THREE.MathUtils.lerp(GRIP_READY.r[i], GRIP_AIM.r[i], ap);
    }
    _gripL[0] += armBob;
    _gripR[0] -= armBob;

    this._poseArm(B.upperArmL, B.foreArmL, _gripL, dead, 0, -1);
    this._poseArm(B.upperArmR, B.foreArmR, _gripR, dead, 3, 1);

    // --- contact shadow ---------------------------------------------------
    // Widens as the body goes flat so a corpse is not grounded by a coin.
    const sc = 1 + cr * 0.12 + flatness * dead * 1.05;
    if (Math.abs(sc - this._shadowScale) > 0.01) {
      this._shadowScale = sc;
      this.shadow.scale.set(sc, 1, sc);
      this.shadow.updateMatrix();
    }

    // --- weapon mount ------------------------------------------------------
    const mount = B.mount;
    const rec = this.recoil;
    mount.position.set(
      THREE.MathUtils.lerp(GRIP_READY.p[0], GRIP_AIM.p[0], ap),
      THREE.MathUtils.lerp(GRIP_READY.p[1], GRIP_AIM.p[1], ap),
      THREE.MathUtils.lerp(GRIP_READY.p[2], GRIP_AIM.p[2], ap) + rec * 0.05
    );
    mount.rotation.set(
      THREE.MathUtils.lerp(GRIP_READY.rot[0], GRIP_AIM.rot[0], ap) + rec * 0.16
        + (this.reloadTimer > 0 ? 0.5 : 0),
      THREE.MathUtils.lerp(GRIP_READY.rot[1], GRIP_AIM.rot[1], ap),
      THREE.MathUtils.lerp(GRIP_READY.rot[2], GRIP_AIM.rot[2], ap)
        + (this.reloadTimer > 0 ? -0.45 : 0)
    );
    if (dead > 0.001) {
      // Dropped weapon. It has to lie along the body's local +Y, because that
      // is the axis that ends up horizontal once the body is flat — pointing
      // it "forward" would stand the rifle on its muzzle.
      mount.position.x = THREE.MathUtils.lerp(mount.position.x, 0.235, dead);
      mount.position.y = THREE.MathUtils.lerp(mount.position.y, 0.020, dead);
      mount.position.z = THREE.MathUtils.lerp(mount.position.z, 0.075, dead);
      mount.rotation.x = THREE.MathUtils.lerp(mount.rotation.x, Math.PI / 2, dead);
      mount.rotation.y = THREE.MathUtils.lerp(mount.rotation.y, 0, dead);
      mount.rotation.z = THREE.MathUtils.lerp(mount.rotation.z, 0.18, dead);
    }
  }

  /**
   * @param {Float32Array} g [shoulder.x, shoulder.y, shoulder.z, elbow.x, elbow.y]
   */
  _poseArm(sh, el, g, dead, li, side) {
    sh.rotation.x = THREE.MathUtils.lerp(g[0], 0.16 + this.limp[li] * 0.45, dead);
    sh.rotation.y = THREE.MathUtils.lerp(g[1], this.limp[li] * 0.4, dead);
    sh.rotation.z = THREE.MathUtils.lerp(g[2], side * 0.42 + this.limp[li + 1] * 0.35, dead);
    el.rotation.x = THREE.MathUtils.lerp(g[3], 0.30 + this.limp[li + 2] * 0.4, dead);
    el.rotation.y = THREE.MathUtils.lerp(g[4], 0, dead);
  }

  // ----------------------------------------------------------- hit zones ---

  /** Rebuild the world-space hit spheres from the current pose. No allocation. */
  _refreshZones() {
    const z = this.hitZones, b = this._zoneBones;
    for (let i = 0; i < z.length; i++) {
      const d = ZONE_DEF[i];
      z[i].center.set(d.ox, d.oy, d.oz).applyMatrix4(b[i].matrixWorld);
    }
  }

  /**
   * World-space hit spheres, mutated in place — Ballistics iterates this array
   * every shot, so it must never allocate.
   * @returns {{center:THREE.Vector3, radius:number, zone:string}[]}
   */
  getHitZones() {
    return this.alive ? this.hitZones : null;
  }

  dispose() {
    this.root.clear();
    this.active = false;
    this.alive = false;
  }
}

/*
 * Grip poses.
 *   l / r : [shoulder.x, shoulder.y, shoulder.z, elbow.x, elbow.y]
 *   p     : weapon-mount position in chest space
 *   rot   : weapon-mount rotation in chest space
 *
 * The arm angles are not eyeballed. For each pose the weapon's grip points —
 * pistol grip at rifle-local (0, -0.030, 0.022), handguard at (0, -0.014,
 * -0.290) — are pushed through the mount transform, and a two-bone solve
 * (upper 0.29, elbow-to-palm 0.30) finds the shoulder Euler and elbow flexion
 * that put the hand centre there, with a pole vector choosing which way the
 * elbow breaks. Residual error is under 8 mm, so the hands actually close on
 * the weapon instead of hovering beside it. Change a mount number and these
 * must be re-solved, or the grip drifts.
 *
 * READY is the pose that carries the whole thing, because a hostile who is not
 * currently shouldered is what the player sees most of the time — and the
 * previous version failed exactly here. Its weapon yawed only 17 deg across
 * the body, so an enemy facing you presented a rifle foreshortened to a stub
 * of about 12 cm: entirely inside a torso half-width of 25 cm, i.e. invisible
 * in silhouette at any range. This one is a stock-in-the-shoulder low ready
 * swung 41 deg across and 17 deg down. The muzzle now sits at chest x -0.348
 * and the buttpad at +0.290 — a 0.64 m horizontal bar straight through the
 * torso outline, roughly 40 px of weapon at 12 m, sticking well clear of the
 * body on both sides no matter which way the agent is facing.
 *
 * AIM still shoulders the weapon square with the chest so the bore lies on the
 * chest's -Z axis (pointing the chest at the target points the gun). A rifle
 * aimed at you is foreshortened by definition, so the silhouette work there is
 * done by the arms instead. The firing elbow is driven out to chest x +0.41 and
 * held high (y 0.420) while the support elbow drops to y 0.368 — both because
 * that is what a real shooter looks like from the front, and because two
 * elbows at the same height read as a scarecrow crossbar, which is the one
 * shape the eye will not accept as a man pointing a rifle at it.
 */
const GRIP_READY = {
  l: [0.409, -0.790, -0.444, 1.515, 0.22],
  r: [-0.290, 0.581, 0.968, 2.483, -0.30],
  p: [0.115, 0.415, -0.185],
  rot: [-0.30, 0.72, 0.06],
};

const GRIP_AIM = {
  l: [1.459, -0.557, 0.508, 0.602, 0.26],
  r: [-0.404, 0.713, 1.661, 2.501, -0.34],
  p: [0.118, 0.438, -0.178],
  rot: [0, 0, -0.10],
};

/** Sidestep angles tried when the grid says the way ahead is blocked. */
const TURN_TRIES = [0.7, -0.7, 1.35, -1.35, 2.2, -2.2];

/** States that keep a claimed cover point rather than handing it back. */
const COVER_KEEP = new Set([STATE.COVER, STATE.ENGAGE, STATE.SUPPRESS, STATE.RETREAT]);

export default Enemy;
