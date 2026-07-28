import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { generateTextureSet } from '../gfx/textures.js';

/*
 * Procedural weapon geometry.
 *
 * Everything is authored in metres from real firearm dimensions, pointing down
 * -Z with +Y up and the origin at the web of the firing hand (top-rear of the
 * pistol grip). Nothing here is a bare box: every prismatic part goes through
 * `chamferBox`, which extrudes a rounded rectangle with a bevel on both ends so
 * that all twelve edges have a real chamfer to catch a highlight. Bodies of
 * revolution (barrels, tubes, turrets) are lathed from explicit profiles with
 * chamfer points at every diameter step.
 *
 * Parts are accumulated into "bins" — one bin per rigid body. Each bin is
 * merged per material at build time, so a whole weapon is ~6 static draw calls
 * plus one per animated sub-assembly, rather than one per bolt and screw.
 *
 * UVs are box-projected at merge time from weapon-space position, so texel
 * density is uniform across every part regardless of how it was generated, and
 * the grain of the gunmetal map runs continuously from one part to the next.
 *
 * Per-part tints ride in a vertex colour attribute (unsigned byte, normalised).
 * They carry a subtle top-lit gradient plus a per-part value shift, which is
 * what stops a monochrome parkerised weapon from reading as one flat grey.
 */

// ---------------------------------------------------------------- constants --

/** Metres of world space covered by one tile of the 512px material maps. */
const TEX_WORLD = 1 / 24;

/** Default chamfer on a prismatic part, in metres. 1.2 mm reads at viewmodel range. */
const C = 0.0012;

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ shapes --

/** Counter-clockwise rounded rectangle centred on the origin, in XY. */
function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = w * 0.5;
  const y = h * 0.5;
  r = Math.min(r, x - 1e-6, y - 1e-6);
  if (!(r > 1e-5)) {
    s.moveTo(-x, -y); s.lineTo(x, -y); s.lineTo(x, y); s.lineTo(-x, y); s.closePath();
    return s;
  }
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r);
  s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y);
  s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r);
  s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  s.closePath();
  return s;
}

/** Circular hole path for use in `Shape.holes`. */
function holeCircle(cx, cy, r) {
  const p = new THREE.Path();
  p.absarc(cx, cy, r, 0, Math.PI * 2, false);
  return p;
}

/**
 * Extrude a shape along Z with a symmetric chamfer at both ends.
 *
 * `bevelOffset = -c` with `bevelSize = c` means the mid-section matches the
 * source outline exactly and only the two ends are drawn in, so the finished
 * solid measures exactly `depth` along Z and exactly the shape's bounds in XY.
 */
function extrudeChamfer(shape, depth, c = C, bevelSegments = 1, curveSegments = 2) {
  const cc = Math.max(0, Math.min(c, depth * 0.45));
  const d = Math.max(depth - 2 * cc, 1e-5);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    steps: 1,
    curveSegments,
    bevelEnabled: cc > 1e-6,
    bevelThickness: cc,
    bevelSize: cc,
    bevelOffset: -cc,
    bevelSegments,
  });
  g.translate(0, 0, -d * 0.5);
  return g;
}

/** Chamfered, corner-rounded box measuring exactly w x h x d, centred on the origin. */
function chamferBox(w, h, d, opts = {}) {
  const {
    c = C,
    r = Math.min(w, h) * 0.18,
    bevelSegments = 1,
    curveSegments = 2,
  } = opts;
  return extrudeChamfer(roundedRect(w, h, r), d, c, bevelSegments, curveSegments);
}

/** Cheap chamfered box for parts that are only a couple of millimetres across. */
function tinyBox(w, h, d, c = 0.0005) {
  return extrudeChamfer(roundedRect(w, h, Math.min(w, h) * 0.22), d, c, 1, 1);
}

/** Hollow chamfered box (a rectangular collar) measuring w x h x d overall. */
function collarBox(w, h, d, wall, opts = {}) {
  const { c = C, r = Math.min(w, h) * 0.16, curveSegments = 2 } = opts;
  const s = roundedRect(w, h, r);
  s.holes.push(roundedRect(w - 2 * wall, h - 2 * wall, Math.max(r - wall, 0.0004)));
  return extrudeChamfer(s, d, c, 1, curveSegments);
}

/**
 * Solid of revolution about the bore axis, pointing down -Z.
 *
 * `profile` is an array of `[radius, z]` ordered from the rearmost point
 * forward (z decreasing). Lathe normals point outward when the source points
 * run in increasing Y, so the profile's Z is negated on the way in and the
 * result is rotated so that the lathe's +Y becomes the weapon's -Z.
 */
function latheZ(profile, seg = 20, phiStart = 0, phiLength = Math.PI * 2) {
  const pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-5), -z));
  const g = new THREE.LatheGeometry(pts, seg, phiStart, phiLength);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ------------------------------------------------------------------- lofts --

/**
 * Counter-clockwise rounded-rectangle ring, generated analytically so every
 * section of a loft has exactly 4*(seg+1) points regardless of its dimensions.
 * `Shape.extractPoints` is not usable here: it de-duplicates coincident points
 * with an exact float compare, so the count wobbles between sections.
 */
function ringPts(w, h, r, seg) {
  const x = w * 0.5;
  const y = h * 0.5;
  const rr = Math.max(0.0002, Math.min(r, x * 0.999, y * 0.999));
  const pts = [];
  const corners = [
    [x - rr, -(y - rr), -Math.PI / 2],
    [x - rr, y - rr, 0],
    [-(x - rr), y - rr, Math.PI / 2],
    [-(x - rr), -(y - rr), Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (Math.PI / 2) * (i / seg);
      pts.push(new THREE.Vector2(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
    }
  }
  return pts;
}

/** Frame matrix for a loft section. */
function frame(x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Matrix4();
  m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
  m.setPosition(x, y, z);
  return m;
}

/**
 * Loft a chain of rounded-rectangle sections into a smooth-shaded solid.
 *
 * Sections are `{ w, h, r, m }`; each cross-section lives in its frame's XY
 * plane and the body runs along each frame's +Z. Used for anything organic:
 * pistol grips, curved magazines, tapering sight towers.
 */
function loft(sections, seg = 3, capStart = true, capEnd = true) {
  const rings = sections.map((s) => {
    const p2 = ringPts(s.w, s.h, s.r === undefined ? Math.min(s.w, s.h) * 0.3 : s.r, seg);
    return p2.map((p) => new THREE.Vector3(p.x, p.y, 0).applyMatrix4(s.m));
  });
  const n = rings[0].length;
  for (const ring of rings) {
    if (ring.length !== n) throw new Error('loft: inconsistent section topology');
  }
  const pos = [];
  const idx = [];
  for (const ring of rings) for (const v of ring) pos.push(v.x, v.y, v.z);

  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = s * n + i;
      const b = s * n + j;
      const c2 = (s + 1) * n + j;
      const d = (s + 1) * n + i;
      idx.push(a, b, c2, a, c2, d);
    }
  }
  let base = rings.length * n;
  if (capStart) {
    const c0 = new THREE.Vector3();
    for (const v of rings[0]) c0.add(v);
    c0.multiplyScalar(1 / n);
    pos.push(c0.x, c0.y, c0.z);
    for (let i = 0; i < n; i++) idx.push(base, (i + 1) % n, i);
    base++;
  }
  if (capEnd) {
    const last = rings[rings.length - 1];
    const o = (rings.length - 1) * n;
    const c1 = new THREE.Vector3();
    for (const v of last) c1.add(v);
    c1.multiplyScalar(1 / n);
    pos.push(c1.x, c1.y, c1.z);
    for (let i = 0; i < n; i++) idx.push(base, o + i, o + ((i + 1) % n));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// -------------------------------------------------------------- transforms --

function at(g, x, y, z) { g.translate(x, y, z); return g; }
function rot(g, rx, ry, rz) {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  return g;
}
/** Rotate then translate, in that order — the common case for placing a part. */
function put(g, x, y, z, rx = 0, ry = 0, rz = 0) { return at(rot(g, rx, ry, rz), x, y, z); }

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// --------------------------------------------------------------- materials --

const OWNED_GEOMETRY = new Set();
const OWNED_MATERIALS = new Set();
const OWNED_TEXTURES = new Set();
let MATS = null;

function ownTextures(set) {
  for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
    if (set[k]) OWNED_TEXTURES.add(set[k]);
  }
  return set;
}

function own(mat) { OWNED_MATERIALS.add(mat); return mat; }

/**
 * Shared material set. Two procedural texture sets (gunmetal, polymer) drive
 * five surface treatments; the variants differ only in tint, roughness scale
 * and normal strength, so the maps are generated once and shared.
 *
 * Every `color` is a multiplier on a shared albedo map, so the numbers are not
 * colours you can read directly — see the VALUE LADDER note on `metal` below
 * before changing any of them. Keep them at or below unity: the renderer runs
 * auto-exposure, and anything authored hot to compensate for a dim frame
 * saturates to white as soon as the exposure comes up.
 */
function getMaterials() {
  if (MATS) return MATS;

  const gun = ownTextures(generateTextureSet('gunmetal', { size: 512, seed: 4471 }));
  const gun2 = ownTextures(generateTextureSet('gunmetal', { size: 512, seed: 4471 }));
  const poly = ownTextures(generateTextureSet('polymer', { size: 512, seed: 2207 }));
  const poly2 = ownTextures(generateTextureSet('polymer', { size: 512, seed: 2207 }));

  const metal = own(new THREE.MeshStandardMaterial({
    map: gun.map,
    normalMap: gun.normalMap,
    roughnessMap: gun.roughnessMap,
    metalnessMap: gun.metalnessMap,
    aoMap: gun.aoMap,
    // Not a pure conductor. A phosphated receiver rendered at metalness 1 has
    // no diffuse term at all, so its whole value comes from the environment and
    // its flanks simply mirror whatever the player is standing on — which is
    // how a black rifle ends up the colour of sand. Backing metalness off gives
    // the dark albedo something to do.
    metalness: 0.82,
    roughness: 0.86,
    vertexColors: true,
    aoMapIntensity: 0.85,
    // Metals take their value from the environment, not from albedo: at unity
    // env intensity a rough steel receiver mirrors a bright sky or a lit
    // warehouse and turns pale regardless of how dark its base colour is.
    envMapIntensity: 0.45,
  }));
  /*
   * VALUE LADDER — read this before touching any colour below.
   *
   * The shared gunmetal albedo map is authored at ~0.22 sRGB (0.040 linear) and
   * the polymer map at ~0.185 sRGB (0.028 linear); every `color` here is a
   * multiplier on top of that, and the per-part vertex tint multiplies again.
   * These used to be pushed well above 1.0 to fight a fixed 0.92 exposure. The
   * renderer now runs auto-exposure over roughly 0.35x-2.6x, so anything
   * authored above unity saturates the moment the player looks somewhere dim
   * and the whole rifle turns to white chrome.
   *
   * So the separation is carried by real albedo differences instead, and the
   * finished sRGB albedos land in this order (times the part tint):
   *
   *   rail slot floor  0.09   barrel / gas system 0.09   optic body 0.09
   *   handguard        0.12   receiver            0.14
   *   polymer furniture 0.19  rail tooth tops     0.20
   *   glove armour     0.21   bare worn steel     0.24   glove shell 0.30
   *
   * i.e. the weapon sits well below mid grey — darker than the concrete it is
   * held against — the worn metal reads as lighter *metal* rather than white,
   * and the hands are the lightest thing in the frame, which is what a
   * viewmodel wants.
   */
  metal.color.setRGB(0.400, 0.408, 0.430);
  metal.normalScale.set(0.85, 0.85);
  metal.name = 'weapon.metal';

  // High-contact surfaces: charging handle, bolt, muzzle device, floorplate,
  // lever tips. Bare steel showing through the finish — lighter and glossier.
  const metalWorn = own(new THREE.MeshStandardMaterial({
    map: gun2.map,
    normalMap: gun2.normalMap,
    roughnessMap: gun2.roughnessMap,
    metalnessMap: gun2.metalnessMap,
    aoMap: gun2.aoMap,
    metalness: 1.0,
    roughness: 0.56,
    vertexColors: true,
    aoMapIntensity: 0.7,
    envMapIntensity: 0.58,
  }));
  metalWorn.color.setRGB(1.12, 1.16, 1.24);
  metalWorn.normalScale.set(0.6, 0.6);
  metalWorn.name = 'weapon.metalWorn';

  const polymer = own(new THREE.MeshStandardMaterial({
    map: poly.map,
    normalMap: poly.normalMap,
    roughnessMap: poly.roughnessMap,
    aoMap: poly.aoMap,
    metalness: 0.0,
    roughness: 0.95,
    vertexColors: true,
    aoMapIntensity: 0.9,
  }));
  // Furniture is a warm grey composite, not black. This is the single biggest
  // lever against the weapon reading as one flat plastic part: the stock and
  // grip have to sit a clear step lighter *and* warmer than the anodised
  // receiver, or the whole gun collapses into one value.
  polymer.color.setRGB(0.94, 0.88, 0.78);
  polymer.normalScale.set(1.0, 1.0);
  polymer.name = 'weapon.polymer';

  // Rubber: buttpad, grip inserts, dust cover interior. Flat and light-eating.
  const rubber = own(new THREE.MeshStandardMaterial({
    map: poly2.map,
    normalMap: poly2.normalMap,
    roughnessMap: poly2.roughnessMap,
    aoMap: poly2.aoMap,
    metalness: 0.0,
    roughness: 1.0,
    vertexColors: true,
    aoMapIntensity: 1.0,
  }));
  rubber.color.setRGB(0.56, 0.55, 0.56);
  rubber.normalScale.set(1.4, 1.4);
  rubber.name = 'weapon.rubber';

  // Optic glass. Real transmission would drag a whole extra render target
  // through the post stack for a 23 mm disc, so this is a thin, very smooth
  // dielectric with a multi-coat tint instead.
  //
  // NOTE: do *not* set premultipliedAlpha here. It switches the blend to
  // (ONE, ONE_MINUS_SRC_ALPHA), so a bright sky reflection is added at full
  // strength on top of the background instead of being mixed in at `opacity`,
  // and the lens renders as a flat white blob. Reflectivity is also kept low
  // and clearcoat off: a coated optic is dark and only flares near grazing
  // angles, it does not mirror the sky.
  const glass = own(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.075, 0.175, 0.185),
    metalness: 0.0,
    roughness: 0.06,
    transparent: true,
    opacity: 0.13,
    ior: 1.52,
    reflectivity: 0.16,
    envMapIntensity: 0.30,
    side: THREE.DoubleSide,
    depthWrite: false,
  }));
  glass.name = 'weapon.glass';

  // The reticle. Additive and transparent so Weapon.js can drive `opacity`
  // and `emissiveIntensity` off the ADS blend; the geometry is three stacked
  // discs so additive accumulation gives a real radial falloff, not a bead.
  const dot = own(new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: new THREE.Color(0.055, 0.0016, 0.0005),
    emissiveIntensity: 8.0,
    roughness: 1.0,
    metalness: 0.0,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  dot.name = 'weapon.dot';

  // Fixed additive bloom seed around the reticle. Kept off `dot` so the ADS
  // brightness ramp cannot drive it to white.
  const dotGlow = own(new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: new THREE.Color(0.085, 0.0035, 0.0010),
    emissiveIntensity: 3.0,
    roughness: 1.0,
    metalness: 0.0,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  dotGlow.name = 'weapon.dotGlow';

  // White-dot front sight paint / tritium inserts on the irons.
  const paint = own(new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: new THREE.Color(0.85, 0.92, 1.0),
    emissiveIntensity: 1.6,
    roughness: 0.6,
    metalness: 0.0,
  }));
  paint.name = 'weapon.sightPaint';

  // Barrel, gas system and muzzle device: hotter-running steel reads darker and
  // rougher than the anodised receiver. Gives the front half its own value.
  const metalDark = own(new THREE.MeshStandardMaterial({
    map: gun.map,
    normalMap: gun.normalMap,
    roughnessMap: gun.roughnessMap,
    metalnessMap: gun.metalnessMap,
    aoMap: gun.aoMap,
    metalness: 0.88,
    roughness: 0.97,
    vertexColors: true,
    aoMapIntensity: 0.9,
    envMapIntensity: 0.36,
  }));
  metalDark.color.setRGB(0.268, 0.270, 0.282);
  metalDark.normalScale.set(1.0, 1.0);
  metalDark.name = 'weapon.metalDark';

  // ---- hands -------------------------------------------------------------
  // Tactical glove: dark synthetic with a fine grain, matte.
  //
  // The value here is load-bearing. A glove authored at a "realistic" black
  // sits below the weapon's own albedo, and since the viewmodel is lit by a
  // single key the whole hand then collapses into one silhouette-less mass —
  // exactly the failure mode the art review called out. A shipped viewmodel
  // glove is always painted a good deal lighter than the reference photo says,
  // so the form shading has somewhere to live.
  const glove = own(new THREE.MeshStandardMaterial({
    map: poly.map,
    normalMap: poly.normalMap,
    roughnessMap: poly.roughnessMap,
    aoMap: poly.aoMap,
    metalness: 0.0,
    roughness: 0.86,
    vertexColors: true,
    aoMapIntensity: 1.0,
  }));
  // Wolf grey, ~0.30 sRGB: the lightest thing on screen, which is what lets the
  // form shading read. Authored black, as reference photos suggest, the hand
  // renders as one silhouette-less mass.
  glove.color.setRGB(2.62, 2.54, 2.44);
  glove.normalScale.set(1.5, 1.5);
  glove.name = 'weapon.glove';

  // Knuckle armour, palm pad and cuff, in a dark earth TPR against the light
  // wolf-grey glove above. The armour was originally the *lighter* of the two
  // and landed within a few percent of the glove's value, so every plate and
  // pad it draws was invisible; running it well below the glove turns the same
  // geometry into readable detail, and the light-glove / dark-armour pairing is
  // also the strongest possible break against a near-black weapon.
  const gloveTan = own(new THREE.MeshStandardMaterial({
    map: poly2.map,
    normalMap: poly2.normalMap,
    roughnessMap: poly2.roughnessMap,
    aoMap: poly2.aoMap,
    metalness: 0.0,
    roughness: 0.88,
    vertexColors: true,
    aoMapIntensity: 0.95,
  }));
  gloveTan.color.setRGB(1.34, 1.18, 0.98);
  gloveTan.normalScale.set(1.6, 1.6);
  gloveTan.name = 'weapon.gloveTan';

  // Uniform sleeve beyond the cuff, in the shared camo weave.
  //
  // Held at arm's length the camo map's pattern contrast is enormous relative
  // to everything else on screen, and at full albedo the forearm read as a
  // bright green-and-tan slab stuck to the handguard — the "texture error"
  // in the review. Knocked down to a dark, desaturated field it reads as a
  // sleeve in shadow, which is what it should be.
  const camo = ownTextures(generateTextureSet('camo', { size: 512, seed: 5501 }));
  const sleeve = own(new THREE.MeshStandardMaterial({
    map: camo.map,
    normalMap: camo.normalMap,
    roughnessMap: camo.roughnessMap,
    aoMap: camo.aoMap,
    metalness: 0.0,
    roughness: 1.0,
    vertexColors: true,
    aoMapIntensity: 1.0,
  }));
  sleeve.color.setRGB(0.50, 0.52, 0.46);
  sleeve.normalScale.set(1.3, 1.3);
  sleeve.name = 'weapon.sleeve';

  MATS = { metal, metalDark, metalWorn, polymer, rubber, glass, dot, dotGlow, paint,
    glove, gloveTan, sleeve };
  return MATS;
}

