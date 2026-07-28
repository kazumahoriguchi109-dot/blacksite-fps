import * as THREE from 'three';
import { Builder, chamferedBox, pipe, surfaceAtHit } from './Builder.js';
import * as P from './Props.js';
import { cbox, cpipe } from './Props.js';

/*
 * "Sector 7" — a walled industrial compound.
 *
 * Layout (X right / Z toward viewer, origin at the courtyard centre):
 *
 *        -Z  ┌──────── admin block (3 storey) ────────┐
 *            │        service yard behind it          │
 *   container│            COURTYARD                   │  warehouse
 *      yard  │      sandbags / barriers / crates      │  + catwalk
 *            │                                        │
 *        +Z  └──────── perimeter wall + gate ─────────┘
 *
 * Everything is authored in metres against real reference: a doorway is 2.1 m,
 * a storey is 3.4 m, an ISO container is 6.058 x 2.438 x 2.591 m, a 200 L drum
 * is 0.585 m across and 0.88 m tall. Getting these right is most of why a space
 * reads as real rather than as "some boxes".
 *
 * The *dressing* rules — chamfer everything, vary every rotation, give every
 * object a dirt junction with the ground — live in Props.js. This file is the
 * layout: what goes where, and why.
 */

const R = (rng, a, b) => a + rng() * (b - a);
const TAU = Math.PI * 2;

/**
 * Material aliases.
 *
 * `Builder` buckets by material *name*, and Level owns the name -> material
 * resolution, so extra looks can be introduced here without touching the
 * catalogue. Everything below is a tint / property override on an existing
 * catalogue entry, so it shares that entry's texture upload and costs nothing
 * to generate.
 *
 * They are not free at runtime, though: Builder buckets by (material, 22 m
 * spatial chunk), so a name sprinkled over the whole compound turns into ~35
 * extra draw calls *and* ~35 extra shadow-map draws. That is why this list is
 * short, and why several looks that started here (machinery grey, stencil
 * white, a dark "interior void", a second container steel) were folded back
 * into catalogue entries that were already being drawn in those chunks anyway.
 */
const MAT_ALIAS = {
  // Wind-blown dust and washed-in grit — the wedge at every ground junction.
  dust:           ['gravel',             { color: new THREE.Color(1.34, 1.18, 0.95) }],
  // Oil, soot, splash-back staining, wet ground and standing-water rims.
  dirt_dark:      ['gravel',             { color: new THREE.Color(0.40, 0.39, 0.37), envMapIntensity: 0.35 }],
  // Plant and container colours. painted_steel carries chipping and primer in
  // its albedo, so a multiplicative tint keeps the wear and only moves the hue.
  paint_green:    ['painted_steel_blue', { color: new THREE.Color(1.45, 1.25, 0.50) }],
  paint_red:      ['painted_steel_yellow', { color: new THREE.Color(1.05, 0.45, 0.42) }],
  // Emissive lamp parts. A lit interior with no visible source reads as fog.
  lamp_glow:      ['sheet_metal_bare',   { props: { emissive: new THREE.Color(1.0, 0.74, 0.45), emissiveIntensity: 9.0 } }],
  lamp_glow_dim:  ['sheet_metal_bare',   { props: { emissive: new THREE.Color(1.0, 0.80, 0.55), emissiveIntensity: 1.6 } }],
  lamp_glow_cool: ['sheet_metal_bare',   { props: { emissive: new THREE.Color(0.70, 0.84, 1.0), emissiveIntensity: 6.0 } }],
};

