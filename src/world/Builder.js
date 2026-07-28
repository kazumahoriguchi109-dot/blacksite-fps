import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

/*
 * Level geometry builder.
 *
 * Accumulates world-space geometry keyed by material, then merges each bucket
 * into a single mesh (so the whole map is a handful of draw calls) and builds
 * one merged BVH for collision and ballistics.
 *
 * Two things here matter for how the map *looks*:
 *  - every box is chamfered, so edges catch a highlight instead of reading as
 *    a hard CG crease;
 *  - UVs are generated in world space at a fixed texel density, so texture
 *    scale is consistent whether a surface is 0.4 m or 40 m across.
 */

/** Force a geometry to non-indexed with exactly position/normal/uv. */
function normalizeGeometry(geom) {
  let g = geom.index ? geom.toNonIndexed() : geom;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    const n = g.attributes.position.count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  // Drop anything else (tangents, uv1, colors) so the buckets stay uniform.
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
  }
  g.clearGroups();
  return g;
}

/** Spatial chunk size in metres for render-bucket splitting. */
const CHUNK = 22;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * A box with chamfered edges, UV-mapped in world space.
 * Built by hand rather than via BoxGeometry so each face gets planar UVs
 * derived from its world extent.
 *
 * @param {number} w,h,d  full dimensions in metres
 * @param {number} chamfer  edge cut in metres (0 = sharp)
 * @param {number|number[]} tile  metres per texture repeat; [u, v] for
 *   anisotropic materials like brick (1.72 x 1.04 m) or corrugated sheet.
 */