// ------------------------------------------------------------------- bins ---

/**
 * Prepare one part for merging: strip stray attributes, force non-indexed so
 * every geometry in the pool has identical layout, and bake the part tint plus
 * a top-lit vertical gradient into a byte vertex-colour attribute.
 */
function prep(geo, tint) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  for (const k of Object.keys(geo.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
  }
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(
      new Float32Array(geo.attributes.position.count * 2), 2));
  }
  let g = geo;
  if (geo.index) {
    g = geo.toNonIndexed();
    geo.dispose();
  }
  g.clearGroups();

  const p = g.attributes.position;
  const col = new Uint8Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    // Fake vertical ambient gradient: undersides of a weapon are always in
    // shadow, and this survives into the merged mesh at zero runtime cost.
    const grad = 0.80 + 0.26 * smoothstep(-0.16, 0.11, p.getY(i));
    const v = Math.max(0, Math.min(255, Math.round(tint * grad * 255)));
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.Uint8BufferAttribute(col, 3, true));
  return g;
}

function newBin(origin) {
  return { origin: origin ? origin.clone() : new THREE.Vector3(), items: [] };
}

/** Add a geometry (already positioned in weapon space) under a material key. */
function add(bin, key, geo, tint = 1.0) {
  bin.items.push({ key, geo: prep(geo, tint) });
}

/**
 * Box-project UVs from weapon-space position using each triangle's dominant
 * axis. Non-indexed input is a precondition, which `prep` guarantees.
 */
function applyBoxUV(geo, scale) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i += 3) {
    const nx = Math.abs(n.getX(i) + n.getX(i + 1) + n.getX(i + 2));
    const ny = Math.abs(n.getY(i) + n.getY(i + 1) + n.getY(i + 2));
    const nz = Math.abs(n.getZ(i) + n.getZ(i + 1) + n.getZ(i + 2));
    let ua = 0;
    let va = 1;
    if (nx >= ny && nx >= nz) { ua = 2; va = 1; }        // side faces: ZY
    else if (ny >= nx && ny >= nz) { ua = 0; va = 2; }   // top/bottom: XZ
    else { ua = 0; va = 1; }                             // front/back: XY
    for (let k = 0; k < 3; k++) {
      const j = i + k;
      const c = [p.getX(j), p.getY(j), p.getZ(j)];
      uv[j * 2] = c[ua] * scale;
      uv[j * 2 + 1] = c[va] * scale;
    }
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
}

/**
 * Merge a bin per material and return a Group whose origin is the bin's pivot,
 * so animated assemblies rotate and slide about a sensible point.
 */