export class Level {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.collider = null;
    this.spawnPoints = [];
    this.enemySpawns = [];
    this.coverPoints = [];
    this.lights = [];
    this._rng = mulberry32(0xC0FFEE);
    this._scratch = { ray: new THREE.Raycaster(), v: new THREE.Vector3(), d: new THREE.Vector3(0, -1, 0) };
    this._scratch.ray.firstHitOnly = true;
  }

  _resolve(name) { return MAT_ALIAS[name] || [name, undefined]; }

  async build() {
    const b = new Builder((name) => this.ctx.materialTile(this._resolve(name)[0]));
    const rng = this._rng;

    this._ground(b, rng);
    this._perimeter(b, rng);
    this._gate(b, rng);
    this._adminBlock(b, rng);
    this._serviceYard(b, rng);
    this._warehouse(b, rng);
    this._containerYard(b, rng);
    this._containerAlley(b, rng);
    this._courtyard(b, rng);
    this._streetFurniture(b, rng);
    this._debris(b, rng);
    this._distantSkyline(b, rng);

    const { group, collider } = b.finish((name) => {
      const [base, opts] = this._resolve(name);
      return this.ctx.mat(base, opts);
    });
    this.root.add(group);
    this.collider = collider;
    this.root.add(collider);

    for (const l of b.lights) { this.root.add(l); this.lights.push(l); }

    this.spawnPoints = [
      new THREE.Vector3(0, 0.2, 16),
      new THREE.Vector3(-14, 0.2, 8),
      new THREE.Vector3(12, 0.2, 14),
    ];
    this.enemySpawns = [
      new THREE.Vector3(0, 0.2, -22), new THREE.Vector3(-10, 0.2, -20),
      new THREE.Vector3(10, 0.2, -20), new THREE.Vector3(26, 0.2, -2),
      new THREE.Vector3(-28, 0.2, 4), new THREE.Vector3(24, 0.2, 14),
      new THREE.Vector3(-20, 0.2, -12), new THREE.Vector3(6, 0.2, -30),
    ];
    return this;
  }

  _cover(x, z) { this.coverPoints.push(new THREE.Vector3(x, 0, z)); }

  // ------------------------------------------------------------- ground ---
  _ground(b, rng) {
    // Base asphalt slab. Kept thick so the BVH has real volume under the player.
    b.box(130, 1.0, 130, [0, -0.5, 0], 'asphalt_road', { chamfer: 0 });

    // Concrete aprons around the buildings, slightly proud of the asphalt so
    // there's a visible lip and a shadow line where they meet.
    const apron = (w, d, x, z, mat) => {
      b.box(w, 0.14, d, [x, 0.05, z], mat, { chamfer: 0.04 });
      // Kerb nosing + the dirt line that always collects against it.
      for (const [ew, ed, ex, ez] of [
        [w, 0.26, x, z + d / 2], [w, 0.26, x, z - d / 2],
        [0.26, d, x + w / 2, z], [0.26, d, x - w / 2, z],
      ]) {
        b.box(ew, 0.075, ed, [ex, 0.15, ez], 'concrete_stained', { chamfer: 0.02, collide: false });
        b.add(cbox(b, ew * 0.98, 0.05, ed * 1.7, 'dust', 0.03), 'dust',
          { pos: [ex + (ex - x) * 0.05, 0.145, ez + (ez - z) * 0.05], collide: false });
      }
      // Saw-cut expansion joints on a 4 m grid — a slab this big is never one pour.
      for (let u = -w / 2 + 6; u < w / 2 - 1; u += 6) {
        b.add(cbox(b, 0.05, 0.03, d - 0.2, 'dirt_dark', 0.01), 'dirt_dark',
          { pos: [x + u, 0.13, z], collide: false });
      }
      for (let v = -d / 2 + 6; v < d / 2 - 1; v += 6) {
        b.add(cbox(b, w - 0.2, 0.03, 0.05, 'dirt_dark', 0.01), 'dirt_dark',
          { pos: [x, 0.13, z + v], collide: false });
      }
    };
    apron(34, 24, 0, -30, 'concrete_floor');
    apron(40, 32, 32, 4, 'concrete_floor');
    apron(28, 40, -32, -2, 'concrete_stained');
    apron(22, 12, 0, 44, 'concrete_stained');

    // Gravel patches — broken ground reads as neglect, which sells the setting.
    for (let i = 0; i < 11; i++) {
      const x = R(rng, -44, 44), z = R(rng, -18, 46);
      const w = R(rng, 4, 12), d = R(rng, 4, 10);
      b.box(w, 0.09, d, [x, 0.03, z], 'gravel', { chamfer: 0.05, rotY: R(rng, 0, Math.PI), collide: false });
      // Feathered edge, so it is not a rectangle of gravel dropped on tarmac.
      for (let k = 0; k < 7; k++) {
        const a = rng() * TAU;
        b.add(cbox(b, R(rng, 0.8, 2.6), 0.05, R(rng, 0.5, 1.6), 'gravel', 0.05), 'gravel', {
          pos: [x + Math.cos(a) * w * 0.55, 0.115, z + Math.sin(a) * d * 0.55],
          rotY: rng() * TAU, collide: false,
        });
      }
    }

    // Patched trench repairs across the yard — different asphalt, sunken edges.
    for (let i = 0; i < 5; i++) {
      const x = R(rng, -34, 34), z = R(rng, -22, 40), a = R(rng, 0, Math.PI);
      const len = R(rng, 6, 18);
      b.box(len, 0.06, R(rng, 0.9, 1.8), [x, 0.125, z], 'concrete_stained', { chamfer: 0.03, rotY: a, collide: false });
      b.add(cbox(b, len + 0.4, 0.04, R(rng, 1.5, 2.5), 'dirt_dark', 0.03), 'dirt_dark',
        { pos: [x, 0.115, z], rotY: a, collide: false });
    }

    // Drainage channel down the centre lane, with grated gullies.
    for (let z = -20; z < 48; z += 3.0) {
      b.add(cbox(b, 0.36, 0.05, 2.95, 'concrete_stained', 0.02), 'concrete_stained',
        { pos: [11.5, 0.115, z], collide: false });
      b.add(cbox(b, 0.2, 0.03, 2.9, 'rubber', 0.01), 'rubber',
        { pos: [11.5, 0.128, z], collide: false });
    }
    for (const z of [-16, -4, 8, 20, 32, 44]) {
      b.box(0.62, 0.1, 0.62, [11.5, 0.1, z], 'metal_grate', { chamfer: 0.02, collide: false });
      b.box(0.78, 0.12, 0.78, [11.5, 0.08, z], 'concrete_stained', { chamfer: 0.02 });
    }
    // Manhole covers.
    for (const [x, z] of [[-8, 18], [6, -6], [-22, -2], [24, 26], [-38, 20]]) {
      b.add(cpipe(b, 0.36, 0.05, 14, 'metal_rusted'), 'metal_rusted', { pos: [x, 0.125, z], collide: false });
      b.add(cpipe(b, 0.44, 0.09, 14, 'concrete_stained'), 'concrete_stained', { pos: [x, 0.1, z], collide: false });
    }

    // Road markings down the centre lane.
    for (let z = -12; z < 46; z += 4.2) {
      b.box(0.16, 0.02, 2.4, [0, 0.115, z], 'road_marking', { chamfer: 0, collide: false });
    }
    // A hatched loading box outside the warehouse door.
    for (let i = 0; i < 9; i++) {
      b.add(cbox(b, 0.14, 0.02, 6.0, 'road_marking', 0.005), 'road_marking',
        { pos: [24 + i * 0.9, 0.115, 22], rotY: 0.62, collide: false });
    }
    for (const [x, z, w, d] of [[24, 19.2, 12, 0.16], [24, 25.2, 12, 0.16]]) {
      b.add(cbox(b, w, 0.02, d, 'road_marking', 0.005), 'road_marking', { pos: [x, 0.115, z], collide: false });
    }

    // Standing water and oil in the low spots.
    for (const [x, z, r] of [
      [-31, 6, 1.5], [-33.5, -3, 1.1], [4, 24, 1.8], [18, -8, 1.3],
      [-6, 32, 2.1], [30, 20, 1.4], [-16, -18, 1.2], [12, 38, 1.6],
    ]) P.puddle(b, rng, { x, z, r });
    for (let i = 0; i < 14; i++) {
      const x = R(rng, -40, 40), z = R(rng, -24, 44);
      b.add(cbox(b, R(rng, 0.8, 2.6), 0.014, R(rng, 0.6, 2.0), 'dirt_dark', 0.12), 'dirt_dark',
        { pos: [x, 0.116, z], rotY: rng() * TAU, collide: false });
    }
    // Tyre tracks through the dust near the gate.
    for (let i = 0; i < 13; i++) {
      const z = 8 + i * 3.2;
      for (const s of [-1, 1]) {
        b.add(cbox(b, 0.24, 0.014, 3.1, 'dirt_dark', 0.02), 'dirt_dark',
          { pos: [s * 1.1 + Math.sin(i * 0.4) * 0.3, 0.117, z], collide: false });
      }
    }
  }

  // ---------------------------------------------------------- perimeter ---
  _perimeter(b, rng) {
    const H = 4.2, EXT = 52;
    // Four runs of precast panel wall. The south run is split by the gate.
    P.precastWall(b, rng, { x: 0, z: -EXT, rotY: 0, len: EXT * 2, height: H });
    P.precastWall(b, rng, { x: -EXT, z: 0, rotY: -Math.PI / 2, len: EXT * 2, height: H });
    P.precastWall(b, rng, { x: EXT, z: 0, rotY: Math.PI / 2, len: EXT * 2, height: H });
    P.precastWall(b, rng, { x: -(EXT + 5) / 2, z: EXT, rotY: 0, len: EXT - 5, height: H });
    P.precastWall(b, rng, { x: (EXT + 5) / 2, z: EXT, rotY: 0, len: EXT - 5, height: H });

    // Watchtowers on two corners — vertical interest on a very horizontal
    // silhouette, and something for the eye to land on down each wall.
    for (const [tx, tz, ty] of [[-EXT + 3, -EXT + 3, Math.PI * 0.25], [EXT - 3, EXT - 3, Math.PI * 1.25]]) {
      const H2 = 6.2;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        b.box(0.24, H2, 0.24, [tx + sx * 1.1, H2 / 2, tz + sz * 1.1], 'painted_steel_yellow', { chamfer: 0.02 });
      }
      for (const ly of [1.6, 3.4, 5.0]) {
        for (const sz of [-1, 1]) b.box(2.4, 0.1, 0.1, [tx, ly, tz + sz * 1.1], 'painted_steel_yellow', { chamfer: 0.012, collide: false });
        for (const sx of [-1, 1]) b.box(0.1, 0.1, 2.4, [tx + sx * 1.1, ly, tz], 'painted_steel_yellow', { chamfer: 0.012, collide: false });
      }
      b.box(3.0, 0.14, 3.0, [tx, H2, tz], 'metal_grate', { chamfer: 0.02 });
      for (const sz of [-1, 1]) {
        b.box(3.0, 1.0, 0.12, [tx, H2 + 0.5, tz + sz * 1.45], 'corrugated_roof', { chamfer: 0.02 });
        b.box(0.12, 1.0, 3.0, [tx + sz * 1.45, H2 + 0.5, tz], 'corrugated_roof', { chamfer: 0.02 });
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        b.box(0.1, 1.5, 0.1, [tx + sx * 1.4, H2 + 1.75, tz + sz * 1.4], 'metal_rusted', { chamfer: 0.012, collide: false });
      }
      b.box(3.6, 0.16, 3.6, [tx, H2 + 2.55, tz], 'corrugated_roof', { chamfer: 0.04 });
      P.ladder(b, rng, { x: tx + Math.cos(ty) * 1.4, y: 0.1, z: tz + Math.sin(ty) * 1.4, rotY: ty, height: H2 - 0.2, cage: true });
      P.contactDress(b, rng, { x: tx, z: tz, y: 0.1, w: 3.2, d: 3.2, amount: 1.0, frags: 6 });
      this._cover(tx, tz);
    }
  }

  // ------------------------------------------------------------- the gate --
  _gate(b, rng) {
    const EXT = 52;
    // Gate piers: proper capped columns, not two posts.
    for (const sx of [-5.4, 5.4]) {
      b.box(0.9, 5.6, 0.9, [sx, 2.8, EXT], 'concrete_wall', { chamfer: 0.04 });
      b.box(1.1, 0.22, 1.1, [sx, 5.72, EXT], 'concrete_stained', { chamfer: 0.03 });
      b.box(1.05, 0.4, 1.05, [sx, 0.2, EXT], 'concrete_stained', { chamfer: 0.04 });
      b.box(0.42, 5.2, 0.06, [sx, 2.8, EXT + 0.48], 'warning_stripe', { chamfer: 0.01, collide: false });
      b.box(0.42, 5.2, 0.06, [sx, 2.8, EXT - 0.48], 'warning_stripe', { chamfer: 0.01, collide: false });
      P.contactDress(b, rng, { x: sx, z: EXT, y: 0.1, w: 1.4, d: 1.4, amount: 1.0, frags: 5 });
    }
    // Two leaves, one hanging open.
    P.gateLeaf(b, rng, { x: -2.5, z: EXT, w: 4.7, h: 3.5, hingeSide: -1, open: 0.0 });
    P.gateLeaf(b, rng, { x: 2.5, z: EXT, w: 4.7, h: 3.5, hingeSide: 1, open: 0.62 });
    // Over-gate sign gantry.
    b.box(11.6, 0.32, 0.32, [0, 5.9, EXT], 'metal_rusted', { chamfer: 0.03, collide: false });
    b.box(11.6, 0.22, 0.22, [0, 6.55, EXT], 'metal_rusted', { chamfer: 0.02, collide: false });
    for (const sx of [-3.6, 0, 3.6]) {
      b.box(0.14, 0.65, 0.14, [sx, 6.22, EXT], 'metal_rusted', { chamfer: 0.014, collide: false });
    }
    P.signage(b, rng, { x: 0, y: 0.1, z: EXT - 0.28, rotY: Math.PI, w: 4.2, h: 0.9, height: 6.2, posts: false, wallMount: true, mat: 'sheet_metal_bare' });
    P.signage(b, rng, { x: -3.2, y: 0.1, z: EXT - 0.3, rotY: Math.PI, w: 1.1, h: 1.4, height: 2.2, posts: true, mat: 'warning_stripe' });

    // Guard post inside the gate, with a light on it.
    P.guardPost(b, rng, { x: -8.6, y: 0.1, z: EXT - 4.2, rotY: Math.PI + 0.25 });
    this._cover(-8.6, EXT - 4.2);

    // Boom across the inbound lane, with a chicane of barriers and bollards.
    P.boomBarrier(b, rng, { x: -5.2, y: 0.1, z: EXT - 7.5, rotY: 0, len: 5.4, raised: false });
    for (const [x, z, r, v] of [
      [3.4, EXT - 6.0, 0.06, 0], [6.6, EXT - 6.3, -0.09, 1], [-2.0, EXT - 11.5, 0.03, 2],
      [1.5, EXT - 11.2, 0.14, 0], [8.4, EXT - 11.0, -0.2, 3],
    ]) { P.jerseyBarrier(b, rng, { x, z, rotY: r, variant: v }); this._cover(x, z); }
    for (let i = 0; i < 6; i++) P.bollard(b, rng, { x: -10.5 + i * 1.4, z: EXT - 9.5 });
    for (const [x, z, k] of [[7.6, EXT - 8.2, false], [8.6, EXT - 8.6, true], [4.4, EXT - 14, false]]) {
      P.trafficCone(b, rng, { x, z, knocked: k });
    }
    // Sandbag firing position covering the gate.
    P.sandbagEmplacement(b, rng, { x: 9.5, z: EXT - 4.5, rotY: -0.35, len: 5.0, rows: 4, depth: 2 });
    this._cover(9.5, EXT - 4.5);
    // Tyre-shredder plate + spilled grit at the threshold.
    b.box(9.0, 0.07, 1.1, [0, 0.14, EXT - 1.6], 'metal_grate', { chamfer: 0.02, collide: false });
    P.litterScatter(b, rng, { x: 0, z: EXT - 3, r: 6, count: 12 });
    P.rubblePile(b, rng, { x: 12.5, z: EXT - 2.5, radius: 1.6, height: 0.6, count: 18, rebar: 4 });
  }

  // -------------------------------------------------------- admin block ---
  _adminBlock(b, rng) {
    const W = 26, D = 15, STOREY = 3.45, FLOORS = 3;
    const cx = 0, cz = -32;
    const T = 0.32;
    const zF = cz + D / 2, zB = cz - D / 2;

    for (let f = 0; f < FLOORS; f++) {
      const y = f * STOREY;
      const mat = f === 0 ? 'concrete_wall' : (f === 1 ? 'brick_red' : 'plaster_damaged');

      // Floor slab, with a visible edge band so it reads as 280 mm of concrete.
      b.box(W, 0.28, D, [cx, y + 0.14, cz], 'concrete_floor', { chamfer: 0.04 });

      // ---- front (south) facade
      const bays = 6;
      for (let i = 0; i < bays; i++) {
        const x = cx - W / 2 + (i + 0.5) * (W / bays);
        const isDoor = f === 0 && (i === 2 || i === 3);
        b.wallWithOpening(W / bays, STOREY, T, [x, y + 0.28, zF], mat,
          isDoor ? { u: 0, v: 1.12, ow: 1.6, oh: 2.24 }
                 : { u: 0, v: 1.85, ow: 1.7, oh: 1.5 });
        if (isDoor) {
          P.doorUnit(b, rng, {
            x, y: y + 0.28, z: zF, rotY: 0, w: 1.6, h: 2.24, thick: T, interior: false,
            leaves: 1, open: i === 2 ? 0.85 : 0.0, missing: i === 3 && rng() < 0.4,
          });
        } else {
          P.windowUnit(b, rng, {
            x, y: y + 0.28 + 1.85, z: zF, rotY: 0, w: 1.7, h: 1.5, thick: T,
            broken: f === 2 ? 0.6 : 0.34, bars: f === 0, boarded: f === 2,
            interior: f > 0, cols: 2, rows: 2,
          });
        }
      }

      // ---- rear (north) wall, with a smaller window per bay
      for (let i = 0; i < bays; i++) {
        const x = cx - W / 2 + (i + 0.5) * (W / bays);
        const svc = f === 0 && i === 4;
        b.wallWithOpening(W / bays, STOREY, T, [x, y + 0.28, zB], mat,
          svc ? { u: 0, v: 1.12, ow: 1.5, oh: 2.24 } : { u: 0, v: 2.0, ow: 1.1, oh: 1.1 });
        if (svc) {
          P.doorUnit(b, rng, { x, y: y + 0.28, z: zB, rotY: Math.PI, w: 1.5, h: 2.24, thick: T, leaves: 1, open: 0.25, interior: false });
        } else {
          P.windowUnit(b, rng, {
            x, y: y + 0.28 + 2.0, z: zB, rotY: Math.PI, w: 1.1, h: 1.1, thick: T,
            broken: 0.45, bars: f === 0, interior: f > 0, cols: 1, rows: 2,
          });
        }
      }

      // ---- side walls
      for (const sx of [-1, 1]) {
        const wx = cx + sx * W / 2;
        if (f === 0) {
          b.wallWithOpening(D, STOREY, T, [wx, y + 0.28, cz], mat,
            { u: sx * 3.5, v: 1.12, ow: 1.5, oh: 2.24 }, { rotY: Math.PI / 2 });
          P.doorUnit(b, rng, {
            x: wx, y: y + 0.28, z: cz + sx * 3.5, rotY: sx * Math.PI / 2,
            w: 1.5, h: 2.24, thick: T, leaves: 1, open: 0.5, interior: false,
          });
        } else {
          // Two windows per side, per floor — each half of the wall is built
          // with its own opening so the reveal is a real hole, not a decal.
          for (const half of [-1, 1]) {
            const wz = cz + half * D / 4;
            b.wallWithOpening(D / 2, STOREY, T, [wx, y + 0.28, wz], mat,
              { u: 0, v: 1.95, ow: 1.25, oh: 1.25 }, { rotY: Math.PI / 2 });
            P.windowUnit(b, rng, {
              x: wx, y: y + 0.28 + 1.95, z: wz, rotY: sx * Math.PI / 2,
              w: 1.25, h: 1.25, thick: T, broken: 0.4, interior: true, cols: 2, rows: 1,
            });
          }
        }
      }

      // ---- floor band / string course between storeys
      b.box(W + 0.42, 0.24, D + 0.42, [cx, y + 0.14, cz], 'concrete_stained', { chamfer: 0.05, collide: false });
      b.box(W + 0.5, 0.05, D + 0.5, [cx, y + 0.02, cz], 'dirt_dark', { chamfer: 0.02, collide: false });
    }

    // ---- ground floor interior: partitions, and enough furniture that it is a
    //      room rather than a shell.
    b.wallWithOpening(D - 1, STOREY, 0.22, [cx - 7, 0.28, cz], 'plaster_white',
      { u: 2.2, v: 1.12, ow: 1.2, oh: 2.24 }, { rotY: Math.PI / 2 });
    b.wallWithOpening(D - 1, STOREY, 0.22, [cx + 7, 0.28, cz], 'plaster_white',
      { u: -2.2, v: 1.12, ow: 1.2, oh: 2.24 }, { rotY: Math.PI / 2 });
    b.box(11, 0.16, 0.22, [cx, 0.28 + STOREY - 0.08, cz - 3], 'plaster_white');
    // Skirting + a dado of damage where furniture and boots have hit the walls.
    for (const [wx, wz, ww, wr] of [
      [cx, cz - D / 2 + 0.2, W - 1, 0], [cx - 7 + 0.15, cz, D - 1, Math.PI / 2], [cx + 7 - 0.15, cz, D - 1, Math.PI / 2],
    ]) {
      b.add(cbox(b, ww, 0.14, 0.05, 'wood_plank', 0.012), 'wood_plank',
        { pos: [wx, 0.35, wz], rotY: wr, collide: false });
      b.add(cbox(b, ww, 0.5, 0.012, 'dirt_dark', 0.02), 'dirt_dark',
        { pos: [wx, 0.6, wz], rotY: wr, collide: false });
    }
    P.cabinet(b, rng, { x: cx - 10.5, y: 0.42, z: cz - 6.2, rotY: 0.06, bays: 3 });
    P.cabinet(b, rng, { x: cx + 10.2, y: 0.42, z: cz - 6.0, rotY: -0.1, bays: 2, mat: 'paint_green' });
    P.workbench(b, rng, { x: cx + 9.5, y: 0.42, z: cz + 3.5, rotY: Math.PI / 2 + 0.05 });
    for (let i = 0; i < 7; i++) {
      P.crate(b, rng, {
        x: cx + R(rng, -11, 11), y: 0.42, z: cz + R(rng, -6, 5),
        rotY: rng() * TAU, scale: R(rng, 0.75, 1.15), variant: (rng() * 4) | 0,
      });
    }
    for (let i = 0; i < 5; i++) {
      P.barrel(b, rng, { x: cx + R(rng, -11, 11), y: 0.42, z: cz + R(rng, -6, 5), tipped: rng() < 0.3 });
    }
    P.rubblePile(b, rng, { x: cx - 2.5, y: 0.42, z: cz - 5.5, radius: 2.0, height: 0.7, count: 26, rebar: 6 });
    P.rubblePile(b, rng, { x: cx + 4.5, y: 0.42, z: cz + 4.0, radius: 1.4, height: 0.5, count: 16, rebar: 4 });
    P.litterScatter(b, rng, { x: cx, y: 0.43, z: cz, r: 9, count: 20 });
    // Ceiling: exposed joists, cable tray and a couple of dead strip lights.
    for (let i = 0; i < 6; i++) {
      b.box(W - 1.2, 0.16, 0.1, [cx, 0.28 + STOREY - 0.24, cz - D / 2 + 0.8 + i * (D - 1.6) / 5], 'wood_plank',
        { chamfer: 0.01, collide: false });
    }
    P.ducting(b, rng, { x: cx, y: 0.28 + STOREY - 0.62, z: cz - 4.5, rotY: 0, len: 22, w: 0.5, h: 0.38, hangTo: 0.35 });
    for (const [lx, lz] of [[-8, -30], [0, -34], [8, -30]]) {
      const lp = P.hangingLamp(b, rng, { x: lx, y: 0.28 + STOREY - 0.3, z: lz, drop: 0.35, radius: 0.3 });
      if (lz !== -34) continue;                 // one real light, three visible fittings
      const l = new THREE.PointLight(0xffd9a8, 9.0, 17, 2);
      l.position.set(lp[0], lp[1], lp[2]);
      l.castShadow = false;
      b.addLight(l);
    }

    // ---- exterior massing -------------------------------------------------
    // The facade was a single flat plane carrying all its detail in texture and
    // in surface-mounted props. Nothing pushed or pulled the wall by more than
    // ~30 cm, so with the textures stripped the building read as one rectangle.
    // These are the elements that give a masonry building its silhouette.
    {
      const H = FLOORS * STOREY + 0.28;
      const bayW = W / 6;

      // Plinth: a heavier base course, which is what stops a building looking
      // like it was pasted onto the ground.
      for (const [zz, dd, rot] of [[zF + 0.10, 0.20, 0], [zB - 0.10, 0.20, 0]]) {
        b.box(W + 0.44, 0.72, dd, [cx, 0.36, zz], 'concrete_stained', { chamfer: 0.05 });
      }
      for (const sx of [-1, 1]) {
        b.box(0.20, 0.72, D + 0.44, [cx + sx * (W / 2 + 0.10), 0.36, cz],
          'concrete_stained', { chamfer: 0.05 });
      }
      // A weathered band above the plinth — splash-back from rain off the apron.
      b.box(W + 0.30, 0.34, 0.06, [cx, 0.90, zF + 0.18], 'dirt_dark',
        { chamfer: 0.01, collide: false });

      // Pilasters on the bay divisions, full height. Skipped at the centre so
      // the entrance surround can occupy that span.
      for (let i = 0; i <= 6; i++) {
        const x = cx - W / 2 + i * bayW;
        if (Math.abs(x - cx) < 0.01) continue;
        const isCorner = i === 0 || i === 6;
        const wide = isCorner ? 0.85 : 0.55;
        const proud = isCorner ? 0.26 : 0.20;
        b.box(wide, H - 0.72, proud, [x, 0.72 + (H - 0.72) / 2, zF + proud / 2],
          'concrete_wall', { chamfer: 0.04 });
        // Capital: a small corbel where the pilaster meets the parapet.
        b.box(wide + 0.14, 0.18, proud + 0.10, [x, H - 0.06, zF + (proud + 0.10) / 2],
          'concrete_stained', { chamfer: 0.03, collide: false });
      }
      // Corner pilasters returned onto the side elevations so the corner reads
      // as solid rather than as two planes meeting at an edge.
      for (const sx of [-1, 1]) {
        b.box(0.26, H - 0.72, 0.85, [cx + sx * (W / 2 + 0.13), 0.72 + (H - 0.72) / 2, zF - 0.42 + 0.85 / 2],
          'concrete_wall', { chamfer: 0.04 });
      }

      // Projecting cornice at every floor line, plus a drip on its underside.
      for (let f = 1; f < FLOORS; f++) {
        const y = f * STOREY + 0.28;
        b.box(W + 0.62, 0.26, 0.38, [cx, y - 0.13, zF + 0.19], 'concrete_stained',
          { chamfer: 0.03, collide: false });
        b.box(W + 0.40, 0.07, 0.12, [cx, y - 0.30, zF + 0.30], 'dirt_dark',
          { chamfer: 0.01, collide: false });
        for (const sx of [-1, 1]) {
          b.box(0.38, 0.26, D + 0.62, [cx + sx * (W / 2 + 0.19), y - 0.13, cz],
            'concrete_stained', { chamfer: 0.03, collide: false });
        }
      }

      // Entrance surround: a projecting portal over the two door bays, with a
      // deep lintel and its own cornice. Reads as the way in from across the yard.
      const eW = bayW * 2 + 0.9, eH = 3.35, eP = 0.62;
      for (const sx of [-1, 1]) {
        b.box(0.62, eH, eP, [cx + sx * (eW / 2 - 0.31), eH / 2, zF + eP / 2],
          'concrete_wall', { chamfer: 0.05 });
      }
      b.box(eW, 0.55, eP + 0.16, [cx, eH - 0.27, zF + (eP + 0.16) / 2],
        'concrete_wall', { chamfer: 0.05 });
      b.box(eW + 0.44, 0.20, eP + 0.34, [cx, eH + 0.10, zF + (eP + 0.34) / 2],
        'concrete_stained', { chamfer: 0.04, collide: false });
      // Signage over the door and a pair of bulkhead lights.
      b.box(2.6, 0.42, 0.06, [cx, eH - 0.30, zF + eP + 0.13], 'warning_stripe',
        { chamfer: 0.01, collide: false });
      for (const sx of [-1, 1]) {
        b.box(0.26, 0.18, 0.16, [cx + sx * 2.1, 2.55, zF + eP + 0.08], 'painted_steel_blue',
          { chamfer: 0.03, collide: false });
      }
      // Two steps up to the threshold.
      for (let i = 0; i < 2; i++) {
        b.box(eW - 0.4 + i * 0.5, 0.14, 0.42 + i * 0.30,
          [cx, 0.07 + (1 - i) * 0.14, zF + eP + 0.24 + i * 0.20],
          'concrete_stained', { chamfer: 0.02 });
      }
    }

    // ---- roof
    const ry = FLOORS * STOREY;
    b.box(W + 0.5, 0.3, D + 0.5, [cx, ry + 0.15, cz], 'concrete_floor', { chamfer: 0.05 });
    for (const z of [cz - D / 2, cz + D / 2]) {
      b.box(W + 0.5, 0.95, 0.3, [cx, ry + 0.78, z], 'concrete_wall', { chamfer: 0.05 });
      b.box(W + 0.72, 0.14, 0.44, [cx, ry + 1.32, z], 'concrete_stained', { chamfer: 0.03, collide: false });
    }
    for (const sx of [-1, 1]) {
      b.box(0.3, 0.95, D + 0.5, [cx + sx * (W / 2 + 0.1), ry + 0.78, cz], 'concrete_wall', { chamfer: 0.05 });
      b.box(0.44, 0.14, D + 0.72, [cx + sx * (W / 2 + 0.1), ry + 1.32, cz], 'concrete_stained', { chamfer: 0.03, collide: false });
    }
    // Roof falls + felt seams + ponding.
    for (let i = 0; i < 8; i++) {
      b.add(cbox(b, W - 0.6, 0.02, 0.09, 'dirt_dark', 0.006), 'dirt_dark',
        { pos: [cx, ry + 0.31, cz - D / 2 + 1.0 + i * (D - 2) / 7], collide: false });
    }
    P.puddle(b, rng, { x: cx - 5, y: ry + 0.31, z: cz + 2, r: 1.6 });
    P.puddle(b, rng, { x: cx + 6, y: ry + 0.31, z: cz - 3, r: 1.1 });
    // HVAC plant, ducting, aerials, water tank.
    for (let i = 0; i < 3; i++) {
      const x = cx - 7 + i * 7, z = cz + R(rng, -3, 3);
      b.box(2.6, 0.16, 1.9, [x, ry + 0.38, z], 'metal_rusted', { chamfer: 0.02 });
      b.box(2.4, 1.15, 1.7, [x, ry + 1.05, z], 'painted_steel_blue', { chamfer: 0.05 });
      b.box(2.0, 0.1, 1.35, [x, ry + 1.66, z], 'metal_grate', { chamfer: 0.02, collide: false });
      for (let k = 0; k < 8; k++) {
        b.box(2.3, 0.05, 0.035, [x, ry + 0.65 + k * 0.055, z + 0.87], 'sheet_metal_bare', { chamfer: 0.006, rot: [0.4, 0, 0], collide: false });
      }
      b.add(cpipe(b, 0.16, 1.3, 12, 'metal_rusted'), 'metal_rusted', { pos: [x + 1.5, ry + 1.1, z + 1.0], collide: false });
      P.contactDress(b, rng, { x, z, y: ry + 0.31, w: 3.0, d: 2.3, amount: 0.7, frags: 4, mat: 'dust' });
    }
    P.ducting(b, rng, { x: cx, y: ry + 1.3, z: cz - 5.5, rotY: 0, len: 18, w: 0.6, h: 0.45, hangTo: 0.6 });
    P.waterTank(b, rng, { x: cx - 10, y: ry + 0.31, z: cz - 4.5, radius: 0.95, height: 1.7, standH: 1.6 });
    P.gasBottleRack(b, rng, { x: cx + 10, y: ry + 0.31, z: cz + 3.5, rotY: -0.4, bays: 1 });
    for (let i = 0; i < 5; i++) {
      b.add(cpipe(b, 0.05, R(rng, 1.5, 4.0), 7, 'metal_rusted'), 'metal_rusted',
        { pos: [cx + R(rng, -11, 11), ry + 2.2, cz + R(rng, -6, 6)], collide: false });
    }
    P.litterScatter(b, rng, { x: cx, y: ry + 0.31, z: cz, r: 10, count: 12 });
    this._cover(cx - 7, cz);
    this._cover(cx + 7, cz);

    // ---- facade services: downpipes, conduit, AC, signage, a fire escape
    for (const sx of [-1, 1]) {
      const px = cx + sx * (W / 2 - 0.5);
      b.add(cpipe(b, 0.075, ry + 0.6, 10, 'metal_rusted'), 'metal_rusted',
        { pos: [px, (ry + 0.6) / 2, zF + 0.22], collide: false });
      for (let i = 0; i < 6; i++) {
        b.box(0.2, 0.06, 0.16, [px, 1.0 + i * 1.8, zF + 0.14], 'metal_rusted', { chamfer: 0.01, collide: false });
      }
      b.add(cpipe(b, 0.11, 0.5, 10, 'metal_rusted'), 'metal_rusted', { pos: [px, 0.3, zF + 0.22], collide: false });
      b.add(cbox(b, 0.6, 1.6, 0.014, 'dirt_dark', 0.02), 'dirt_dark',
        { pos: [px, 0.9, zF + 0.165], collide: false });
      // Hopper head at the top.
      b.box(0.3, 0.34, 0.28, [px, ry + 0.55, zF + 0.22], 'metal_rusted', { chamfer: 0.02, collide: false });
    }
    P.conduitRun(b, rng, { x: cx + 4, y: 2.55, z: zF + 0.17, rotY: 0, len: 16, count: 3, standoff: 0.07 });
    P.conduitRun(b, rng, { x: cx - 11.4, y: 0, z: zF + 0.17, rotY: 0, len: 5.6, count: 2, vertical: true, standoff: 0.07 });
    for (const [ax, ay] of [[-8.5, 4.2], [-4.2, 7.7], [6.3, 4.2], [9.8, 7.7]]) {
      P.airCon(b, rng, { x: cx + ax, y: ay, z: zF + 0.16, rotY: 0, scale: 0.95 });
    }
    P.signage(b, rng, { x: cx - 6.5, z: zF + 0.2, rotY: 0, w: 2.6, h: 0.7, height: 3.15, posts: false, wallMount: true, mat: 'sheet_metal_bare' });
    P.signage(b, rng, { x: cx + 6.0, z: zF + 0.2, rotY: 0, w: 0.8, h: 1.0, height: 2.35, posts: false, wallMount: true, mat: 'warning_stripe' });
    // Canopy over the entrance.
    b.box(7.0, 0.16, 1.9, [cx, 2.85, zF + 0.95], 'sheet_metal_bare', { chamfer: 0.03, collide: false });
    b.box(7.2, 0.22, 0.16, [cx, 2.78, zF + 1.9], 'metal_rusted', { chamfer: 0.02, collide: false });
    for (const sx of [-1, 1]) {
      b.add(cpipe(b, 0.045, 2.2, 8, 'metal_rusted'), 'metal_rusted',
        { pos: [cx + sx * 3.2, 3.5, zF + 1.0], rot: [0, 0, sx * 0.5], collide: false });
    }
    // Steps and a handrail up to the entrance.
    for (let i = 0; i < 3; i++) {
      b.box(7.4 - i * 0.4, 0.13, 0.34, [cx, 0.19 - i * 0.055, zF + 1.0 + i * 0.34], 'concrete_stained', { chamfer: 0.02 });
    }
    for (const sx of [-1, 1]) {
      b.add(cpipe(b, 0.035, 1.7, 8, 'metal_rusted'), 'metal_rusted',
        { pos: [cx + sx * 3.5, 0.95, zF + 1.3], collide: false });
      b.add(cpipe(b, 0.035, 1.4, 8, 'metal_rusted'), 'metal_rusted',
        { pos: [cx + sx * 3.5, 1.75, zF + 1.9], rot: [Math.PI / 2 - 0.3, 0, 0], collide: false });
    }

    // External fire stair to the roof, so the building is actually usable.
    this._stairs(b, [cx + W / 2 + 1.5, 0.3, cz + 4], 0, ry - 0.3, 12, Math.PI);
    P.ladder(b, rng, { x: cx - W / 2 - 0.55, y: 0.1, z: cz - 3, rotY: -Math.PI / 2, height: ry + 0.9, cage: true });

    // Grounding around the whole footprint.
    for (const [gx, gz, gw, gd] of [
      [cx, zF + 0.3, W + 1, 0.9], [cx, zB - 0.3, W + 1, 0.9],
      [cx - W / 2 - 0.3, cz, 0.9, D], [cx + W / 2 + 0.3, cz, 0.9, D],
    ]) {
      P.contactDress(b, rng, { x: gx, z: gz, y: 0.12, w: gw, d: gd, amount: 1.2, frags: 8, fragSpread: 2.0 });
    }
  }

  _stairs(b, base, rotY, height, steps, faceRot = 0) {
    const rise = height / steps, run = 0.29, width = 1.25;
    for (let i = 0; i < steps; i++) {
      const y = base[1] + rise * (i + 0.5);
      const off = run * (i + 0.5);
      const dx = Math.cos(faceRot) * off, dz = Math.sin(faceRot) * off;
      b.box(width, rise, run, [base[0] + dx, y, base[2] + dz], 'metal_grate',
        { chamfer: 0.015, rotY: faceRot });
      // Nosing so each tread has a lit top edge.
      b.box(width, 0.035, 0.06, [base[0] + dx + Math.cos(faceRot) * run * 0.47, y + rise / 2, base[2] + dz + Math.sin(faceRot) * run * 0.47],
        'painted_steel_yellow', { chamfer: 0.008, rotY: faceRot, collide: false });
    }
    // Stringers, handrail, mid rail and balusters.
    const len = Math.hypot(run * steps, height);
    const ang = Math.atan2(height, run * steps);
    for (const s of [-1, 1]) {
      const sx = base[0] + Math.cos(faceRot) * (run * steps / 2) + Math.sin(faceRot) * s * width / 2;
      const sz = base[2] + Math.sin(faceRot) * (run * steps / 2) - Math.cos(faceRot) * s * width / 2;
      b.add(cbox(b, 0.08, 0.26, len, 'painted_steel_yellow', 0.02), 'painted_steel_yellow', {
        pos: [sx, base[1] + height / 2 - 0.16, sz], rot: [-ang, faceRot, 0], collide: false,
      });
      for (const hy of [0.55, 1.0]) {
        b.add(cpipe(b, hy > 0.8 ? 0.035 : 0.026, len, 8, 'painted_steel_yellow'), 'painted_steel_yellow', {
          pos: [sx, base[1] + height / 2 + hy, sz], rot: [Math.PI / 2 - ang, faceRot, 0], collide: false,
        });
      }
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        b.add(cpipe(b, 0.022, 1.05, 6, 'painted_steel_yellow'), 'painted_steel_yellow', {
          pos: [
            base[0] + Math.cos(faceRot) * (run * steps * t) + Math.sin(faceRot) * s * width / 2,
            base[1] + height * t + 0.5,
            base[2] + Math.sin(faceRot) * (run * steps * t) - Math.cos(faceRot) * s * width / 2,
          ], collide: false,
        });
      }
    }
  }

  // ------------------------------------------------------- service yard ---
  /** The strip between the admin block and the north wall: pure back-of-house. */
  _serviceYard(b, rng) {
    const z0 = -44;
    P.generator(b, rng, { x: -14, y: 0.12, z: z0 + 1.5, rotY: 0.12 });
    this._cover(-14, z0 + 1.5);
    P.waterTank(b, rng, { x: -24, y: 0.12, z: z0 + 2.0, rotY: 0.5, radius: 1.5, height: 2.8, standH: 2.8 });
    P.gasBottleRack(b, rng, { x: -7.5, y: 0.12, z: z0 + 0.6, rotY: -0.08, bays: 3 });
    P.dumpster(b, rng, { x: 6.5, y: 0.12, z: z0 + 1.2, rotY: 0.22, len: 3.2, mat: 'paint_green' });
    P.dumpster(b, rng, { x: 12.0, y: 0.12, z: z0 + 1.6, rotY: -0.34, len: 2.6, mat: 'paint_red', full: false });
    this._cover(6.5, z0 + 1.2);
    P.palletStack(b, rng, { x: 18, z: z0 + 2.0, rotY: 0.3, count: 7 });
    P.stackedMaterial(b, rng, { x: -32, y: 0.12, z: z0 + 3.0, rotY: 0.08, len: 5.0, kind: 0 });
    P.stackedMaterial(b, rng, { x: 24, y: 0.12, z: z0 + 3.4, rotY: -0.15, len: 4.4, kind: 1 });
    P.cableDrum(b, rng, { x: 1.5, y: 0.12, z: z0 + 3.6, rotY: 0.9, radius: 0.95, width: 0.8 });
    P.cableDrum(b, rng, { x: 3.6, y: 0.12, z: z0 + 1.2, rotY: 0.2, radius: 0.7, width: 0.6, onSide: true });
    P.tarpCover(b, rng, { x: -19.5, y: 0.12, z: z0 + 2.4, rotY: 0.4, w: 3.0, d: 2.2, h: 1.3 });
    P.brazier(b, rng, { x: -3.5, z: z0 + 5.5 });

    // Overhead services running the length of the yard, wall to building.
    P.pipeRun(b, rng, { x: 0, y: 3.4, z: z0 - 1.2, rotY: 0, len: 46, lines: 4, spacing: 0.44, baseRadius: 0.1 });
    P.cableRun(b, rng, { x: 0, y: 5.1, z: z0 - 2.0, rotY: 0, len: 44, spans: 8, cables: 4, sag: 0.4 });
    for (let i = 0; i < 8; i++) {
      const x = -44 + i * 12.5;
      b.box(0.26, 5.4, 0.26, [x, 2.7, z0 - 2.0], 'metal_rusted', { chamfer: 0.02 });
      b.box(0.5, 0.16, 0.5, [x, 0.2, z0 - 2.0], 'concrete_stained', { chamfer: 0.03 });
      P.contactDress(b, rng, { x, z: z0 - 2.0, y: 0.12, w: 0.9, d: 0.9, amount: 0.7, frags: 3 });
    }
    // Assorted drums and crates against the wall.
    for (let i = 0; i < 18; i++) {
      const x = R(rng, -46, 46), z = R(rng, -50, -41);
      if (Math.abs(x) < 3 && z > -42) continue;
      if (rng() < 0.55) P.barrel(b, rng, { x, y: 0.12, z, tipped: rng() < 0.2 });
      else P.crate(b, rng, { x, y: 0.12, z, scale: R(rng, 0.8, 1.2) });
    }
    P.litterScatter(b, rng, { x: 0, y: 0.13, z: z0 + 2, r: 20, count: 26 });
    for (const [x, z, r] of [[-10, z0 + 4, 1.6], [9, z0 + 5, 1.2], [-28, z0 + 5, 1.4]]) P.puddle(b, rng, { x, z, r });
    P.rubblePile(b, rng, { x: 30, y: 0.12, z: z0 + 1, radius: 2.4, height: 0.9, count: 30, rebar: 8 });
    P.rubblePile(b, rng, { x: -40, y: 0.12, z: z0 + 4, radius: 1.8, height: 0.7, count: 22, rebar: 5 });
  }

  // ----------------------------------------------------------- warehouse ---
  _warehouse(b, rng) {
    const W = 24, D = 30, H = 9.5;
    const cx = 32, cz = 4;
    const T = 0.3;

    // Corrugated shell on a steel frame.
    b.box(W, H, T, [cx, H / 2, cz - D / 2], 'corrugated_roof');
    b.box(9, H, T, [cx + 7.5, H / 2, cz + D / 2], 'corrugated_roof');
    b.wallWithOpening(6, H, T, [cx, 0, cz + D / 2], 'corrugated_roof', { u: 0, v: 2.3, ow: 5.5, oh: 4.6 });
    b.wallWithOpening(9, H, T, [cx - 7.5, 0, cz + D / 2], 'corrugated_roof', { u: -0.5, v: 1.05, ow: 1.1, oh: 2.1 });
    b.box(T, H, D, [cx + W / 2, H / 2, cz], 'corrugated_roof');
    b.wallWithOpening(D, H, T, [cx - W / 2, 0, cz], 'corrugated_roof', { u: 6, v: 2.1, ow: 4.0, oh: 4.2 }, { rotY: Math.PI / 2 });

    // Base plinth + a stained band where the sheeting meets the slab.
    for (const [px, pz, pw, pd] of [
      [cx, cz - D / 2, W + 0.4, 0.7], [cx, cz + D / 2, W + 0.4, 0.7],
      [cx + W / 2, cz, 0.7, D + 0.4], [cx - W / 2, cz, 0.7, D + 0.4],
    ]) {
      b.box(pw, 0.62, pd, [px, 0.31, pz], 'concrete_stained', { chamfer: 0.03 });
      b.add(cbox(b, pw + 0.1, 0.55, pd + 0.1, 'dirt_dark', 0.05), 'dirt_dark',
        { pos: [px, 0.9, pz], collide: false });
    }

    // Sheeting girts and eaves gutter — the flat panels needed something on them.
    for (const [gx, gz, gw, gd, gr] of [
      [cx, cz - D / 2 - 0.2, W, 0.08, 0], [cx, cz + D / 2 + 0.2, W, 0.08, 0],
      [cx + W / 2 + 0.2, cz, 0.08, D, 0], [cx - W / 2 - 0.2, cz, 0.08, D, 0],
    ]) {
      for (let i = 1; i < 6; i++) {
        b.box(gw, 0.1, gd, [gx, i * 1.55, gz], 'metal_rusted', { chamfer: 0.012, collide: false });
      }
      b.box(gw + 0.24, 0.24, gd + 0.24, [gx, H + 0.35, gz], 'metal_rusted', { chamfer: 0.03, collide: false });
    }
    // Downpipes at the corners with splash blocks.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const px = cx + sx * (W / 2 + 0.28), pz = cz + sz * (D / 2 - 0.6);
      b.add(cpipe(b, 0.075, H + 0.4, 10, 'metal_rusted'), 'metal_rusted', { pos: [px, (H + 0.4) / 2, pz], collide: false });
      b.box(0.5, 0.14, 0.7, [px, 0.13, pz + sz * 0.2], 'concrete_stained', { chamfer: 0.03, collide: false });
      P.contactDress(b, rng, { x: px, z: pz, y: 0.14, w: 0.9, d: 1.0, amount: 0.8, frags: 4 });
    }

    // Shallow gable roof.
    for (const s of [-1, 1]) {
      b.add(cbox(b, W / 2 + 0.4, 0.22, D + 0.6, 'corrugated_roof', 0.04), 'corrugated_roof', {
        pos: [cx + s * W / 4, H + 0.9, cz], rot: [0, 0, s * -0.16],
      });
    }
    b.box(W + 0.8, 0.3, 0.4, [cx, H + 1.55, cz], 'metal_rusted', { chamfer: 0.04 });
    // Roof lights — bright strips that explain the light on the floor.
    for (let i = 0; i < 5; i++) {
      const z = cz - D / 2 + 3.5 + i * 6;
      for (const s of [-1, 1]) {
        b.add(cbox(b, 3.4, 0.08, 2.2, 'lamp_glow_dim', 0.03), 'lamp_glow_dim', {
          pos: [cx + s * W / 4, H + 0.72, z], rot: [0, 0, s * -0.16], collide: false,
        });
      }
    }
    // Roof-mounted extract fans.
    for (const z of [cz - 9, cz + 1, cz + 11]) {
      b.add(cpipe(b, 0.42, 0.55, 14, 'sheet_metal_bare'), 'sheet_metal_bare', { pos: [cx, H + 1.9, z], collide: false });
      b.add(cpipe(b, 0.55, 0.09, 14, 'metal_rusted'), 'metal_rusted', { pos: [cx, H + 2.2, z], collide: false });
      for (let i = 0; i < 6; i++) {
        b.box(0.9, 0.03, 0.1, [cx, H + 2.24, z], 'metal_rusted', { chamfer: 0.006, rotY: i * 0.52, collide: false });
      }
    }

    // Steel portal frames, visible from inside — now real I-sections.
    for (let i = 0; i <= 6; i++) {
      const z = cz - D / 2 + (i * D / 6);
      for (const s of [-1, 1]) {
        const px = cx + s * (W / 2 - 0.3);
        // I-section: web across the frame, flanges front and back.
        b.box(0.05, H, 0.24, [px, H / 2, z], 'painted_steel_blue', { chamfer: 0.008 });
        for (const sz of [-1, 1]) {
          b.box(0.2, H, 0.035, [px, H / 2, z + sz * 0.12], 'painted_steel_blue', { chamfer: 0.008, collide: sz > 0 });
        }
        // Base plate + holding-down bolts + haunch.
        b.box(0.42, 0.04, 0.5, [px, 0.66, z], 'sheet_metal_bare', { chamfer: 0.008, collide: false });
        for (const sz of [-1, 1]) b.add(cpipe(b, 0.018, 0.08, 6, 'sheet_metal_bare'), 'sheet_metal_bare', { pos: [px, 0.71, z + sz * 0.18], collide: false });
        b.box(0.24, 1.1, 0.26, [px - s * 0.5, H - 0.7, z], 'painted_steel_blue', { chamfer: 0.02, rot: [0, 0, s * 0.5], collide: false });
      }
      b.box(W - 0.4, 0.3, 0.26, [cx, H - 0.2, z], 'painted_steel_blue', { chamfer: 0.03 });
      b.box(W - 0.4, 0.05, 0.34, [cx, H - 0.05, z], 'painted_steel_blue', { chamfer: 0.008, collide: false });
      b.box(W - 0.4, 0.05, 0.34, [cx, H - 0.35, z], 'painted_steel_blue', { chamfer: 0.008, collide: false });
      // Purlins on top of the rafters.
      if (i < 6) {
        for (let k = 1; k < 8; k++) {
          b.box(0.12, 0.16, D / 6, [cx - W / 2 + k * W / 8, H + 0.1, z + D / 12], 'sheet_metal_bare', { chamfer: 0.012, collide: false });
        }
      }
    }

    // Roller shutter in the south opening + a personnel door beside it.
    P.rollerShutter(b, rng, { x: cx, y: 0.0, z: cz + D / 2, rotY: 0, w: 5.4, h: 4.6, openAmount: 0.62 });
    P.doorUnit(b, rng, {
      x: cx - 8, y: 0.0, z: cz + D / 2, rotY: 0, w: 1.1, h: 2.1, thick: T, leaves: 1, open: 0.4, interior: false,
    });

    // Concrete floor + hard-wearing markings and spills.
    b.box(W - 0.4, 0.14, D - 0.4, [cx, 0.11, cz], 'concrete_floor', { chamfer: 0.03 });
    for (const lx of [cx - 8.6, cx - 1.6, cx + 5.4]) {
      b.add(cbox(b, 0.12, 0.016, D - 3, 'road_marking', 0.004), 'road_marking', { pos: [lx, 0.185, cz], collide: false });
    }
    for (let i = 0; i < 12; i++) {
      b.add(cbox(b, R(rng, 0.5, 2.4), 0.014, R(rng, 0.4, 1.8), 'dirt_dark', 0.1), 'dirt_dark',
        { pos: [cx + R(rng, -10, 10), 0.186, cz + R(rng, -13, 13)], rotY: rng() * TAU, collide: false });
    }
    P.litterScatter(b, rng, { x: cx, y: 0.19, z: cz, r: 11, count: 22 });

    // Catwalk down one side at 5.2 m, reachable by stairs.
    const cwY = 5.2;
    b.box(2.6, 0.12, D - 2, [cx + W / 2 - 1.6, cwY, cz], 'metal_grate', { chamfer: 0.02 });
    b.box(2.7, 0.2, 0.16, [cx + W / 2 - 1.6, cwY - 0.14, cz], 'painted_steel_yellow', { chamfer: 0.02, collide: false });
    for (let i = 0; i < 10; i++) {
      const z = cz - D / 2 + 1.5 + i * (D - 3) / 9;
      b.add(cpipe(b, 0.04, 1.05, 8, 'painted_steel_yellow'), 'painted_steel_yellow',
        { pos: [cx + W / 2 - 2.85, cwY + 0.58, z], collide: false });
      // Support brackets back to the portal columns.
      b.box(1.4, 0.12, 0.1, [cx + W / 2 - 2.2, cwY - 0.3, z], 'painted_steel_yellow', { chamfer: 0.012, rot: [0, 0, 0.5], collide: false });
    }
    for (const hy of [0.58, 1.08]) {
      b.add(cpipe(b, hy > 0.8 ? 0.045 : 0.03, D - 2, 8, 'painted_steel_yellow'), 'painted_steel_yellow',
        { pos: [cx + W / 2 - 2.85, cwY + hy + (hy > 0.8 ? 0 : 0), cz], rot: [Math.PI / 2, 0, 0], collide: false });
    }
    b.box(0.1, 0.5, D - 2, [cx + W / 2 - 2.88, cwY + 0.18, cz], 'sheet_metal_bare', { chamfer: 0.01, collide: false });
    this._stairs(b, [cx + W / 2 - 1.6, 0.19, cz - D / 2 + 1.2], 0, cwY - 0.19, 16, Math.PI / 2);
    // Kit stored on the catwalk.
    for (let i = 0; i < 4; i++) {
      P.crate(b, rng, { x: cx + W / 2 - 1.6 + R(rng, -0.5, 0.5), y: cwY + 0.06, z: cz + R(rng, -12, 12), scale: 0.7, ground: false });
    }
    this._cover(cx + W / 2 - 1.6, cz - 6);
    this._cover(cx + W / 2 - 1.6, cz + 6);

    // Mezzanine office in the far corner.
    {
      const ox = cx - W / 2 + 4.5, oz = cz - D / 2 + 4.0, ow = 8.0, od = 7.0, oy = 3.1;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        b.box(0.16, oy, 0.16, [ox + sx * (ow / 2 - 0.1), oy / 2, oz + sz * (od / 2 - 0.1)], 'painted_steel_blue', { chamfer: 0.02 });
      }
      b.box(ow, 0.18, od, [ox, oy + 0.09, oz], 'metal_grate', { chamfer: 0.02 });
      b.box(ow + 0.1, 0.22, 0.14, [ox, oy + 0.2, oz + od / 2], 'painted_steel_yellow', { chamfer: 0.02, collide: false });
      // Office box on top.
      b.box(ow - 0.4, 2.5, od - 0.4, [ox, oy + 1.43, oz], 'sheet_metal_bare', { chamfer: 0.03 });
      b.box(ow - 0.2, 0.14, od - 0.2, [ox, oy + 2.75, oz], 'metal_rusted', { chamfer: 0.03, collide: false });
      P.windowUnit(b, rng, {
        x: ox, y: oy + 1.75, z: oz + od / 2 - 0.2, rotY: 0, w: 3.4, h: 1.1, thick: 0.16,
        inset: 0.06, broken: 0.25, interior: true, sill: false, cols: 3, rows: 1, revealMat: 'sheet_metal_bare',
      });
      P.doorUnit(b, rng, {
        x: ox + 2.9, y: oy + 0.18, z: oz + od / 2 - 0.2, rotY: 0, w: 0.95, h: 2.05,
        thick: 0.16, leaves: 1, open: 0.6, interior: false,
      });
      for (let i = 0; i < 3; i++) {
        b.box(0.04, 0.5, 0.5, [ox - ow / 2 + 0.2, oy + 1.8, oz - 2 + i * 2], 'lamp_glow_dim', { chamfer: 0.01, collide: false });
      }
      this._stairs(b, [ox + ow / 2 + 0.9, 0.19, oz - 2.6], 0, oy - 0.1, 12, 0);
      const ol = new THREE.PointLight(0xffe0b0, 5, 9, 2);
      ol.position.set(ox, oy + 2.0, oz);
      b.addLight(ol);
      this._cover(ox, oz + od / 2);
      // Underneath: stores.
      P.cabinet(b, rng, { x: ox - 2.4, y: 0.19, z: oz - 2.4, rotY: Math.PI, bays: 3 });
      P.workbench(b, rng, { x: ox + 1.6, y: 0.19, z: oz - 2.6, rotY: Math.PI });
      P.gasBottleRack(b, rng, { x: ox - 3.0, y: 0.19, z: oz + 1.6, rotY: 0.3, bays: 2 });
      P.palletStack(b, rng, { x: ox + 2.6, y: 0.19, z: oz + 1.8, rotY: 0.2, count: 5 });
    }

    // ---- racking: two double runs down the middle plus one against the wall
    const rackZ = cz - 2;
    P.racking(b, rng, { x: cx - 4.4, y: 0.19, z: rackZ, rotY: 0, bays: 6, bayLen: 2.7, depth: 2.3, height: 6.4, fill: 0.6 });
    P.racking(b, rng, { x: cx + 2.8, y: 0.19, z: rackZ, rotY: 0, bays: 6, bayLen: 2.7, depth: 2.3, height: 6.4, fill: 0.55 });
    P.racking(b, rng, {
      x: cx, y: 0.19, z: cz - D / 2 + 1.2, rotY: Math.PI / 2 * 0, bays: 5, bayLen: 2.6,
      depth: 1.0, height: 4.6, levels: [0.15, 1.7, 3.3], fill: 0.6,
    });

    // Floor storage in the open bay by the shutter.
    for (let i = 0; i < 6; i++) {
      P.loadedPallet(b, rng, { x: cx + R(rng, -9, 9), y: 0.19, z: cz + R(rng, 8, 13), rotY: rng() * TAU });
    }
    for (let i = 0; i < 5; i++) P.palletStack(b, rng, { x: cx + R(rng, -9, 9), y: 0.19, z: cz + R(rng, 6, 13), count: 3 + ((rng() * 5) | 0) });
    for (let i = 0; i < 10; i++) {
      P.barrel(b, rng, { x: cx + R(rng, -10, 10), y: 0.19, z: cz + R(rng, -13, 13), tipped: rng() < 0.15 });
    }
    P.cableDrum(b, rng, { x: cx - 9, y: 0.19, z: cz + 11, rotY: 0.4, radius: 1.0, width: 0.85 });
    P.stackedMaterial(b, rng, { x: cx + 9.2, y: 0.19, z: cz - 10, rotY: Math.PI / 2, len: 5.5, kind: 1 });
    P.dumpster(b, rng, { x: cx - 9.6, y: 0.19, z: cz + 3, rotY: Math.PI / 2, len: 2.6, mat: 'sheet_metal_bare' });
    this._cover(cx, cz + 10);
    this._cover(cx - 9, cz);
    this._cover(cx + 9, cz);

    // Services under the roof: cable tray, ducting, sprinkler main.
    P.ducting(b, rng, { x: cx, y: H - 1.5, z: cz - 8, rotY: 0, len: 22, w: 0.7, h: 0.55, hangTo: 1.0 });
    P.cableRun(b, rng, { x: cx, y: H - 1.2, z: cz + 6, rotY: 0, len: 20, spans: 5, cables: 5, sag: 0.22 });
    P.pipeRun(b, rng, { x: cx, y: H - 1.9, z: cz + 10.5, rotY: 0, len: 20, lines: 2, spacing: 0.5, baseRadius: 0.07 });

    // Hanging industrial lamps with visible emissive sources.
    // Ten fittings are visible, four of them are lights. Point lights are the
    // most expensive thing in a forward renderer; the emissive lenses carry the
    // "the source is visible" read on their own.
    for (let i = 0; i < 5; i++) {
      const z = cz - D / 2 + 3.5 + i * 6;
      for (const s of [-1, 1]) {
        const lx = cx + s * 5.6;
        const lp = P.hangingLamp(b, rng, { x: lx, y: H - 0.35, z, drop: 1.5, radius: 0.46 });
        if (i % 2 !== 1) continue;
        const l = new THREE.PointLight(0xfff0d0, 17, 23, 2);
        l.position.set(lp[0], lp[1] - 0.1, lp[2]);
        b.addLight(l);
      }
    }
    for (const s of [-1, 1]) {
      P.floodlight(b, rng, { x: cx + s * 3.6, y: 5.4, z: cz + D / 2 - 0.2, rotY: Math.PI, heads: 1, size: 0.8 });
    }
  }

  // ------------------------------------------------------ container yard ---
  _containerYard(b, rng) {
    const CH = 2.591;
    const mats = ['painted_steel_blue', 'metal_rusted', 'paint_red', 'paint_green', 'metal_rusted', 'sheet_metal_bare'];
    let ci = 3;
    const place = (x, y, z, rotY, o = {}) => {
      const m = mats[(ci++) % mats.length];
      isoAt(x, y, z, rotY, m, o);
    };
    const isoAt = (x, y, z, rotY, m, o) => {
      P.isoContainer(b, rng, {
        x, y, z, rotY, mat: m,
        damaged: o.damaged ?? (rng() < 0.22),
        doorsOpen: o.doorsOpen ?? (rng() < 0.18),
        roofClutter: y < 0.1 ? false : rng() < 0.5,
        len: o.len ?? 6.058,
      });
      this._cover(x, z);
    };

    // Two stacked rows forming a corridor — the classic container-alley fight.
    for (let i = 0; i < 5; i++) {
      const z = -14 + i * 6.4;
      place(-38, 0, z, R(rng, -0.02, 0.02));
      place(-38, CH, z + R(rng, -0.25, 0.25), R(rng, -0.03, 0.03));
      if (rng() < 0.35) place(-38, CH * 2, z, R(rng, -0.04, 0.04));
      place(-26, 0, z + 3.0, R(rng, -0.02, 0.02));
      if (rng() < 0.55) place(-26, CH, z + 3.0, R(rng, -0.03, 0.03));
    }
    // A couple knocked askew, and one on its side — irregularity reads as real.
    place(-31.5, 0, 14.5, 0.42, { damaged: true, doorsOpen: true });
    place(-33.5, 0, -22, -0.3);
    place(-44.5, 0, -6, 0.08, { doorsOpen: true });
    // The one on its side: rotate about Z so the doors face up-slope.
    P.isoContainer(b, rng, {
      x: -21.5, y: 0, z: -19, rotY: 0.15, mat: 'metal_rusted', damaged: true,
    });
    P.isoContainer(b, rng, { x: -21.6, y: 2.6, z: -19.2, rotY: 0.42, mat: 'paint_red', roofClutter: true });

    // Gantry crane across the yard, now with a real trolley and festoon cable.
    for (const x of [-46, -19]) {
      for (const z of [-17, 11]) {
        b.box(0.62, 11, 0.62, [x, 5.5, z], 'painted_steel_yellow', { chamfer: 0.05 });
        b.box(1.3, 0.5, 1.3, [x, 0.25, z], 'concrete_stained', { chamfer: 0.04 });
        // Lattice web between the two legs of each portal.
        for (const ly of [3.6, 7.6]) {
          b.box(0.16, 0.16, 28, [x, ly, -3], 'painted_steel_yellow', { chamfer: 0.02, collide: false });
        }
        P.contactDress(b, rng, { x, z, y: 0.12, w: 1.7, d: 1.7, amount: 1.1, frags: 6 });
      }
      b.box(0.9, 1.0, 28, [x, 11.3, -3], 'painted_steel_yellow', { chamfer: 0.05 });
      b.box(1.1, 0.1, 28, [x, 11.85, -3], 'painted_steel_yellow', { chamfer: 0.01, collide: false });
    }
    b.box(27, 0.9, 1.4, [-32.5, 11.3, -3], 'painted_steel_yellow', { chamfer: 0.05 });
    b.box(27, 0.12, 1.7, [-32.5, 11.83, -3], 'painted_steel_yellow', { chamfer: 0.01, collide: false });
    for (let i = 0; i < 5; i++) {
      b.box(0.14, 1.1, 1.5, [-44 + i * 6.4, 11.3, -3], 'painted_steel_yellow', { chamfer: 0.02, collide: false });
    }
    // Trolley + hook block hanging over the yard.
    b.box(2.2, 0.9, 2.0, [-30, 10.6, -3], 'paint_red', { chamfer: 0.04, collide: false });
    b.box(2.6, 0.2, 2.4, [-30, 10.05, -3], 'metal_rusted', { chamfer: 0.03, collide: false });
    for (const s of [-1, 1]) {
      b.add(cpipe(b, 0.018, 5.5, 5, 'metal_rusted'), 'metal_rusted', { pos: [-30 + s * 0.45, 7.3, -3], collide: false });
    }
    b.box(0.7, 0.6, 0.5, [-30, 4.3, -3], 'metal_rusted', { chamfer: 0.05, collide: false });
    b.add(P.torus(0.28, 0.055, 4, 10), 'metal_rusted', { pos: [-30, 3.8, -3], rot: [0, 0, Math.PI], collide: false });
    // Festoon cable along the gantry beam.
    P.cableRun(b, rng, { x: -32.5, y: 11.7, z: -1.2, rotY: 0, len: 25, spans: 9, cables: 3, sag: 0.35 });

    // Ground: crane rails and heavy staining.
    for (const x of [-46, -19]) {
      b.box(0.4, 0.16, 30, [x, 0.16, -3], 'metal_rusted', { chamfer: 0.02, collide: false });
      b.box(0.8, 0.1, 30, [x, 0.14, -3], 'concrete_stained', { chamfer: 0.02, collide: false });
    }
  }

  // ------------------------------------------------------ container alley --
  /**
   * The corridor between the two container rows. It was empty; a working
   * compound fills a space like this with everything it has nowhere else to put.
   */
  _containerAlley(b, rng) {
    const AX = -32;   // alley centreline

    // Services strung and clipped along the container faces.
    P.pipeRun(b, rng, { x: AX - 3.6, y: 2.3, z: -3, rotY: Math.PI / 2, len: 34, lines: 3, spacing: 0.4, baseRadius: 0.085 });
    P.conduitRun(b, rng, { x: AX + 3.6, y: 2.05, z: -3, rotY: -Math.PI / 2, len: 30, count: 3, standoff: 0.09 });
    P.cableRun(b, rng, { x: AX, y: 4.6, z: -3, rotY: Math.PI / 2, len: 32, spans: 7, cables: 4, sag: 0.5 });
    // Light strings over the alley.
    for (let i = 0; i < 7; i++) {
      const z = -16 + i * 5.2;
      b.box(0.22, 0.16, 0.22, [AX, 4.3, z], 'sheet_metal_bare', { chamfer: 0.02, collide: false });
      b.add(cpipe(b, 0.1, 0.16, 10, 'lamp_glow'), 'lamp_glow', { pos: [AX, 4.18, z], collide: false });
      if (i % 3 !== 1) continue;
      const l = new THREE.PointLight(0xffcf9a, 9, 14, 2);
      l.position.set(AX, 4.1, z);
      b.addLight(l);
    }

    // Ground clutter down the length of it.
    const spots = [
      -17, -14.4, -11.2, -8.6, -5.5, -2.4, 0.6, 3.4, 6.2, 9.0, 11.8, 14.6, 17.2,
    ];
    for (let i = 0; i < spots.length; i++) {
      const z = spots[i] + R(rng, -0.7, 0.7);
      const side = i % 2 ? 1 : -1;
      const x = AX + side * R(rng, 1.4, 2.6);
      const k = rng();
      if (k < 0.16) P.palletStack(b, rng, { x, y: 0.12, z, count: 3 + ((rng() * 5) | 0) });
      else if (k < 0.32) P.barrel(b, rng, { x, y: 0.12, z, tipped: rng() < 0.25 });
      else if (k < 0.44) P.crate(b, rng, { x, y: 0.12, z, scale: R(rng, 0.8, 1.25) });
      else if (k < 0.54) P.gasBottleRack(b, rng, { x, y: 0.12, z, rotY: side * Math.PI / 2 + R(rng, -0.2, 0.2), bays: 1 });
      else if (k < 0.64) P.cableDrum(b, rng, { x, y: 0.12, z, rotY: R(rng, 0, Math.PI), radius: R(rng, 0.6, 1.0), width: R(rng, 0.5, 0.8), onSide: rng() < 0.3 });
      else if (k < 0.74) P.stackedMaterial(b, rng, { x, y: 0.12, z, rotY: Math.PI / 2 + R(rng, -0.1, 0.1), len: R(rng, 3, 5), kind: (rng() * 3) | 0 });
      else if (k < 0.82) P.tarpCover(b, rng, { x, y: 0.12, z, rotY: rng() * TAU, w: R(rng, 1.8, 2.8), d: R(rng, 1.4, 2.0), h: R(rng, 0.8, 1.3) });
      else if (k < 0.9) P.dumpster(b, rng, { x, y: 0.12, z, rotY: side * Math.PI / 2 + R(rng, -0.15, 0.15), len: R(rng, 2.2, 3.0), mat: rng() < 0.5 ? 'paint_green' : 'paint_red' });
      else P.loadedPallet(b, rng, { x, y: 0.12, z, rotY: rng() * TAU });
      this._cover(x, z);
    }
    // Two ladders leaning against the stacks — verticality and a reason to look up.
    P.ladder(b, rng, { x: AX - 2.6, y: 0.12, z: -6.5, rotY: -Math.PI / 2, height: 5.2, lean: 0.14 });
    P.ladder(b, rng, { x: AX + 2.6, y: 0.12, z: 8.5, rotY: Math.PI / 2, height: 5.4, lean: 0.12 });
    // A generator humming away halfway down.
    P.generator(b, rng, { x: AX - 0.4, y: 0.12, z: 1.5, rotY: Math.PI / 2 + 0.08, scale: 0.85 });
    P.brazier(b, rng, { x: AX + 1.6, z: -12.5 });
    P.workbench(b, rng, { x: AX - 2.0, y: 0.12, z: 13.5, rotY: -Math.PI / 2 });

    // Wet, filthy floor.
    for (const [z, r] of [[-15, 1.7], [-9.5, 1.2], [-1.5, 2.0], [5.5, 1.4], [12, 1.8]]) {
      P.puddle(b, rng, { x: AX + R(rng, -1.2, 1.2), z, r });
    }
    P.litterScatter(b, rng, { x: AX, y: 0.13, z: -3, r: 11, count: 34 });
    for (let i = 0; i < 20; i++) {
      b.add(cbox(b, R(rng, 0.6, 2.4), 0.014, R(rng, 0.5, 1.6), 'dirt_dark', 0.1), 'dirt_dark',
        { pos: [AX + R(rng, -3, 3), 0.126, R(rng, -19, 19)], rotY: rng() * TAU, collide: false });
    }
    // Grit wedge along the base of both container rows.
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 16; i++) {
        b.add(cbox(b, R(rng, 1.4, 3.0), R(rng, 0.03, 0.09), R(rng, 0.2, 0.45), 'dust', 0.04), 'dust', {
          pos: [AX + sx * (3.2 + R(rng, -0.25, 0.25)), 0.135, -19 + i * 2.4],
          rotY: R(rng, -0.1, 0.1) + Math.PI / 2, collide: false,
        });
      }
    }
  }

  // ----------------------------------------------------------- courtyard ---
  _courtyard(b, rng) {
    // Sandbag emplacements.
    for (const [x, z, r, len, rows] of [
      [-6, 6, 0.1, 5.5, 4], [8, 2, -1.45, 4.2, 3], [-14, -6, 0.9, 4.0, 4],
      [14, -10, 2.1, 5.0, 3], [2, -14, 0.05, 6.5, 4], [-20, 16, -0.4, 4.4, 3],
      [20, 16, 0.6, 4.0, 4],
    ]) {
      P.sandbagEmplacement(b, rng, { x, z, rotY: r, len, rows, depth: 2 });
      this._cover(x, z);
    }

    // Jersey barriers — every one a different variant, yaw and tilt.
    const barrierSpots = [
      [-2, 20], [2.9, 20.4], [7.6, 19.7], [-6.9, 20.3], [-11.4, 19.9],
      [18, 8], [18.3, 11.1], [-18, 14], [-15.2, 15.1], [22, -14], [-24, -14],
      [-9.5, 27], [-4.6, 27.4], [0.4, 26.8], [26, 2], [26.2, 5.2], [-28, 6], [-28.3, 9.1],
    ];
    for (const [x, z] of barrierSpots) {
      const r = R(rng, -0.28, 0.28) + (Math.abs(x) > 17 ? Math.PI / 2 : 0);
      P.jerseyBarrier(b, rng, { x: x + R(rng, -0.3, 0.3), z: z + R(rng, -0.3, 0.3), rotY: r, variant: (rng() * 4) | 0 });
      this._cover(x, z);
    }

    // Crate clusters — real variants, real stacking, occasional collapse.
    for (let i = 0; i < 20; i++) {
      const x = R(rng, -26, 26), z = R(rng, -20, 34);
      if (Math.hypot(x, z - 5) < 6) continue;
      if (x > 18 && z > -12 && z < 20) continue;      // keep out of the warehouse apron
      const s = R(rng, 0.8, 1.35);
      const base = P.crate(b, rng, { x, z, scale: s, variant: (rng() * 4) | 0 });
      this._cover(x, z);
      if (rng() < 0.5) {
        P.crate(b, rng, {
          x: x + R(rng, -0.35, 0.35), y: 0.1 + base.h, z: z + R(rng, -0.35, 0.35),
          scale: s * R(rng, 0.72, 0.95), variant: (rng() * 4) | 0, ground: false,
        });
      }
      if (rng() < 0.22) {
        // One that has been knocked over and spilled.
        P.crate(b, rng, { x: x + R(rng, 1.0, 1.8), z: z + R(rng, -1.0, 1.0), scale: s * 0.85, variant: 2 });
        P.litterScatter(b, rng, { x, z, r: 2.2, count: 10 });
      }
    }

    // Drums, singly and in groups on pallets.
    for (let i = 0; i < 26; i++) {
      const x = R(rng, -36, 36), z = R(rng, -26, 38);
      if (Math.hypot(x, z - 5) < 4) continue;
      if (x > 19 && z > -12 && z < 20) continue;
      P.barrel(b, rng, { x, z, tipped: rng() < 0.2, variant: (rng() * 4) | 0 });
    }
    for (const [x, z] of [[-10, 24], [13, -19], [-22, 26], [17, 30]]) {
      P.loadedPallet(b, rng, { x, z, rotY: rng() * TAU, kind: 1 });
      this._cover(x, z);
    }
    for (const [x, z] of [[-16, 30], [6, -24], [24, 34]]) P.palletStack(b, rng, { x, z });

    // Tarped stockpiles and stacked material give the middle distance mass.
    P.tarpCover(b, rng, { x: -13, z: 20, rotY: 0.3, w: 4.0, d: 2.6, h: 1.5 });
    P.tarpCover(b, rng, { x: 15, z: -22, rotY: -0.6, w: 3.2, d: 2.4, h: 1.3 });
    P.stackedMaterial(b, rng, { x: -25, z: -2, rotY: 0.4, len: 5.0, kind: 0 });
    P.stackedMaterial(b, rng, { x: 22, z: 28, rotY: -0.25, len: 4.6, kind: 2 });
    this._cover(-13, 20); this._cover(15, -22); this._cover(-25, -2);

    // A burnt-out truck hulk as a landmark and hard cover.
    this._wreck(b, [-9, 0.1, -6], -0.6, rng);
    this._wreck(b, [21, 0.1, -20], 2.3, rng);

    // Traffic management and a bit of human presence.
    for (const [x, z, k] of [[-3.5, 12, false], [-2.6, 12.9, true], [11, 4, false], [10.2, 22, false], [-19, 3, true]]) {
      P.trafficCone(b, rng, { x, z, knocked: k });
    }
    P.brazier(b, rng, { x: -7.5, z: 8.5 });
    P.signage(b, rng, { x: -12.5, z: 12.5, rotY: 0.4, w: 1.2, h: 0.9, height: 1.9, mat: 'warning_stripe' });
    P.signage(b, rng, { x: 14, z: 12, rotY: -0.9, w: 1.5, h: 1.0, height: 2.2, mat: 'sheet_metal_bare' });
  }

  _wreck(b, pos, rotY, rng) {
    const [x, y, z] = pos;
    const f = P.frame(x, y, z, rotY);
    const put = (w, h, d, lx, ly, lz, mat, ch, col = true) =>
      b.add(cbox(b, w, h, d, mat, ch), mat, { pos: f.p(lx, ly, lz), rotY, collide: col, surface: 'metal' });

    // Chassis rails + cross members.
    for (const sz of [-1, 1]) put(5.6, 0.22, 0.16, 0, 0.55, sz * 0.6, 'metal_rusted', 0.03);
    for (let i = 0; i < 5; i++) put(0.14, 0.16, 1.2, -2.2 + i * 1.1, 0.55, 0, 'metal_rusted', 0.02, false);
    // Cab: firewall, roof, pillars, blown-out glazing, buckled bonnet.
    put(1.9, 1.5, 2.0, 1.9, 1.5, 0, 'metal_rusted', 0.09);
    put(2.0, 0.12, 2.1, 1.9, 2.3, 0, 'metal_rusted', 0.04, false);
    for (const sz of [-1, 1]) for (const lx of [1.05, 2.75]) {
      put(0.1, 1.6, 0.1, lx, 1.5, sz * 0.95, 'metal_rusted', 0.015, false);
    }
    put(1.7, 1.0, 1.9, 1.9, 1.55, 0, 'rubber', 0.05, false);
    put(1.5, 0.5, 1.9, 3.0, 1.05, 0, 'metal_rusted', 0.06, false);
    // Bed with dropped sides and a torn floor.
    put(3.2, 0.16, 2.1, -1.2, 0.78, 0, 'metal_rusted', 0.03);
    for (const sz of [-1, 1]) put(3.2, 0.7, 0.08, -1.2, 1.1, sz * 1.02, 'metal_rusted', 0.02, false);
    put(0.08, 0.7, 2.1, -2.75, 1.1, 0, 'metal_rusted', 0.02, false);
    for (let i = 0; i < 4; i++) {
      put(0.7, 0.5, 0.06, -2.2 + i * 0.9, 1.4, 1.06, 'metal_rusted', 0.02, false);
    }
    // Wheels — two burnt off, which is why it reads as a wreck.
    for (const [ax, az] of [[2.0, 1.05], [2.0, -1.05], [-1.7, 1.05]]) {
      b.add(P.torus(0.42, 0.17, 4, 10), 'rubber',
        { pos: f.p(ax, 0.44, az), rot: [0, rotY, Math.PI / 2], collide: true });
      b.add(cpipe(b, 0.2, 0.24, 12, 'metal_rusted'), 'metal_rusted',
        { pos: f.p(ax, 0.44, az), rot: [0, rotY, Math.PI / 2], collide: false });
    }
    for (const [ax, az] of [[-1.7, -1.05]]) {
      b.add(cpipe(b, 0.09, 0.5, 8, 'metal_rusted'), 'metal_rusted', { pos: f.p(ax, 0.5, az), rot: [0, rotY, Math.PI / 2], collide: false });
      // Burnt tyre carcass on the ground beside it.
      b.add(P.torus(0.4, 0.09, 4, 10), 'rubber', { pos: f.p(ax - 0.6, 0.1, az - 0.7), rot: [0.1, rotY, 0], collide: false });
    }
    // Bumper, exhaust stack, mirror arms, and the scorch mark under it all.
    put(0.35, 0.5, 1.9, -2.9, 1.0, 0, 'metal_rusted', 0.04, false);
    b.add(cpipe(b, 0.07, 2.1, 8, 'metal_rusted'), 'metal_rusted', { pos: f.p(0.95, 1.7, -1.0), collide: false });
    for (const sz of [-1, 1]) {
      b.add(cpipe(b, 0.025, 0.7, 6, 'metal_rusted'), 'metal_rusted', { pos: f.p(2.8, 1.9, sz * 1.2), rot: [0, rotY, 0.3], collide: false });
    }
    b.add(cbox(b, 6.5, 0.016, 3.0, 'dirt_dark', 0.2), 'dirt_dark', { pos: f.p(0, 0.008, 0), rotY, collide: false });
    P.contactDress(b, rng, { x, z, y, w: 6.2, d: 2.8, rotY, amount: 1.3, frags: 10, fragSpread: 2.2 });
    P.litterScatter(b, rng, { x, z, r: 4.5, count: 22 });
    P.rubblePile(b, rng, { x: x + Math.cos(rotY + 1.6) * 3.4, z: z + Math.sin(rotY + 1.6) * 3.4, radius: 1.3, height: 0.4, count: 12, rebar: 3 });
    this._cover(x, z);
  }

  /**
   * A ring of blocked-out buildings well outside the playable area.
   *
   * Without this the ground plane meets the sky at a hard line and the world
   * reads as unfinished. These never need detail — at 200-400 m through aerial
   * perspective they are silhouettes, and silhouettes are all the eye wants.
   */
  _distantSkyline(b, rng) {
    // The playable ground slab is only 130 m across, so without a surrounding
    // plane the outer rings sit over empty sky and read as floating boxes.
    // One large, non-colliding, non-shadow-casting quad fixes it for one draw.
    b.box(900, 0.6, 900, [0, -0.34, 0], 'asphalt_road',
      { chamfer: 0, collide: false, tileOverride: 26 });

    const rings = [
      // Fewer, larger blocks: each one lands in its own 22 m chunk 200-350 m
      // out, so every extra block was a draw call and a shadow draw for a shape
      // that is a few pixels of silhouette.
      { r: 180, count: 13, hMin: 12, hMax: 36, wMin: 30, wMax: 52 },
      { r: 265, count: 13, hMin: 18, hMax: 60, wMin: 38, wMax: 68 },
      { r: 350, count: 11, hMin: 26, hMax: 84, wMin: 46, wMax: 82 },
    ];
    for (const ring of rings) {
      for (let i = 0; i < ring.count; i++) {
        const a = (i / ring.count) * Math.PI * 2 + R(rng, -0.06, 0.06);
        const rr = ring.r * R(rng, 0.88, 1.16);
        const h = R(rng, ring.hMin, ring.hMax);
        const w = R(rng, ring.wMin, ring.wMax);
        const d = R(rng, ring.wMin, ring.wMax);
        const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
        // One rotation shared by the whole building. Giving the setback its own
        // random yaw let it overhang the base into empty air, which at this
        // distance reads as a slab floating in the sky.
        const rotY = R(rng, 0, Math.PI);
        const mat = rng() < 0.5 ? 'concrete_wall' : 'plaster_damaged';
        // Sink the base well below grade so no gap can open at the horizon.
        b.box(w, h + 8, d, [bx, (h + 8) / 2 - 8, bz], mat,
          { chamfer: 0.4, rotY, collide: false });
        if (rng() < 0.45) {
          // Strictly inset, same yaw, and overlapping the base by a metre so
          // there is never a visible seam.
          const w2 = w * R(rng, 0.42, 0.66), d2 = d * R(rng, 0.42, 0.66);
          const h2 = R(rng, 5, 17);
          b.box(w2, h2 + 1.0, d2, [bx, h - 2 + h2 / 2 - 0.5, bz],
            mat, { chamfer: 0.3, rotY, collide: false });
          // A roofline plant room, which is what actually breaks a flat roof.
          if (rng() < 0.5) {
            b.box(w2 * 0.4, R(rng, 2.5, 5), d2 * 0.4,
              [bx, h - 2 + h2 + 1.5, bz], 'concrete_stained',
              { chamfer: 0.2, rotY, collide: false });
          }
        }
      }
    }
  }

  // ---------------------------------------------------- street furniture ---
  _streetFurniture(b, rng) {
    let lit = 0;
    // Light masts.
    for (const [x, z] of [[-20, 22], [20, 22], [-20, -18], [20, -18], [0, 0], [-40, 14], [40, 14], [-42, 34], [42, 34]]) {
      b.box(0.62, 0.36, 0.62, [x, 0.18, z], 'concrete_stained', { chamfer: 0.04 });
      b.box(0.5, 0.08, 0.5, [x, 0.38, z], 'sheet_metal_bare', { chamfer: 0.01, collide: false });
      for (const [bx, bz] of [[0.22, 0.22], [-0.22, 0.22], [0.22, -0.22], [-0.22, -0.22]]) {
        b.add(cpipe(b, 0.016, 0.08, 6, 'sheet_metal_bare'), 'sheet_metal_bare', { pos: [x + bx, 0.44, z + bz], collide: false });
      }
      b.add(cpipe(b, 0.12, 7.4, 12, 'painted_steel_blue'), 'painted_steel_blue', { pos: [x, 4.1, z] });
      // Cable access door + a coil of slack cable at the base.
      b.box(0.16, 0.4, 0.05, [x, 1.0, z + 0.1], 'sheet_metal_bare', { chamfer: 0.008, collide: false });
      b.add(cpipe(b, 0.08, 0.94, 8, 'painted_steel_blue'), 'painted_steel_blue',
        { pos: [x + 0.42, 7.72, z], rot: [0, 0, Math.PI / 2 - 0.32], collide: false });
      const fp = P.floodlight(b, rng, { x: x + 0.9, y: 7.5, z, rotY: Math.PI / 2, heads: 2, size: 1.0 });
      if (lit++ % 2 === 0) {
        const l = new THREE.PointLight(0xcfe0ff, 26, 30, 2);
        l.position.set(fp[0], fp[1], fp[2]);
        b.addLight(l);
      }
      P.contactDress(b, rng, { x, z, y: 0.1, w: 1.1, d: 1.1, amount: 0.8, frags: 4 });
    }

    // Pipe runs along the warehouse west wall — vertical detail on flat panels.
    P.pipeRun(b, rng, { x: 19.55, y: 2.4, z: 4, rotY: Math.PI / 2, len: 28, lines: 4, spacing: 1.05, baseRadius: 0.1, bracketEvery: 3.4 });
    P.conduitRun(b, rng, { x: 19.7, y: 1.3, z: 4, rotY: Math.PI / 2, len: 26, count: 3, standoff: 0.1 });
    P.pipeRun(b, rng, { x: 19.9, y: 0, z: -8.5, rotY: Math.PI / 2, len: 7.4, lines: 2, spacing: 0.5, baseRadius: 0.09, vertical: true });
    P.airCon(b, rng, { x: 19.7, y: 3.1, z: 12.5, rotY: -Math.PI / 2, scale: 1.05 });
    P.airCon(b, rng, { x: 19.7, y: 3.1, z: -3.5, rotY: -Math.PI / 2, scale: 0.9 });
    P.ladder(b, rng, { x: 19.75, y: 0.12, z: 16.5, rotY: -Math.PI / 2, height: 9.6, cage: true });
    // Stuff parked against that wall.
    for (let i = 0; i < 9; i++) {
      const z = -10 + i * 2.9;
      const k = rng();
      if (k < 0.3) P.barrel(b, rng, { x: 18.6 + R(rng, -0.3, 0.3), z, tipped: rng() < 0.2 });
      else if (k < 0.5) P.crate(b, rng, { x: 18.4 + R(rng, -0.3, 0.3), z, scale: R(rng, 0.8, 1.2) });
      else if (k < 0.68) P.palletStack(b, rng, { x: 18.5, z, count: 3 + ((rng() * 4) | 0) });
      else if (k < 0.82) P.gasBottleRack(b, rng, { x: 18.7, z, rotY: -Math.PI / 2 + R(rng, -0.15, 0.15), bays: 1 });
      else P.tarpCover(b, rng, { x: 18.3, z, rotY: R(rng, 0, TAU), w: 2.2, d: 1.7, h: 1.0 });
      this._cover(18.5, z);
    }
    P.litterScatter(b, rng, { x: 18.8, z: 4, r: 12, count: 20 });

    // Signage.
    P.signage(b, rng, { x: -5.5, z: 49.6, rotY: Math.PI, w: 1.8, h: 1.2, height: 2.3, mat: 'warning_stripe' });
    P.signage(b, rng, { x: 19.35, z: 12, rotY: -Math.PI / 2, w: 1.6, h: 1.1, height: 2.6, posts: false, wallMount: true, mat: 'warning_stripe' });
    P.signage(b, rng, { x: -19.6, z: -30, rotY: Math.PI / 2, w: 1.4, h: 1.0, height: 2.2, mat: 'sheet_metal_bare' });

    // Chainlink fence partitioning the yard, with proper posts and a top rail.
    for (let i = 0; i < 8; i++) {
      const x = -22 + i * 3.05;
      b.box(3.0, 2.4, 0.05, [x, 1.3, 30], 'chainlink', { chamfer: 0 });
      b.add(cpipe(b, 0.05, 2.9, 8, 'metal_rusted'), 'metal_rusted', { pos: [x + 1.52, 1.45, 30], collide: true });
      b.box(0.24, 0.14, 0.24, [x + 1.52, 0.17, 30], 'concrete_stained', { chamfer: 0.02, collide: false });
      b.add(cpipe(b, 0.03, 3.05, 6, 'metal_rusted'), 'metal_rusted', { pos: [x, 2.52, 30], rot: [0, 0, Math.PI / 2], collide: false });
      b.add(cpipe(b, 0.03, 3.05, 6, 'metal_rusted'), 'metal_rusted', { pos: [x, 0.16, 30], rot: [0, 0, Math.PI / 2], collide: false });
      // Sagging bottom edge and a torn section.
      if (i === 4) {
        b.box(1.4, 1.0, 0.04, [x, 0.7, 30.05], 'chainlink', { chamfer: 0, rot: [0, 0.5, 0.3], collide: false });
      }
      if (rng() < 0.4) {
        b.add(cbox(b, R(rng, 0.4, 1.2), R(rng, 0.3, 0.7), 0.02, 'tarp', 0.02), 'tarp',
          { pos: [x + R(rng, -1, 1), R(rng, 0.4, 1.6), 30.06], rot: [0, 0, R(rng, -0.4, 0.4)], collide: false });
      }
      P.contactDress(b, rng, { x, z: 30, y: 0.1, w: 3.0, d: 0.5, amount: 0.5, frags: 2 });
    }
  }

  _debris(b, rng) {
    // Rubble mounds — real chunks with thickness, not intersecting planes.
    for (const [x, z, r, h] of [
      [-9, -24, 2.6, 1.0], [4, -24.5, 2.2, 0.8], [-16.5, -23.5, 1.9, 0.7],
      [12.5, -24, 2.4, 0.95], [-2, -25, 1.6, 0.55],
      [-45, -30, 2.8, 1.1], [46, -34, 2.4, 0.9], [-46, 40, 2.2, 0.8], [45, 44, 2.6, 1.0],
      [30, -40, 2.0, 0.7], [-33, 36, 1.8, 0.6],
    ]) P.rubblePile(b, rng, { x, z, radius: r, height: h, count: Math.round(r * 14), rebar: Math.round(r * 3.5) });

    // Scattered chunks with real thickness across the whole compound.
    for (let i = 0; i < 70; i++) {
      const x = R(rng, -42, 42), z = R(rng, -42, 42);
      if (Math.hypot(x, z - 5) < 3) continue;
      const s = R(rng, 0.1, 0.45);
      const m = rng() < 0.7 ? 'rebar_concrete' : 'concrete_stained';
      b.add(cbox(b, s * R(rng, 0.8, 1.7), s * R(rng, 0.4, 0.85), s * R(rng, 0.7, 1.3), m, s * 0.18), m, {
        pos: [x, 0.12 + s * 0.22, z],
        rot: [R(rng, -0.45, 0.45), R(rng, 0, TAU), R(rng, -0.45, 0.45)],
        collide: false,
      });
    }
    // Broad litter passes so no patch of ground is completely clean.
    for (const [x, z, r, n] of [
      [0, 12, 18, 34], [-30, 20, 14, 20], [26, 30, 14, 20], [0, -18, 16, 24],
    ]) P.litterScatter(b, rng, { x, z, r, count: n });

    // Scattered loose pallets.
    for (let i = 0; i < 12; i++) {
      const x = R(rng, -34, 34), z = R(rng, -22, 38);
      if (x > 19 && z > -12 && z < 20) continue;
      P.pallet(b, rng, { x, z, rotY: rng() * TAU });
    }
  }

  /** Physical surface directly under a world position (for footsteps). */
  surfaceUnder(pos) {
    const s = this._scratch;
    if (!this.collider) return 'concrete';
    s.v.set(pos.x, pos.y + 0.6, pos.z);
    s.ray.set(s.v, s.d);
    s.ray.far = 2.0;
    const hits = s.ray.intersectObject(this.collider, false);
    if (!hits.length) return 'concrete';
    return surfaceAtHit(this.collider, hits[0].faceIndex);
  }

  update(dt, ctx) {
    // Level geometry is static; footstep surface tracking lives here so the
    // player controller doesn't need to know about the collider layout.
    if (ctx.player && ctx.player.grounded) {
      this._surfTimer = (this._surfTimer ?? 0) - dt;
      if (this._surfTimer <= 0) {
        this._surfTimer = 0.12;
        ctx.player.surface = this.surfaceUnder(ctx.player.position);
      }
    }
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