export function chamferedBox(w, h, d, chamfer = 0.02, tile = 2.0, uvOffset = [0, 0]) {
  const tileU = Array.isArray(tile) ? tile[0] : tile;
  const tileV = Array.isArray(tile) ? tile[1] : tile;
  const c = Math.min(chamfer, w / 2.5, h / 2.5, d / 2.5);
  const hw = w / 2, hh = h / 2, hd = d / 2;

  const pos = [];
  const nor = [];
  const uv = [];

  // Emit a quad with a planar UV projection along its dominant axis.
  const quad = (a, b, cc, dd, n, uAxis, vAxis, uo, vo) => {
    const pts = [a, b, cc, a, cc, dd];
    for (const p of pts) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      const u = (p[uAxis] + uo) / tileU + uvOffset[0];
      const v = (p[vAxis] + vo) / tileV + uvOffset[1];
      uv.push(u, v);
    }
  };

  // Inset face corners so the chamfer strips have somewhere to live.
  const X = hw, Y = hh, Z = hd, Xi = hw - c, Yi = hh - c, Zi = hd - c;

  // +X / -X faces (project on Z,Y)
  quad([X, -Yi, -Zi], [X, -Yi, Zi], [X, Yi, Zi], [X, Yi, -Zi], [1, 0, 0], 2, 1, hd, hh);
  quad([-X, -Yi, Zi], [-X, -Yi, -Zi], [-X, Yi, -Zi], [-X, Yi, Zi], [-1, 0, 0], 2, 1, hd, hh);
  // +Y / -Y faces (project on X,Z)
  quad([-Xi, Y, Zi], [Xi, Y, Zi], [Xi, Y, -Zi], [-Xi, Y, -Zi], [0, 1, 0], 0, 2, hw, hd);
  quad([-Xi, -Y, -Zi], [Xi, -Y, -Zi], [Xi, -Y, Zi], [-Xi, -Y, Zi], [0, -1, 0], 0, 2, hw, hd);
  // +Z / -Z faces (project on X,Y)
  quad([-Xi, -Yi, Z], [Xi, -Yi, Z], [Xi, Yi, Z], [-Xi, Yi, Z], [0, 0, 1], 0, 1, hw, hh);
  quad([Xi, -Yi, -Z], [-Xi, -Yi, -Z], [-Xi, Yi, -Z], [Xi, Yi, -Z], [0, 0, -1], 0, 1, hw, hh);

  if (c > 0.0005) {
    const s = Math.SQRT1_2;
    // 4 vertical chamfer strips
    quad([X, -Yi, Zi], [Xi, -Yi, Z], [Xi, Yi, Z], [X, Yi, Zi], [s, 0, s], 2, 1, hd, hh);
    quad([Xi, -Yi, -Z], [X, -Yi, -Zi], [X, Yi, -Zi], [Xi, Yi, -Z], [s, 0, -s], 2, 1, hd, hh);
    quad([-Xi, -Yi, Z], [-X, -Yi, Zi], [-X, Yi, Zi], [-Xi, Yi, Z], [-s, 0, s], 2, 1, hd, hh);
    quad([-X, -Yi, -Zi], [-Xi, -Yi, -Z], [-Xi, Yi, -Z], [-X, Yi, -Zi], [-s, 0, -s], 2, 1, hd, hh);
    // 4 top chamfer strips
    quad([-Xi, Y, Zi], [Xi, Y, Zi], [Xi, Yi, Z], [-Xi, Yi, Z], [0, s, s], 0, 2, hw, hd);
    quad([Xi, Y, -Zi], [-Xi, Y, -Zi], [-Xi, Yi, -Z], [Xi, Yi, -Z], [0, s, -s], 0, 2, hw, hd);
    quad([X, Y, -Zi], [X, Y, Zi], [Xi, Yi, Zi], [Xi, Yi, -Zi], [s, s, 0], 2, 0, hd, hw);
    quad([-X, Y, Zi], [-X, Y, -Zi], [-Xi, Yi, -Zi], [-Xi, Yi, Zi], [-s, s, 0], 2, 0, hd, hw);
    // 4 bottom chamfer strips
    quad([Xi, -Yi, Z], [-Xi, -Yi, Z], [-Xi, -Y, Zi], [Xi, -Y, Zi], [0, -s, s], 0, 2, hw, hd);
    quad([-Xi, -Yi, -Z], [Xi, -Yi, -Z], [Xi, -Y, -Zi], [-Xi, -Y, -Zi], [0, -s, -s], 0, 2, hw, hd);
    quad([X, -Yi, Zi], [X, -Yi, -Zi], [Xi, -Y, -Zi], [Xi, -Y, Zi], [s, -s, 0], 2, 0, hd, hw);
    quad([-X, -Yi, -Zi], [-X, -Yi, Zi], [-Xi, -Y, Zi], [-Xi, -Y, -Zi], [-s, -s, 0], 2, 0, hd, hw);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Cylinder with world-space UVs, for pipes, barrels, posts. */
export function pipe(radius, height, segments = 16, tile = 2.0, capped = true) {
  const g = new THREE.CylinderGeometry(radius, radius, height, segments, 1, !capped);
  const uv = g.attributes.uv;
  const circumference = 2 * Math.PI * radius;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (circumference / tile), uv.getY(i) * (height / tile));
  }
  uv.needsUpdate = true;
  return g;
}

export class Builder {
  /**
   * @param {(name:string)=>number|number[]} tileFor  metres per texture repeat
   *   for a material. Baking this into the UVs (rather than into each texture's
   *   `repeat`) is what keeps texel density consistent across the whole map.
   */
  constructor(tileFor = null) {
    this.tileFor = tileFor;
    /** @type {Map<string, {geoms: THREE.BufferGeometry[], surface: string}>} */
    this.buckets = new Map();
    this.colliderGeoms = [];
    this.colliderSurfaces = [];   // parallel: surface name per source geometry
    this.lights = [];
    this.count = 0;
  }