function finalize(bin, name) {
  const mats = getMaterials();
  const group = new THREE.Group();
  group.name = name;
  group.position.copy(bin.origin);

  const byKey = new Map();
  for (const it of bin.items) {
    if (!byKey.has(it.key)) byKey.set(it.key, []);
    byKey.get(it.key).push(it.geo);
  }
  for (const [key, geos] of byKey) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) throw new Error(`weapon merge failed for material "${key}"`);
    if (geos.length > 1) for (const g of geos) g.dispose();
    applyBoxUV(merged, 1 / TEX_WORLD);
    merged.translate(-bin.origin.x, -bin.origin.y, -bin.origin.z);
    merged.computeBoundingSphere();
    OWNED_GEOMETRY.add(merged);
    const mesh = new THREE.Mesh(merged, mats[key]);
    mesh.name = `${name}.${key}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  return group;
}

/**
 * Ejection anchor. The contract wants +X pointing the way brass leaves the
 * gun, so the anchor is rotated by the shortest arc from +X onto `dir`.
 */
function makeEjectAnchor(x, y, z, dir) {
  const o = new THREE.Object3D();
  o.name = 'ejectPort';
  o.position.set(x, y, z);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
  return o;
}

/**
 * Shallow spherical cap for an optic element. `apexZ` is the pole of the cap;
 * the rim sits `sag` behind it (objective, bulging down -Z) or in front of it
 * (ocular, bulging toward the eye). A cap rather than a flat disc is what makes
 * the specular vary across the glass.
 */
function lensDome(apexZ, sag, radius, forward, seg = 24, n = 7) {
  const prof = [];
  for (let i = 0; i <= n; i++) {
    // Ordered so z always decreases, which is what latheZ needs for outward
    // normals; the two cases just walk the cap from opposite ends.
    const t = forward ? 1 - i / n : i / n;
    prof.push([Math.max(radius * t, 1e-5), apexZ + (forward ? 1 : -1) * sag * t * t]);
  }
  return latheZ(prof, seg);
}

// ------------------------------------------------------- detail assemblies --

/**
 * MIL-STD-1913 cross-section, to spec: 21.2 mm across the recoil-groove
 * shoulders, 15.7 mm across the top, 6.35 mm tall, 45-degree flanks. Extruded
 * once per tooth so the transverse slots between them are real geometry.
 */
function picProfile() {
  const s = new THREE.Shape();
  const P = [
    [-0.00785, 0.00635], [-0.01060, 0.00360], [-0.01060, 0.00200], [-0.00950, 0.0],
    [0.00950, 0.0], [0.01060, 0.00200], [0.01060, 0.00360], [0.00785, 0.00635],
  ];
  s.moveTo(P[0][0], P[0][1]);
  for (let i = 1; i < P.length; i++) s.lineTo(P[i][0], P[i][1]);
  s.closePath();
  return s;
}

/**
 * A run of Picatinny rail from z0 back to z1, sitting on y.
 * 10 mm pitch: 4.8 mm tooth, 5.2 mm slot — the real thing.
 */
function railRun(bin, key, y, z0, z1, tint = 1.05) {
  const len = Math.abs(z1 - z0);
  const zf = Math.min(z0, z1);
  const pitch = 0.0100;
  const tooth = 0.0048;
  const n = Math.max(1, Math.floor(len / pitch));
  const pad = (len - n * pitch) * 0.5;

  // Continuous slot floor so you never see daylight between the teeth. Kept
  // deliberately dark: the alternating dark slot / bright tooth is a value
  // rhythm, and it only works if the two ends are actually far apart.
  add(bin, key, at(chamferBox(0.0190, 0.0022, len, { c: 0.0006, r: 0.0006 }),
    0, y + 0.0011, zf + len * 0.5), tint * 0.42);

  // Tooth tops are the most-rubbed surface on the whole weapon, so they run on
  // the worn variant, and at a tint high enough that they actually draw a
  // bright line down the spine of the gun. At the old value they landed within
  // ten percent of the receiver and the rail vanished into it.
  const prof = picProfile();
  for (let i = 0; i < n; i++) {
    const zc = zf + pad + i * pitch + pitch * 0.5;
    add(bin, 'metalWorn', at(extrudeChamfer(prof, tooth, 0.0005, 1, 1), 0, y, zc), tint * 0.70);
  }
}

/**
 * Rubbed-through edge highlight. A 1.4 mm square fillet of the bare-steel
 * material laid along an edge of a part, running from z0 to z1 at (x, y).
 *
 * Every finish on a weapon fails at the edges first, and a viewmodel with no
 * edge wear reads as a toy: the whole object has exactly one value. These
 * cost almost nothing (they merge into the existing metalWorn draw call) and
 * they are what pulls the receiver, handguard and controls apart from each
 * other under a single key light.
 */
function wearEdge(bin, x, y, z0, z1, w = 0.0014, tint = 1.0) {
  const len = Math.abs(z1 - z0);
  add(bin, 'metalWorn', at(chamferBox(w, w, len, { c: 0.0004, r: 0.0004, bevelSegments: 1, curveSegments: 1 }),
    x, y, (z0 + z1) * 0.5), tint);
}

/** Hex-socket fastener head sunk into a surface. */
function screw(bin, key, x, y, z, r = 0.0022, axis = 'y', tint = 1.0) {
  const g = new THREE.CylinderGeometry(r, r * 0.94, 0.0016, 8, 1, false);
  const rim = new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.0022, 6, 1, false);
  if (axis === 'x') { rot(g, 0, 0, Math.PI / 2); rot(rim, 0, 0, Math.PI / 2); }
  else if (axis === 'z') { rot(g, Math.PI / 2, 0, 0); rot(rim, Math.PI / 2, 0, 0); }
  add(bin, key, at(g, x, y, z), tint);
  add(bin, key, at(rim, x, y, z), tint * 0.7);
}

/** QD sling swivel socket: a recessed cup with a rim. */
function slingSocket(bin, key, x, y, z, tint = 1.0) {
  const sign = Math.sign(x) || 1;
  const cup = latheZ([
    [0.0068, 0], [0.0068, -0.0010], [0.0058, -0.0016],
    [0.0058, -0.0044], [0.0030, -0.0048], [0.0030, -0.0010], [0.0006, -0.0006],
  ], 12);
  rot(cup, 0, sign * Math.PI / 2, 0);
  add(bin, key, at(cup, x, y, z), tint * 0.85);
}

/** Steel sling loop — a flattened torus through a mounting lug. */
function slingLoop(bin, key, x, y, z, r = 0.0075, tint = 1.0) {
  const t = new THREE.TorusGeometry(r, 0.0016, 6, 14);
  t.scale(1, 1, 0.55);
  add(bin, key, put(t, x, y, z, 0, Math.PI / 2, 0), tint);
}

/**
 * Cocking / gripping serrations: a row of angled ribs on both flanks.
 * `tilt` rakes them like slide serrations on a modern pistol.
 */
function serrations(bin, key, opts) {
  const {
    xIn, xOut, yc, h, z0, z1, count, w = 0.0018, tilt = 0, tint = 1.0, both = true,
  } = opts;
  const span = Math.abs(z1 - z0);
  const step = span / count;
  for (let i = 0; i < count; i++) {
    const zc = Math.min(z0, z1) + step * (i + 0.5);
    for (const s of both ? [-1, 1] : [1]) {
      const g = chamferBox(xOut - xIn, h, w, { c: 0.0004, r: 0.0004, bevelSegments: 1, curveSegments: 1 });
      add(bin, key, put(g, s * (xIn + (xOut - xIn) * 0.5), yc, zc, tilt, 0, 0), tint * 1.04);
    }
  }
}

/**
 * A witness-hole strip for a magazine: a thin plate with real circular holes
 * punched through it, standing 0.6 mm proud of the magazine body so the darker
 * body reads through the holes.
 */
function witnessStrip(bin, key, opts) {
  const { x, y, z, count, spacing, hole = 0.0026, w = 0.013, thick = 0.0016, rx = 0, tint = 1.0 } = opts;
  const h = spacing * count + 0.006;
  const s = roundedRect(w, h, 0.0025);
  for (let i = 0; i < count; i++) {
    s.holes.push(holeCircle(0, -h * 0.5 + 0.003 + spacing * (i + 0.5), hole));
  }
  const g = extrudeChamfer(s, thick, 0.0004, 1, 3);
  // Plate is authored in XY and extruded along Z; roll it onto the magazine flank.
  rot(g, 0, Math.PI / 2, 0);
  add(bin, key, put(g, x, y, z, rx, 0, 0), tint);
}

// ============================================================== HANDS =======
/*
 * Gloved hands.
 *
 * Three earlier attempts modelled a hand as "a tube bent around the grip with
 * some bumps on it", and all three read as a mitten with sausages: the eye has
 * no trouble telling a lofted arc from a hand, because what it actually looks
 * for is a *palm volume*, a *knuckle line*, and *three segments per finger with
 * a notch between them*. None of those survive being approximated.
 *
 * So this builds the anatomy instead:
 *
 *   - a palm slab lofted along the longitudinal metacarpal arch, so its inner
 *     face is genuinely concave and cups the gripped body, with the thenar and
 *     hypothenar eminences as separate masses either side of that hollow;
 *   - four fingers of three phalanges each, wrapped onto the gripped body by
 *     stepping around its cross-section one bone length at a time, so the tips
 *     are *on the far surface* by construction rather than by eyeballing an
 *     arc length;
 *   - a real notch at every joint: each phalanx stops 1.2 mm short and a
 *     narrower, darker band fills the gap, which puts the segmentation in the
 *     silhouette where it survives being sixty pixels tall;
 *   - four metacarpal domes under a knuckle plate, because the firing hand is
 *     seen almost entirely from the back;
 *   - a thumb of metacarpal + two phalanges on its own chain;
 *   - a wrist that pinches to ~0.7 of the forearm, then a cuff with a seam,
 *     a strap and a pull tab.
 *
 * MIRRORING. Reflecting a mesh inverts its winding, so nothing here is
 * mirrored. A hand is authored in a canonical right-handed frame
 *
 *      +X  across the palm toward the thumb        (index -> little is -X)
 *      +Y  dorsal, out of the back of the hand
 *      +Z  distal, wrist -> knuckles -> fingertips
 *
 * and the left hand is produced by negating the *layout* x of every landmark
 * (`side = -1`). Every primitive is bilaterally symmetric about its own local
 * YZ plane and is placed by a rigid, positively-oriented transform, so the
 * result is a true left hand with correct winding and no reflected matrix.
 *
 * The gripped body is described in the same frame: its axis is +X, offset to
 * the palmar side of the palm arch, with an elliptical cross-section (`ry`
 * dorsal-palmar, `rz` distal-proximal). Placing a hand is therefore just
 * "point +X along the thing being gripped and say which way the back of the
 * hand faces" — the wrap follows.
 */

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Loft a rounded-rectangle tube along an arbitrary polyline in weapon space.
 * `sizes[i]` is `[w, h, r]` in the frame at `pts[i]`; the frame's +Z is the
 * path tangent and its +Y is `up` made perpendicular to that tangent. Used for
 * the wrist, cuff and sleeve, where the section only has to follow a curve.
 */
function pathTube(pts, sizes, up, seg = 3, capStart = true, capEnd = true) {
  const secs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const T = new THREE.Vector3().subVectors(b, a).normalize();
    let U = up.clone().normalize();
    if (Math.abs(U.dot(T)) > 0.97) U = new THREE.Vector3(T.y, T.z, T.x).normalize();
    const X = new THREE.Vector3().crossVectors(U, T).normalize();
    const Y = new THREE.Vector3().crossVectors(T, X);
    secs.push({
      w: sizes[i][0], h: sizes[i][1], r: sizes[i][2],
      m: new THREE.Matrix4().makeBasis(X, Y, T).setPosition(pts[i]),
    });
  }
  return loft(secs, seg, capStart, capEnd);
}

/** Wrist crease to knuckle line. */
const PALM_LEN = 0.0900;
/**
 * Proximal length of the palm that does not curve. The heel of the hand
 * overhangs whatever is being held — it does not wrap it — and modelling the
 * palm as one long arc swings the heel out into space beside the weapon.
 */
const PALM_FLAT = 0.0260;
/** Station along the palm at which the gripped body sits. */
const GRIP_S = 0.0700;

/**
 * Digits, index to little. `s` is the station of the MCP joint along the palm
 * (the knuckle line is oblique, which is most of why a hand does not read as a
 * comb), `L` the three phalanx lengths, `v` a per-digit value step. Four
 * identical fingers merge into one slab under a single key light no matter how
 * well they are modelled; a deliberate ramp is what separates them.
 */
const DIGITS = [
  { x: 0.0294, s: 0.0925, L: [0.0400, 0.0262, 0.0212], w: 0.0192, t: 0.0194, v: 1.16 },
  { x: 0.0100, s: 0.0950, L: [0.0450, 0.0292, 0.0224], w: 0.0192, t: 0.0198, v: 1.03 },
  { x: -0.0100, s: 0.0902, L: [0.0422, 0.0278, 0.0212], w: 0.0178, t: 0.0186, v: 0.92 },
  { x: -0.0294, s: 0.0824, L: [0.0332, 0.0212, 0.0182], w: 0.0158, t: 0.0164, v: 0.83 },
];

/** Palm breadth and thickness at station `s`. */
function palmSection(s) {
  const u = Math.min(1, Math.max(0, s / PALM_LEN));
  return {
    // The breadth has to stay inside the span of the knuckles plus half an
    // outer finger, or the slab reads as a mitten with the digits buried in it.
    w: 0.0500 + 0.0262 * Math.sin(u * 1.34),
    t: 0.0270 - 0.0058 * u,
  };
}

/**
 * The palm's centreline in the hand's YZ plane: straight through the heel,
 * then a circular arc of radius `R` that curls the metacarpals around whatever
 * is being gripped. Returns position, distal tangent and dorsal normal at
 * arc-length `s` from the wrist crease.
 */
function palmAt(s, R, flat = PALM_FLAT) {
  if (s <= flat) return { y: 0, z: s, ty: 0, tz: 1, dy: 1, dz: 0 };
  const a = (s - flat) / R;
  return {
    y: -R * (1 - Math.cos(a)), z: flat + R * Math.sin(a),
    ty: -Math.sin(a), tz: Math.cos(a),
    dy: Math.cos(a), dz: Math.sin(a),
  };
}

const hl = (x, y, z) => ({ x, y, z });
function hlAdd(p, q, k = 1) { return hl(p.x + q.x * k, p.y + q.y * k, p.z + q.z * k); }
function hlLerp(p, q, t) {
  return hl(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t);
}
function hlDist(p, q) {
  const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Build the hand-local -> weapon-space frame, and locate the gripped body in
 * hand-local coordinates so that its surface is tangent to the palm's inner
 * face at station GRIP_S.
 */
function handSpace(cfg) {
  const { gripAxis, dorsal, gripPoint, ry, rz, side, arch = 0.045, flat = PALM_FLAT } = cfg;
  const X = gripAxis.clone().normalize();
  const Y = dorsal.clone().addScaledVector(X, -dorsal.dot(X)).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);

  const f = palmAt(GRIP_S, arch, flat);
  const inset = palmSection(GRIP_S).t * 0.5 + ry;
  const H = {
    X, Y, Z, side, ry, rz,
    gy: f.y - f.dy * inset, gz: f.z - f.dz * inset,
    uy: f.dy, uz: f.dz,      // wrap-plane axis toward the back of the hand
    vy: f.ty, vz: f.tz,      // wrap-plane axis toward the fingertips
  };
  H.origin = gripPoint.clone().addScaledVector(Y, -H.gy).addScaledVector(Z, -H.gz);
  H.w = (p) => H.origin.clone()
    .addScaledVector(X, p.x).addScaledVector(Y, p.y).addScaledVector(Z, p.z);
  H.local = (p) => {
    const d = p.clone().sub(H.origin);
    return hl(d.dot(X), d.dot(Y), d.dot(Z));
  };
  return H;
}

/** Point `off` metres outboard of the gripped surface, at polar angle `th`. */
function wrapAt(H, x, th, off) {
  const a = (H.ry + off) * Math.sin(th);
  const b = (H.rz + off) * Math.cos(th);
  return hl(x, H.gy + H.uy * a + H.vy * b, H.gz + H.uz * a + H.vz * b);
}

/** Polar angle of a hand-local point about the gripped body's axis. */
function wrapAngle(H, p) {
  const dy = p.y - H.gy, dz = p.z - H.gz;
  return Math.atan2(dy * H.uy + dz * H.uz, dy * H.vy + dz * H.vz);
}

/**
 * Step a finger around the gripped body. Each joint is placed on the offset
 * cross-section exactly one phalanx length from the previous one, which is
 * what guarantees the tip ends up pressed against the far surface instead of
 * hovering somewhere near it — the failure mode of every previous attempt.
 */
function wrapChain(H, start, xs, lengths, offs, stop = -1.85) {
  const pts = [start];
  let th = wrapAngle(H, start);
  let clamped = false;
  for (let k = 0; k < lengths.length; k++) {
    const prev = pts[pts.length - 1];
    if (!clamped) {
      let cur = th;
      for (let i = 0; i < 460; i++) {
        cur -= 0.0080;
        if (cur < stop) { clamped = true; break; }
        if (hlDist(wrapAt(H, xs[k], cur, offs[k]), prev) >= lengths[k]) break;
      }
      if (!clamped) {
        th = cur;
        pts.push(wrapAt(H, xs[k], th, offs[k]));
        continue;
      }
    }
    // Past the stop angle the digit has closed as far as it is going to. Park
    // the remaining joints on the surface at the stop angle rather than letting
    // the march keep going: continuing the wrap sends the fingertips all the
    // way round and out behind the hand, and continuing straight throws them
    // off into space beside the weapon. Both were visible in review.
    pts.push(wrapAt(H, xs[k], stop - k * 0.06, offs[k] * 0.72));
  }
  return pts;
}

/**
 * One bone: a chamfered, tapered loft between two hand-local points. `s0`/`s1`
 * are `[width across the hand, thickness]`; `bulge` swells the mid-span so a
 * phalanx is barrel-shaped rather than prismatic.
 */
function boneGeo(H, p0, p1, s0, s1, bulge = 1.0, seg = 2) {
  const a = H.w(p0), b = H.w(p1);
  const T = new THREE.Vector3().subVectors(b, a);
  const len = T.length();
  if (len < 1e-6) return null;
  T.divideScalar(len);
  let Xa = H.X.clone().addScaledVector(T, -H.X.dot(T));
  if (Xa.lengthSq() < 1e-6) Xa = H.Y.clone().addScaledVector(T, -H.Y.dot(T));
  Xa.normalize();
  const Ya = new THREE.Vector3().crossVectors(T, Xa);
  const secs = [];
  const N = 2;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const k = 1 + (bulge - 1) * Math.sin(Math.PI * t);
    const w = (s0[0] + (s1[0] - s0[0]) * t) * k;
    const h = (s0[1] + (s1[1] - s0[1]) * t) * k;
    secs.push({
      w, h, r: Math.min(w, h) * 0.44,
      m: new THREE.Matrix4().makeBasis(Xa, Ya, T)
        .setPosition(a.clone().addScaledVector(T, len * t)),
    });
  }
  return loft(secs, seg);
}

/** Unit hand-local direction from `p` to `q`. */
function hlDir(p, q) {
  const d = hl(q.x - p.x, q.y - p.y, q.z - p.z);
  const n = Math.hypot(d.x, d.y, d.z) || 1;
  return hl(d.x / n, d.y / n, d.z / n);
}

/**
 * Lay a chain of joints down as phalanges plus joint bands. Each bone is
 * trimmed by `gap` at both ends and the band fills the gap at 0.86 of the
 * cross-section, so there is a real notch in the silhouette at every joint.
 */
function digitChain(bin, H, pts, w, t, tint, opts = {}) {
  const { gap = 0.0013, taper = 0.80, band = 'gloveTan', tipRound = true } = opts;
  const n = pts.length - 1;
  const ends = [];
  for (let k = 0; k < n; k++) {
    const d = hlDir(pts[k], pts[k + 1]);
    const a = hlAdd(pts[k], d, k === 0 ? gap * 0.2 : gap);
    const b = hlAdd(pts[k + 1], d, -(k === n - 1 && tipRound ? gap * 1.6 : gap));
    ends.push([a, b]);
    const f0 = k / n, f1 = (k + 1) / n;
    const s = (f) => [w * (1 - (1 - taper) * f), t * (1 - (1 - taper) * f * 1.15)];
    const g = boneGeo(H, a, b, s(f0), s(f1), k === 0 ? 1.06 : 1.03);
    if (g) add(bin, 'glove', g, tint);
  }
  for (let k = 1; k < n; k++) {
    const f = k / n;
    const bw = w * (1 - (1 - taper) * f) * 0.86;
    const bt = t * (1 - (1 - taper) * f * 1.15) * 0.86;
    const g = boneGeo(H, ends[k - 1][1], ends[k][0], [bw, bt], [bw, bt], 1.0, 2);
    if (g) add(bin, band, g, tint * 0.94);
  }
  return ends;
}

/**
 * Metacarpal dome at one MCP joint. Four of these under a knuckle plate are
 * the most recognisable thing about a gloved fist, and they are what stops the
 * back of the hand — most of what is ever seen of the firing hand — from
 * reading as one uninterrupted convex slab. The dome is a squashed sphere so
 * it stands proud across the knuckle line without ballooning the silhouette.
 */
function knuckleDome(bin, H, d, mcpPt, tint) {
  const SX = (x) => x * H.side;
  const outward = hlDir(hl(SX(d.x), H.gy, H.gz), mcpPt);
  const c = hlAdd(mcpPt, outward, d.t * 0.30);
  const wc = H.w(c);
  const wo = H.w(hlAdd(c, outward, 1)).sub(wc).normalize();
  const dome = new THREE.SphereGeometry(d.w * 0.66, 9, 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), wo);
  dome.scale(1.0, 0.62, 1.0);
  dome.applyQuaternion(q);
  add(bin, 'glove', at(dome, wc.x, wc.y, wc.z), tint * d.v * 1.14);
}

/**
 * Build one gloved hand plus its forearm into `bin`.
 *
 * @param {object} cfg
 *   side       +1 right hand, -1 left hand
 *   gripAxis   weapon-space direction the hand's +X (thumb side) points along
 *   dorsal     weapon-space direction the back of the hand faces
 *   gripPoint  point on the gripped body's axis, level with the hand's middle
 *   ry, rz     gripped cross-section radii, dorsal-palmar and distal-proximal
 *   trigger    weapon-space point the index fingertip's centre reaches, or null
 *   thumbPose  'wrap' (over the top of the grip) | 'rail' (along the handguard)
 *   armDir     direction the forearm runs; it should exit the frame
 *   armLen     forearm length
 */
function buildHand(bin, cfg) {
  const {
    trigger = null, thumbPose = 'wrap', armDir, armLen = 0.36, tint = 1.0,
    wristLift = 0, arch = 0.045, wristX = -0.012,
    wrapStop = -2.45, thumbAim = null, flat = PALM_FLAT,
  } = cfg;
  const H = handSpace(cfg);
  const side = H.side;
  const SX = (x) => x * side;

  // ---------------------------------------------------------------- palm ---
  // Lofted along the metacarpal arch. Because the sections ride a curve, the
  // inner face is concave along its length and actually cups the gripped body;
  // a straight slab is the single loudest "this is a mitten" tell.
  const NP = 7;
  const palmSecs = [];
  for (let i = 0; i <= NP; i++) {
    const s = PALM_LEN * (i / NP);
    const f = palmAt(s, arch, flat);
    const sec = palmSection(s);
    const T = new THREE.Vector3().addScaledVector(H.Y, f.ty).addScaledVector(H.Z, f.tz);
    const Xa = H.X.clone();
    const Ya = new THREE.Vector3().crossVectors(T, Xa);
    palmSecs.push({
      w: sec.w, h: sec.t, r: sec.t * 0.48,
      m: new THREE.Matrix4().makeBasis(Xa, Ya, T)
        .setPosition(H.w(hl(SX(-0.0015), f.y, f.z))),
    });
  }
  add(bin, 'glove', loft(palmSecs, 4), tint * 0.90);

  // Thenar and hypothenar eminences: the two palmar masses that bracket the
  // hollow of the palm. Without them the palm is a flat card and the hand has
  // no thickness where it meets the grip.
  const eminence = (x, s0, s1, wid, dep) => {
    const secs = [];
    for (let i = 0; i <= 2; i++) {
      const s = s0 + (s1 - s0) * (i / 2);
      const f = palmAt(s, arch, flat);
      const t = palmSection(s).t;
      const T = new THREE.Vector3().addScaledVector(H.Y, f.ty).addScaledVector(H.Z, f.tz);
      const Xa = H.X.clone();
      const Ya = new THREE.Vector3().crossVectors(T, Xa);
      const k = Math.sin(Math.PI * (0.20 + 0.60 * (i / 2)));
      const p = hl(SX(x), f.y - f.dy * (t * 0.5 + dep * 0.35 * k),
        f.z - f.dz * (t * 0.5 + dep * 0.35 * k));
      secs.push({
        w: wid * (0.72 + 0.28 * k), h: dep * (0.55 + 0.45 * k), r: dep * 0.34,
        m: new THREE.Matrix4().makeBasis(Xa, Ya, T).setPosition(H.w(p)),
      });
    }
    add(bin, 'glove', loft(secs, 3), tint * 0.98);
  };
  eminence(0.0175, 0.0090, 0.0620, 0.0300, 0.0175);   // thenar (thumb ball)
  eminence(-0.0225, 0.0060, 0.0640, 0.0250, 0.0135);  // hypothenar

  // Padded palm, with a stitched border. Mostly crushed against the grip, but
  // it shows at the heel and along both edges, and it is the difference
  // between a glove and a smooth mitten.
  {
    const secs = [];
    const stitch = [[], []];
    for (let i = 0; i <= 3; i++) {
      const s = 0.0150 + (0.0790 - 0.0150) * (i / 3);
      const f = palmAt(s, arch, flat);
      const t = palmSection(s).t;
      const T = new THREE.Vector3().addScaledVector(H.Y, f.ty).addScaledVector(H.Z, f.tz);
      const Xa = H.X.clone();
      const Ya = new THREE.Vector3().crossVectors(T, Xa);
      const wid = 0.0430 + 0.0090 * Math.sin(Math.PI * (i / 3));
      const p = hl(SX(-0.0020), f.y - f.dy * (t * 0.5 + 0.0016),
        f.z - f.dz * (t * 0.5 + 0.0016));
      secs.push({
        w: wid, h: 0.0032, r: 0.0014,
        m: new THREE.Matrix4().makeBasis(Xa, Ya, T).setPosition(H.w(p)),
      });
      for (const [j, sgn] of [[0, 1], [1, -1]]) {
        stitch[j].push({
          w: 0.0022, h: 0.0022, r: 0.0009,
          m: new THREE.Matrix4().makeBasis(Xa, Ya, T)
            .setPosition(H.w(hlAdd(p, hl(sgn * wid * 0.5, 0, 0)))),
        });
      }
    }
    add(bin, 'gloveTan', loft(secs, 3), tint * 1.02);
    for (const st of stitch) add(bin, 'glove', loft(st, 2), tint * 1.14);
  }

  // ------------------------------------------------------------- fingers ---
  const mcp = [];
  for (const d of DIGITS) {
    const f = palmAt(d.s, arch, flat);
    mcp.push(hl(SX(d.x), f.y + f.dy * 0.0015, f.z + f.dz * 0.0015));
  }

  for (let i = 0; i < 4; i++) {
    const d = DIGITS[i];
    if (i === 0 && trigger) continue;
    // Fingers converge slightly toward the tips, as they do in a real fist.
    const xs = [SX(d.x * 0.94), SX(d.x * 0.86), SX(d.x * 0.78)];
    const offs = [d.t * 0.52, d.t * 0.46, d.t * 0.38];
    const pts = wrapChain(H, mcp[i], xs, d.L, offs, wrapStop);
    digitChain(bin, H, pts, d.w, d.t, tint * d.v);

    knuckleDome(bin, H, d, mcp[i], tint);
  }

  // Webbing valleys. A dark wedge sunk between each pair of digits at the base
  // keeps four fingers reading as four when they are seen end-on, without
  // letting them float apart into separate sticks.
  for (let i = trigger ? 1 : 0; i < 3; i++) {
    const a = DIGITS[i], b = DIGITS[i + 1];
    const x = SX((a.x + b.x) * 0.5);
    const s0 = hl(x, (mcp[i].y + mcp[i + 1].y) * 0.5, (mcp[i].z + mcp[i + 1].z) * 0.5);
    const off = Math.min(a.t, b.t) * 0.48;
    const p1 = wrapChain(H, s0, [x], [Math.min(a.L[0], b.L[0]) * 0.46], [off])[1];
    const gw = Math.abs(a.x - b.x) - Math.max(a.w, b.w) * 0.94;
    const g = boneGeo(H, hlAdd(s0, hlDir(s0, p1), -0.0040), p1,
      [Math.max(0.0058, gw + 0.0074), Math.min(a.t, b.t) * 0.84],
      [Math.max(0.0044, gw + 0.0038), Math.min(a.t, b.t) * 0.54], 1.0, 2);
    if (g) add(bin, 'gloveTan', g, tint * 0.72);
  }

  // ------------------------------------- index finger, pad on the trigger ---
  if (trigger) {
    const d = DIGITS[0];
    const T = H.local(trigger);
    const total = d.L[0] + d.L[1] + d.L[2];
    const base = mcp[0];
    // Bow the finger out toward the distal-dorsal side, and scale the bow
    // until the curve's length matches the finger's, so the reach is right and
    // the second knuckle stands proud instead of the whole digit being a
    // straight stick pointing at the trigger.
    const bowDir = (() => {
      const m = hlLerp(base, T, 0.5);
      const o = hlDir(hl(SX(d.x), H.gy, H.gz), m);
      return o;
    })();
    const curveAt = (k, u) => {
      const p0 = base, p2 = T;
      const p1 = hlAdd(hlLerp(p0, p2, 0.48), bowDir, k);
      const a = hlLerp(p0, p1, u), b = hlLerp(p1, p2, u);
      return hlLerp(a, b, u);
    };
    const lengthOf = (k) => {
      let L = 0;
      let prev = curveAt(k, 0);
      for (let i = 1; i <= 24; i++) { const q = curveAt(k, i / 24); L += hlDist(prev, q); prev = q; }
      return L;
    };
    let lo = 0, hi = Math.max(0.004, total * 0.9);
    if (lengthOf(hi) > total) {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) * 0.5;
        if (lengthOf(mid) > total) hi = mid; else lo = mid;
      }
    }
    const k = (lo + hi) * 0.5;
    // Walk the curve and drop the joints at the right arc lengths.
    const want = [d.L[0], d.L[0] + d.L[1], total];
    const pts = [base];
    let acc = 0, prev = curveAt(k, 0), wi = 0;
    for (let i = 1; i <= 96 && wi < 3; i++) {
      const q = curveAt(k, i / 96);
      acc += hlDist(prev, q); prev = q;
      while (wi < 3 && acc >= want[wi] - 1e-5) { pts.push(q); wi++; }
    }
    while (pts.length < 4) pts.push(T);
    pts[3] = T;
    digitChain(bin, H, pts, d.w, d.t, tint * d.v, { taper: 0.84 });
    knuckleDome(bin, H, d, mcp[0], tint);
  }

  // --------------------------------------------------------------- thumb ---
  // Metacarpal out of the thenar, then two phalanges. Like the fingers, the
  // two phalanges are placed *on the gripped body* rather than by dead
  // reckoning from joint angles: a thumb aimed by angles either buries itself
  // in the grip or waves in the air 20 mm clear of it, and both read as a
  // sausage stuck on the side of a mitten.
  const thumbTheta = wrapAngle(H, mcp[1]);
  {
    const rail = thumbPose === 'rail';
    const f0 = palmAt(0.0250, arch, flat);
    const cmc = hl(SX(0.0255), f0.y - f0.dy * 0.0090, f0.z - f0.dz * 0.0090);
    // The MCP sits at the web, proximal-dorsal of the knuckle line; from there
    // the thumb either crosses the grip or runs off along the gripped body.
    // Angles are chosen so the three bones come out at roughly 43 / 32 / 24 mm
    // once they are projected onto the gripped body — a thumb whose phalanges
    // land at 17 mm reads as a knuckle-sized lump, which is exactly what the
    // last review called "a separate sphere for the thumb knuckle".
    const P = thumbAim || (rail
      ? { x: [0.0360, 0.0640, 0.0860], th: [0.46, 0.34, 0.20], off: [0.0155, 0.0140, 0.0125] }
      : { x: [0.0340, 0.0380, 0.0400], th: [0.55, -0.45, -1.25], off: [0.0175, 0.0160, 0.0140] });
    const pts = [cmc];
    for (let k = 0; k < 3; k++) {
      pts.push(wrapAt(H, SX(P.x[k]), thumbTheta + P.th[k], P.off[k]));
    }
    digitChain(bin, H, pts, 0.0242, 0.0248, tint * 1.12, { taper: 0.70, gap: 0.0017 });
    // Reinforcement panel down the back of the thumb. On a support hand this is
    // the one digit fully in view, so it carries the glove's read.
    const back = hlDir(hl(SX(DIGITS[0].x), H.gy, H.gz), pts[1]);
    const g = boneGeo(H, hlAdd(pts[1], back, 0.0080), hlAdd(pts[2], back, 0.0066),
      [0.0130, 0.0040], [0.0110, 0.0036], 1.0, 2);
    if (g) add(bin, 'gloveTan', g, tint * 1.10);
  }

  // ------------------------------------------ knuckle plate and back seams ---
  // A curved plate riding the four metacarpal domes, lofted across the hand so
  // it shares their curvature rather than floating over them as a flat card.
  {
    const secs = [];
    for (let i = 0; i < 4; i++) {
      const d = DIGITS[i];
      const outward = hlDir(hl(SX(d.x), H.gy, H.gz), mcp[i]);
      const p = hlAdd(mcp[i], outward, d.t * 0.40);
      const wp = H.w(p);
      const Tdir = i < 3
        ? new THREE.Vector3().subVectors(H.w(mcp[i + 1]), H.w(mcp[i])).normalize()
        : new THREE.Vector3().subVectors(H.w(mcp[3]), H.w(mcp[2])).normalize();
      const Xa = new THREE.Vector3().addScaledVector(H.Y, outward.y)
        .addScaledVector(H.Z, outward.z).normalize();
      const Ya = new THREE.Vector3().crossVectors(Tdir, Xa).normalize();
      const Za = new THREE.Vector3().crossVectors(Xa, Ya);
      secs.push({
        w: 0.0050, h: d.w * (i === 0 || i === 3 ? 1.02 : 1.18), r: 0.0022,
        m: new THREE.Matrix4().makeBasis(Xa, Ya, Za).setPosition(wp),
      });
    }
    add(bin, 'gloveTan', loft(secs, 3), tint * 1.20);
  }
  // Metacarpal ridges. Four raised runs from the wrist out to each knuckle,
  // with a dark glove seam sunk in each valley between them. This is the single
  // biggest fix for the back of the hand: without it the dorsum is a 90 mm
  // rounded slab with nothing on it, and the whole fist reads as a mitten no
  // matter how good the fingers are. The firing hand is seen almost entirely
  // from this face.
  const dorsalRun = (sx0, sx1, s0, s1, w, h, key, val, lift) => {
    const secs = [];
    const N = 4;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const s = s0 + (s1 - s0) * u;
      const f = palmAt(s, arch, flat);
      const t = palmSection(s).t;
      const T = new THREE.Vector3().addScaledVector(H.Y, f.ty).addScaledVector(H.Z, f.tz);
      const Xa = H.X.clone();
      const Ya = new THREE.Vector3().crossVectors(T, Xa);
      const off = t * 0.5 + lift;
      const p = hl(SX(sx0 + (sx1 - sx0) * u), f.y + f.dy * off, f.z + f.dz * off);
      // Ridges swell toward the knuckle and die away into the wrist.
      const k = 0.35 + 0.65 * u;
      secs.push({
        w: w * k, h: h * k, r: Math.min(w, h) * 0.42,
        m: new THREE.Matrix4().makeBasis(Xa, Ya, T).setPosition(H.w(p)),
      });
    }
    add(bin, key, loft(secs, 3), tint * val);
  };
  for (let i = 0; i < 4; i++) {
    const d = DIGITS[i];
    dorsalRun(d.x * 0.40, d.x, 0.0260, d.s - 0.0060,
      d.w * 0.80, 0.0088, 'glove', 1.26, -0.0026);
  }
  for (let i = 0; i < 3; i++) {
    const a = DIGITS[i], b = DIGITS[i + 1];
    dorsalRun((a.x + b.x) * 0.20, (a.x + b.x) * 0.5, 0.0290, (a.s + b.s) * 0.5 - 0.0060,
      0.0040, 0.0036, 'gloveTan', 0.50, 0.0006);
  }
  // Side seams down the radial and ulnar edges of the glove, plus the wrist
  // cinch. The two flanks of the palm are the largest unbroken surfaces on the
  // hand and the support hand is seen almost entirely on its ulnar flank, so
  // without these it is a smooth tube whichever way it is rotated.
  for (const [sx0, sx1] of [[-0.0300, -0.0392], [0.0300, 0.0392]]) {
    const secs = [];
    for (let i = 0; i <= 4; i++) {
      const u = i / 4;
      const s = 0.0140 + (0.0870 - 0.0140) * u;
      const f = palmAt(s, arch, flat);
      const sec = palmSection(s);
      const T = new THREE.Vector3().addScaledVector(H.Y, f.ty).addScaledVector(H.Z, f.tz);
      const Xa = H.X.clone();
      const Ya = new THREE.Vector3().crossVectors(T, Xa);
      const edge = Math.min(sec.w * 0.5 - 0.0012, Math.abs(sx0 + (sx1 - sx0) * u));
      const p = hl(SX(Math.sign(sx0) * edge), f.y, f.z);
      secs.push({
        w: 0.0030, h: sec.t * 0.86, r: 0.0012,
        m: new THREE.Matrix4().makeBasis(Xa, Ya, T).setPosition(H.w(p)),
      });
    }
    add(bin, 'gloveTan', loft(secs, 3), tint * 0.62);
  }
  {
    // Wrist cinch: the glove's cuff seam where it closes over the wrist.
    const secs = [];
    for (const s of [0.0090, 0.0155]) {
      const f = palmAt(s, arch, flat);
      const sec = palmSection(s);
      const T = new THREE.Vector3().addScaledVector(H.Y, f.ty).addScaledVector(H.Z, f.tz);
      const Xa = H.X.clone();
      const Ya = new THREE.Vector3().crossVectors(T, Xa);
      secs.push({
        w: sec.w * 1.03, h: sec.t * 1.05, r: sec.t * 0.48,
        m: new THREE.Matrix4().makeBasis(Xa, Ya, T).setPosition(H.w(hl(SX(-0.0015), f.y, f.z))),
      });
    }
    add(bin, 'gloveTan', loft(secs, 4, false, false), tint * 0.92);
  }

  // ------------------------------------------------ wrist, cuff, forearm ---
  // The wrist has to pinch behind the hand and flare again into the cuff. A
  // forearm that leaves the glove at a constant radius is the clearest single
  // giveaway of a procedural arm; the ratio here is 0.7 : 1 wrist to forearm.
  const dir = armDir.clone().normalize();
  const f0 = palmAt(0, arch, flat);
  // The forearm leaves from the ulnar end of the wrist crease, not its middle:
  // the crease is a 60 mm line lying along the gripped body, and the wrist
  // joint sits at its little-finger end.
  const palmBack = H.w(hl(SX(wristX), f0.y - f0.ty * 0.0040, f0.z - f0.tz * 0.0040));
  const out0 = new THREE.Vector3()
    .addScaledVector(H.Y, -f0.ty).addScaledVector(H.Z, -f0.tz).normalize()
    .addScaledVector(H.Y, wristLift).normalize();

  const w0 = palmBack.clone();
  const w1 = w0.clone().addScaledVector(out0, 0.0130).addScaledVector(dir, 0.0110);
  const w2 = w1.clone().addScaledVector(out0, 0.0040).addScaledVector(dir, 0.0190);
  const cuff0 = w2.clone().addScaledVector(dir, 0.0120);
  const cuff1 = cuff0.clone().addScaledVector(dir, 0.0230);

  // Wrist: pinched to 0.7 of the forearm, then flared back out into the cuff.
  add(bin, 'glove', pathTube([w0, w1, w2],
    [[0.0272, 0.0570, 0.0122], [0.0272, 0.0420, 0.0130], [0.0300, 0.0402, 0.0145]],
    H.X, 4, true, false), tint * 0.86);
  // Cuff: a padded collar stepping out over the sleeve, with a hard seam where
  // it meets the glove and a velcro strap across it.
  add(bin, 'glove', pathTube([w2, cuff0],
    [[0.0306, 0.0410, 0.0148], [0.0398, 0.0528, 0.0194]], H.X, 4, false, false), tint * 1.18);
  add(bin, 'gloveTan', pathTube([cuff0, cuff1],
    [[0.0424, 0.0558, 0.0205], [0.0444, 0.0584, 0.0214]], H.X, 4, false, false), tint * 1.02);
  const strapA = cuff0.clone().lerp(cuff1, 0.32);
  const strapB = cuff0.clone().lerp(cuff1, 0.64);
  add(bin, 'glove', pathTube([strapA, strapB],
    [[0.0458, 0.0602, 0.0220], [0.0458, 0.0602, 0.0220]], H.X, 4, false, false), tint * 1.28);
  // Pull tab standing proud of the strap, on the back of the wrist.
  const along = new THREE.Vector3().subVectors(strapB, strapA).normalize();
  const tabDir = H.Y.clone().addScaledVector(along, -H.Y.dot(along));
  tabDir.copy(tabDir.lengthSq() > 1e-6 ? tabDir.normalize() : H.X);
  add(bin, 'gloveTan', pathTube(
    [strapA.clone().addScaledVector(tabDir, 0.0230), strapB.clone().addScaledVector(tabDir, 0.0250)],
    [[0.0056, 0.0100, 0.0024], [0.0046, 0.0084, 0.0020]], tabDir, 3), tint * 1.16);

  // Forearm. Real forearms swell toward the elbow and sag away from the wrist,
  // so the path bends along whatever component of world-down is perpendicular
  // to `armDir` and leaves through a corner of the frame.
  let drop = V3(0, -1, 0).addScaledVector(dir, -dir.y);
  drop = drop.lengthSq() > 1e-6 ? drop.normalize() : H.Y.clone();
  const A1 = cuff1.clone().addScaledVector(dir, armLen * 0.30).addScaledVector(drop, armLen * 0.030);
  const A2 = cuff1.clone().addScaledVector(dir, armLen * 0.62).addScaledVector(drop, armLen * 0.105);
  const A3 = cuff1.clone().addScaledVector(dir, armLen * 0.94).addScaledVector(drop, armLen * 0.225);
  add(bin, 'sleeve', pathTube([cuff1, A1, A2, A3],
    [[0.0436, 0.0574, 0.0210], [0.0490, 0.0630, 0.0230],
      [0.0552, 0.0700, 0.0255], [0.0606, 0.0764, 0.0278]],
    H.X, 5, false, true), tint * 1.0);
  // Fabric folds. The section has to be derived from the sleeve's own taper at
  // that station — a fixed radius leaves the ring poking through the sleeve
  // wall further down the arm as a row of shards.
  for (const [t, s] of [[0.16, 1.022], [0.40, 1.020], [0.64, 1.018]]) {
    const p0 = cuff1.clone().lerp(A2, t);
    const p1 = cuff1.clone().lerp(A2, t + 0.050);
    const w0f = (0.0436 + (0.0552 - 0.0436) * t) * s;
    const h0f = (0.0574 + (0.0700 - 0.0574) * t) * s;
    const w1f = (0.0436 + (0.0552 - 0.0436) * (t + 0.05)) * s;
    const h1f = (0.0574 + (0.0700 - 0.0574) * (t + 0.05)) * s;
    add(bin, 'sleeve', pathTube([p0, p1],
      [[w0f, h0f, w0f * 0.42], [w1f, h1f, w1f * 0.42]],
      H.X, 5, false, false), tint * 1.18);
  }
}

// ============================================================ RIFLE =========
/*
 * 5.56 x 45 carbine. Real M4-pattern numbers throughout:
 *   overall (stock extended) .......... 838 mm
 *   barrel (bolt face to muzzle) ...... 368 mm
 *   A2 flash hider .................... 56 mm
 *   upper receiver .................... 195 mm, 38 mm wide, 36 mm tall
 *   free-float handguard .............. 190 mm, 50 mm across flats
 *   STANAG magazine ................... 180 mm tall, 24 x 62 mm body
 *   sight-over-bore (absolute cowitness) 66 mm
 *
 * The origin is the web of the firing hand; the bolt face lands at z = -0.065
 * and the buttpad at z = +0.349, which is a 368 mm length of pull.
 */

const R = {
  bore: 0.055,
  boltFace: -0.065,
  muzzle: -0.489,
  buttRear: 0.349,
  upperFront: -0.140,
  upperRear: 0.055,
  upperH: 0.036,
  upperW: 0.038,
  railY: 0.0755,          // rail seat; teeth top out 6.35 mm above this
  opticY: 0.121,          // bore + 66 mm
  hgFront: -0.330,
  hgRear: -0.140,
  hgFlat: 0.0250,         // outer radius across flats
  hgWall: 0.0042,
};

function buildRifleReceiver(S) {
  const y = R.bore;

  // -- upper receiver -------------------------------------------------------
  const upLen = R.upperRear - R.upperFront;
  add(S, 'metal', at(chamferBox(R.upperW, R.upperH, upLen, { c: 0.0016, r: 0.0075 }),
    0, y + 0.0025, (R.upperRear + R.upperFront) * 0.5), 1.06);

  // Flat-top shelf the rail sits on, slightly narrower than the receiver.
  add(S, 'metal', at(chamferBox(0.0230, 0.0040, upLen - 0.004, { c: 0.0010, r: 0.0016 }),
    0, R.railY - 0.0015, (R.upperRear + R.upperFront) * 0.5), 1.03);

  // Charging-handle raceway hump at the rear.
  add(S, 'metal', at(chamferBox(0.0300, 0.0150, 0.030, { c: 0.0012, r: 0.0050 }),
    0, y + 0.0130, R.upperRear - 0.013), 0.86);

  // Barrel-nut / receiver front ring.
  add(S, 'metal', at(latheZ([
    [0.0210, R.upperFront + 0.014], [0.0215, R.upperFront + 0.011],
    [0.0215, R.upperFront - 0.001], [0.0205, R.upperFront - 0.004],
    [0.0125, R.upperFront - 0.004], [0.0125, R.upperFront + 0.014],
  ], 18), 0, y, 0), 1.02);

  // Worn edges along the top corners of the receiver, either side of the rail
  // shelf: the two brightest lines on the whole upper, and what separates the
  // receiver's value from the handguard's.
  for (const sx of [-1, 1]) {
    wearEdge(S, sx * 0.0186, R.railY - 0.0035, R.upperFront + 0.004, R.upperRear - 0.004, 0.0016, 1.02);
    wearEdge(S, sx * 0.0178, 0.0388, R.upperFront + 0.008, 0.0480, 0.0013, 0.90);
  }

  // -- picatinny, receiver run and handguard run ----------------------------
  railRun(S, 'metal', R.railY, R.upperRear - 0.008, R.upperFront + 0.002);
  railRun(S, 'metal', R.railY, R.hgRear - 0.003, R.hgFront + 0.003);

  // -- ejection port --------------------------------------------------------
  const portZ = -0.030;
  const portY = y + 0.004;
  // Recessed floor, then a raised rim on all four sides.
  add(S, 'metal', at(chamferBox(0.0030, 0.0210, 0.0430, { c: 0.0006, r: 0.0010 }),
    0.0175, portY, portZ), 0.55);
  for (const [dy, hh] of [[0.0125, 0.0035], [-0.0125, 0.0035]]) {
    add(S, 'metal', at(chamferBox(0.0035, hh, 0.0470, { c: 0.0007, r: 0.0010 }),
      0.0186, portY + dy, portZ), 1.05);
  }
  for (const dz of [0.0245, -0.0245]) {
    add(S, 'metal', at(chamferBox(0.0035, 0.0290, 0.0040, { c: 0.0007, r: 0.0010 }),
      0.0186, portY, portZ + dz), 1.05);
  }
  // Brass deflector — the wedge behind the port.
  add(S, 'metal', put(chamferBox(0.0130, 0.0150, 0.0180, { c: 0.0010, r: 0.0030 }),
    0.0165, portY + 0.004, portZ + 0.030, 0, 0, -32 * DEG), 1.0);

  // Forward assist.
  add(S, 'metal', put(new THREE.CylinderGeometry(0.0058, 0.0062, 0.0175, 10),
    0.0195, y + 0.006, R.upperRear - 0.021, Math.PI / 2, 0, 0), 0.98);
  add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0072, 0.0072, 0.0050, 10),
    0.0195, y + 0.006, R.upperRear - 0.032, Math.PI / 2, 0, 0), 1.0);

  // -- lower receiver -------------------------------------------------------
  const loFront = -0.140;
  const loRear = 0.060;
  add(S, 'metal', at(chamferBox(0.0360, 0.0330, loRear - loFront, { c: 0.0016, r: 0.0060 }),
    0, 0.0225, (loRear + loFront) * 0.5), 0.90);

  // Magazine well: hollow collar, tilted 4 degrees forward like the real one.
  const mwZ = -0.0775;
  add(S, 'metal', put(collarBox(0.0400, 0.0740, 0.0620, 0.0055, { c: 0.0014, r: 0.0060 }),
    0, 0.0110, mwZ, Math.PI / 2 + 4 * DEG, 0, 0), 0.94);
  // Flared mouth at the bottom of the well.
  add(S, 'metalWorn', put(collarBox(0.0430, 0.0790, 0.0090, 0.0060, { c: 0.0012, r: 0.0065 }),
    0, -0.0175, mwZ - 0.0016, Math.PI / 2 + 4 * DEG, 0, 0), 0.72);

  // Takedown / pivot pins.
  for (const pz of [loRear - 0.012, loFront + 0.012]) {
    for (const sx of [-1, 1]) {
      add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0035, 0.0035, 0.0030, 10),
        sx * 0.0182, 0.0300, pz, 0, 0, Math.PI / 2), 1.0);
    }
  }
  // Buffer-tube junction, castle nut and end plate.
  add(S, 'metal', at(latheZ([
    [0.0170, loRear + 0.006], [0.0175, loRear + 0.003], [0.0175, loRear - 0.010],
    [0.0150, loRear - 0.013], [0.0100, loRear - 0.013],
  ], 16), 0, y, 0), 0.99);
  add(S, 'metalWorn', at(latheZ([
    [0.0195, loRear + 0.0125], [0.0195, loRear + 0.0065], [0.0165, loRear + 0.0060],
    [0.0165, loRear + 0.0120], [0.0155, loRear + 0.0125],
  ], 12), 0, y, 0), 1.0);
}

function buildRifleHandguard(S) {
  const y = R.bore;
  // Octagonal free-float tube: eight flats, five of them broken by 32 mm M-LOK
  // slots so you can see the gas tube and barrel through the gaps.
  const facetW = 2 * R.hgFlat * Math.tan(22.5 * DEG);
  const rMid = R.hgFlat - R.hgWall * 0.5;
  const len = R.hgRear - R.hgFront;
  const slotted = new Set([90, 135, 180, 225, 270]);
  const nSlots = 3;
  const slotLen = 0.0320;
  const bridge = (len - nSlots * slotLen) / (nSlots + 1);

  for (let k = 0; k < 8; k++) {
    const deg = k * 45;
    const a = deg * DEG;
    const cx = Math.sin(a) * rMid;
    const cy = Math.cos(a) * rMid + y;
    if (!slotted.has(deg)) {
      add(S, 'metal', put(chamferBox(facetW - 0.0012, R.hgWall, len - 0.001,
        { c: 0.0009, r: 0.0009 }), cx, cy, R.hgFront + len * 0.5, 0, 0, -a), 0.76);
    } else {
      for (let i = 0; i <= nSlots; i++) {
        const segZ = R.hgFront + i * (bridge + slotLen) + bridge * 0.5;
        add(S, 'metal', put(chamferBox(facetW - 0.0012, R.hgWall, bridge - 0.001,
          { c: 0.0009, r: 0.0009 }), cx, cy, segZ, 0, 0, -a), 0.76);
      }
      // M-LOK slot rails: the raised lips either side of each cut-out.
      for (let i = 0; i < nSlots; i++) {
        const sz = R.hgFront + bridge + i * (bridge + slotLen) + slotLen * 0.5;
        for (const s of [-1, 1]) {
          const ox = Math.cos(a) * s * (facetW * 0.5 - 0.0016);
          const oy = -Math.sin(a) * s * (facetW * 0.5 - 0.0016);
          add(S, 'metal', put(chamferBox(0.0026, R.hgWall * 0.7, slotLen,
            { c: 0.0005, r: 0.0005, bevelSegments: 1, curveSegments: 1 }),
          cx + ox, cy + oy, sz, 0, 0, -a), 0.86);
        }
      }
    }
  }
  // Rear collar clamping onto the barrel nut, and a front end cap.
  add(S, 'metalWorn', at(latheZ([
    [0.0250, R.hgRear + 0.001], [0.0262, R.hgRear - 0.002], [0.0262, R.hgRear - 0.016],
    [0.0250, R.hgRear - 0.019], [0.0208, R.hgRear - 0.019], [0.0208, R.hgRear + 0.001],
  ], 20), 0, y, 0), 1.0);
  add(S, 'metalWorn', at(latheZ([
    [0.0222, R.hgFront + 0.010], [0.0240, R.hgFront + 0.007], [0.0240, R.hgFront - 0.002],
    [0.0228, R.hgFront - 0.005], [0.0130, R.hgFront - 0.005], [0.0130, R.hgFront + 0.010],
  ], 20), 0, y, 0), 1.04);
  for (const sx of [-1, 1]) screw(S, 'metalWorn', sx * 0.0180, y - 0.0175, R.hgRear - 0.009, 0.0024, 'y', 1.0);
  slingSocket(S, 'metal', -0.0245, y - 0.006, R.hgFront + 0.048, 1.0);
  slingSocket(S, 'metal', 0.0245, y - 0.006, R.hgFront + 0.048, 1.0);

  // Gas tube, visible through the M-LOK cut-outs.
  add(S, 'metalWorn', at(new THREE.CylinderGeometry(0.0026, 0.0026, 0.185, 8)
    .rotateX(Math.PI / 2), 0, y + 0.0128, R.hgFront + 0.090), 0.9);

  // Rubbed-through anodising on the four corner edges the support hand and the
  // sling actually touch. The handguard is a plain black octagon otherwise and
  // it is the single largest unbroken area on the weapon.
  for (const deg of [22.5, 157.5, 202.5, 337.5]) {
    const a = deg * DEG;
    wearEdge(S, Math.sin(a) * R.hgFlat * 1.005, Math.cos(a) * R.hgFlat * 1.005 + y,
      R.hgFront + 0.008, R.hgRear - 0.020, 0.0016, 0.86);
  }
}

function buildRifleBarrel(S) {
  const y = R.bore;
  // Step-down profile: heavy chamber section, relieved under the handguard,
  // gas-block journal, thin exposed muzzle section, threaded shoulder.
  add(S, 'metalDark', at(latheZ([
    [0.0122, -0.055], [0.0122, -0.128], [0.0116, -0.132],
    [0.0116, -0.150], [0.0098, -0.154],
    [0.0098, -0.245], [0.0086, -0.249],
    [0.0086, -0.334], [0.0092, -0.337],
    [0.0092, -0.376], [0.0080, -0.379],
    [0.0080, -0.428], [0.0088, -0.431], [0.0088, -0.433],
  ], 20), 0, y, 0), 0.88);

  // -- front sight base / gas block ----------------------------------------
  const fz = -0.356;
  add(S, 'metalDark', at(chamferBox(0.0250, 0.0230, 0.0400, { c: 0.0014, r: 0.0040 }),
    0, y + 0.0015, fz), 1.05);
  // Folded / low-profile front sight. A full-height post sits at absolute
  // cowitness, which put it straight through the middle of the red dot's
  // field and made the reticle look like it was mounted on a stalk. Folded
  // down it clears the optic's view cone entirely, which is how every rifle
  // running a primary optic is actually set up.
  add(S, 'metalDark', loft([
    { w: 0.0210, h: 0.0120, r: 0.0035, m: frame(0, y + 0.010, fz, Math.PI / 2) },
    { w: 0.0160, h: 0.0120, r: 0.0030, m: frame(0, y + 0.020, fz, Math.PI / 2) },
  ], 3), 0.97);
  for (const sx of [-1, 1]) {
    add(S, 'metal', at(chamferBox(0.0030, 0.0150, 0.0110, { c: 0.0006, r: 0.0010 }),
      sx * 0.0046, y + 0.0220, fz), 1.02);
  }
  add(S, 'metalWorn', at(new THREE.CylinderGeometry(0.0011, 0.0014, 0.0130, 8),
    0, y + 0.0210, fz), 1.05);
  // Gas port boss and taper pins.
  add(S, 'metal', at(new THREE.CylinderGeometry(0.0042, 0.0042, 0.0120, 10)
    .rotateX(Math.PI / 2), 0, y + 0.0128, fz + 0.019), 0.95);
  for (const sx of [-1, 1]) screw(S, 'metalWorn', sx * 0.0128, y - 0.002, fz + 0.011, 0.0022, 'x', 1.0);
  // Sling swivel under the gas block.
  add(S, 'metal', at(chamferBox(0.0090, 0.0090, 0.0080, { c: 0.0008, r: 0.0020 }),
    0, y - 0.0170, fz - 0.010), 0.95);
  slingLoop(S, 'metalWorn', 0, y - 0.0245, fz - 0.010, 0.0072, 1.0);

  // -- A2 flash hider: rear collar, six tines, five open slots, closed floor --
  const fh0 = -0.433;
  const fh1 = R.muzzle;
  add(S, 'metalWorn', at(latheZ([
    [0.0090, fh0 + 0.001], [0.0110, fh0 - 0.001], [0.0110, fh0 - 0.010],
    [0.0104, fh0 - 0.013], [0.0072, fh0 - 0.013], [0.0072, fh0 + 0.001],
  ], 16), 0, y, 0), 1.0);
  add(S, 'metalWorn', at(latheZ([
    [0.0100, fh1 + 0.012], [0.0108, fh1 + 0.009], [0.0108, fh1 + 0.002],
    [0.0100, fh1], [0.0062, fh1], [0.0062, fh1 + 0.012],
  ], 16), 0, y, 0), 1.05);
  // Inner sleeve so the bore is visible through the slots.
  add(S, 'metalWorn', at(latheZ([[0.0064, fh0], [0.0064, fh1 + 0.002]], 14), 0, y, 0), 0.6);
  const tineZ = (fh0 - 0.013 + fh1 + 0.012) * 0.5;
  const tineL = (fh0 - 0.013) - (fh1 + 0.012);
  for (const deg of [30, 90, 150, 210, 270, 330]) {
    const a = deg * DEG;
    add(S, 'metalWorn', put(chamferBox(0.0040, 0.0038, tineL, { c: 0.0005, r: 0.0008 }),
      Math.sin(a) * 0.0086, Math.cos(a) * 0.0086 + y, tineZ, 0, 0, -a), 1.02);
  }
  // Closed bottom web (an A2 vents up and sideways only).
  add(S, 'metalWorn', at(chamferBox(0.0110, 0.0040, tineL, { c: 0.0005, r: 0.0008 }),
    0, y - 0.0084, tineZ), 1.0);
}

function buildRifleStock(S) {
  const y = R.bore;
  // Mil-spec receiver extension, 29 mm across, with the six adjustment
  // detents modelled as the ribs between the notches on its underside.
  add(S, 'metal', at(latheZ([
    [0.0126, 0.2600], [0.0148, 0.2565], [0.0148, 0.0620], [0.0120, 0.0600],
  ], 16), 0, y, 0), 0.9);
  for (let i = 0; i < 6; i++) {
    const z = 0.108 + i * 0.0235;
    add(S, 'metal', at(chamferBox(0.0140, 0.0032, 0.0150, { c: 0.0005, r: 0.0008 }),
      0, y - 0.0152, z), 0.86);
  }

  // Collapsible stock body — lofted so the cheek weld is a real curve.
  const sz0 = 0.160;
  const sz1 = R.buttRear;
  const P = (t) => sz0 + (sz1 - sz0) * t;
  add(S, 'polymer', loft([
    { w: 0.0400, h: 0.0330, r: 0.0090, m: frame(0, y - 0.001, P(0.00)) },
    { w: 0.0450, h: 0.0380, r: 0.0110, m: frame(0, y - 0.002, P(0.16)) },
    { w: 0.0460, h: 0.0500, r: 0.0120, m: frame(0, y - 0.007, P(0.42)) },
    { w: 0.0440, h: 0.0640, r: 0.0120, m: frame(0, y - 0.013, P(0.72)) },
    { w: 0.0430, h: 0.0760, r: 0.0110, m: frame(0, y - 0.018, P(0.94)) },
    { w: 0.0410, h: 0.0770, r: 0.0100, m: frame(0, y - 0.018, P(1.00)) },
  ], 4), 0.95);
  // Cheek rest ridge and the sling-mount boss.
  add(S, 'polymer', at(chamferBox(0.0340, 0.0080, 0.1000, { c: 0.0012, r: 0.0025 }),
    0, y + 0.0230, P(0.62)), 1.02);
  for (const sx of [-1, 1]) {
    add(S, 'polymer', at(chamferBox(0.0060, 0.0180, 0.0300, { c: 0.0010, r: 0.0025 }),
      sx * 0.0215, y - 0.0090, P(0.30)), 0.9);
    slingSocket(S, 'metal', sx * 0.0230, y - 0.009, P(0.30), 1.0);
  }
  // Release lever under the stock.
  add(S, 'polymer', put(chamferBox(0.0180, 0.0110, 0.0480, { c: 0.0010, r: 0.0030 }),
    0, y - 0.0400, P(0.40), -6 * DEG, 0, 0), 0.88);
  add(S, 'metalWorn', at(chamferBox(0.0130, 0.0040, 0.0140, { c: 0.0006, r: 0.0012 }),
    0, y - 0.0455, P(0.28)), 1.0);

  // Rubber buttpad with a checkered face.
  add(S, 'rubber', at(chamferBox(0.0420, 0.0790, 0.0110, { c: 0.0020, r: 0.0110 }),
    0, y - 0.0180, sz1 - 0.0055), 1.0);
  for (let i = 0; i < 4; i++) {
    add(S, 'rubber', at(chamferBox(0.0330, 0.0040, 0.0040, { c: 0.0006, r: 0.0008 }),
      0, y - 0.0450 + i * 0.0180, sz1 - 0.0002), 0.9);
  }
}

function buildRifleGrip(S) {
  // A2-pattern pistol grip: 25 degrees off vertical, lofted with a palm swell
  // and four finger grooves cut into the front strap by the section widths.
  const tilt = 25 * DEG;
  const sec = [];
  const N = 9;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // Groove modulation: three scallops down the front of the grip.
    const groove = Math.sin(t * Math.PI * 3.2 - 0.6);
    const w = 0.0320 + 0.0028 * Math.sin(t * Math.PI) - 0.0006 * groove;
    const d = 0.0430 - 0.0060 * t + 0.0022 * groove;
    const dist = 0.0060 + t * 0.1010;
    sec.push({
      w,
      h: d,
      r: 0.0075,
      m: frame(0, -Math.cos(tilt) * dist + 0.006, Math.sin(tilt) * dist + 0.0050, Math.PI / 2),
    });
  }
  add(S, 'polymer', loft(sec, 4), 0.96);
  // Beavertail where the grip meets the receiver.
  add(S, 'polymer', put(chamferBox(0.0340, 0.0140, 0.0300, { c: 0.0012, r: 0.0050 }),
    0, 0.0035, 0.0180, -18 * DEG, 0, 0), 1.0);
  // Grip cap / storage-door hinge at the base.
  add(S, 'polymer', put(chamferBox(0.0300, 0.0400, 0.0060, { c: 0.0010, r: 0.0050 }),
    0, -0.0985, 0.0505, Math.PI / 2 - tilt, 0, 0), 0.88);
  // Rubberised backstrap insert.
  add(S, 'rubber', put(chamferBox(0.0240, 0.0700, 0.0040, { c: 0.0008, r: 0.0060 }),
    0, -0.0480, 0.0470, -tilt, 0, 0), 1.0);
}

function buildRifleControls(S) {
  // Trigger guard: a closed loop extruded across the receiver.
  const tg = roundedRect(0.0670, 0.0460, 0.0140);
  tg.holes.push(roundedRect(0.0550, 0.0330, 0.0100));
  const tgGeo = extrudeChamfer(tg, 0.0085, 0.0010, 1, 4);
  rot(tgGeo, 0, Math.PI / 2, 0);
  // Shape's +x becomes weapon -z, so the loop centre sits forward of the grip.
  add(S, 'metal', at(tgGeo, 0, -0.0180, -0.0215), 0.95);

  // Safety selector: drum plus lever, ambidextrous.
  for (const sx of [-1, 1]) {
    add(S, 'metal', put(new THREE.CylinderGeometry(0.0072, 0.0072, 0.0040, 12),
      sx * 0.0180, 0.0270, 0.0110, 0, 0, Math.PI / 2), 1.0);
    add(S, 'metalWorn', put(chamferBox(0.0045, 0.0090, 0.0230, { c: 0.0006, r: 0.0012 }),
      sx * 0.0205, 0.0225, 0.0195, 28 * DEG, 0, 0), 1.05);
  }
  // Magazine release: right-side button inside a protective fence.
  add(S, 'metal', put(collarBox(0.0180, 0.0180, 0.0035, 0.0035, { c: 0.0008, r: 0.0060 }),
    0.0182, 0.0245, -0.0400, 0, Math.PI / 2, 0), 0.95);
  add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0052, 0.0050, 0.0055, 10),
    0.0192, 0.0245, -0.0400, 0, 0, Math.PI / 2), 1.05);
  // Bolt catch: left-side paddle with a raised upper shelf.
  add(S, 'metal', put(chamferBox(0.0040, 0.0110, 0.0330, { c: 0.0007, r: 0.0018 }),
    -0.0186, 0.0230, -0.0330, 0, 0, 0), 1.0);
  add(S, 'metalWorn', at(chamferBox(0.0045, 0.0130, 0.0090, { c: 0.0007, r: 0.0015 }),
    -0.0190, 0.0270, -0.0455), 1.05);
  // Trigger-pin and hammer-pin heads.
  for (const pz of [-0.0170, 0.0060]) {
    for (const sx of [-1, 1]) {
      add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0026, 0.0026, 0.0022, 8),
        sx * 0.0178, 0.0140, pz, 0, 0, Math.PI / 2), 1.0);
    }
  }
}

/**
 * Enclosed-emitter red dot, 30 mm tube, on a 39 mm mount — which is exactly the
 * height that puts the reticle 66 mm over the bore, i.e. absolute cowitness
 * with the front sight post built above.
 */
function buildRifleOptic(S, extras) {
  const oy = R.opticY;
  const z0 = 0.005;    // rear glass
  const z1 = -0.057;   // objective

  // Mount: clamp body, throw lever, recoil lug.
  //
  // The whole optic assembly is tinted well down from the receiver. A hard-
  // anodised black optic body really is the darkest thing bolted to a rifle,
  // and giving it the bottom of the value ladder is what stops the sight
  // picture — the one thing the player looks at — from dissolving into the
  // receiver behind it.
  add(S, 'metal', at(chamferBox(0.0260, 0.0250, 0.0360, { c: 0.0012, r: 0.0035 }),
    0, 0.0940, -0.0260), 0.66);
  add(S, 'metal', at(chamferBox(0.0320, 0.0090, 0.0250, { c: 0.0010, r: 0.0025 }),
    0, 0.0855, -0.0260), 0.62);
  add(S, 'metalWorn', put(chamferBox(0.0090, 0.0130, 0.0300, { c: 0.0008, r: 0.0030 }),
    0.0180, 0.0870, -0.0260, 0, 0, -12 * DEG), 0.80);
  screw(S, 'metalWorn', 0, 0.1075, -0.0400, 0.0028, 'y', 0.82);

  // Tube: two bells with a relieved waist and a saddle for the turrets.
  add(S, 'metal', at(latheZ([
    [0.0140, z0 + 0.006], [0.0165, z0 + 0.003], [0.0165, z0 - 0.001],
    [0.0152, z0 - 0.004], [0.0152, z0 - 0.014],
    [0.0148, z0 - 0.017], [0.0148, z1 + 0.017],
    [0.0152, z1 + 0.014], [0.0152, z1 + 0.004],
    [0.0165, z1 + 0.001], [0.0165, z1 - 0.003], [0.0140, z1 - 0.006],
  ], 24), 0, oy, 0), 1.0);
  // Turret saddle. This has to be bored through: as a solid box it straddled
  // the optic axis and occluded both the reticle and the view down the tube,
  // which is why the lens read as an opaque disc with no dot in it.
  // The wall between the outer profile and the bore has to stay thicker than
  // the chamfer, or ExtrudeGeometry's bevel pass walks the two contours past
  // each other at the end caps and re-fills the middle.
  const saddle = roundedRect(0.0360, 0.0340, 0.0080);
  saddle.holes.push(holeCircle(0, 0, 0.0136));
  add(S, 'metal', at(extrudeChamfer(saddle, 0.0230, 0.0010, 1, 8), 0, oy, -0.0270), 0.98);
  // Elevation (top) and windage (right) turret caps, knurled.
  for (const [tx, ty, rz] of [[0, 0.0215, 0], [0.0215, 0, Math.PI / 2]]) {
    add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0072, 0.0078, 0.0090, 12),
      tx, oy + ty, -0.0270, 0, 0, rz), 1.04);
    add(S, 'metal', put(new THREE.CylinderGeometry(0.0090, 0.0090, 0.0050, 12),
      tx * 0.75, oy + ty * 0.75, -0.0270, 0, 0, rz), 0.95);
  }
  // Brightness rotary on the left.
  add(S, 'metal', put(new THREE.CylinderGeometry(0.0088, 0.0088, 0.0070, 12),
    -0.0180, oy, -0.0270, 0, 0, Math.PI / 2), 0.97);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    add(S, 'metal', put(tinyBox(0.0070, 0.0016, 0.0016),
      -0.0215, oy + Math.cos(a) * 0.0082, -0.0270 + Math.sin(a) * 0.0082,
      0, 0, Math.PI / 2), 1.06);
  }
  // Battery cap under the saddle.
  add(S, 'metal', put(new THREE.CylinderGeometry(0.0070, 0.0070, 0.0060, 10),
    0, oy - 0.0210, -0.0270, 0, 0, 0), 0.94);

  // Emitter: the LED pod on the tube floor, canted up the sight axis.
  add(S, 'metal', put(chamferBox(0.0075, 0.0050, 0.0095, { c: 0.0006, r: 0.0012 }),
    0, oy - 0.0146, z1 + 0.014, -14 * DEG, 0, 0), 0.8);
  const emit = new THREE.SphereGeometry(0.0011, 8, 6);
  add(S, 'metalWorn', at(emit, 0, oy - 0.0128, z1 + 0.0180), 1.15);

  // -- lens stack ----------------------------------------------------------
  // Inner tube wall, so the bore behind the lens reads as a dark cylinder
  // rather than as nothing. This is what gives the lens somewhere to sit.
  add(S, 'metal', at(latheZ([
    [0.0128, z0 - 0.004], [0.0128, z1 + 0.004],
  ], 24), 0, oy, 0), 0.34);

  // Recessed bezels: a raised rim at each opening that overhangs the glass,
  // which is what reads as "lens set inside a tube" instead of a painted disc.
  add(S, 'metalWorn', at(latheZ([
    [0.0128, z0 + 0.001], [0.0150, z0 + 0.001], [0.0150, z0 - 0.005],
    [0.0128, z0 - 0.006], [0.0128, z0 + 0.001],
  ], 24), 0, oy, 0), 1.10);
  add(S, 'metalWorn', at(latheZ([
    [0.0128, z1 + 0.007], [0.0150, z1 + 0.007], [0.0150, z1 + 0.001],
    [0.0128, z1], [0.0128, z1 + 0.007],
  ], 24), 0, oy, 0), 1.10);

  const mats2 = getMaterials();
  // Both elements are shallow spherical caps rather than flat discs, so the
  // specular falls off radially across the glass instead of blowing out as one
  // uniform blob. Objective bulges forward, ocular bulges toward the eye.
  const objective = lensDome(z1 + 0.0085, 0.0022, 0.0126, true, 28, 7);
  objective.translate(0, oy, 0);
  OWNED_GEOMETRY.add(objective);
  const objMesh = new THREE.Mesh(objective, mats2.glass);
  objMesh.name = 'rifle.opticObjective';
  objMesh.frustumCulled = false;
  extras.push(objMesh);

  const ocular = lensDome(z0 - 0.0075, 0.0016, 0.0124, false, 28, 6);
  ocular.translate(0, oy, 0);
  OWNED_GEOMETRY.add(ocular);
  const ocMesh = new THREE.Mesh(ocular, mats2.glass);
  ocMesh.name = 'rifle.opticOcular';
  ocMesh.frustumCulled = false;
  extras.push(ocMesh);

  // The reticle: a saturated core disc that occludes, plus a fixed additive
  // halo behind it, both on the sight axis at the objective. Exposed as
  // model.dot; Weapon.js drives its opacity and emissiveIntensity from the
  // ADS blend, so the dot brightens as you bring the weapon up.
  const haloGeo = new THREE.CircleGeometry(0.0030, 20);
  haloGeo.translate(0, oy, z1 + 0.0113);
  OWNED_GEOMETRY.add(haloGeo);
  const haloMesh = new THREE.Mesh(haloGeo, mats2.dotGlow);
  haloMesh.name = 'rifle.reticleGlow';
  haloMesh.frustumCulled = false;
  extras.push(haloMesh);

  const dotGeo = new THREE.CircleGeometry(0.0013, 16);
  dotGeo.translate(0, oy, z1 + 0.0116);
  OWNED_GEOMETRY.add(dotGeo);
  const dotMesh = new THREE.Mesh(dotGeo, mats2.dot);
  dotMesh.name = 'rifle.reticle';
  dotMesh.frustumCulled = false;
  extras.push(dotMesh);

  return { z0, dot: dotMesh };
}

/** 30-round STANAG, curved on a 550 mm radius with real witness holes. */
function buildRifleMagazine() {
  const pivot = new THREE.Vector3(0, 0.0400, -0.0775);
  const M = newBin(pivot);
  const Rc = 0.550;
  const lean = 4 * DEG;
  const N = 8;
  const total = 0.180;
  const ds = total / N;

  const pts = [];
  let yy = pivot.y;
  let zz = pivot.z;
  let th = lean;
  for (let i = 0; i <= N; i++) {
    pts.push({ y: yy, z: zz, th });
    yy -= Math.cos(th) * ds;
    zz -= Math.sin(th) * ds;
    th += ds / Rc;
  }
  const sec = pts.map((p, i) => {
    const t = i / N;
    return {
      w: 0.0240 - 0.0008 * t,
      h: 0.0625 - 0.0045 * t,
      r: 0.0055,
      m: frame(0, p.y, p.z, Math.PI / 2 + p.th),
    };
  });
  add(M, 'polymer', loft(sec, 4), 0.92);

  // Reinforcing ribs around the body.
  for (const i of [2, 4, 6]) {
    const p = pts[i];
    add(M, 'polymer', put(collarBox(0.0262, 0.0630, 0.0055, 0.0030, { c: 0.0006, r: 0.0055 }),
      0, p.y, p.z, Math.PI / 2 + p.th), 1.05);
  }
  // Witness holes: two strips per flank, each planar and tangent to the curve.
  for (const sx of [-1, 1]) {
    for (const i of [2, 5]) {
      const p = pts[i];
      witnessStrip(M, 'polymer', {
        x: sx * 0.0124, y: p.y - ds * 0.5, z: p.z - Math.sin(p.th) * ds * 0.5,
        count: 2, spacing: 0.0150, hole: 0.0028, w: 0.0130, thick: 0.0016,
        rx: -p.th, tint: 1.06,
      });
    }
  }
  // Magazine catch notch on the right, and the feed-lip block up top.
  add(M, 'polymer', at(chamferBox(0.0040, 0.0090, 0.0130, { c: 0.0006, r: 0.0012 }),
    0.0126, pivot.y - 0.0210, pivot.z + 0.0230), 0.85);
  add(M, 'metalWorn', put(collarBox(0.0230, 0.0600, 0.0120, 0.0028, { c: 0.0008, r: 0.0045 }),
    0, pivot.y + 0.0025, pivot.z - 0.0002, Math.PI / 2 + lean), 0.95);

  // Floorplate and its front lip.
  const b = pts[N];
  add(M, 'metalWorn', put(chamferBox(0.0290, 0.0640, 0.0110, { c: 0.0012, r: 0.0035 }),
    0, b.y + 0.0040, b.z, Math.PI / 2 + b.th), 1.0);
  add(M, 'polymer', put(chamferBox(0.0250, 0.0120, 0.0150, { c: 0.0008, r: 0.0025 }),
    0, b.y + 0.0035, b.z - 0.0290, Math.PI / 2 + b.th), 0.9);

  return { bin: M, pivot };
}

function buildRifleChargingHandle() {
  const pivot = new THREE.Vector3(0, 0.0700, 0.0720);
  const H = newBin(pivot);
  add(H, 'metalWorn', at(chamferBox(0.0300, 0.0058, 0.0290, { c: 0.0008, r: 0.0018 }),
    0, 0.0700, 0.0705), 1.0);
  // Latch, on the left, with a raised thumb pad.
  add(H, 'metalWorn', at(chamferBox(0.0230, 0.0092, 0.0135, { c: 0.0008, r: 0.0022 }),
    -0.0160, 0.0700, 0.0800), 1.05);
  add(H, 'metalWorn', at(chamferBox(0.0130, 0.0040, 0.0090, { c: 0.0006, r: 0.0012 }),
    -0.0215, 0.0700, 0.0800), 1.12);
  // Knurled rear lip.
  add(H, 'metalWorn', at(chamferBox(0.0320, 0.0105, 0.0048, { c: 0.0008, r: 0.0016 }),
    0, 0.0718, 0.0858), 1.02);
  for (let i = 0; i < 7; i++) {
    add(H, 'metalWorn', at(tinyBox(0.0022, 0.0090, 0.0035),
      -0.0126 + i * 0.0042, 0.0718, 0.0880), 1.08);
  }
  // The two legs that ride in the receiver raceway.
  for (const sx of [-1, 1]) {
    add(H, 'metal', at(new THREE.CylinderGeometry(0.0034, 0.0034, 0.0500, 8)
      .rotateX(Math.PI / 2), sx * 0.0098, 0.0672, 0.0430), 0.85);
  }
  return { bin: H, pivot };
}

function buildRifleTrigger() {
  const pivot = new THREE.Vector3(0, 0.0080, -0.0160);
  const T = newBin(pivot);
  add(T, 'metalWorn', at(chamferBox(0.0072, 0.0110, 0.0058, { c: 0.0006, r: 0.0014 }),
    0, 0.0030, -0.0160), 1.0);
  add(T, 'metalWorn', put(chamferBox(0.0070, 0.0105, 0.0062, { c: 0.0006, r: 0.0014 }),
    0, -0.0060, -0.0178, 14 * DEG), 1.02);
  add(T, 'metalWorn', put(chamferBox(0.0076, 0.0090, 0.0068, { c: 0.0006, r: 0.0016 }),
    0, -0.0140, -0.0212, 34 * DEG), 1.05);
  for (let i = 0; i < 3; i++) {
    add(T, 'metalWorn', put(tinyBox(0.0060, 0.0016, 0.0016),
      0, -0.0035 - i * 0.0048, -0.0196 - i * 0.0014, 18 * DEG), 1.1);
  }
  return { bin: T, pivot };
}

function buildRifleDustCover() {
  const pivot = new THREE.Vector3(0.0190, 0.0452, -0.0300);
  const D = newBin(pivot);
  add(D, 'metal', at(chamferBox(0.0032, 0.0250, 0.0455, { c: 0.0008, r: 0.0020 }),
    0.0197, 0.0578, -0.0300), 0.9);
  add(D, 'metal', at(chamferBox(0.0028, 0.0060, 0.0400, { c: 0.0006, r: 0.0012 }),
    0.0216, 0.0578, -0.0300), 1.0);
  add(D, 'rubber', at(chamferBox(0.0022, 0.0210, 0.0410, { c: 0.0005, r: 0.0016 }),
    0.0172, 0.0578, -0.0300), 0.8);
  add(D, 'metalWorn', put(new THREE.CylinderGeometry(0.0022, 0.0022, 0.0480, 8),
    0.0190, 0.0452, -0.0300, Math.PI / 2), 1.0);
  return { bin: D, pivot };
}

function buildRifleBolt() {
  const pivot = new THREE.Vector3(0, R.bore, -0.0300);
  const B = newBin(pivot);
  add(B, 'metalWorn', at(latheZ([
    [0.0118, 0.0130], [0.0118, -0.0620], [0.0102, -0.0650],
    [0.0102, -0.0700], [0.0060, -0.0700],
  ], 16), 0, R.bore, 0), 0.75);
  // Cam pin and the gas key up top.
  add(B, 'metalWorn', at(chamferBox(0.0130, 0.0090, 0.0230, { c: 0.0007, r: 0.0018 }),
    0, R.bore + 0.0150, -0.0130), 0.8);
  add(B, 'metalWorn', put(new THREE.CylinderGeometry(0.0038, 0.0038, 0.0110, 8),
    0, R.bore + 0.0150, -0.0420, Math.PI / 2), 0.85);
  return { bin: B, pivot };
}

/**
 * Rifle hand placement.
 *
 * Firing hand: the right hand on the A2 grip. Its +X (thumb side) runs up the
 * grip, so the knuckle line lies up the grip's right flank, the palm takes the
 * backstrap and the fingers wrap the front strap from the right. The index is
 * pulled off the wrap and put on the trigger.
 *
 * Support hand: the left hand on the handguard, palm on the outboard flank,
 * fingers over the top and down the far side, thumb crossing the top rail.
 * Note that hand chirality fixes the thumb direction once the wrap direction is
 * chosen — for a LEFT hand with the palm outboard and the fingers cresting the
 * top, the thumb necessarily lies back along the rail rather than forward down
 * it. The two read identically from the player's eye (the thumb is almost
 * end-on either way) and this one keeps the wrist and forearm on the correct
 * side of the weapon.
 */
function buildRifleHands(S) {
  const gt = 25 * DEG;
  const gripUp = V3(0, Math.cos(gt), -Math.sin(gt));
  // The grip's own axis, 40 mm down from the top: that puts the index knuckle
  // 11 mm below the beavertail (a high grip) and the little finger 69 mm down,
  // just above the grip cap.
  buildHand(S, {
    side: 1,
    gripAxis: gripUp,
    dorsal: V3(0.78, 0.10, 0.62),
    gripPoint: V3(0, 0.006, 0.005).addScaledVector(gripUp, -0.0400),
    // A2 grip: 43 mm front to back, 32 mm across.
    ry: 0.0200, rz: 0.0166,
    arch: 0.0380,
    trigger: V3(0.0038, -0.0128, -0.0112),
    thumbPose: 'wrap',
    armDir: V3(0.30, -0.46, 0.84),
    armLen: 0.38,
    tint: 1.0,
  });

  buildHand(S, {
    side: -1,
    gripAxis: V3(0, 0, -1),
    dorsal: V3(-0.86, 0.51, 0),
    gripPoint: V3(0, R.bore + 0.0030, -0.2380),
    ry: 0.0250, rz: 0.0250,
    arch: 0.0400, flat: 0.0120,
    wrapStop: -2.30,
    thumbPose: 'wrap',
    armDir: V3(-0.40, -0.52, 0.76),
    armLen: 0.38,
    tint: 1.0,
  });
}

function buildRifle() {
  const S = newBin();
  const extras = [];
  buildRifleReceiver(S);
  buildRifleHandguard(S);
  buildRifleBarrel(S);
  buildRifleStock(S);
  buildRifleGrip(S);
  buildRifleControls(S);
  const optic = buildRifleOptic(S, extras);
  buildRifleHands(S);

  const group = new THREE.Group();
  group.name = 'weapon.rifle';
  const staticGroup = finalize(S, 'rifle.static');
  group.add(staticGroup);
  for (const m of extras) group.add(m);

  const mag = buildRifleMagazine();
  const magazine = finalize(mag.bin, 'rifle.magazine');
  group.add(magazine);

  const ch = buildRifleChargingHandle();
  const charging = finalize(ch.bin, 'rifle.charging');
  group.add(charging);

  const tr = buildRifleTrigger();
  const trigger = finalize(tr.bin, 'rifle.trigger');
  group.add(trigger);

  const dc = buildRifleDustCover();
  const dustCover = finalize(dc.bin, 'rifle.dustCover');
  group.add(dustCover);

  const bl = buildRifleBolt();
  const bolt = finalize(bl.bin, 'rifle.bolt');
  group.add(bolt);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'rifle.muzzle';
  muzzle.position.set(0, R.bore, R.muzzle);
  group.add(muzzle);

  const ejectPort = makeEjectAnchor(0.0215, R.bore + 0.004, -0.030, new THREE.Vector3(0.90, 0.40, -0.16));
  group.add(ejectPort);

  const sight = new THREE.Object3D();
  sight.name = 'rifle.sight';
  sight.position.set(0, R.opticY, optic.z0);
  group.add(sight);

  return {
    group, muzzle, ejectPort, magazine, charging, sight,
    trigger, dustCover, bolt, dot: optic.dot, adsDistance: 0.240,
  };
}

// ============================================================== SMG =========
/*
 * 9 x 19 roller-delayed submachine gun, MP5A3 pattern:
 *   overall (stock extended) .......... 680 mm
 *   overall (stock retracted) ......... 490 mm
 *   barrel ............................ 225 mm
 *   receiver .......................... 42 mm across, stamped rounded-square
 *   magazine .......................... 30 rounds, 205 mm, tightly curved
 *   sight-over-bore ................... 37 mm (drum rear, hooded front post)
 *
 * Iron sights rather than an optic: the rotary drum and the hooded post are
 * the two details that make this silhouette instantly readable.
 */

const G = {
  bore: 0.048,
  boltFace: -0.110,
  muzzle: -0.335,
  buttRear: 0.3417,
  recRear: 0.155,
  recFront: -0.150,
  sightY: 0.085,
  hgFront: -0.272,
  drumZ: 0.070,
};

function buildSmgReceiver(S) {
  const y = G.bore;
  // Stamped receiver: a rounded square, lofted so the flanks stay smooth.
  add(S, 'metal', loft([
    { w: 0.0400, h: 0.0390, r: 0.0130, m: frame(0, y + 0.002, G.recFront - 0.004) },
    { w: 0.0420, h: 0.0400, r: 0.0135, m: frame(0, y + 0.002, G.recFront + 0.030) },
    { w: 0.0420, h: 0.0400, r: 0.0135, m: frame(0, y + 0.002, 0.060) },
    { w: 0.0415, h: 0.0400, r: 0.0135, m: frame(0, y + 0.002, G.recRear) },
  ], 5), 1.0);

  // Pressed flutes down the forward flanks.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      add(S, 'metal', at(chamferBox(0.0035, 0.0060, 0.0380, { c: 0.0006, r: 0.0016 }),
        sx * 0.0202, y + 0.0090 - i * 0.0075, G.recFront + 0.055), 1.05);
    }
  }
  // Ejection port, right flank.
  add(S, 'metal', at(chamferBox(0.0030, 0.0195, 0.0400, { c: 0.0006, r: 0.0012 }),
    0.0192, y + 0.0090, -0.0450), 0.55);
  for (const dy of [0.0115, -0.0115]) {
    add(S, 'metal', at(chamferBox(0.0032, 0.0035, 0.0440, { c: 0.0006, r: 0.0010 }),
      0.0204, y + 0.0090 + dy, -0.0450), 1.06);
  }

  // Rear end cap with the stock guide rails and the sling loop.
  add(S, 'metal', at(chamferBox(0.0430, 0.0410, 0.0140, { c: 0.0012, r: 0.0130 }),
    0, y + 0.002, G.recRear + 0.006), 0.95);
  for (const sx of [-1, 1]) screw(S, 'metalWorn', sx * 0.0130, y + 0.0180, G.recRear + 0.006, 0.0024, 'y', 1.0);
  slingLoop(S, 'metalWorn', 0, y - 0.0245, G.recRear + 0.004, 0.0080, 1.0);

  // Front trunnion collar where the barrel enters.
  add(S, 'metal', at(latheZ([
    [0.0130, G.recFront + 0.022], [0.0215, G.recFront + 0.020],
    [0.0215, G.recFront - 0.006], [0.0198, G.recFront - 0.010],
    [0.0120, G.recFront - 0.010], [0.0120, G.recFront + 0.022],
  ], 18), 0, y, 0), 1.02);

  // Cocking-lever tube, upper left, and the housing that ties it to the barrel.
  const cx = -0.0205;
  const cy = y + 0.0215;
  add(S, 'metal', at(latheZ([
    [0.0098, G.recFront + 0.008], [0.0105, G.recFront + 0.005],
    [0.0105, -0.2980], [0.0092, -0.3015],
  ], 14), cx, cy, 0), 0.96);
  // Web joining the cocking tube to the barrel shroud.
  add(S, 'metal', put(chamferBox(0.0090, 0.0230, 0.1450, { c: 0.0008, r: 0.0025 }),
    cx * 0.55, cy - 0.0125, -0.2200, 0, 0, -38 * DEG), 0.9);
}

function buildSmgBarrel(S) {
  const y = G.bore;
  // 225 mm barrel from the bolt face, stepping down to a 3-lug muzzle.
  add(S, 'metalDark', at(latheZ([
    [0.0128, -0.100], [0.0128, -0.146], [0.0112, -0.150],
    [0.0112, -0.176], [0.0084, -0.180],
    [0.0084, -0.286], [0.0092, -0.289],
    [0.0092, -0.298], [0.0076, -0.301],
    [0.0076, -0.318], [0.0088, -0.321], [0.0088, -0.331],
    [0.0072, -0.335], [0.0050, -0.335], [0.0050, -0.325],
  ], 18), 0, y, 0), 0.9);
  // Three-lug suppressor mount.
  for (const deg of [0, 120, 240]) {
    const a = deg * DEG;
    add(S, 'metalWorn', put(chamferBox(0.0042, 0.0032, 0.0100, { c: 0.0005, r: 0.0008 }),
      Math.sin(a) * 0.0098, Math.cos(a) * 0.0098 + y, -0.3255, 0, 0, -a), 1.05);
  }

  // Polymer handguard: a slim tube with a finger groove and cooling slots.
  add(S, 'polymer', loft([
    { w: 0.0400, h: 0.0380, r: 0.0140, m: frame(0, y - 0.001, -0.1490) },
    { w: 0.0430, h: 0.0410, r: 0.0155, m: frame(0, y - 0.002, -0.1750) },
    { w: 0.0415, h: 0.0400, r: 0.0150, m: frame(0, y - 0.002, -0.2350) },
    { w: 0.0350, h: 0.0345, r: 0.0130, m: frame(0, y - 0.001, G.hgFront) },
  ], 5), 0.95);
  // Finger groove and vent slots.
  add(S, 'polymer', at(chamferBox(0.0380, 0.0060, 0.0700, { c: 0.0010, r: 0.0025 }),
    0, y - 0.0195, -0.2050), 0.86);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      add(S, 'polymer', at(chamferBox(0.0030, 0.0080, 0.0230, { c: 0.0006, r: 0.0016 }),
        sx * 0.0206, y + 0.0010, -0.1780 - i * 0.0300), 0.8);
    }
  }
  add(S, 'polymer', at(latheZ([
    [0.0130, G.hgFront + 0.008], [0.0180, G.hgFront + 0.006],
    [0.0180, G.hgFront - 0.002], [0.0165, G.hgFront - 0.005],
    [0.0110, G.hgFront - 0.005], [0.0110, G.hgFront + 0.008],
  ], 16), 0, y, 0), 1.02);

  // -- hooded front post ---------------------------------------------------
  const fz = -0.3020;
  add(S, 'metal', at(chamferBox(0.0180, 0.0180, 0.0140, { c: 0.0010, r: 0.0035 }),
    0, y + 0.0110, fz), 0.95);
  add(S, 'metal', loft([
    { w: 0.0160, h: 0.0140, r: 0.0035, m: frame(0, y + 0.018, fz, Math.PI / 2) },
    { w: 0.0135, h: 0.0140, r: 0.0032, m: frame(0, y + 0.028, fz, Math.PI / 2) },
  ], 3), 0.98);
  // The hood itself: a closed annular profile revolved about the sight axis.
  add(S, 'metal', at(latheZ([
    [0.0075, fz + 0.0095], [0.0105, fz + 0.0095], [0.0105, fz - 0.0095],
    [0.0075, fz - 0.0095], [0.0075, fz + 0.0095],
  ], 16), 0, G.sightY, 0), 1.0);
  add(S, 'metalWorn', at(new THREE.CylinderGeometry(0.0011, 0.0014, 0.0160, 8),
    0, G.sightY - 0.0075, fz), 1.06);

  // -- rotary drum rear sight ----------------------------------------------
  const dz = G.drumZ;
  add(S, 'metal', at(chamferBox(0.0180, 0.0180, 0.0160, { c: 0.0010, r: 0.0035 }),
    0, y + 0.0140, dz), 0.95);
  add(S, 'metal', at(new THREE.CylinderGeometry(0.0140, 0.0140, 0.0130, 16)
    .rotateX(Math.PI / 2), 0, G.sightY, dz), 1.0);
  // Four apertures around the drum face; the one on the sight axis is open.
  for (let i = 0; i < 4; i++) {
    const a = i * 90 * DEG;
    add(S, 'metal', at(new THREE.CylinderGeometry(0.0030, 0.0030, 0.0030, 8)
      .rotateX(Math.PI / 2), Math.sin(a) * 0.0095, G.sightY + Math.cos(a) * 0.0095, dz + 0.0070), 0.5);
  }
  add(S, 'metal', at(latheZ([
    [0.0018, dz + 0.0075], [0.0058, dz + 0.0075], [0.0058, dz - 0.0075],
    [0.0018, dz - 0.0075], [0.0018, dz + 0.0075],
  ], 12), 0, G.sightY, 0), 0.7);
  // Knurled adjustment collar.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    add(S, 'metal', put(tinyBox(0.0022, 0.0022, 0.0120),
      Math.sin(a) * 0.0142, G.sightY + Math.cos(a) * 0.0142, dz), 1.06);
  }
}

function buildSmgFrame(S) {
  const y = G.bore;
  // Polymer trigger housing, the classic "SEF" lower.
  add(S, 'polymer', loft([
    { w: 0.0380, h: 0.0300, r: 0.0080, m: frame(0, 0.0140, -0.0640, Math.PI / 2, 0, 0) },
    { w: 0.0390, h: 0.0300, r: 0.0085, m: frame(0, 0.0140, -0.0300, Math.PI / 2, 0, 0) },
    { w: 0.0390, h: 0.0300, r: 0.0085, m: frame(0, 0.0140, 0.0200, Math.PI / 2, 0, 0) },
    { w: 0.0360, h: 0.0280, r: 0.0080, m: frame(0, 0.0140, 0.0460, Math.PI / 2, 0, 0) },
  ], 4, true, true), 0.94);

  // Pistol grip: 12 degrees off vertical with a palm swell and finger relief.
  const tilt = 13 * DEG;
  const sec = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const groove = Math.sin(t * Math.PI * 2.6 - 0.5);
    sec.push({
      w: 0.0320 + 0.0030 * Math.sin(t * Math.PI) - 0.0005 * groove,
      h: 0.0420 - 0.0055 * t + 0.0020 * groove,
      r: 0.0080,
      m: frame(0, 0.004 - Math.cos(tilt) * (0.006 + t * 0.098),
        0.006 + Math.sin(tilt) * (0.006 + t * 0.098), Math.PI / 2),
    });
  }
  add(S, 'polymer', loft(sec, 4), 0.96);
  add(S, 'rubber', put(chamferBox(0.0230, 0.0640, 0.0040, { c: 0.0008, r: 0.0060 }),
    0, -0.0450, 0.0330, -tilt, 0, 0), 1.0);
  add(S, 'polymer', put(chamferBox(0.0300, 0.0400, 0.0060, { c: 0.0010, r: 0.0050 }),
    0, -0.0995, 0.0300, Math.PI / 2 - tilt, 0, 0), 0.88);

  // Trigger guard.
  const tg = roundedRect(0.0620, 0.0430, 0.0130);
  tg.holes.push(roundedRect(0.0500, 0.0300, 0.0095));
  const tgGeo = extrudeChamfer(tg, 0.0080, 0.0010, 1, 3);
  rot(tgGeo, 0, Math.PI / 2, 0);
  add(S, 'polymer', at(tgGeo, 0, -0.0175, -0.0220), 0.92);

  // Selector: ambidextrous levers on a common shaft.
  for (const sx of [-1, 1]) {
    add(S, 'polymer', put(new THREE.CylinderGeometry(0.0080, 0.0080, 0.0035, 12),
      sx * 0.0195, 0.0150, 0.0110, 0, 0, Math.PI / 2), 1.0);
    add(S, 'metalWorn', put(chamferBox(0.0042, 0.0085, 0.0230, { c: 0.0006, r: 0.0012 }),
      sx * 0.0218, 0.0110, 0.0195, 25 * DEG, 0, 0), 1.05);
  }

  // Magazine well and the paddle release behind it.
  const mz = -0.0900;
  add(S, 'metal', put(collarBox(0.0320, 0.0420, 0.0560, 0.0045, { c: 0.0012, r: 0.0060 }),
    0, 0.0130, mz, Math.PI / 2 + 2 * DEG, 0, 0), 0.94);
  add(S, 'metal', put(collarBox(0.0350, 0.0460, 0.0080, 0.0050, { c: 0.0010, r: 0.0065 }),
    0, -0.0140, mz - 0.0008, Math.PI / 2 + 2 * DEG, 0, 0), 1.02);
  add(S, 'polymer', put(chamferBox(0.0150, 0.0180, 0.0090, { c: 0.0008, r: 0.0025 }),
    0, 0.0180, mz + 0.0330, -20 * DEG, 0, 0), 0.9);
  // Push-button release on the right.
  add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0048, 0.0046, 0.0050, 10),
    0.0175, 0.0230, mz + 0.0270, 0, 0, Math.PI / 2), 1.05);
  // Housing pins.
  for (const pz of [0.0400, -0.0540]) {
    for (const sx of [-1, 1]) {
      add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0030, 0.0030, 0.0022, 8),
        sx * 0.0192, 0.0170, pz, 0, 0, Math.PI / 2), 1.0);
    }
  }
}

function buildSmgStock(S) {
  const y = G.bore;
  // Sliding stock: two guide tubes, a lower strut and a folding butt plate.
  for (const sx of [-1, 1]) {
    add(S, 'metal', at(new THREE.CylinderGeometry(0.0072, 0.0072, 0.1880, 10)
      .rotateX(Math.PI / 2), sx * 0.0190, y - 0.0060, 0.2380), 0.92);
  }
  add(S, 'metal', at(chamferBox(0.0480, 0.0090, 0.0400, { c: 0.0010, r: 0.0030 }),
    0, y - 0.0290, 0.2100), 0.9);
  // Butt plate, canted and rubber-faced.
  add(S, 'metal', put(chamferBox(0.0460, 0.0680, 0.0090, { c: 0.0014, r: 0.0090 }),
    0, y - 0.0090, G.buttRear - 0.0075, -4 * DEG, 0, 0), 0.95);
  add(S, 'rubber', put(chamferBox(0.0410, 0.0640, 0.0060, { c: 0.0012, r: 0.0085 }),
    0, y - 0.0090, G.buttRear - 0.0018, -4 * DEG, 0, 0), 1.0);
  for (let i = 0; i < 3; i++) {
    add(S, 'rubber', at(chamferBox(0.0330, 0.0040, 0.0035, { c: 0.0005, r: 0.0008 }),
      0, y - 0.0290 + i * 0.0200, G.buttRear + 0.0008), 0.9);
  }
  // Latch and detent strip along the left tube.
  for (let i = 0; i < 4; i++) {
    add(S, 'metal', at(chamferBox(0.0040, 0.0110, 0.0090, { c: 0.0006, r: 0.0012 }),
      -0.0245, y - 0.0060, 0.1780 + i * 0.0300), 0.88);
  }
}

/** 30-round 9 mm stick magazine — tightly curved on a 280 mm radius. */
function buildSmgMagazine() {
  const pivot = new THREE.Vector3(0, 0.0320, -0.0900);
  const M = newBin(pivot);
  const Rc = 0.280;
  const lean = 2 * DEG;
  const N = 9;
  const total = 0.205;
  const ds = total / N;

  const pts = [];
  let yy = pivot.y;
  let zz = pivot.z;
  let th = lean;
  for (let i = 0; i <= N; i++) {
    pts.push({ y: yy, z: zz, th });
    yy -= Math.cos(th) * ds;
    zz -= Math.sin(th) * ds;
    th += ds / Rc;
  }
  const sec = pts.map((p, i) => ({
    w: 0.0255 - 0.0010 * (i / N),
    h: 0.0400 - 0.0035 * (i / N),
    r: 0.0070,
    m: frame(0, p.y, p.z, Math.PI / 2 + p.th),
  }));
  add(M, 'metal', loft(sec, 4), 0.9);

  // Stiffening ribs and the witness column.
  for (const i of [2, 4, 6]) {
    const p = pts[i];
    add(M, 'metal', put(collarBox(0.0278, 0.0410, 0.0050, 0.0028, { c: 0.0006, r: 0.0060 }),
      0, p.y, p.z, Math.PI / 2 + p.th), 1.06);
  }
  for (const sx of [-1, 1]) {
    for (const i of [2, 5]) {
      const p = pts[i];
      witnessStrip(M, 'metal', {
        x: sx * 0.0132, y: p.y - ds * 0.5, z: p.z - Math.sin(p.th) * ds * 0.5,
        count: 2, spacing: 0.0130, hole: 0.0022, w: 0.0100, thick: 0.0014,
        rx: -p.th, tint: 1.08,
      });
    }
  }
  // Feed lips and floorplate.
  add(M, 'metalWorn', put(collarBox(0.0240, 0.0380, 0.0110, 0.0025, { c: 0.0007, r: 0.0050 }),
    0, pivot.y + 0.0020, pivot.z, Math.PI / 2 + lean), 0.95);
  const b = pts[N];
  add(M, 'metalWorn', put(chamferBox(0.0300, 0.0420, 0.0100, { c: 0.0012, r: 0.0035 }),
    0, b.y + 0.0035, b.z, Math.PI / 2 + b.th), 1.0);
  add(M, 'polymer', put(chamferBox(0.0250, 0.0100, 0.0130, { c: 0.0008, r: 0.0022 }),
    0, b.y + 0.0030, b.z - 0.0180, Math.PI / 2 + b.th), 0.9);
  return { bin: M, pivot };
}

function buildSmgCharging() {
  // Cocking lever: the knob on the tube at the upper left, plus its shank.
  const pivot = new THREE.Vector3(-0.0205, G.bore + 0.0215, -0.2560);
  const H = newBin(pivot);
  add(H, 'metal', at(chamferBox(0.0120, 0.0090, 0.0180, { c: 0.0008, r: 0.0025 }),
    -0.0205, G.bore + 0.0215, -0.2560), 0.95);
  add(H, 'metalWorn', put(chamferBox(0.0110, 0.0300, 0.0150, { c: 0.0010, r: 0.0035 }),
    -0.0320, G.bore + 0.0335, -0.2560, 0, 0, 42 * DEG), 1.06);
  add(H, 'metalWorn', put(chamferBox(0.0080, 0.0140, 0.0130, { c: 0.0008, r: 0.0030 }),
    -0.0395, G.bore + 0.0415, -0.2560, 0, 0, 42 * DEG), 1.12);
  return { bin: H, pivot };
}

function buildSmgTrigger() {
  const pivot = new THREE.Vector3(0, 0.0000, -0.0170);
  const T = newBin(pivot);
  add(T, 'metalWorn', at(chamferBox(0.0068, 0.0100, 0.0055, { c: 0.0006, r: 0.0014 }),
    0, -0.0050, -0.0170), 1.0);
  add(T, 'metalWorn', put(chamferBox(0.0068, 0.0100, 0.0060, { c: 0.0006, r: 0.0014 }),
    0, -0.0135, -0.0195, 20 * DEG), 1.03);
  add(T, 'metalWorn', put(chamferBox(0.0072, 0.0080, 0.0065, { c: 0.0006, r: 0.0016 }),
    0, -0.0205, -0.0240, 38 * DEG), 1.06);
  return { bin: T, pivot };
}

function buildSmgBolt() {
  const pivot = new THREE.Vector3(0, G.bore, -0.0600);
  const B = newBin(pivot);
  add(B, 'metalWorn', at(latheZ([
    [0.0130, 0.0300], [0.0130, -0.0940], [0.0110, -0.0970], [0.0060, -0.0970],
  ], 14), 0, G.bore, 0), 0.75);
  return { bin: B, pivot };
}

function buildSmgHands(S) {
  const gt = 13 * DEG;
  const gripUp = V3(0, Math.cos(gt), -Math.sin(gt));
  buildHand(S, {
    side: 1,
    gripAxis: gripUp,
    dorsal: V3(0.78, 0.10, 0.62),
    gripPoint: V3(0, 0.004, 0.006).addScaledVector(gripUp, -0.0420),
    ry: 0.0196, rz: 0.0166,
    arch: 0.0378,
    trigger: V3(0.0038, -0.0158, -0.0122),
    thumbPose: 'wrap',
    armDir: V3(0.36, -0.42, 0.83),
    armLen: 0.38,
  });

  buildHand(S, {
    side: -1,
    gripAxis: V3(0, 0, -1),
    dorsal: V3(-0.86, 0.51, 0),
    gripPoint: V3(0, G.bore + 0.0020, -0.2060),
    ry: 0.0232, rz: 0.0232,
    arch: 0.0380, flat: 0.0120,
    wrapStop: -2.30,
    thumbPose: 'wrap',
    armDir: V3(-0.40, -0.52, 0.76),
    armLen: 0.38,
  });
}

function buildSmg() {
  const S = newBin();
  buildSmgReceiver(S);
  buildSmgBarrel(S);
  buildSmgFrame(S);
  buildSmgStock(S);
  buildSmgHands(S);

  const group = new THREE.Group();
  group.name = 'weapon.smg';
  group.add(finalize(S, 'smg.static'));

  const mag = buildSmgMagazine();
  const magazine = finalize(mag.bin, 'smg.magazine');
  group.add(magazine);

  const ch = buildSmgCharging();
  const charging = finalize(ch.bin, 'smg.charging');
  group.add(charging);

  const tr = buildSmgTrigger();
  const trigger = finalize(tr.bin, 'smg.trigger');
  group.add(trigger);

  const bl = buildSmgBolt();
  const bolt = finalize(bl.bin, 'smg.bolt');
  group.add(bolt);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'smg.muzzle';
  muzzle.position.set(0, G.bore, G.muzzle);
  group.add(muzzle);

  const ejectPort = makeEjectAnchor(0.0215, G.bore + 0.009, -0.045,
    new THREE.Vector3(0.92, 0.36, -0.15));
  group.add(ejectPort);

  const sight = new THREE.Object3D();
  sight.name = 'smg.sight';
  sight.position.set(0, G.sightY, G.drumZ + 0.0075);
  group.add(sight);

  return {
    group, muzzle, ejectPort, magazine, charging, sight,
    trigger, bolt, adsDistance: 0.215,
  };
}

// ============================================================ PISTOL ========
/*
 * Striker-fired 9 mm service pistol:
 *   overall length .................... 195 mm
 *   overall height (sights to floor) .. 135 mm
 *   slide ............................. 26 x 24 mm
 *   barrel ............................ 108 mm
 *   bore axis over the web ............ 28 mm
 *   grip rake ......................... 16 degrees forward
 *
 * Origin is the web of the firing hand at the top of the backstrap, so the
 * slide's rear face lands 18 mm behind it and the muzzle 177 mm in front.
 */

const P = {
  bore: 0.0280,
  slideY: 0.0285,
  slideTop: 0.0405,
  slideBot: 0.0165,
  slideRear: 0.0180,
  muzzle: -0.1770,
  breech: -0.0690,
  sightTop: 0.0481,
  sightY: 0.0460,
  rearSightZ: 0.0080,
  frontSightZ: -0.1680,
  gripTilt: 16 * DEG,
  gripLen: 0.0865,
};

function buildPistolSlide(S, pivot) {
  const len = P.slideRear - P.muzzle;
  const zc = (P.slideRear + P.muzzle) * 0.5;

  add(S, 'metal', at(chamferBox(0.0260, 0.0240, len, { c: 0.0016, r: 0.0042 }), 0, P.slideY, zc), 1.08);
  // Flat sight rib along the top, and the bevelled nose.
  add(S, 'metal', at(chamferBox(0.0170, 0.0038, len - 0.006, { c: 0.0010, r: 0.0014 }),
    0, P.slideTop - 0.0008, zc), 1.05);
  add(S, 'metal', put(chamferBox(0.0230, 0.0130, 0.0140, { c: 0.0014, r: 0.0035 }),
    0, P.slideY - 0.0045, P.muzzle + 0.0075, 0, 0, 0), 1.02);

  // Rear and forward cocking serrations, raked 12 degrees.
  serrations(S, 'metal', {
    xIn: 0.0118, xOut: 0.0136, yc: P.slideY, h: 0.0190,
    z0: P.slideRear - 0.0030, z1: P.slideRear - 0.0320, count: 8, w: 0.0020, tilt: 12 * DEG,
  });
  serrations(S, 'metal', {
    xIn: 0.0118, xOut: 0.0136, yc: P.slideY, h: 0.0190,
    z0: -0.1280, z1: -0.1520, count: 6, w: 0.0020, tilt: 12 * DEG,
  });

  // Ejection port with a lowered, flared right wall.
  const pz = -0.0430;
  add(S, 'metal', at(chamferBox(0.0032, 0.0140, 0.0450, { c: 0.0006, r: 0.0012 }), 0.0122, 0.0335, pz), 0.55);
  add(S, 'metal', at(chamferBox(0.0034, 0.0045, 0.0490, { c: 0.0006, r: 0.0010 }), 0.0132, 0.0388, pz), 1.06);
  for (const dz of [0.0255, -0.0255]) {
    add(S, 'metal', at(chamferBox(0.0034, 0.0180, 0.0038, { c: 0.0006, r: 0.0010 }), 0.0132, 0.0320, pz + dz), 1.06);
  }
  // Extractor and its plunger pin.
  add(S, 'metalWorn', at(chamferBox(0.0034, 0.0075, 0.0230, { c: 0.0006, r: 0.0012 }), 0.0130, 0.0300, pz + 0.0330), 1.05);
  // Striker channel plug at the rear face.
  add(S, 'metal', put(new THREE.CylinderGeometry(0.0038, 0.0038, 0.0040, 10),
    0, P.slideY, P.slideRear - 0.0010, Math.PI / 2), 0.9);
  add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0016, 0.0016, 0.0040, 8),
    0, P.slideY, P.slideRear - 0.0008, Math.PI / 2), 1.1);
  // Loaded-chamber witness slot on top of the barrel hood.
  add(S, 'metal', at(chamferBox(0.0060, 0.0030, 0.0130, { c: 0.0005, r: 0.0008 }),
    0, P.slideTop - 0.0020, -0.0180), 0.6);

  // -- irons: notch rear, white-dot front ----------------------------------
  const mats = getMaterials();
  add(S, 'metal', at(chamferBox(0.0185, 0.0028, 0.0080, { c: 0.0006, r: 0.0010 }),
    0, P.slideTop + 0.0013, P.rearSightZ), 0.95);
  for (const sx of [-1, 1]) {
    add(S, 'metal', at(chamferBox(0.0062, 0.0050, 0.0080, { c: 0.0006, r: 0.0010 }),
      sx * 0.0056, P.slideTop + 0.0052, P.rearSightZ), 1.0);
  }
  add(S, 'metal', at(chamferBox(0.0038, 0.0076, 0.0042, { c: 0.0005, r: 0.0008 }),
    0, P.slideTop + 0.0038, P.frontSightZ), 1.0);

  // Sight paint: two rear dots and one front dot, on the faces the eye sees.
  const dots = [];
  for (const sx of [-1, 1]) {
    const d = new THREE.CircleGeometry(0.0011, 10);
    d.translate(sx * 0.0056, P.slideTop + 0.0050, P.rearSightZ + 0.0041);
    dots.push(d);
  }
  const fd = new THREE.SphereGeometry(0.0016, 10, 8);
  fd.scale(1, 1, 0.45);
  fd.translate(0, P.slideTop + 0.0044, P.frontSightZ + 0.0020);
  dots.push(fd);
  const dotGeo = mergeGeometries(dots, false);
  for (const d of dots) d.dispose();
  // The dots ride on the slide, so they are expressed in the slide's frame.
  dotGeo.translate(-pivot.x, -pivot.y, -pivot.z);
  OWNED_GEOMETRY.add(dotGeo);
  const dotMesh = new THREE.Mesh(dotGeo, mats.paint);
  dotMesh.name = 'pistol.sightDots';
  dotMesh.frustumCulled = false;
  dotMesh.renderOrder = 2;
  return dotMesh;
}

function buildPistolBarrel(S) {
  const y = P.bore;
  // Barrel: chamber block, locking lug, tapered muzzle with a real crown.
  add(S, 'metalWorn', at(latheZ([
    [0.0088, -0.0400], [0.0088, -0.0560], [0.0074, -0.0590],
    [0.0074, -0.1690], [0.0068, -0.1725],
    [0.0068, -0.1770], [0.0050, -0.1770], [0.0046, -0.1745],
    [0.0046, -0.1600],
  ], 18), 0, y, 0), 0.95);
  // Barrel hood, visible through the ejection port.
  add(S, 'metalWorn', at(chamferBox(0.0140, 0.0100, 0.0230, { c: 0.0008, r: 0.0025 }),
    0, y + 0.0020, -0.0300), 0.85);
  // Recoil spring guide rod head, poking out under the muzzle.
  add(S, 'metalWorn', at(latheZ([
    [0.0044, -0.1670], [0.0044, -0.1755], [0.0026, -0.1770],
  ], 12), 0, y - 0.0135, 0), 1.05);
}

function buildPistolFrame(S) {
  // Dust cover with an accessory rail underneath.
  add(S, 'polymer', at(chamferBox(0.0272, 0.0150, 0.0700, { c: 0.0014, r: 0.0038 }),
    0, 0.0088, -0.1090), 0.95);
  add(S, 'polymer', at(chamferBox(0.0210, 0.0040, 0.0620, { c: 0.0008, r: 0.0012 }),
    0, 0.0002, -0.1090), 0.9);
  for (let i = 0; i < 3; i++) {
    add(S, 'polymer', at(chamferBox(0.0230, 0.0032, 0.0042, { c: 0.0006, r: 0.0008 }),
      0, 0.0004, -0.0870 - i * 0.0160), 1.05);
  }
  // Frame rails the slide rides on.
  for (const sx of [-1, 1]) {
    add(S, 'metalWorn', at(chamferBox(0.0028, 0.0042, 0.0500, { c: 0.0005, r: 0.0008 }),
      sx * 0.0128, 0.0155, -0.0480), 1.06);
  }
  // Receiver block around the trigger and magwell.
  add(S, 'polymer', at(chamferBox(0.0280, 0.0210, 0.0760, { c: 0.0014, r: 0.0045 }),
    0, 0.0055, -0.0350), 0.96);
  add(S, 'polymer', at(chamferBox(0.0290, 0.0230, 0.0330, { c: 0.0014, r: 0.0055 }),
    0, 0.0000, -0.0080), 0.96);
  // Beavertail tang.
  add(S, 'polymer', put(chamferBox(0.0230, 0.0075, 0.0230, { c: 0.0010, r: 0.0035 }),
    0, 0.0075, 0.0060, -14 * DEG, 0, 0), 1.02);

  // Trigger guard: undercut at the rear, squared at the front.
  const tg = roundedRect(0.0560, 0.0420, 0.0120);
  tg.holes.push(roundedRect(0.0430, 0.0290, 0.0090));
  const tgGeo = extrudeChamfer(tg, 0.0090, 0.0012, 1, 3);
  rot(tgGeo, 0, Math.PI / 2, 0);
  add(S, 'polymer', at(tgGeo, 0, -0.0170, -0.0470), 0.93);

  // -- grip -----------------------------------------------------------------
  const t0 = P.gripTilt;
  const sec = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const swell = Math.sin(t * Math.PI);
    sec.push({
      w: 0.0300 + 0.0026 * swell,
      h: 0.0470 - 0.0060 * t,
      r: 0.0090,
      m: frame(0,
        -Math.cos(t0) * (0.0010 + t * P.gripLen),
        -Math.sin(t0) * (0.0010 + t * P.gripLen) - 0.0090,
        Math.PI / 2),
    });
  }
  add(S, 'polymer', loft(sec, 4), 0.97);
  // Backstrap and frontstrap texture panels.
  add(S, 'rubber', put(chamferBox(0.0210, 0.0640, 0.0040, { c: 0.0008, r: 0.0055 }),
    0, -0.0420, 0.0040, -t0, 0, 0), 1.0);
  add(S, 'rubber', put(chamferBox(0.0180, 0.0560, 0.0040, { c: 0.0008, r: 0.0050 }),
    0, -0.0400, -0.0455, -t0, 0, 0), 1.0);
  for (const sx of [-1, 1]) {
    add(S, 'rubber', put(chamferBox(0.0040, 0.0480, 0.0300, { c: 0.0008, r: 0.0050 }),
      sx * 0.0158, -0.0400, -0.0215, -t0, 0, 0), 1.02);
  }
  // Magwell mouth flare.
  add(S, 'polymer', put(collarBox(0.0310, 0.0400, 0.0080, 0.0045, { c: 0.0010, r: 0.0055 }),
    0, -0.0768, -0.0330, Math.PI / 2 + t0, 0, 0), 0.9);

  // -- controls -------------------------------------------------------------
  // Slide stop, left side.
  add(S, 'metalWorn', at(chamferBox(0.0032, 0.0075, 0.0320, { c: 0.0006, r: 0.0014 }),
    -0.0148, 0.0130, -0.0330), 1.05);
  add(S, 'metalWorn', at(chamferBox(0.0038, 0.0100, 0.0100, { c: 0.0006, r: 0.0016 }),
    -0.0152, 0.0140, -0.0200), 1.1);
  // Takedown lever, both sides.
  for (const sx of [-1, 1]) {
    add(S, 'metalWorn', at(chamferBox(0.0032, 0.0055, 0.0140, { c: 0.0005, r: 0.0012 }),
      sx * 0.0146, 0.0110, -0.0700), 1.05);
  }
  // Magazine release button in a shallow relief.
  add(S, 'polymer', put(new THREE.CylinderGeometry(0.0068, 0.0068, 0.0030, 12),
    -0.0140, -0.0075, -0.0345, 0, 0, Math.PI / 2), 0.88);
  add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0046, 0.0044, 0.0055, 10),
    -0.0152, -0.0075, -0.0345, 0, 0, Math.PI / 2), 1.08);
  // Frame pins.
  for (const pz of [-0.0230, -0.0560]) {
    for (const sx of [-1, 1]) {
      add(S, 'metalWorn', put(new THREE.CylinderGeometry(0.0022, 0.0022, 0.0020, 8),
        sx * 0.0142, 0.0020, pz, 0, 0, Math.PI / 2), 1.0);
    }
  }
  // Lanyard loop at the heel.
  slingLoop(S, 'metalWorn', 0, -0.0770, 0.0060, 0.0042, 1.0);
}

function buildPistolMagazine() {
  const pivot = new THREE.Vector3(0, 0.0060, -0.0250);
  const M = newBin(pivot);
  const t0 = P.gripTilt;
  const N = 4;
  const total = 0.0900;
  const sec = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    sec.push({
      w: 0.0210 - 0.0006 * t,
      h: 0.0330 - 0.0030 * t,
      r: 0.0055,
      m: frame(0,
        pivot.y - Math.cos(t0) * t * total,
        pivot.z - Math.sin(t0) * t * total,
        Math.PI / 2 + t0),
    });
  }
  add(M, 'metal', loft(sec, 4), 0.88);
  // Witness column on the rear flank.
  for (const sx of [-1, 1]) {
    witnessStrip(M, 'metal', {
      x: sx * 0.0110,
      y: pivot.y - Math.cos(t0) * 0.045,
      z: pivot.z - Math.sin(t0) * 0.045,
      count: 3, spacing: 0.0140, hole: 0.0020, w: 0.0090, thick: 0.0012,
      rx: -t0, tint: 1.08,
    });
  }
  // Feed lips and the polymer floorplate with its front lip.
  add(M, 'metalWorn', put(collarBox(0.0195, 0.0310, 0.0090, 0.0022, { c: 0.0006, r: 0.0045 }),
    0, pivot.y + 0.0015, pivot.z, Math.PI / 2 + t0), 0.95);
  const by = pivot.y - Math.cos(t0) * total;
  const bz = pivot.z - Math.sin(t0) * total;
  add(M, 'polymer', put(chamferBox(0.0250, 0.0360, 0.0095, { c: 0.0012, r: 0.0035 }),
    0, by + 0.0030, bz, Math.PI / 2 + t0), 0.9);
  add(M, 'polymer', put(chamferBox(0.0230, 0.0075, 0.0120, { c: 0.0008, r: 0.0022 }),
    0, by + 0.0025, bz - 0.0170, Math.PI / 2 + t0), 0.95);
  return { bin: M, pivot };
}

function buildPistolTrigger() {
  const pivot = new THREE.Vector3(0, -0.0060, -0.0430);
  const T = newBin(pivot);
  add(T, 'polymer', at(chamferBox(0.0070, 0.0130, 0.0055, { c: 0.0006, r: 0.0016 }),
    0, -0.0110, -0.0430), 0.95);
  add(T, 'polymer', put(chamferBox(0.0068, 0.0110, 0.0058, { c: 0.0006, r: 0.0014 }),
    0, -0.0215, -0.0455, 22 * DEG), 0.98);
  // The blade safety down the middle of the face.
  add(T, 'polymer', put(chamferBox(0.0022, 0.0180, 0.0040, { c: 0.0004, r: 0.0006 }),
    0, -0.0165, -0.0478, 10 * DEG), 1.1);
  return { bin: T, pivot };
}

/**
 * Two-handed pistol grip. The firing hand takes the frame; the support hand
 * wraps over the top of it on a slightly larger radius, offset to the weak
 * side, with both thumbs pointing forward along the frame.
 */
function buildPistolHands(S) {
  const t0 = P.gripTilt;
  const gripUp = V3(0, Math.cos(t0), Math.sin(t0));
  const fireC = V3(0, -0.0010, -0.0095).addScaledVector(gripUp, -0.0380);
  buildHand(S, {
    side: 1,
    gripAxis: gripUp,
    dorsal: V3(0.78, 0.10, 0.62),
    gripPoint: fireC,
    ry: 0.0225, rz: 0.0155,
    arch: 0.0390,
    trigger: V3(0.0038, -0.0245, -0.0392),
    thumbPose: 'wrap',
    armDir: V3(0.30, -0.42, 0.86),
    armLen: 0.36,
  });

  // Support hand rides over the firing hand's fingers, so it grips a larger
  // effective cylinder from the weak side. Its knuckle line runs down the
  // grip's left flank and its fingers close over the firing hand's.
  buildHand(S, {
    side: -1,
    gripAxis: gripUp,
    dorsal: V3(-0.62, -0.04, 0.78),
    gripPoint: fireC.clone().add(V3(-0.0020, -0.0060, 0.0020)),
    ry: 0.0300, rz: 0.0250,
    arch: 0.0480,
    thumbPose: 'rail',
    armDir: V3(-0.38, -0.46, 0.80),
    armLen: 0.36,
    tint: 0.96,
  });
}

function buildPistol() {
  const S = newBin();
  // The slide is its own rigid body so the recoil cycle can be animated;
  // everything it carries - sights, extractor, serrations, barrel - rides with
  // it, and only the frame, controls and trigger stay behind.
  const slidePivot = new THREE.Vector3(0, P.slideY, 0);
  const SL = newBin(slidePivot);
  const dotMesh = buildPistolSlide(SL, slidePivot);
  buildPistolBarrel(SL);
  buildPistolFrame(S);
  buildPistolHands(S);

  const group = new THREE.Group();
  group.name = 'weapon.pistol';

  const staticGroup = finalize(S, 'pistol.static');
  group.add(staticGroup);

  const slide = finalize(SL, 'pistol.slide');
  slide.add(dotMesh);
  group.add(slide);

  const mag = buildPistolMagazine();
  const magazine = finalize(mag.bin, 'pistol.magazine');
  group.add(magazine);

  const tr = buildPistolTrigger();
  const trigger = finalize(tr.bin, 'pistol.trigger');
  group.add(trigger);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'pistol.muzzle';
  muzzle.position.set(0, P.bore, P.muzzle);
  group.add(muzzle);

  const ejectPort = makeEjectAnchor(0.0140, 0.0340, -0.0430,
    new THREE.Vector3(0.88, 0.46, -0.10));
  group.add(ejectPort);

  const sight = new THREE.Object3D();
  sight.name = 'pistol.sight';
  sight.position.set(0, P.sightY, P.rearSightZ);
  group.add(sight);

  // A pistol has no separate charging handle: the slide is what you rack, so
  // the contract's `charging` group is the slide assembly itself. Translating
  // it along +Z cycles the action.
  return {
    group, muzzle, ejectPort, magazine, charging: slide, sight,
    trigger, slide, adsDistance: 0.380,
  };
}

// ====================================================== public interface =====

function builderFor(kind) {
  if (kind === 'rifle') return buildRifle;
  if (kind === 'smg') return buildSmg;
  if (kind === 'pistol') return buildPistol;
  return null;
}

/**
 * Camera-local height the sight anchor is driven to when aiming. Zero puts the
 * reticle dead on the optical axis, which is the only correct answer for a
 * red dot; the viewmodel sway/recoil rig is free to bias it afterwards.
 */
const ADS_EYE_Y = 0.0;

/**
 * Build a weapon.
 *
 * @param {'rifle'|'smg'|'pistol'} kind
 * @returns {{group: THREE.Group, muzzle: THREE.Object3D, ejectPort: THREE.Object3D,
 *            magazine: THREE.Object3D, charging: THREE.Object3D,
 *            sight: THREE.Object3D, adsOffset: THREE.Vector3}}
 */
export function buildWeaponModel(kind) {
  const make = builderFor(kind);
  if (!make) throw new Error(`buildWeaponModel: unknown kind "${kind}"`);
  const w = make();

  // adsOffset is derived from where the sight anchor actually ended up, so it
  // stays correct if any of the dimensions above are edited. Setting
  // group.position to it places the sight on the camera's local axis at
  // `adsDistance` in front of the eye.
  w.group.updateMatrixWorld(true);
  const sp = w.sight.getWorldPosition(new THREE.Vector3());
  const adsOffset = new THREE.Vector3(
    -sp.x,
    ADS_EYE_Y - sp.y,
    -w.adsDistance - sp.z,
  );

  w.group.userData.kind = kind;
  w.group.userData.isViewmodel = true;
  w.group.userData.sightHeight = sp.y;
  w.group.userData.adsDistance = w.adsDistance;

  return {
    group: w.group,
    muzzle: w.muzzle,
    ejectPort: w.ejectPort,
    magazine: w.magazine,
    charging: w.charging,
    sight: w.sight,
    adsOffset,
    // The reticle mesh. Weapon.js drives its material opacity and
    // emissiveIntensity off the ADS blend, so the dot brightens as you aim.
    dot: w.dot || null,
    // Extra animatable sub-assemblies beyond the contract's minimum.
    trigger: w.trigger || null,
    bolt: w.bolt || null,
    dustCover: w.dustCover || null,
    slide: w.slide || null,
    hammer: w.hammer || null,
  };
}

/** Release every geometry, material and texture this module has allocated. */
export function disposeWeaponModels() {
  for (const g of OWNED_GEOMETRY) g.dispose();
  OWNED_GEOMETRY.clear();
  for (const m of OWNED_MATERIALS) m.dispose();
  OWNED_MATERIALS.clear();
  for (const t of OWNED_TEXTURES) t.dispose();
  OWNED_TEXTURES.clear();
  MATS = null;
}