  /**
   * Add world-space geometry.
   * @param {THREE.BufferGeometry} geom  consumed (transformed in place)
   * @param {string} mat  material name
   * @param {object} o  { pos, rotY, rot, scale, surface, collide }
   */
  add(geom, mat, o = {}) {
    const { pos, rotY = 0, rot = null, scale = null, surface = null, collide = true } = o;
    // mergeGeometries requires every input to agree on indexing and on which
    // attributes exist. Our chamfered boxes are non-indexed while Three's
    // primitives are indexed, so normalise everything to non-indexed with
    // exactly position/normal/uv.
    geom = normalizeGeometry(geom);
    _m.identity();
    if (rot) { _e.set(rot[0], rot[1], rot[2], 'YXZ'); _q.setFromEuler(_e); }
    else { _e.set(0, rotY, 0, 'YXZ'); _q.setFromEuler(_e); }
    _m.compose(
      pos ? _v.set(pos[0], pos[1], pos[2]) : _v.set(0, 0, 0),
      _q,
      scale ? new THREE.Vector3(scale[0], scale[1], scale[2]) : new THREE.Vector3(1, 1, 1)
    );
    geom.applyMatrix4(_m);

    // Bucket by material AND by a spatial cell. Merging by material alone gives
    // a beautiful draw-call count and *zero* frustum culling — one mesh spanning
    // the whole map is always submitted, for the main pass and again for every
    // shadow pass. Chunking costs a few hundred draw calls and buys back the
    // culling, which is overwhelmingly the better trade at this geometry
    // density (2.3M triangles was rendering at 4 fps unchunked).
    geom.computeBoundingSphere();
    const c = geom.boundingSphere.center;
    const cx = Math.floor(c.x / CHUNK) | 0;
    const cz = Math.floor(c.z / CHUNK) | 0;
    // Anything larger than a chunk can't benefit from chunking; keep those in a
    // single shared bucket so their bounding spheres stay tight-ish.
    const big = geom.boundingSphere.radius > CHUNK;
    const key = big ? `${mat}#big` : `${mat}#${cx}_${cz}`;

    if (!this.buckets.has(key)) {
      this.buckets.set(key, { geoms: [], surface: surface || mat, mat });
    }
    this.buckets.get(key).geoms.push(geom);
    if (collide) {
      this.colliderGeoms.push(geom);
      this.colliderSurfaces.push(surface || surfaceFromMaterial(mat));
    }
    this.count++;
    return geom;
  }

  /** Metres per texture repeat for a material, U and V. */
  _tile(mat, override) {
    if (override != null) return Array.isArray(override) ? override : [override, override];
    const t = this.tileFor ? this.tileFor(mat) : 2.0;
    return Array.isArray(t) ? t : [t, t];
  }

  /** Convenience: chamfered box at a position. */
  box(w, h, d, pos, mat, o = {}) {
    const t = this._tile(mat, o.tileOverride);
    const g = chamferedBox(w, h, d, o.chamfer ?? 0.025, t, o.uvOffset);
    return this.add(g, mat, { pos, ...o });
  }

  /**
   * A wall with a rectangular opening cut out, built as four sub-boxes.
   * Cheaper and more robust than CSG, and gives clean UVs.
   * Opening is specified in wall-local coordinates (u across, v up).
   */
  wallWithOpening(w, h, thick, pos, mat, opening, o = {}) {
    const { u = 0, v = 1.05, ow = 1.0, oh = 2.1 } = opening;
    const left = (w / 2) + (u - ow / 2);        // width of the left segment
    const right = (w / 2) - (u + ow / 2);
    const below = v - oh / 2;
    const above = h - (v + oh / 2);
    const rotY = o.rotY ?? 0;
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const place = (lx, ly) => [
      pos[0] + lx * cy, pos[1] + ly, pos[2] + lx * sy,
    ];
    const tile = o.tile ?? 2.0;
    if (left > 0.01) {
      this.box(left, h, thick, place(-w / 2 + left / 2, h / 2), mat, { ...o, tile });
    }
    if (right > 0.01) {
      this.box(right, h, thick, place(w / 2 - right / 2, h / 2), mat, { ...o, tile });
    }
    if (below > 0.01) {
      this.box(ow, below, thick, place(u, below / 2), mat, { ...o, tile });
    }
    if (above > 0.01) {
      this.box(ow, above, thick, place(u, v + oh / 2 + above / 2), mat, { ...o, tile });
    }
  }

  addLight(light) { this.lights.push(light); }

  /**
   * Merge everything and produce the render group plus a single BVH collider.
   * @param {(name:string)=>THREE.Material} matProvider
   */
  finish(matProvider) {
    const group = new THREE.Group();
    group.name = 'level';

    let meshCount = 0, triCount = 0;
    for (const [key, bucket] of this.buckets) {
      if (!bucket.geoms.length) continue;
      const name = bucket.mat;
      const merged = BufferGeometryUtils.mergeGeometries(bucket.geoms, false);
      if (!merged) {
        console.warn(`[Builder] merge failed for material "${name}"`);
        continue;
      }
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      // aoMap needs a second UV channel; level geometry always has uv.
      if (merged.attributes.uv && !merged.attributes.uv1) {
        merged.setAttribute('uv1', merged.attributes.uv.clone());
      }
      const mesh = new THREE.Mesh(merged, matProvider(name));
      mesh.name = name;
      mesh.frustumCulled = true;
      // Purely decorative buckets don't need to cast — the shadow pass is the
      // second most expensive thing in the frame and small clutter contributes
      // nothing readable to it.
      mesh.castShadow = !NO_SHADOW_MATERIALS.has(name);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData.surface = bucket.surface;
      mesh.userData.chunk = key;
      group.add(mesh);
      meshCount++;
      triCount += merged.attributes.position.count / 3;
    }
    console.info(`[Builder] ${meshCount} chunked meshes, ${(triCount / 1000).toFixed(0)}k tris`);

    // ---- collider: one merged, position-only mesh with a BVH ----
    const stripped = [];
    const triSurfaces = [];
    for (let i = 0; i < this.colliderGeoms.length; i++) {
      const src = this.colliderGeoms[i];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.attributes.position.clone());
      if (src.index) g.setIndex(src.index.clone());
      stripped.push(g);
      const triCount = (src.index ? src.index.count : src.attributes.position.count) / 3;
      const sid = SURFACE_IDS[this.colliderSurfaces[i]] ?? 0;
      for (let t = 0; t < triCount; t++) triSurfaces.push(sid);
    }
    const colliderGeom = BufferGeometryUtils.mergeGeometries(stripped, false);
    colliderGeom.boundsTree = new MeshBVH(colliderGeom, { maxLeafTris: 8 });
    const collider = new THREE.Mesh(
      colliderGeom,
      new THREE.MeshBasicMaterial({ wireframe: true, visible: false })
    );
    collider.name = 'collider';
    collider.matrixAutoUpdate = false;
    collider.userData.triSurfaces = Uint8Array.from(triSurfaces);

    for (const g of stripped) { /* geometry retained by merge */ }

    return { group, collider };
  }
}

/**
 * Materials whose geometry is small clutter — excluded from shadow casting.
 * The shadow pass costs roughly as much as the main pass, and none of this
 * reads as a shadow at any distance a player will see it from.
 */
export const NO_SHADOW_MATERIALS = new Set([
  'road_marking', 'warning_stripe', 'chainlink', 'glass_dirty', 'glass_broken',
  'rubber', 'tarp',
]);

export const SURFACE_NAMES = [
  'concrete', 'metal', 'wood', 'gravel', 'asphalt', 'brick',
  'glass', 'sandbag', 'tile', 'plaster', 'rubber', 'dirt',
];
export const SURFACE_IDS = Object.fromEntries(SURFACE_NAMES.map((n, i) => [n, i]));

/** Best-guess physical surface from a material name, for footsteps and impacts. */
export function surfaceFromMaterial(mat) {
  const m = mat.toLowerCase();
  if (m.includes('asphalt') || m.includes('road')) return 'asphalt';
  if (m.includes('gravel')) return 'gravel';
  if (m.includes('brick')) return 'brick';
  if (m.includes('wood') || m.includes('crate') || m.includes('plank')) return 'wood';
  if (m.includes('glass')) return 'glass';
  if (m.includes('sandbag')) return 'sandbag';
  if (m.includes('tile')) return 'tile';
  if (m.includes('plaster')) return 'plaster';
  if (m.includes('rubber') || m.includes('tarp')) return 'rubber';
  if (m.includes('metal') || m.includes('steel') || m.includes('grate')
      || m.includes('corrugated') || m.includes('chainlink')) return 'metal';
  return 'concrete';
}

/** Look up the physical surface at a BVH raycast hit. */
export function surfaceAtHit(collider, faceIndex) {
  const ids = collider?.userData?.triSurfaces;
  if (!ids || faceIndex == null || faceIndex >= ids.length) return 'concrete';
  return SURFACE_NAMES[ids[faceIndex]] ?? 'concrete';
}
