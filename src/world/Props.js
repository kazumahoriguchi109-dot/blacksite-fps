import * as THREE from 'three';
import { chamferedBox, pipe } from './Builder.js';

/*
 * Set dressing — reusable, parameterised prop builders.
 *
 * Everything here writes into a `Builder`, so props are merged by material and
 * cost essentially nothing in draw calls. Rules the whole module follows:
 *
 *  - No hard 90-degree edges. Every box is chamfered. A 2 mm chamfer on a
 *    0.1 m section and a 30 mm chamfer on a container corner post are both
 *    "the arris is broken"; a perfectly sharp edge is the loudest CG tell
 *    there is, because nothing manufactured stays sharp.
 *  - Nothing is symmetrical or evenly spaced unless a machine made it that
 *    way. Bags sag, barriers get knocked askew, crates get stacked badly.
 *  - Nothing sits *on* the ground — everything sits *in* it. Every prop that
 *    touches the floor gets a dust wedge and a few fragments at the junction
 *    (`contactDress`), because that transition is what actually reads as
 *    "this object has been here a while".
 *  - Real dimensions: ISO container 6.058 x 2.438 x 2.591 m, 200 L drum
 *    0.585 x 0.880 m, EUR pallet 1.200 x 0.800 x 0.144 m, gas cylinder
 *    0.229 x 1.37 m, jersey barrier 3.0 x 0.81 x 0.61 m.
 *
 * Materials are referenced by name; names that are not in the catalogue are
 * resolved by Level.js's alias table (tinted variants of catalogue entries,
 * which cost nothing because they share the underlying texture upload).
 */

const TAU = Math.PI * 2;
const R = (rng, a, b) => a + rng() * (b - a);
const pick = (rng, arr) => arr[(rng() * arr.length) | 0];

// ---------------------------------------------------------------- frames --

/**
 * A local coordinate frame: origin + yaw. Prop bodies are authored in local
 * metres (x across, y up, z out/forward) and placed through this, which is the
 * only sane way to write a prop that has thirty parts and can face any way.
 */
export function frame(x, y, z, rotY = 0) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return {
    x, y, z, rotY, c, s,
    /** local -> world position */
    p(lx, ly, lz) { return [x + lx * c + lz * s, y + ly, z - lx * s + lz * c]; },
    /** local direction -> world direction */
    d(lx, lz) { return [lx * c + lz * s, -lx * s + lz * c]; },
  };
}

/*
 * Geometry cache.
 *
 * Building a chamfered box means ~2400 array pushes and three typed-array
 * conversions; cloning one is a typed-array copy. A compound this dense makes
 * tens of thousands of boxes, most of them repeats of a handful of shapes
 * (container ribs, wall panels, pallet blocks, sandbags), so dimensions are
 * snapped to a tolerance the eye cannot see and the geometry is reused. This
 * is most of the level's build time.
 */
const _geomCache = new Map();
const CACHE_LIMIT = 3000;
/** Snap to a tolerance proportional to size: 2 mm small, 50 mm large. */
const q = (v) => {
  const a = Math.abs(v);
  const s = a < 0.5 ? 500 : (a < 3 ? 100 : 20);
  return Math.round(v * s) / s;
};

/**
 * A slumped sandbag, as a single surface with one continuous UV projection.
 *
 * These were chamfered boxes: 0.5 x 0.185 x 0.3 with a 0.072 chamfer, which
 * leaves a 41 mm sliver of flat front face wrapped in twelve chamfer strips —
 * and `chamferedBox` projects each strip from a different axis pair (x/y, z/y,
 * x/z). The sandbag material is authored so one texture tile IS one bag, with a
 * slumped crown, a sewn hem and gathered ends, so three disagreeing projections
 * of that pattern turned a wall into khaki shards. It had to be flattened to
 * almost nothing to be usable, which is why the emplacement read as stacked
 * plates rather than bags.
 *
 * This builds a superellipsoid instead — genuinely bag-shaped, with a sag on
 * top and a flattened base where it rests — and projects UVs planar from the
 * front so the authored pattern lands the same way on every facet. Sides
 * stretch, but in a stacked wall the sides are barely seen.
 */
function sandbagGeometry(w, h, d, tile, segU = 9, segV = 6) {
  const g = new THREE.SphereGeometry(0.5, segU, segV);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const [tu, tv] = Array.isArray(tile) ? tile : [tile, tile];
  const EXP = 0.62;                       // < 1 rounds toward a box
  const soft = (t) => Math.sign(t) * Math.pow(Math.abs(t), EXP);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    let nx = soft(x / len), ny = soft(y / len), nz = soft(z / len);
    // A filled bag bulges at its waist and slumps on top.
    const waist = 1 + 0.16 * (1 - Math.abs(ny));
    let px = nx * (w / 2) * waist;
    let pz = nz * (d / 2) * waist;
    let py = ny * (h / 2);
    if (ny > 0) py *= 0.86;                               // sag
    if (ny < -0.55) py = Math.max(py, -h / 2 * 0.94);     // flattened base
    pos.setXYZ(i, px, py, pz);
    // Planar front projection, in the same world units the material expects.
    uv.setXY(i, (px + w / 2) / tu, (py + h / 2) / tv);
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Cached sandbag geometry at the material's own texel density. */
function sandbag(b, w, h, d) {
  const t = b._tile('sandbag');
  const key = `sb${q(w)}|${q(h)}|${q(d)}|${t}`;
  const hit = _geomCache.get(key);
  if (hit) return hit.clone();
  const g = sandbagGeometry(q(w), q(h), q(d), t);
  if (_geomCache.size < CACHE_LIMIT) { _geomCache.set(key, g); return g.clone(); }
  return g;
}

/** chamferedBox at the material's own texel density, cached. */
function cbox(b, w, h, d, mat, chamfer = 0.015) {
  const t = b._tile(mat);
  const qw = q(w), qh = q(h), qd = q(d);
  const key = `b${qw}|${qh}|${qd}|${chamfer}|${t}`;
  const hit = _geomCache.get(key);
  if (hit) return hit.clone();
  const g = chamferedBox(qw, qh, qd, chamfer, t);
  if (_geomCache.size < CACHE_LIMIT) { _geomCache.set(key, g); return g.clone(); }
  return g;
}

/** Cylinder at the material's own texel density, cached. */
function cpipe(b, radius, len, segments, mat, capped = true) {
  const t = b._tile(mat);
  const qr = q(radius), ql = q(len);
  const key = `p${qr}|${ql}|${segments}|${capped}|${t}`;
  const hit = _geomCache.get(key);
  if (hit) return hit.clone();
  const g = pipe(qr, ql, segments, t, capped);
  if (_geomCache.size < CACHE_LIMIT) { _geomCache.set(key, g); return g.clone(); }
  return g;
}

/** Torus at a fixed low tessellation — these are always small on screen. */
function ctorus(radius, tube, rad = 4, tub = 10, arc = TAU) {
  const key = `t${q(radius)}|${q(tube)}|${rad}|${tub}|${arc.toFixed(2)}`;
  const hit = _geomCache.get(key);
  if (hit) return hit.clone();
  const g = new THREE.TorusGeometry(q(radius), q(tube), rad, tub, arc);
  if (_geomCache.size < CACHE_LIMIT) { _geomCache.set(key, g); return g.clone(); }
  return g;
}
export { ctorus as torus, cbox, cpipe };

/** Local-space chamfered box. */
function fbox(b, f, w, h, d, lx, ly, lz, mat, o = {}) {
  const g = cbox(b, w, h, d, mat, o.chamfer ?? 0.015);
  return b.add(g, mat, {
    pos: f.p(lx, ly, lz),
    rot: o.rot ?? null,
    rotY: f.rotY + (o.dyaw ?? 0),
    surface: o.surface,
    collide: o.collide ?? false,
  });
}

/** Local-space cylinder along the frame's local X / Y / Z. */
function fpipe(b, f, radius, len, lx, ly, lz, mat, axis = 'y', o = {}) {
  const g = cpipe(b, radius, len, o.segments ?? 8, mat, o.capped !== false);
  const rot = axis === 'x' ? [0, f.rotY, -Math.PI / 2]
            : axis === 'z' ? [Math.PI / 2, f.rotY, 0]
            : [0, f.rotY, 0];
  return b.add(g, mat, { pos: f.p(lx, ly, lz), rot, collide: o.collide ?? false });
}

// -------------------------------------------------------------- grounding --

/**
 * The single highest-value thing in this file.
 *
 * Wind-blown dust and washed-in grit build a wedge against anything that has
 * stood still outdoors, and traffic breaks a scatter of grit out of the slab
 * around it. Without that wedge an object reads as pasted onto the ground no
 * matter how good its own silhouette is — which is exactly the "objects float"
 * complaint. It also gives HBAO something to bite on at the contact line.
 *
 * @param o {x, z, y, w, d, rotY, amount, round, mat, frags, fragMat}
 */
export function contactDress(b, rng, o) {
  const {
    x, z, y = 0.1, w = 1.0, d = 1.0, rotY = 0,
    amount = 1.0, round = false, mat = 'dust', frags = 5, fragMat = null,
    fragSpread = 1.5,
  } = o;
  const f = frame(x, y, z, rotY);

  if (round) {
    const rad = w * 0.5;
    const n = Math.max(3, Math.round(5 * amount));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + R(rng, -0.22, 0.22);
      const rr = rad * R(rng, 0.94, 1.16);
      const ww = rad * R(rng, 0.5, 0.95);
      b.add(cbox(b, ww, R(rng, 0.025, 0.07) * amount, R(rng, 0.10, 0.24), mat, 0.03), mat, {
        pos: [x + Math.cos(a) * rr, y + 0.012, z + Math.sin(a) * rr],
        rot: [R(rng, -0.05, 0.05), a + Math.PI / 2, R(rng, -0.05, 0.05)],
        collide: false,
      });
    }
  } else {
    // Four skirts, one per edge, each broken into 2-4 uneven segments.
    const edges = [
      [w, d / 2, 0, 0], [w, -d / 2, 0, 0],
      [d, 0, w / 2, Math.PI / 2], [d, 0, -w / 2, Math.PI / 2],
    ];
    for (const [len, ez, ex, ey] of edges) {
      const segs = 1 + ((rng() * 2) | 0);
      let u = -len / 2;
      for (let i = 0; i < segs; i++) {
        const sw = (len / segs) * R(rng, 0.6, 1.05);
        const cu = u + sw / 2;
        u += len / segs;
        if (rng() < 0.18) continue;                 // gaps: the wedge is not continuous
        if (rng() < 0.2) continue;
        const off = R(rng, 0.02, 0.13) * amount;
        const lx = ey ? ex + (ex > 0 ? off : -off) : cu;
        const lz = ey ? cu : ez + (ez > 0 ? off : -off);
        b.add(cbox(b, sw, R(rng, 0.02, 0.065) * amount, R(rng, 0.10, 0.26), mat, 0.028), mat, {
          pos: f.p(lx, 0.012, lz),
          rot: [R(rng, -0.04, 0.04), f.rotY + ey + R(rng, -0.1, 0.1), R(rng, -0.04, 0.04)],
          collide: false,
        });
      }
    }
  }

  // A handful of chipped fragments thrown clear of the base.
  const fm = fragMat || 'rebar_concrete';
  const rad = Math.max(w, d) * 0.5;
  for (let i = 0; i < frags; i++) {
    const a = rng() * TAU;
    const rr = rad * R(rng, 1.0, fragSpread);
    const s = R(rng, 0.035, 0.13);
    b.add(cbox(b, s, s * R(rng, 0.45, 0.9), s * R(rng, 0.7, 1.3), fm, s * 0.22), fm, {
      pos: [x + Math.cos(a) * rr, y + s * 0.22, z + Math.sin(a) * rr],
      rot: [R(rng, -0.5, 0.5), rng() * TAU, R(rng, -0.5, 0.5)],
      collide: false,
    });
  }
}

/** A shallow standing puddle: dark rim, glassy centre. Reads wet at any angle. */
export function puddle(b, rng, o) {
  const { x, z, y = 0.105, r = 1.0 } = o;
  const lobes = 3 + ((rng() * 3) | 0);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU;
    const off = r * R(rng, 0.0, 0.34);
    const rr = r * R(rng, 0.6, 1.0);
    b.add(cbox(b, rr * 2, 0.016, rr * 1.55, 'dirt_dark', 0.05), 'dirt_dark', {
      pos: [x + Math.cos(a) * off, y - 0.004, z + Math.sin(a) * off],
      rotY: rng() * TAU, collide: false,
    });
    b.add(cbox(b, rr * 1.72, 0.012, rr * 1.3, 'glass_dirty', 0.04), 'glass_dirty', {
      pos: [x + Math.cos(a) * off, y + 0.004, z + Math.sin(a) * off],
      rotY: rng() * TAU, collide: false,
    });
  }
}

/** Loose small rubbish: cans, boards, torn sheet, wire offcuts, paper. */
export function litterScatter(b, rng, o) {
  const { x, z, y = 0.11, r = 3.0, count = 14 } = o;
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU, rr = Math.sqrt(rng()) * r;
    const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
    const k = rng();
    if (k < 0.24) {
      // crushed can / bottle
      const m = pick(rng, ['sheet_metal_bare', 'metal_rusted']);
      b.add(cpipe(b, R(rng, 0.031, 0.042), R(rng, 0.10, 0.16), 8, m), m, {
        pos: [px, y + 0.033, pz], rot: [Math.PI / 2, rng() * TAU, R(rng, -0.3, 0.3)], collide: false,
      });
    } else if (k < 0.5) {
      // timber offcut
      b.add(cbox(b, R(rng, 0.25, 0.9), 0.022, R(rng, 0.06, 0.13), 'wood_plank', 0.008), 'wood_plank', {
        pos: [px, y + 0.014, pz], rot: [R(rng, -0.06, 0.06), rng() * TAU, R(rng, -0.06, 0.06)], collide: false,
      });
    } else if (k < 0.68) {
      // torn sheet / cardboard
      b.add(cbox(b, R(rng, 0.22, 0.5), 0.012, R(rng, 0.18, 0.4), 'tarp', 0.02), 'tarp', {
        pos: [px, y + 0.009, pz], rot: [R(rng, -0.12, 0.12), rng() * TAU, R(rng, -0.12, 0.12)], collide: false,
      });
    } else if (k < 0.84) {
      // grit / broken slab chip
      const s = R(rng, 0.05, 0.17);
      b.add(cbox(b, s, s * R(rng, 0.35, 0.7), s * R(rng, 0.7, 1.2), 'rebar_concrete', s * 0.2), 'rebar_concrete', {
        pos: [px, y + s * 0.2, pz], rot: [R(rng, -0.4, 0.4), rng() * TAU, R(rng, -0.4, 0.4)], collide: false,
      });
    } else {
      // wire offcut / strapping
      b.add(cpipe(b, 0.008, R(rng, 0.3, 0.8), 5, 'metal_rusted'), 'metal_rusted', {
        pos: [px, y + 0.012, pz], rot: [Math.PI / 2 + R(rng, -0.2, 0.2), rng() * TAU, 0], collide: false,
      });
    }
  }
}

// ------------------------------------------------------------------ crates --

/**
 * Shipping crates. Four genuinely different builds, not one box at four sizes:
 *  0 slatted timber crate (gaps you can see through the shadow of)
 *  1 plywood case with steel corner brackets and strapping
 *  2 long ordnance case, lid rebate + latches + rope handles
 *  3 heavy skid crate on integral bearers, stencilled
 */
export function crate(b, rng, o) {
  const { x, y = 0.1, z, rotY = rng() * TAU, scale = 1, variant = (rng() * 4) | 0, ground = true } = o;
  const v = variant % 4;
  const s = scale;

  if (v === 0) {
    const w = 1.06 * s, h = 0.92 * s, d = 0.86 * s;
    const f = frame(x, y, z, rotY);
    // Corner posts + top/bottom rails, then slats with gaps between them.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      fbox(b, f, 0.075 * s, h, 0.075 * s, sx * (w / 2 - 0.037 * s), h / 2, sz * (d / 2 - 0.037 * s), 'wood_plank', { chamfer: 0.008, collide: false });
    }
    for (const sz of [-1, 1]) {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const ly = 0.09 * s + i * (h - 0.16 * s) / (n - 1);
        fbox(b, f, w - 0.02 * s, 0.115 * s, 0.028 * s, 0, ly, sz * d / 2, 'wood_crate', { chamfer: 0.006, collide: false });
      }
    }
    for (const sx of [-1, 1]) {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const ly = 0.09 * s + i * (h - 0.16 * s) / (n - 1);
        fbox(b, f, 0.028 * s, 0.115 * s, d - 0.02 * s, sx * w / 2, ly, 0, 'wood_crate', { chamfer: 0.006, collide: false });
      }
    }
    // Solid top and a diagonal brace on one face.
    fbox(b, f, w, 0.045 * s, d, 0, h - 0.022 * s, 0, 'wood_crate', { chamfer: 0.01 });
    fbox(b, f, w * 0.96, 0.045 * s, d * 0.96, 0, 0.03 * s, 0, 'wood_crate', { chamfer: 0.01 });
    fbox(b, f, Math.hypot(w, h) * 0.94, 0.09 * s, 0.024 * s, 0, h / 2, d / 2 + 0.016 * s, 'wood_plank',
      { chamfer: 0.006, rot: [0, rotY, Math.atan2(h, w)], collide: false });
    // Interior mass so the slats read as a container, not a cage.
    fbox(b, f, w - 0.09 * s, h - 0.12 * s, d - 0.09 * s, 0, h / 2, 0, 'rubber', { chamfer: 0.02, collide: true, surface: 'wood' });
    if (ground) contactDress(b, rng, { x, z, y, w: w * 1.12, d: d * 1.12, rotY, amount: 0.8, frags: 4 });
    return { w, h, d };
  }

  if (v === 1) {
    const w = 0.92 * s, h = 0.78 * s, d = 0.92 * s;
    const f = frame(x, y, z, rotY);
    fbox(b, f, w, h, d, 0, h / 2, 0, 'wood_crate', { chamfer: 0.012, collide: true, surface: 'wood' });
    // Steel corner brackets — 3 plates per corner.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [0, 1]) {
      const ly = sy ? h - 0.055 * s : 0.055 * s;
      fbox(b, f, 0.17 * s, 0.055 * s, 0.02 * s, sx * (w / 2 - 0.085 * s), ly, sz * (d / 2 + 0.008 * s), 'sheet_metal_bare', { chamfer: 0.004 });
      fbox(b, f, 0.02 * s, 0.055 * s, 0.17 * s, sx * (w / 2 + 0.008 * s), ly, sz * (d / 2 - 0.085 * s), 'sheet_metal_bare', { chamfer: 0.004 });
      fbox(b, f, 0.02 * s, 0.17 * s, 0.02 * s, sx * (w / 2 + 0.008 * s), ly + (sy ? -0.09 * s : 0.09 * s), sz * (d / 2 + 0.008 * s), 'sheet_metal_bare', { chamfer: 0.004 });
    }
    // Steel strapping around the girth.
    for (const u of [-0.22, 0.22]) {
      fbox(b, f, w + 0.016 * s, 0.035 * s, d + 0.016 * s, 0, h * 0.5 + u * s, 0, 'sheet_metal_bare', { chamfer: 0.004 });
    }
    fbox(b, f, w * 0.5, 0.006 * s, d * 0.34, 0, h + 0.004 * s, 0, 'sheet_metal_bare', { chamfer: 0.002 });
    if (ground) contactDress(b, rng, { x, z, y, w: w * 1.15, d: d * 1.15, rotY, amount: 0.75, frags: 4 });
    return { w, h, d };
  }

  if (v === 2) {
    const w = 1.42 * s, h = 0.42 * s, d = 0.52 * s;
    const f = frame(x, y, z, rotY);
    fbox(b, f, w, h - 0.07 * s, d, 0, (h - 0.07 * s) / 2, 0, 'wood_crate', { chamfer: 0.018, collide: true, surface: 'wood' });
    fbox(b, f, w + 0.02 * s, 0.085 * s, d + 0.02 * s, 0, h - 0.03 * s, 0, 'wood_crate', { chamfer: 0.022, collide: false });
    // Latches, hinges and rope handles.
    for (const u of [-0.34, 0.34]) {
      fbox(b, f, 0.075 * s, 0.11 * s, 0.028 * s, u * w, h - 0.06 * s, d / 2 + 0.012 * s, 'sheet_metal_bare', { chamfer: 0.006 });
      fbox(b, f, 0.075 * s, 0.075 * s, 0.028 * s, u * w, h - 0.055 * s, -d / 2 - 0.012 * s, 'metal_rusted', { chamfer: 0.006 });
    }
    for (const sx of [-1, 1]) {
      fpipe(b, f, 0.016 * s, 0.24 * s, sx * (w / 2 + 0.02 * s), h * 0.5, 0, 'rubber', 'z', { segments: 6 });
      fbox(b, f, 0.05 * s, 0.05 * s, 0.05 * s, sx * (w / 2 + 0.014 * s), h * 0.5, 0, 'sheet_metal_bare', { chamfer: 0.008 });
    }
    fbox(b, f, w * 0.42, 0.005 * s, d * 0.3, -w * 0.15, h + 0.015 * s, 0, 'sheet_metal_bare', { chamfer: 0.002 });
    if (ground) contactDress(b, rng, { x, z, y, w: w * 1.1, d: d * 1.3, rotY, amount: 0.7, frags: 3 });
    return { w, h, d };
  }

  const w = 1.24 * s, h = 1.08 * s, d = 1.0 * s;
  const f = frame(x, y, z, rotY);
  // Integral bearers hold the body 0.1 m off the ground — a strong shadow gap.
  for (const u of [-0.36, 0, 0.36]) {
    fbox(b, f, 0.11 * s, 0.1 * s, d, u * w, 0.05 * s, 0, 'wood_plank', { chamfer: 0.008, collide: false });
  }
  fbox(b, f, w, h - 0.1 * s, d, 0, 0.1 * s + (h - 0.1 * s) / 2, 0, 'wood_crate', { chamfer: 0.016, collide: true, surface: 'wood' });
  // Framing ribs on all four faces.
  for (const sz of [-1, 1]) {
    fbox(b, f, w + 0.012 * s, 0.09 * s, 0.03 * s, 0, 0.19 * s, sz * d / 2, 'wood_plank', { chamfer: 0.006 });
    fbox(b, f, w + 0.012 * s, 0.09 * s, 0.03 * s, 0, h - 0.07 * s, sz * d / 2, 'wood_plank', { chamfer: 0.006 });
    for (const u of [-0.4, 0.4]) {
      fbox(b, f, 0.09 * s, h - 0.16 * s, 0.03 * s, u * w, 0.1 * s + (h - 0.1 * s) / 2, sz * d / 2, 'wood_plank', { chamfer: 0.006 });
    }
  }
  fbox(b, f, w * 0.45, 0.006 * s, d * 0.28, 0, h + 0.004 * s, 0, 'sheet_metal_bare', { chamfer: 0.002 });
  fbox(b, f, 0.28 * s, 0.006 * s, 0.2 * s, w * 0.18, 0.6 * s, d / 2 + 0.02 * s, 'warning_stripe', { chamfer: 0.002 });
  if (ground) contactDress(b, rng, { x, z, y, w: w * 1.15, d: d * 1.15, rotY, amount: 0.9, frags: 5 });
  return { w, h, d };
}

// ----------------------------------------------------------------- barrels --

/**
 * 200 L drums. Variants: 0 steel tight-head, 1 ribbed plastic, 2 crushed,
 * 3 open-top with a lid ring. `tipped` lays it on its side.
 */
export function barrel(b, rng, o) {
  const { x, y = 0.1, z, rotY = rng() * TAU, variant = (rng() * 4) | 0, tipped = false, mat, ground = true } = o;
  const v = variant % 4;
  const RAD = 0.2925, HGT = 0.88;
  const m = mat || pick(rng, ['metal_rusted', 'painted_steel_blue', 'paint_green', 'paint_red', 'metal_rusted']);
  const seg = 12;

  if (tipped) {
    const f = frame(x, y + RAD, z, rotY);
    fpipe(b, f, RAD, HGT, 0, 0, 0, m, 'x', { segments: seg, collide: true });
    for (const u of [-0.24, 0.24]) {
      b.add(ctorus(RAD + 0.012, 0.022, 4, 10), 'metal_rusted',
        { pos: f.p(u, 0, 0), rot: [0, rotY, Math.PI / 2], collide: false });
    }
    for (const u of [-0.5, 0.5]) {
      fpipe(b, f, RAD * 0.96, 0.03, u * HGT, 0, 0, 'metal_rusted', 'x', { segments: seg });
    }
    // Spilt contents.
    b.add(cbox(b, R(rng, 0.7, 1.3), 0.014, R(rng, 0.5, 1.0), 'dirt_dark', 0.06), 'dirt_dark', {
      pos: [x + Math.cos(rotY) * 0.7, y + 0.006, z - Math.sin(rotY) * 0.7], rotY, collide: false,
    });
    if (ground) contactDress(b, rng, { x, z, y, w: HGT * 1.3, d: RAD * 3, rotY, amount: 0.7, frags: 3 });
    return;
  }

  const f = frame(x, y, z, rotY);
  if (v === 2) {
    // Crushed: three stacked sections of decreasing radius, leaning.
    const lean = R(rng, 0.06, 0.16), la = rng() * TAU;
    const rot = [Math.sin(la) * lean, rotY, Math.cos(la) * lean];
    const g1 = cpipe(b, RAD, 0.34, seg, m); b.add(g1, m, { pos: f.p(0, 0.17, 0), rot, collide: true });
    const g2 = cpipe(b, RAD * 0.86, 0.2, seg, m); b.add(g2, m, { pos: f.p(0, 0.43, 0), rot, collide: false });
    const g3 = cpipe(b, RAD * 0.97, 0.16, seg, m); b.add(g3, m, { pos: f.p(0, 0.6, 0), rot, collide: false });
    b.add(ctorus(RAD * 0.99, 0.02, 4, 10), 'metal_rusted', { pos: f.p(0, 0.68, 0), rot: [Math.PI / 2 + rot[0], rotY, rot[2]], collide: false });
    if (ground) contactDress(b, rng, { x, z, y, w: RAD * 2.5, round: true, amount: 0.8, frags: 4 });
    return;
  }

  fpipe(b, f, RAD, HGT, 0, HGT / 2, 0, m, 'y', { segments: seg, collide: true });
  // Rolling hoops (steel) or moulded ribs (plastic).
  if (v === 1) {
    for (const u of [0.16, 0.3, 0.44, 0.58, 0.72]) {
      fpipe(b, f, RAD + 0.016, 0.035, 0, u * HGT, 0, m, 'y', { segments: seg });
    }
  } else {
    for (const u of [0.3, 0.62]) {
      b.add(ctorus(RAD + 0.008, 0.023, 4, 10), 'metal_rusted', { pos: f.p(0, u * HGT, 0), rot: [Math.PI / 2, 0, 0], collide: false });
    }
  }
  // Top and bottom chime, plus bungs.
  for (const u of [0.012, HGT - 0.012]) {
    fpipe(b, f, RAD + 0.012, 0.028, 0, u, 0, 'metal_rusted', 'y', { segments: seg });
  }
  if (v === 3) {
    fpipe(b, f, RAD * 0.93, 0.02, 0, HGT - 0.05, 0, 'rubber', 'y', { segments: seg });
    fpipe(b, f, RAD + 0.02, 0.05, 0, HGT + 0.01, 0, 'sheet_metal_bare', 'y', { segments: seg });
  } else {
    for (const [bx, bz] of [[0.14, 0.06], [-0.11, -0.13]]) {
      fpipe(b, f, 0.035, 0.028, bx, HGT + 0.005, bz, 'sheet_metal_bare', 'y', { segments: 8 });
    }
  }
  // Label band. Never hazard tape: a `warning_stripe` ring wrapped around a
  // drum reads as a candy stripe, and it was the single loudest object in
  // several frames. A drum label is a painted or bare-metal band; the yellow
  // accent is reserved for actual hazard marking under the colour script.
  fpipe(b, f, RAD + 0.004, 0.2, 0, HGT * 0.52, 0, 'sheet_metal_bare', 'y',
    { segments: seg, capped: false });
  if (ground) contactDress(b, rng, { x, z, y, w: RAD * 2.6, round: true, amount: 0.8, frags: 4 });
}

// ---------------------------------------------------------------- pallets --

/** EUR pallet: 1.2 x 0.8 x 0.144, nine blocks, three bearers, five deck boards. */
export function pallet(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, mat = 'wood_plank', collide = false, simple = false } = o;
  const f = frame(x, y, z, rotY);
  const W = 1.2, D = 0.8;
  // In a stack only the ends and the top face are ever visible, so the blocks
  // and bottom boards are dropped for anything but a pallet on its own.
  for (const u of [-0.5, 0, 0.5]) {
    if (!simple) {
      for (const w of [-0.5, 0, 0.5]) {
        fbox(b, f, 0.1, 0.078, 0.145, u * (W - 0.1), 0.039, w * (D - 0.145), mat, { chamfer: 0.006 });
      }
    } else if (u === 0) {
      fbox(b, f, W, 0.078, D * 0.92, 0, 0.039, 0, mat, { chamfer: 0.012 });
    }
    fbox(b, f, 0.1, 0.022, D, u * (W - 0.1), 0.089, 0, mat, { chamfer: 0.005 });
  }
  const deck = simple ? [-0.5, 0, 0.5] : [-0.5, -0.25, 0, 0.25, 0.5];
  for (const u of deck) {
    const bw = Math.abs(u) === 0.5 ? 0.145 : 0.1;
    fbox(b, f, bw, 0.022, D, u * (W - bw), 0.111, 0, mat, { chamfer: 0.005, collide });
  }
  if (!simple) {
    for (const w of [-0.5, 0, 0.5]) {
      fbox(b, f, W, 0.022, 0.1, 0, 0.011, w * (D - 0.1), mat, { chamfer: 0.005 });
    }
  }
  return { w: W, d: D, top: 0.144 };
}

/** A leaning stack of empty pallets — every yard has one. */
export function palletStack(b, rng, o) {
  const { x, y = 0.1, z, rotY = rng() * TAU, count = 3 + ((rng() * 4) | 0) } = o;
  for (let i = 0; i < count; i++) {
    pallet(b, rng, {
      x: x + R(rng, -0.05, 0.05) * i, y: y + i * 0.146, z: z + R(rng, -0.05, 0.05) * i,
      rotY: rotY + R(rng, -0.09, 0.09) * (i + 1), collide: i === count - 1,
      simple: i < count - 1,
    });
  }
  contactDress(b, rng, { x, z, y, w: 1.5, d: 1.1, rotY, amount: 0.9, frags: 5 });
}

/** Pallet with a load: sacks, drums, wrapped bundle, or boxes. */
export function loadedPallet(b, rng, o) {
  const { x, y = 0.1, z, rotY = rng() * TAU, kind = (rng() * 4) | 0, ground = true } = o;
  const p = pallet(b, rng, { x, y, z, rotY, collide: true });
  const f = frame(x, y + p.top, z, rotY);
  if (kind === 0) {
    // Sacks — five per course, courses cross-stacked, top course incomplete.
    const courses = 3 + ((rng() * 2) | 0);
    for (let c = 0; c < courses; c++) {
      const cross = c % 2;
      const n = c === courses - 1 ? 2 + ((rng() * 3) | 0) : 5;
      for (let i = 0; i < n; i++) {
        const t = (i - (n - 1) / 2) / 2.2;
        const lx = cross ? t * 0.62 : R(rng, -0.06, 0.06);
        const lz = cross ? R(rng, -0.05, 0.05) : t * 0.62;
        fbox(b, f, cross ? 0.34 : 0.72, 0.17, cross ? 0.7 : 0.32, lx, 0.09 + c * 0.16, lz, 'sandbag',
          { chamfer: 0.06, rot: [R(rng, -0.04, 0.04), rotY + R(rng, -0.1, 0.1), R(rng, -0.04, 0.04)], collide: c < 2 });
      }
    }
  } else if (kind === 1) {
    for (const [lx, lz] of [[-0.29, -0.19], [0.29, -0.19], [-0.29, 0.19], [0.29, 0.19]]) {
      barrel(b, rng, { x: f.p(lx, 0, lz)[0], y: y + p.top, z: f.p(lx, 0, lz)[2], rotY: rng() * TAU, ground: false, variant: 0 });
    }
  } else if (kind === 2) {
    // Shrink-wrapped bundle: a tarp block with rope banding.
    const h = R(rng, 0.6, 1.1);
    fbox(b, f, 1.1, h, 0.74, 0, h / 2, 0, 'tarp', { chamfer: 0.07, collide: true });
    for (const u of [-0.3, 0.3]) {
      fbox(b, f, 1.13, 0.03, 0.77, 0, h * 0.5 + u * h, 0, 'rubber', { chamfer: 0.008 });
    }
    fbox(b, f, 0.4, 0.006, 0.26, 0, h + 0.004, 0, 'sheet_metal_bare', { chamfer: 0.002 });
  } else {
    let ly = 0;
    for (let i = 0; i < 2 + ((rng() * 2) | 0); i++) {
      const cw = R(rng, 0.5, 0.62), ch = R(rng, 0.3, 0.42);
      fbox(b, f, cw * 2, ch, cw * 1.4, R(rng, -0.08, 0.08), ly + ch / 2, R(rng, -0.06, 0.06), 'wood_crate',
        { chamfer: 0.014, dyaw: R(rng, -0.12, 0.12), collide: true, surface: 'wood' });
      for (const sz of [-1, 1]) {
        fbox(b, f, cw * 2 + 0.01, 0.05, 0.022, 0, ly + ch * 0.75, sz * cw * 0.7, 'wood_plank', { chamfer: 0.005, dyaw: R(rng, -0.12, 0.12) });
      }
      ly += ch;
    }
  }
  if (ground) contactDress(b, rng, { x, z, y, w: 1.45, d: 1.05, rotY, amount: 0.85, frags: 4 });
}

// ------------------------------------------------------------- containers --

/**
 * A real ISO container. The previous version was flat panels; this one has the
 * things you actually recognise a container by: 275 mm corrugation, top and
 * bottom side rails, corner posts, eight corner castings, forklift pockets, a
 * cambered roof, and — on the door end — two leaves with four locking bars,
 * cams, hinges and a header plate.
 *
 * @param o {x, y, z, rotY, len, mat, variant, doorsOpen, damaged}
 */
export function isoContainer(b, rng, o) {
  const {
    x, y = 0, z, rotY = 0, len = 6.058, mat = 'metal_rusted',
    doorsOpen = false, damaged = false, ground = true, roofClutter = false,
  } = o;
  const W = 2.438, H = 2.591;
  const f = frame(x, y, z, rotY);
  const railM = 'metal_rusted';
  const hw = W / 2, hl = len / 2;

  // ---- corner posts + castings
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    fbox(b, f, 0.16, H - 0.3, 0.16, sx * (hl - 0.08), H / 2, sz * (hw - 0.08), mat, { chamfer: 0.022 });
    for (const sy of [0, 1]) {
      fbox(b, f, 0.178, 0.118, 0.162, sx * (hl - 0.089), sy ? H - 0.059 : 0.059, sz * (hw - 0.081), railM, { chamfer: 0.028, collide: false });
    }
  }
  // ---- top and bottom side rails
  for (const sz of [-1, 1]) {
    fbox(b, f, len - 0.18, 0.13, 0.115, 0, H - 0.065, sz * (hw - 0.058), railM, { chamfer: 0.018 });
    fbox(b, f, len - 0.18, 0.155, 0.13, 0, 0.078, sz * (hw - 0.065), railM, { chamfer: 0.018, collide: true, surface: 'metal' });
  }
  for (const sx of [-1, 1]) {
    fbox(b, f, 0.115, 0.13, W - 0.18, sx * (hl - 0.058), H - 0.065, 0, railM, { chamfer: 0.018 });
    fbox(b, f, 0.13, 0.155, W - 0.18, sx * (hl - 0.065), 0.078, 0, railM, { chamfer: 0.018 });
  }
  // ---- underframe cross members, visible under a raised container
  for (let i = 0; i < 5; i++) {
    fbox(b, f, 0.075, 0.1, W - 0.2, -hl + 0.4 + i * (len - 0.8) / 4, 0.05, 0, railM, { chamfer: 0.01 });
  }
  // ---- forklift pockets
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    fbox(b, f, 0.36, 0.12, 0.1, sx * 0.95, 0.08, sz * (hw - 0.055), 'rubber', { chamfer: 0.012 });
  }

  // ---- corrugated side walls: web panel + real ribs at 275 mm pitch
  const pitch = 0.2755;
  const ribs = Math.max(4, Math.floor((len - 0.4) / pitch));
  const wallH = H - 0.34;
  for (const sz of [-1, 1]) {
    fbox(b, f, len - 0.22, wallH, 0.045, 0, 0.17 + wallH / 2, sz * (hw - 0.045), mat, { chamfer: 0.008, collide: true, surface: 'metal' });
    for (let i = 0; i < ribs; i++) {
      const u = -((ribs - 1) / 2) * pitch + i * pitch;
      const skip = damaged && rng() < 0.14;
      if (skip) continue;
      fbox(b, f, 0.135, wallH - 0.02, 0.038, u, 0.17 + wallH / 2, sz * (hw - 0.014), mat, { chamfer: 0.014 });
    }
  }
  // ---- front end wall (opposite the doors)
  {
    const eribs = 7, epitch = (W - 0.4) / (eribs - 1);
    fbox(b, f, 0.045, wallH, W - 0.22, -hl + 0.045, 0.17 + wallH / 2, 0, mat, { chamfer: 0.008, collide: true, surface: 'metal' });
    for (let i = 0; i < eribs; i++) {
      fbox(b, f, 0.038, wallH - 0.02, 0.13, -hl + 0.014, 0.17 + wallH / 2, -((eribs - 1) / 2) * epitch + i * epitch, mat, { chamfer: 0.014 });
    }
  }

  // ---- door end
  {
    const dx = hl - 0.03;
    fbox(b, f, 0.09, 0.16, W - 0.2, dx - 0.02, H - 0.24, 0, railM, { chamfer: 0.014 });   // header
    fbox(b, f, 0.09, 0.1, W - 0.2, dx - 0.02, 0.21, 0, railM, { chamfer: 0.012 });        // sill
    for (const sz of [-1, 1]) {
      const leafW = (W - 0.26) / 2;
      const hingeSide = sz;
      const open = doorsOpen ? sz * 1.25 : 0;                 // radians the leaf swings
      const cy = Math.cos(open), sy2 = Math.sin(open);
      const pivotZ = sz * (hw - 0.11);
      // Leaf body, hinged about its outer edge.
      const lz = pivotZ - hingeSide * (leafW / 2) * cy;
      const lx = dx - (leafW / 2) * sy2 * hingeSide;
      fbox(b, f, 0.05, H - 0.5, leafW, lx, H / 2 - 0.03, lz, mat,
        { chamfer: 0.01, dyaw: -hingeSide * open, collide: !doorsOpen, surface: 'metal' });
      for (let i = 0; i < 4; i++) {
        const t = (i - 1.5) * (leafW / 4.6);
        const rz = lz + Math.cos(-hingeSide * open + Math.PI / 2) * 0;
        fbox(b, f, 0.035, H - 0.54, 0.11, lx + 0.038 * cy, H / 2 - 0.03, rz + t, mat,
          { chamfer: 0.012, dyaw: -hingeSide * open });
      }
      // Locking bars + cams + keepers.
      for (const t of [-leafW * 0.3, leafW * 0.3]) {
        fpipe(b, f, 0.019, H - 0.62, lx + 0.07 * cy, H / 2 - 0.03, lz + t, 'sheet_metal_bare', 'y', { segments: 8 });
        for (const ky of [0.42, H - 0.5]) {
          fbox(b, f, 0.05, 0.075, 0.075, lx + 0.062 * cy, ky, lz + t, railM, { chamfer: 0.01, dyaw: -hingeSide * open });
        }
        fbox(b, f, 0.05, 0.05, 0.22, lx + 0.085 * cy, H * 0.5, lz + t + 0.1, 'painted_steel_yellow', { chamfer: 0.008, dyaw: -hingeSide * open });
      }
      // Hinges.
      for (const hy of [0.36, H * 0.5, H - 0.42]) {
        fbox(b, f, 0.075, 0.13, 0.075, dx + 0.03, hy, pivotZ, railM, { chamfer: 0.014 });
      }
    }
    // CSC plate + stencilled serial.
    fbox(b, f, 0.012, 0.2, 0.3, dx + 0.05, 1.35, -hw + 0.45, 'sheet_metal_bare', { chamfer: 0.004 });
  }

  // ---- roof: transverse corrugation + a slight camber
  fbox(b, f, len - 0.2, 0.05, W - 0.2, 0, H - 0.045, 0, mat, { chamfer: 0.01, collide: true, surface: 'metal' });
  const rn = Math.max(4, Math.floor((len - 0.5) / 0.85));
  for (let i = 0; i < rn; i++) {
    const u = -((rn - 1) / 2) * ((len - 0.5) / (rn - 1)) + i * ((len - 0.5) / (rn - 1));
    fbox(b, f, 0.16, 0.03, W - 0.28, u, H - 0.012, 0, mat, { chamfer: 0.01 });
  }

  // ---- stencils and placards on the side
  for (const sz of [-1, 1]) {
    fbox(b, f, 1.5, 0.24, 0.008, -hl * 0.35, H * 0.68, sz * (hw + 0.005), 'sheet_metal_bare', { chamfer: 0.003 });
  }

  if (damaged) {
    // Buckled panel + a torn hole with folded lips.
    fbox(b, f, R(rng, 0.5, 1.1), R(rng, 0.5, 1.0), 0.12, R(rng, -hl * 0.6, hl * 0.6), R(rng, 0.7, 1.9), (rng() < 0.5 ? 1 : -1) * (hw - 0.02),
      'rubber', { chamfer: 0.03 });
    for (let i = 0; i < 5; i++) {
      fbox(b, f, R(rng, 0.1, 0.4), R(rng, 0.1, 0.35), 0.02, R(rng, -hl, hl), R(rng, 0.4, H - 0.4), (rng() < 0.5 ? 1 : -1) * (hw + 0.04),
        mat, { chamfer: 0.01, rot: [R(rng, -0.6, 0.6), rotY, R(rng, -0.6, 0.6)] });
    }
  }

  if (roofClutter) {
    for (let i = 0; i < 3 + ((rng() * 4) | 0); i++) {
      const s = R(rng, 0.1, 0.3);
      fbox(b, f, s, s * R(rng, 0.3, 0.7), s * R(rng, 0.7, 1.3), R(rng, -hl, hl), H + s * 0.2, R(rng, -hw, hw), 'rebar_concrete',
        { chamfer: s * 0.2, rot: [R(rng, -0.3, 0.3), rotY + rng(), R(rng, -0.3, 0.3)] });
    }
    fbox(b, f, R(rng, 0.6, 1.6), 0.02, R(rng, 0.5, 1.4), R(rng, -hl * 0.7, hl * 0.7), H + 0.02, R(rng, -0.7, 0.7), 'dirt_dark', { chamfer: 0.06 });
  }

  if (ground && y < 0.4) {
    contactDress(b, rng, { x, z, y: y + 0.1, w: len + 0.4, d: W + 0.4, rotY, amount: 1.2, frags: 7, fragSpread: 1.25 });
  }
  return { w: len, d: W, h: H };
}

// ------------------------------------------------------------- sandbags ---

/**
 * A sandbag emplacement that reads as built by hand under time pressure:
 * courses sag toward the middle, each course is trimmed differently so the top
 * line is broken, bags alternate header/stretcher, and there are always a few
 * on the deck that never made it up.
 */
export function sandbagEmplacement(b, rng, o) {
  const {
    x, y = 0.1, z, rotY = 0, len = 4.5, rows = 4, depth = 2, collide = true,
    spill = true, stakes = true,
  } = o;
  const BW = 0.5, BH = 0.185, BD = 0.3;
  const f = frame(x, y, z, rotY);

  for (let r = 0; r < rows; r++) {
    // Broken top line: every course gets its own uneven ends, and the top one
    // is deliberately ragged.
    const top = r === rows - 1;
    const trimA = top ? R(rng, 0.1, 1.3) : R(rng, 0, 0.4);
    const trimB = top ? R(rng, 0.1, 1.3) : R(rng, 0, 0.4);
    const u0 = -len / 2 + trimA, u1 = len / 2 - trimB;
    if (u1 - u0 < BW) continue;
    const n = Math.max(1, Math.round((u1 - u0) / (BW * 0.94)));
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const u = u0 + t * (u1 - u0);
      // Courses settle: the middle of the wall sinks into the ones below it.
      const sag = Math.sin(t * Math.PI) * 0.016 * r;
      for (let dRow = 0; dRow < depth; dRow++) {
        if (dRow > 0 && rng() < 0.18 + r * 0.06) continue;   // back courses thin out
        const cross = (r + dRow) % 2 === 1;
        const lz = (dRow - (depth - 1) / 2) * (cross ? BW * 0.62 : BD * 1.06) + R(rng, -0.035, 0.035);
        const ly = y + BH * 0.55 + r * (BH * 0.86) - sag + R(rng, -0.012, 0.012);
        const squash = 1 - r * 0.018;
        b.add(sandbag(b, (cross ? BD : BW) * R(rng, 0.93, 1.07), BH * R(rng, 0.88, 1.1) * squash, (cross ? BW : BD) * R(rng, 0.93, 1.08)), 'sandbag', {
          pos: f.p(u + R(rng, -0.03, 0.03), ly - y, lz),
          rot: [R(rng, -0.07, 0.07), f.rotY + R(rng, -0.14, 0.14), R(rng, -0.1, 0.1)],
          collide: collide && dRow === 0 && r < rows - 1 && i % 2 === 0,
          surface: 'sandbag',
        });
      }
    }
  }

  if (spill) {
    // Bags that fell off the front, one split with its sand run out.
    for (let i = 0; i < 2 + ((rng() * 3) | 0); i++) {
      const u = R(rng, -len / 2, len / 2), lz = R(rng, 0.35, 0.85) * (depth * BD * 0.5 + 0.5);
      b.add(sandbag(b, BW * R(rng, 0.9, 1.1), BH, BD), 'sandbag', {
        pos: f.p(u, BH * 0.5, lz), rot: [R(rng, -0.25, 0.25), f.rotY + rng() * TAU, R(rng, -0.25, 0.25)], collide: false,
      });
    }
    const su = R(rng, -len / 3, len / 3);
    b.add(cbox(b, R(rng, 0.6, 1.1), 0.05, R(rng, 0.4, 0.8), 'dust', 0.08), 'dust', {
      pos: f.p(su, 0.022, R(rng, 0.5, 0.9)), rotY: f.rotY + R(rng, -0.5, 0.5), collide: false,
    });
  }

  if (stakes) {
    for (const u of [-len / 2 + 0.15, len / 2 - 0.15]) {
      fpipe(b, f, 0.035, rows * BH * 0.86 + 0.5, u, (rows * BH * 0.86 + 0.5) / 2 - 0.15, depth * BD * 0.5 + 0.06, 'wood_plank', 'y',
        { segments: 6, collide: false });
    }
    // A plank revetment behind the top course, and an ammo box on the step.
    if (rng() < 0.6) {
      fbox(b, f, len * R(rng, 0.4, 0.8), 0.2, 0.03, R(rng, -0.6, 0.6), rows * BH * 0.86 + 0.06, -depth * BD * 0.5 - 0.03, 'wood_plank', { chamfer: 0.008 });
    }
  }

  contactDress(b, rng, {
    x, z, y, w: len + 0.5, d: depth * BD + 0.7, rotY, amount: 1.0, frags: 5,
  });
}

// ------------------------------------------------------- jersey barriers ---

/**
 * A real F-shape jersey barrier profile: 0.61 m base, battered face up to a
 * 0.25 m nose, 0.81 m tall, 3.0 m long, with lifting lugs, joint keys and a
 * chamfered nose. Variants: 0 clean concrete, 1 crash-damaged, 2 plastic
 * water-filled, 3 short 1.2 m section.
 */
export function jerseyBarrier(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, variant = (rng() * 4) | 0, tilt = 0 } = o;
  const v = variant % 4;
  const L = v === 3 ? 1.25 : 3.0;
  const f = frame(x, y, z, rotY);
  const m = v === 2 ? pick(rng, ['paint_red', 'sheet_metal_bare', 'painted_steel_yellow']) : 'concrete_stained';
  const lean = tilt || (rng() < 0.25 ? R(rng, -0.06, 0.06) : 0);
  const rot = lean ? [0, rotY, lean] : null;
  let putN = 0;
  const put = (w, h, d, ly, ch) => b.add(cbox(b, w, h, d, m, ch), m, {
    pos: f.p(0, ly, 0), rot, rotY, collide: (putN++ % 2) === 1, surface: v === 2 ? 'rubber' : 'concrete',
  });

  // Stepped batter — five courses approximating the F profile.
  put(L, 0.075, 0.61, 0.037, 0.02);
  put(L, 0.18, 0.55, 0.165, 0.025);
  put(L, 0.14, 0.42, 0.325, 0.05);
  put(L, 0.28, 0.31, 0.535, 0.045);
  put(L, 0.13, 0.255, 0.74, 0.055);

  if (v !== 2) {
    // Lifting lugs and the pin pockets at each end.
    for (const u of [-0.28, 0.28]) {
      fpipe(b, f, 0.014, 0.16, u * L, 0.83, 0, 'metal_rusted', 'z', { segments: 6 });
      fbox(b, f, 0.09, 0.06, 0.1, u * L, 0.79, 0, 'rubber', { chamfer: 0.012, rot });
    }
    for (const sx of [-1, 1]) {
      fbox(b, f, 0.05, 0.34, 0.16, sx * (L / 2 - 0.02), 0.5, 0, 'concrete_stained', { chamfer: 0.02, rot });
    }
    // Reflective panel + scuffed paint stripe.
    fbox(b, f, L * 0.9, 0.11, 0.02, 0, 0.6, 0.16, 'warning_stripe', { chamfer: 0.008, rot });
    if (rng() < 0.5) fbox(b, f, R(rng, 0.3, 0.9), 0.05, 0.02, R(rng, -1, 1), R(rng, 0.3, 0.7), -0.19, 'sheet_metal_bare', { chamfer: 0.004, rot });
  } else {
    // Water-filled plastic: ribs and a fill cap.
    for (let i = 0; i < 7; i++) {
      fbox(b, f, 0.05, 0.6, 0.5, -L / 2 + 0.25 + i * (L - 0.5) / 6, 0.4, 0, m, { chamfer: 0.02, rot });
    }
    fpipe(b, f, 0.06, 0.05, 0, 0.83, 0, 'sheet_metal_bare', 'y', { segments: 8 });
  }

  if (v === 1) {
    // Crash damage: a spalled corner with the mesh showing, and skid marks.
    fbox(b, f, R(rng, 0.3, 0.7), R(rng, 0.2, 0.45), 0.2, R(rng, -1.1, 1.1), R(rng, 0.25, 0.6), 0.16, 'rebar_concrete',
      { chamfer: 0.05, rot: [R(rng, -0.2, 0.2), rotY, R(rng, -0.2, 0.2)] });
    for (let i = 0; i < 4; i++) {
      fpipe(b, f, 0.008, R(rng, 0.15, 0.35), R(rng, -1.1, 1.1), R(rng, 0.3, 0.7), 0.2, 'metal_rusted', 'z',
        { segments: 5 });
    }
  }

  contactDress(b, rng, { x, z, y, w: L + 0.4, d: 0.95, rotY, amount: 0.9, frags: 5 });
  return { len: L };
}

// ----------------------------------------------------------- pipes/cables --

/**
 * A run of process pipe: several parallel lines on shared brackets, with
 * flanged joints, valves, insulation collars and drip staining below.
 */
export function pipeRun(b, rng, o) {
  const {
    x, y, z, rotY = 0, len = 20, lines = 4, spacing = 0.42, bracketEvery = 3.2,
    baseRadius = 0.09, vertical = false,
  } = o;
  const f = frame(x, y, z, rotY);
  const mats = ['metal_rusted', 'painted_steel_blue', 'paint_green', 'sheet_metal_bare'];
  for (let i = 0; i < lines; i++) {
    const m = mats[i % mats.length];
    const r = baseRadius * R(rng, 0.75, 1.4);
    const ly = vertical ? 0 : i * spacing;
    const lz = vertical ? i * spacing : 0;
    if (vertical) {
      fpipe(b, f, r, len, 0, len / 2, lz, m, 'y', { segments: 12 });
    } else {
      fpipe(b, f, r, len, 0, ly, 0, m, 'x', { segments: 12 });
    }
    // Flanged joints every few metres.
    const joints = Math.max(1, Math.floor(len / R(rng, 4, 7)));
    for (let j = 1; j <= joints; j++) {
      const u = -len / 2 + j * len / (joints + 1);
      if (vertical) fpipe(b, f, r * 1.55, 0.055, 0, u + len / 2, lz, 'sheet_metal_bare', 'y', { segments: 12 });
      else fpipe(b, f, r * 1.55, 0.055, u, ly, 0, 'sheet_metal_bare', 'x', { segments: 12 });
    }
    // A valve or two per line.
    if (rng() < 0.55) {
      const u = R(rng, -len * 0.4, len * 0.4);
      if (!vertical) {
        fbox(b, f, 0.16, r * 2.6, r * 2.6, u, ly, 0, 'paint_red', { chamfer: 0.02 });
        fpipe(b, f, r * 0.5, 0.16, u, ly + r * 1.9, 0, 'sheet_metal_bare', 'y', { segments: 8 });
        b.add(ctorus(0.11, 0.016, 4, 10), 'paint_red', { pos: f.p(u, ly + r * 1.9 + 0.08, 0), rot: [Math.PI / 2, rotY, 0], collide: false });
      }
    }
    // Insulation collar section.
    if (rng() < 0.4 && !vertical) {
      const u = R(rng, -len * 0.35, len * 0.35);
      fpipe(b, f, r * 1.9, R(rng, 0.8, 2.4), u, ly, 0, 'sheet_metal_bare', 'x', { segments: 12 });
    }
  }
  // Brackets.
  const nb = Math.max(2, Math.round(len / bracketEvery));
  for (let i = 0; i <= nb; i++) {
    const u = -len / 2 + i * len / nb;
    if (vertical) {
      fbox(b, f, 0.09, 0.09, lines * spacing + 0.3, 0, i * len / nb, (lines - 1) * spacing / 2, 'metal_rusted', { chamfer: 0.012 });
    } else {
      fbox(b, f, 0.09, lines * spacing + 0.36, 0.075, u, (lines - 1) * spacing / 2, -0.1, 'metal_rusted', { chamfer: 0.012 });
      fbox(b, f, 0.12, 0.09, 0.22, u, -0.2, -0.06, 'metal_rusted', { chamfer: 0.012 });
      fbox(b, f, 0.12, 0.09, 0.22, u, lines * spacing, -0.06, 'metal_rusted', { chamfer: 0.012 });
    }
  }
}

/** Sagging cable bundles between brackets, plus junction boxes. */
export function cableRun(b, rng, o) {
  const { x, y, z, rotY = 0, len = 12, spans = 4, cables = 3, sag = 0.28, radius = 0.022 } = o;
  const f = frame(x, y, z, rotY);
  const spanLen = len / spans;
  for (let s = 0; s < spans; s++) {
    const u0 = -len / 2 + s * spanLen;
    for (let c = 0; c < cables; c++) {
      const lz = (c - (cables - 1) / 2) * radius * 2.6;
      const sg = sag * R(rng, 0.8, 1.2);
      // Three chords approximating a catenary.
      const segs = 3;
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs, t1 = (i + 1) / segs;
        const y0 = -4 * sg * t0 * (1 - t0), y1 = -4 * sg * t1 * (1 - t1);
        const a0 = u0 + t0 * spanLen, a1 = u0 + t1 * spanLen;
        const mid = (a0 + a1) / 2, my = (y0 + y1) / 2;
        const dl = Math.hypot(a1 - a0, y1 - y0);
        const ang = Math.atan2(y1 - y0, a1 - a0);
        b.add(cpipe(b, radius, dl, 6, 'rubber'), 'rubber', {
          pos: f.p(mid, my, lz), rot: [0, rotY, -Math.PI / 2 - ang], collide: false,
        });
      }
    }
    // Bracket at the span start.
    fbox(b, f, 0.07, 0.14, cables * radius * 3 + 0.14, u0, 0.04, 0, 'metal_rusted', { chamfer: 0.01 });
    if (rng() < 0.35) {
      fbox(b, f, 0.22, 0.3, 0.14, u0, -0.24, 0, 'sheet_metal_bare', { chamfer: 0.018 });
      fbox(b, f, 0.16, 0.02, 0.1, u0, -0.24, 0.08, 'warning_stripe', { chamfer: 0.004 });
    }
  }
  fbox(b, f, 0.07, 0.14, cables * radius * 3 + 0.14, len / 2, 0.04, 0, 'metal_rusted', { chamfer: 0.01 });
}

/** Small-bore conduit clipped to a wall, with saddles and junction boxes. */
export function conduitRun(b, rng, o) {
  const { x, y, z, rotY = 0, len = 8, count = 2, standoff = 0.06, vertical = false, radius = 0.026 } = o;
  const f = frame(x, y, z, rotY);
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * 0.09;
    if (vertical) fpipe(b, f, radius, len, off, len / 2, standoff, 'sheet_metal_bare', 'y', { segments: 8 });
    else fpipe(b, f, radius, len, 0, off, standoff, 'sheet_metal_bare', 'x', { segments: 8 });
  }
  const n = Math.max(2, Math.round(len / 1.4));
  for (let i = 0; i <= n; i++) {
    const u = -len / 2 + i * len / n;
    if (vertical) fbox(b, f, count * 0.09 + 0.08, 0.03, standoff + 0.02, 0, u + len / 2, standoff / 2, 'metal_rusted', { chamfer: 0.005 });
    else fbox(b, f, 0.03, count * 0.09 + 0.08, standoff + 0.02, u, 0, standoff / 2, 'metal_rusted', { chamfer: 0.005 });
  }
  // Junction / isolator boxes.
  for (let i = 0; i < 1 + ((rng() * 2) | 0); i++) {
    const u = R(rng, -len * 0.4, len * 0.4);
    if (vertical) fbox(b, f, 0.2, 0.26, 0.11, 0, len / 2 + u, standoff + 0.05, 'sheet_metal_bare', { chamfer: 0.014 });
    else fbox(b, f, 0.26, 0.2, 0.11, u, 0, standoff + 0.05, 'sheet_metal_bare', { chamfer: 0.014 });
  }
}

// --------------------------------------------------------------- plant ----

/** Wall-mounted split-system condenser: casing, fan grille, brackets, pipes. */
export function airCon(b, rng, o) {
  const { x, y, z, rotY = 0, scale = 1 } = o;
  const f = frame(x, y, z, rotY);
  const W = 0.85 * scale, H = 0.62 * scale, D = 0.33 * scale;
  fbox(b, f, W, H, D, 0, 0, D / 2, 'sheet_metal_bare', { chamfer: 0.018, collide: true, surface: 'metal' });
  fbox(b, f, W * 0.98, H * 0.06, D * 1.04, 0, H * 0.42, D / 2, 'sheet_metal_bare', { chamfer: 0.008 });
  // Fan grille: a ring plus radial bars.
  b.add(ctorus(H * 0.34, 0.016 * scale, 4, 10), 'sheet_metal_bare', { pos: f.p(0, -0.02, D + 0.01), rot: [0, rotY, 0], collide: false });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI;
    fbox(b, f, H * 0.68, 0.012 * scale, 0.012 * scale, 0, -0.02, D + 0.008, 'sheet_metal_bare', { chamfer: 0.003, rot: [0, rotY, a] });
  }
  fpipe(b, f, H * 0.09, 0.06 * scale, 0, -0.02, D + 0.02, 'sheet_metal_bare', 'z', { segments: 10 });
  // Wall brackets.
  for (const sx of [-1, 1]) {
    fbox(b, f, 0.05 * scale, 0.05 * scale, D * 1.1, sx * W * 0.4, -H / 2 - 0.03, D * 0.5, 'metal_rusted', { chamfer: 0.006 });
    fbox(b, f, 0.05 * scale, H * 0.5, 0.05 * scale, sx * W * 0.4, -H / 2 - 0.2, 0.04, 'metal_rusted', { chamfer: 0.006, rot: [0, rotY, -0.5] });
  }
  // Lagged pipework dropping away from it.
  fpipe(b, f, 0.035 * scale, 0.5 * scale, W * 0.3, -H / 2 - 0.25, 0.08, 'sheet_metal_bare', 'y', { segments: 8 });
  fpipe(b, f, 0.02 * scale, 0.6 * scale, W * 0.38, -H / 2 - 0.3, 0.08, 'rubber', 'y', { segments: 6 });
  // Rust runoff below.
  fbox(b, f, W * 0.5, 1.2 * scale, 0.012, 0, -H / 2 - 0.65, 0.012, 'dirt_dark', { chamfer: 0.02 });
}

/** Skid-mounted diesel generator in a canopy. */
export function generator(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, scale = 1 } = o;
  const f = frame(x, y, z, rotY);
  const W = 3.3 * scale, H = 1.75 * scale, D = 1.3 * scale;
  // Skid + fuel tank base.
  fbox(b, f, W, 0.22 * scale, D, 0, 0.11 * scale, 0, 'metal_rusted', { chamfer: 0.02, collide: true, surface: 'metal' });
  fbox(b, f, W * 0.94, 0.34 * scale, D * 0.9, 0, 0.4 * scale, 0, 'sheet_metal_bare', { chamfer: 0.03, collide: true, surface: 'metal' });
  // Canopy.
  fbox(b, f, W * 0.92, H * 0.62, D * 0.88, 0, 0.57 * scale + H * 0.31, 0, 'paint_green', { chamfer: 0.035, collide: true, surface: 'metal' });
  fbox(b, f, W * 0.96, 0.07 * scale, D * 0.94, 0, 0.57 * scale + H * 0.62 + 0.03 * scale, 0, 'paint_green', { chamfer: 0.02 });
  // Louvre banks on both long sides.
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      fbox(b, f, W * 0.3, 0.045 * scale, 0.03 * scale, -W * 0.28, 0.72 * scale + i * 0.062 * scale, sz * D * 0.445, 'sheet_metal_bare', { chamfer: 0.006, rot: [0.35, rotY, 0] });
    }
    // Control panel / access door.
    fbox(b, f, W * 0.26, H * 0.4, 0.03 * scale, W * 0.24, 1.15 * scale, sz * D * 0.45, 'sheet_metal_bare', { chamfer: 0.008 });
    fbox(b, f, W * 0.16, H * 0.16, 0.02 * scale, W * 0.24, 1.28 * scale, sz * D * 0.47, 'rubber', { chamfer: 0.006 });
    fbox(b, f, 0.06 * scale, 0.16 * scale, 0.04 * scale, W * 0.36, 1.1 * scale, sz * D * 0.47, 'sheet_metal_bare', { chamfer: 0.008 });
  }
  // Exhaust stack with a rain cap, and a silencer box.
  fpipe(b, f, 0.09 * scale, 1.15 * scale, -W * 0.3, 0.57 * scale + H * 0.62 + 0.6 * scale, D * 0.2, 'metal_rusted', 'y', { segments: 10 });
  fpipe(b, f, 0.14 * scale, 0.1 * scale, -W * 0.3, 0.57 * scale + H * 0.62 + 1.18 * scale, D * 0.2, 'metal_rusted', 'y', { segments: 10 });
  fbox(b, f, 0.6 * scale, 0.28 * scale, 0.28 * scale, -W * 0.3, 0.57 * scale + H * 0.62 + 0.12 * scale, D * 0.2, 'metal_rusted', { chamfer: 0.03 });
  // Lifting eyes and hazard markings.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.add(ctorus(0.06 * scale, 0.016 * scale, 4, 10), 'sheet_metal_bare',
      { pos: f.p(sx * W * 0.4, 0.57 * scale + H * 0.62 + 0.09 * scale, sz * D * 0.35), rot: [0, rotY, 0], collide: false });
  }
  fbox(b, f, W * 0.9, 0.09 * scale, 0.012, 0, 0.26 * scale, D * 0.46, 'warning_stripe', { chamfer: 0.004 });
  // Cable dropping out of the base, and an oil stain.
  fpipe(b, f, 0.035 * scale, 0.9 * scale, W * 0.44, 0.3 * scale, 0, 'rubber', 'y', { segments: 6 });
  b.add(cbox(b, 1.5 * scale, 0.014, 1.1 * scale, 'dirt_dark', 0.1), 'dirt_dark', {
    pos: f.p(-W * 0.2, 0.008, D * 0.75), rotY, collide: false,
  });
  contactDress(b, rng, { x, z, y, w: W + 0.5, d: D + 0.5, rotY, amount: 1.1, frags: 6 });
}

/** Caged rack of industrial gas cylinders, chained. */
export function gasBottleRack(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, bays = 2 } = o;
  const f = frame(x, y, z, rotY);
  const W = bays * 0.78, H = 1.75, D = 0.55;
  // Frame: corner angles, top and bottom rails, back mesh.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    fbox(b, f, 0.05, H, 0.05, sx * W / 2, H / 2, sz * D / 2, 'painted_steel_yellow', { chamfer: 0.008, collide: true, surface: 'metal' });
  }
  for (const ly of [0.08, H - 0.06, H * 0.55]) {
    for (const sz of [-1, 1]) fbox(b, f, W, 0.05, 0.05, 0, ly, sz * D / 2, 'painted_steel_yellow', { chamfer: 0.008 });
    for (const sx of [-1, 1]) fbox(b, f, 0.05, 0.05, D, sx * W / 2, ly, 0, 'painted_steel_yellow', { chamfer: 0.008 });
  }
  fbox(b, f, W - 0.05, H - 0.1, 0.02, 0, H / 2, -D / 2 + 0.02, 'chainlink', { chamfer: 0 });
  fbox(b, f, W, 0.06, D, 0, 0.13, 0, 'metal_grate', { chamfer: 0.008, collide: true, surface: 'metal' });

  const cols = ['paint_red', 'paint_green', 'painted_steel_blue', 'sheet_metal_bare', 'sheet_metal_bare'];
  for (let bidx = 0; bidx < bays; bidx++) {
    const bx = -W / 2 + 0.39 + bidx * 0.78;
    for (let i = 0; i < 4; i++) {
      if (rng() < 0.12) continue;
      const cx = bx + (i % 2 ? 0.21 : -0.21) + R(rng, -0.03, 0.03);
      const cz = (i < 2 ? -0.13 : 0.13) + R(rng, -0.03, 0.03);
      const m = cols[(rng() * cols.length) | 0];
      fpipe(b, f, 0.1145, 1.32, cx, 0.16 + 0.66, cz, m, 'y', { segments: 12, collide: false });
      fpipe(b, f, 0.09, 0.14, cx, 0.16 + 1.36, cz, m, 'y', { segments: 12 });
      fpipe(b, f, 0.035, 0.14, cx, 0.16 + 1.48, cz, 'sheet_metal_bare', 'y', { segments: 8 });
      fbox(b, f, 0.09, 0.09, 0.05, cx, 0.16 + 1.5, cz + 0.07, 'sheet_metal_bare', { chamfer: 0.01 });
    }
    // Retaining chain across the bay.
    fbox(b, f, 0.72, 0.02, 0.02, bx, 1.15, D / 2 - 0.05, 'metal_rusted', { chamfer: 0.005 });
  }
  fbox(b, f, 0.4, 0.28, 0.012, 0, H + 0.16, -D / 2, 'warning_stripe', { chamfer: 0.006 });
  contactDress(b, rng, { x, z, y, w: W + 0.4, d: D + 0.4, rotY, amount: 0.9, frags: 4 });
}

/** Timber cable drum, with cable actually coiled on it. */
export function cableDrum(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, radius = 0.85, width = 0.72, onSide = false } = o;
  const f = frame(x, y, z, rotY);
  const seg = 20;
  if (onSide) {
    // Lying flat like a table — the classic yard bench.
    for (const u of [-width / 2, width / 2]) {
      fpipe(b, f, radius, 0.07, 0, radius * 0 + 0.035 + (u + width / 2), 0, 'wood_plank', 'y', { segments: seg, collide: true });
    }
    fpipe(b, f, radius * 0.4, width, 0, width / 2, 0, 'wood_plank', 'y', { segments: 14, collide: true });
    for (let i = 0; i < 5; i++) {
      fpipe(b, f, radius * 0.42 + i * 0.032, 0.03, 0, width - 0.05 - i * 0.033, 0, 'rubber', 'y', { segments: 16 });
    }
    contactDress(b, rng, { x, z, y, w: radius * 2.2, round: true, amount: 0.9, frags: 4 });
    return;
  }
  // Standing on its rim.
  for (const u of [-width / 2, width / 2]) {
    fpipe(b, f, radius, 0.075, u, radius, 0, 'wood_plank', 'x', { segments: seg, collide: true });
    // Flange battens.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI;
      fbox(b, f, 0.03, radius * 1.9, 0.075, u + (u > 0 ? 0.05 : -0.05), radius, 0, 'wood_plank', { chamfer: 0.006, rot: [0, rotY, a] });
    }
  }
  fpipe(b, f, radius * 0.36, width - 0.16, 0, radius, 0, 'wood_plank', 'x', { segments: 14, collide: true });
  // Coiled cable.
  for (let i = 0; i < 7; i++) {
    fpipe(b, f, radius * 0.38 + i * 0.035, width - 0.2, 0, radius, 0, 'rubber', 'x', { segments: 18, capped: false });
  }
  // Centre hole and a stencil.
  fpipe(b, f, 0.075, width + 0.02, 0, radius, 0, 'rubber', 'x', { segments: 10 });
  fbox(b, f, 0.02, 0.3, 0.4, width / 2 + 0.05, radius, 0, 'sheet_metal_bare', { chamfer: 0.004 });
  // Chock so it does not read as balanced on a knife edge.
  fbox(b, f, width * 0.5, 0.1, 0.28, 0, 0.05, radius * 0.92, 'wood_plank', { chamfer: 0.012, rot: [0, rotY, 0] });
  contactDress(b, rng, { x, z, y, w: width + 0.5, d: radius * 2 + 0.4, rotY, amount: 0.9, frags: 4 });
}

/** Steel ladder: rails, rungs, wall standoffs, optional safety hoops. */
export function ladder(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, height = 4.0, width = 0.46, cage = false, mat = 'metal_rusted', lean = 0 } = o;
  const f = frame(x, y, z, rotY);
  const rot = lean ? [lean, rotY, 0] : null;
  const dz = (ly) => lean ? -Math.sin(lean) * ly : 0;
  for (const sx of [-1, 1]) {
    b.add(cbox(b, 0.05, height, 0.09, mat, 0.008), mat, {
      pos: f.p(sx * width / 2, height / 2, dz(height / 2)), rot, rotY, collide: true, surface: 'metal',
    });
  }
  const rungs = Math.floor(height / 0.3);
  for (let i = 1; i < rungs; i++) {
    const ly = i * 0.3;
    fpipe(b, f, 0.017, width, 0, ly, dz(ly), mat, 'x', { segments: 7 });
  }
  for (const ly of [0.35, height - 0.4]) {
    for (const sx of [-1, 1]) fbox(b, f, 0.05, 0.05, 0.18, sx * width / 2, ly, dz(ly) - 0.13, mat, { chamfer: 0.008 });
  }
  if (cage) {
    for (let i = 0; i < Math.floor((height - 2.2) / 0.7); i++) {
      const ly = 2.2 + i * 0.7;
      b.add(ctorus(0.38, 0.014, 4, 10, Math.PI * 1.25), mat,
        { pos: f.p(0, ly, dz(ly) + 0.2), rot: [0, rotY + Math.PI / 2, Math.PI * 0.375], collide: false });
    }
    for (const sx of [-1, 1]) {
      fbox(b, f, 0.03, height - 2.4, 0.03, sx * 0.36, height / 2 + 1.1, 0.36, mat, { chamfer: 0.005 });
    }
  }
}

/** A tarp thrown over a stack, sagging between the high points, roped down. */
export function tarpCover(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, w = 2.4, d = 1.8, h = 1.1, mat = 'tarp', fill = true } = o;
  const f = frame(x, y, z, rotY);
  if (fill) {
    // What is under the tarp — an uneven stack, so the drape has a reason.
    let ly = 0;
    for (let i = 0; i < 3; i++) {
      const hh = h * R(rng, 0.22, 0.34);
      fbox(b, f, w * R(rng, 0.72, 0.92), hh, d * R(rng, 0.72, 0.92), R(rng, -0.1, 0.1), ly + hh / 2, R(rng, -0.08, 0.08),
        pick(rng, ['wood_crate', 'wood_plank', 'rebar_concrete']), { chamfer: 0.02, dyaw: R(rng, -0.15, 0.15), collide: true, surface: 'wood' });
      ly += hh;
    }
  }
  // The drape: a coarse grid of quads whose height falls off toward the edges.
  const nx = 5, nz = 4;
  const hgt = (u, v) => {
    const e = Math.max(Math.abs(u), Math.abs(v));
    return h * (1 - Math.pow(e, 2.1)) * R(rng, 0.97, 1.03) - 0.02 * Math.cos(u * 5) * Math.cos(v * 4);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const u = (i / (nx - 1)) * 2 - 1, v = (j / (nz - 1)) * 2 - 1;
      const uu = (i + 0.5) / nx * 2 - 1, vv = (j + 0.5) / nz * 2 - 1;
      const hh = hgt(uu, vv);
      const dxU = (hgt(uu + 0.2, vv) - hgt(uu - 0.2, vv)) / (0.4 * w / 2);
      const dxV = (hgt(uu, vv + 0.2) - hgt(uu, vv - 0.2)) / (0.4 * d / 2);
      b.add(cbox(b, w / nx * 1.18, 0.035, d / nz * 1.18, mat, 0.02), mat, {
        pos: f.p(uu * w / 2, Math.max(0.03, hh), vv * d / 2),
        rot: [Math.atan(dxV), rotY, -Math.atan(dxU)],
        collide: false,
      });
    }
  }
  // Eyelets and tie-down ropes at the corners.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const hx = sx * w / 2, hz = sz * d / 2;
    fpipe(b, f, 0.012, 0.55, hx * 1.06, 0.28, hz * 1.06, 'rubber', 'y', { segments: 5, });
    fbox(b, f, 0.08, 0.06, 0.08, hx * 1.12, 0.03, hz * 1.12, 'rebar_concrete', { chamfer: 0.015 });
  }
  contactDress(b, rng, { x, z, y, w: w + 0.4, d: d + 0.4, rotY, amount: 0.8, frags: 4 });
}

/** A rubble mound with real thickness — chunks, not intersecting planes. */
export function rubblePile(b, rng, o) {
  const { x, y = 0.1, z, radius = 2.2, height = 0.9, count = 17, rebar = 4, dust = true } = o;
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU;
    const rr = Math.pow(rng(), 0.65) * radius;
    const t = 1 - rr / radius;
    const s = R(rng, 0.14, 0.55) * (0.5 + t * 0.9);
    const ly = y + t * height * R(rng, 0.15, 0.95) + s * 0.3;
    const m = rng() < 0.68 ? 'rebar_concrete' : 'concrete_stained';
    b.add(cbox(b, s * R(rng, 0.8, 1.9), s * R(rng, 0.45, 0.95), s * R(rng, 0.8, 1.6), m, s * 0.16), m, {
      pos: [x + Math.cos(a) * rr, ly, z + Math.sin(a) * rr],
      rot: [R(rng, -0.55, 0.55), rng() * TAU, R(rng, -0.55, 0.55)],
      collide: rr < radius * 0.3 && ly < y + height,
      surface: 'concrete',
    });
  }
  // Broken slab sections leaning out of it.
  for (let i = 0; i < 3; i++) {
    const a = rng() * TAU, rr = radius * R(rng, 0.2, 0.6);
    b.add(cbox(b, R(rng, 0.9, 2.0), R(rng, 0.1, 0.2), R(rng, 0.7, 1.5), 'rebar_concrete', 0.04), 'rebar_concrete', {
      pos: [x + Math.cos(a) * rr, y + height * R(rng, 0.3, 0.8), z + Math.sin(a) * rr],
      rot: [R(rng, -0.7, 0.7), rng() * TAU, R(rng, -0.7, 0.7)], collide: true, surface: 'concrete',
    });
  }
  for (let i = 0; i < rebar; i++) {
    const a = rng() * TAU, rr = radius * rng() * 0.8;
    b.add(cpipe(b, 0.014, R(rng, 0.5, 1.7), 5, 'metal_rusted'), 'metal_rusted', {
      pos: [x + Math.cos(a) * rr, y + height * R(rng, 0.3, 0.9), z + Math.sin(a) * rr],
      rot: [R(rng, -1.1, 1.1), rng() * TAU, R(rng, -1.1, 1.1)], collide: false,
    });
  }
  if (dust) {
    for (let i = 0; i < 5; i++) {
      const a = rng() * TAU, rr = radius * R(rng, 0.85, 1.5);
      b.add(cbox(b, R(rng, 0.5, 1.4), R(rng, 0.02, 0.07), R(rng, 0.3, 0.8), 'dust', 0.05), 'dust', {
        pos: [x + Math.cos(a) * rr, y + 0.02, z + Math.sin(a) * rr], rotY: rng() * TAU, collide: false,
      });
    }
  }
}

/** Builder's skip / dumpster: tapered body, ribs, hook bars, lid. */
export function dumpster(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, len = 3.0, mat = 'paint_green', full = true } = o;
  const f = frame(x, y, z, rotY);
  const H = 1.25, Dbot = 1.35, Dtop = 1.75;
  // Body: stacked courses widening upward gives the skip taper.
  const courses = 5;
  for (let i = 0; i < courses; i++) {
    const t = i / (courses - 1);
    const dd = Dbot + (Dtop - Dbot) * t;
    const ll = len * (0.9 + 0.1 * t);
    fbox(b, f, ll, H / courses + 0.01, dd, 0, 0.14 + (i + 0.5) * H / courses, 0, mat,
      { chamfer: 0.02, collide: i < 3, surface: 'metal' });
  }
  fbox(b, f, len * 0.94, H, Dtop * 0.9, 0, 0.14 + H / 2 + 0.06, 0, 'rubber', { chamfer: 0.03 });
  // Top rail and vertical ribs.
  fbox(b, f, len + 0.04, 0.09, Dtop + 0.04, 0, 0.14 + H + 0.02, 0, 'metal_rusted', { chamfer: 0.02, collide: true, surface: 'metal' });
  for (let i = 0; i < 7; i++) {
    const u = -len / 2 + 0.2 + i * (len - 0.4) / 6;
    for (const sz of [-1, 1]) fbox(b, f, 0.07, H, 0.05, u, 0.14 + H / 2, sz * (Dtop * 0.5 - 0.02), mat, { chamfer: 0.01 });
  }
  // Runners and hook bars.
  for (const sz of [-1, 1]) {
    fbox(b, f, len, 0.11, 0.14, 0, 0.07, sz * Dbot * 0.36, 'metal_rusted', { chamfer: 0.015, collide: true, surface: 'metal' });
    fpipe(b, f, 0.03, 0.5, 0, 0.62, sz * (Dtop * 0.5 + 0.06), 'metal_rusted', 'z', { segments: 8 });
  }
  for (const sx of [-1, 1]) {
    fbox(b, f, 0.1, 0.5, 0.1, sx * (len / 2 - 0.1), 0.4, 0, 'metal_rusted', { chamfer: 0.012, rot: [0, rotY, sx * 0.35] });
  }
  if (full) {
    for (let i = 0; i < 10; i++) {
      const s = R(rng, 0.2, 0.6);
      const m = pick(rng, ['wood_plank', 'rebar_concrete', 'sheet_metal_bare', 'brick_red', 'tarp']);
      fbox(b, f, s * R(rng, 0.8, 2.2), s * R(rng, 0.2, 0.6), s * R(rng, 0.6, 1.4),
        R(rng, -len * 0.4, len * 0.4), 0.14 + H + R(rng, -0.1, 0.28), R(rng, -Dtop * 0.35, Dtop * 0.35), m,
        { chamfer: 0.02, rot: [R(rng, -0.5, 0.5), rotY + rng() * TAU, R(rng, -0.5, 0.5)] });
    }
    for (let i = 0; i < 3; i++) {
      fpipe(b, f, 0.014, R(rng, 0.6, 1.6), R(rng, -1, 1), 0.14 + H + 0.2, R(rng, -0.5, 0.5), 'metal_rusted', 'z',
        { segments: 5, });
    }
  }
  fbox(b, f, 0.7, 0.26, 0.012, 0, 0.8, Dtop * 0.5 + 0.03, 'sheet_metal_bare', { chamfer: 0.004 });
  contactDress(b, rng, { x, z, y, w: len + 0.5, d: Dtop + 0.5, rotY, amount: 1.0, frags: 6 });
}

/** Sign on posts, or bolted flat to a wall. */
export function signage(b, rng, o) {
  const {
    x, y = 0.1, z, rotY = 0, w = 1.4, h = 0.95, height = 2.1,
    mat = 'warning_stripe', posts = true, wallMount = false, frameMat = 'metal_rusted',
  } = o;
  const f = frame(x, y, z, rotY);
  const cy = wallMount ? height : height;
  fbox(b, f, w, h, 0.035, 0, cy, 0, mat, { chamfer: 0.01 });
  // Frame angle around the board + backing rails.
  for (const sy of [-1, 1]) fbox(b, f, w + 0.05, 0.045, 0.06, 0, cy + sy * h / 2, 0, frameMat, { chamfer: 0.008 });
  for (const sx of [-1, 1]) fbox(b, f, 0.045, h + 0.05, 0.06, sx * w / 2, cy, 0, frameMat, { chamfer: 0.008 });
  fbox(b, f, w * 0.9, 0.05, 0.05, 0, cy, -0.05, frameMat, { chamfer: 0.008 });
  // Bolt heads.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    fpipe(b, f, 0.016, 0.02, sx * (w / 2 - 0.07), cy + sy * (h / 2 - 0.07), 0.028, 'sheet_metal_bare', 'z', { segments: 6 });
  }
  if (posts && !wallMount) {
    for (const sx of [-1, 1]) {
      fbox(b, f, 0.07, cy + h / 2, 0.07, sx * w * 0.34, (cy + h / 2) / 2, -0.05, frameMat, { chamfer: 0.01, collide: true, surface: 'metal' });
      fbox(b, f, 0.24, 0.14, 0.24, sx * w * 0.34, 0.07, -0.05, 'concrete_stained', { chamfer: 0.02, collide: true });
    }
    contactDress(b, rng, { x, z, y, w: w * 0.9, d: 0.5, rotY, amount: 0.6, frags: 3 });
  } else if (wallMount) {
    for (const sx of [-1, 1]) fbox(b, f, 0.05, 0.05, 0.1, sx * w * 0.4, cy, -0.07, frameMat, { chamfer: 0.008 });
  }
}

/** Elevated water tank on a steel stand. */
export function waterTank(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, radius = 1.3, height = 2.4, standH = 2.6 } = o;
  const f = frame(x, y, z, rotY);
  const seg = 18;
  // Stand: four splayed legs, two rings of bracing, diagonal cross-bracing.
  const legOff = radius * 0.78;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    fbox(b, f, 0.12, standH, 0.12, sx * legOff, standH / 2, sz * legOff, 'painted_steel_yellow',
      { chamfer: 0.014, rot: [sz * 0.045, rotY, -sx * 0.045], collide: true, surface: 'metal' });
    fbox(b, f, 0.3, 0.1, 0.3, sx * legOff * 1.1, 0.05, sz * legOff * 1.1, 'concrete_stained', { chamfer: 0.02, collide: true });
  }
  for (const ly of [standH * 0.35, standH * 0.78]) {
    for (const sz of [-1, 1]) fbox(b, f, legOff * 2, 0.08, 0.08, 0, ly, sz * legOff, 'painted_steel_yellow', { chamfer: 0.01 });
    for (const sx of [-1, 1]) fbox(b, f, 0.08, 0.08, legOff * 2, sx * legOff, ly, 0, 'painted_steel_yellow', { chamfer: 0.01 });
  }
  for (const sz of [-1, 1]) for (const s of [-1, 1]) {
    const dl = Math.hypot(legOff * 2, standH * 0.43);
    fbox(b, f, dl, 0.05, 0.05, 0, standH * 0.565, sz * legOff, 'painted_steel_yellow',
      { chamfer: 0.008, rot: [0, rotY, s * Math.atan2(standH * 0.43, legOff * 2)] });
  }
  // Tank body: courses with a visible weld seam ring between them.
  const courses = 3;
  for (let i = 0; i < courses; i++) {
    fpipe(b, f, radius, height / courses, 0, standH + (i + 0.5) * height / courses, 0, 'metal_rusted', 'y',
      { segments: seg, collide: true });
    fpipe(b, f, radius + 0.02, 0.05, 0, standH + (i + 1) * height / courses, 0, 'metal_rusted', 'y', { segments: seg });
  }
  fpipe(b, f, radius * 0.55, 0.28, 0, standH + height + 0.14, 0, 'metal_rusted', 'y', { segments: seg });
  fpipe(b, f, radius * 0.2, 0.16, 0, standH + height + 0.34, 0, 'sheet_metal_bare', 'y', { segments: 10 });
  // Downpipe + valve, overflow, and rust runoff.
  fpipe(b, f, 0.07, standH + 0.6, radius * 0.72, (standH + 0.6) / 2, 0, 'metal_rusted', 'y', { segments: 10 });
  fbox(b, f, 0.18, 0.18, 0.18, radius * 0.72, 1.1, 0, 'paint_red', { chamfer: 0.02 });
  fpipe(b, f, 0.045, height * 0.8, -radius * 0.9, standH + height * 0.5, 0, 'metal_rusted', 'y', { segments: 8 });
  for (let i = 0; i < 5; i++) {
    const a = rng() * TAU;
    fbox(b, f, 0.1, height * R(rng, 0.3, 0.9), 0.01,
      Math.cos(a) * radius * 1.005, standH + height * 0.55, Math.sin(a) * radius * 1.005, 'dirt_dark',
      { chamfer: 0.01, rot: [0, rotY - a + Math.PI / 2, 0] });
  }
  ladder(b, rng, { x: f.p(-radius - 0.06, 0, 0)[0], y, z: f.p(-radius - 0.06, 0, 0)[2], rotY: rotY + Math.PI / 2, height: standH + height * 0.9, cage: false });
  contactDress(b, rng, { x, z, y, w: radius * 2.4, round: true, amount: 1.0, frags: 6 });
}

/** Rectangular HVAC ducting with flanged joints and drop-rod hangers. */
export function ducting(b, rng, o) {
  const { x, y, z, rotY = 0, len = 12, w = 0.55, h = 0.42, hangers = true, hangTo = 1.4, mat = 'sheet_metal_bare' } = o;
  const f = frame(x, y, z, rotY);
  const sections = Math.max(2, Math.round(len / 1.6));
  for (let i = 0; i < sections; i++) {
    const u = -len / 2 + (i + 0.5) * len / sections;
    fbox(b, f, len / sections - 0.03, h, w, u, 0, 0, mat, { chamfer: 0.012 });
    fbox(b, f, 0.04, h + 0.06, w + 0.06, u + len / sections / 2, 0, 0, mat, { chamfer: 0.008 });
  }
  fbox(b, f, 0.04, h + 0.06, w + 0.06, -len / 2, 0, 0, mat, { chamfer: 0.008 });
  if (hangers) {
    for (let i = 0; i <= sections; i += 2) {
      const u = -len / 2 + i * len / sections;
      for (const sz of [-1, 1]) fpipe(b, f, 0.012, hangTo, u, h / 2 + hangTo / 2, sz * w * 0.55, 'sheet_metal_bare', 'y', { segments: 6 });
      fbox(b, f, 0.05, 0.04, w * 1.25, u, -h / 2 - 0.02, 0, 'metal_rusted', { chamfer: 0.006 });
    }
  }
}

// -------------------------------------------------------------- racking ---

/**
 * Real pallet racking. Uprights are built as C-sections (web + two flanges)
 * with lattice bracing, box beams have end connectors, levels are timber
 * decked, and every column gets a yellow guard at floor level.
 *
 * @param o {x, y, z, rotY, bays, bayLen, depth, height, levels, fill}
 */
export function racking(b, rng, o) {
  const {
    x, y = 0.1, z, rotY = 0, bays = 4, bayLen = 2.7, depth = 1.1,
    height = 6.4, levels = [0.15, 2.05, 3.95, 5.6], fill = 0.72, doubleSided = false,
  } = o;
  const f = frame(x, y, z, rotY);
  const totalLen = bays * bayLen;
  const frames = bays + 1;

  for (let i = 0; i < frames; i++) {
    const u = -totalLen / 2 + i * bayLen;
    for (const sz of [-1, 1]) {
      // C-section column: web + two flanges.
      fbox(b, f, 0.02, height, 0.09, u, height / 2, sz * depth / 2, 'painted_steel_blue', { chamfer: 0.004, collide: sz > 0, surface: 'metal' });
      for (const s2 of [-1, 1]) {
        fbox(b, f, 0.045, height, 0.018, u + s2 * 0.028, height / 2, sz * depth / 2 + (sz > 0 ? 0.036 : -0.036), 'painted_steel_blue', { chamfer: 0.004 });
      }
      // Base plate + floor bolts.
      fbox(b, f, 0.14, 0.02, 0.16, u, 0.01, sz * depth / 2, 'sheet_metal_bare', { chamfer: 0.004 });
      for (const s2 of [-1, 1]) fpipe(b, f, 0.011, 0.04, u + s2 * 0.045, 0.03, sz * depth / 2, 'sheet_metal_bare', 'y', { segments: 6 });
      // Column guard.
      fbox(b, f, 0.13, 0.42, 0.05, u, 0.21, sz * (depth / 2 + 0.09), 'painted_steel_yellow', { chamfer: 0.012 });
    }
    // Lattice bracing between the two columns of a frame.
    const steps = Math.floor(height / 1.25);
    for (let s = 0; s < steps; s++) {
      const ly = 0.22 + s * 0.75;
      fbox(b, f, 0.035, 0.035, depth - 0.1, u, ly, 0, 'painted_steel_blue', { chamfer: 0.005 });
      const dl = Math.hypot(depth - 0.1, 1.25);
      fbox(b, f, 0.035, 0.035, dl, u, ly + 0.625, 0, 'painted_steel_blue',
        { chamfer: 0.005, rot: [(s % 2 ? 1 : -1) * Math.atan2(1.25, depth - 0.1), rotY, 0] });
    }
    fbox(b, f, 0.035, 0.035, depth - 0.1, u, height - 0.1, 0, 'painted_steel_blue', { chamfer: 0.005 });
  }

  // Beams and decking.
  for (let li = 0; li < levels.length; li++) {
    const ly = levels[li];
    if (ly < 0.3) continue;
    for (let bi = 0; bi < bays; bi++) {
      const cu = -totalLen / 2 + (bi + 0.5) * bayLen;
      for (const sz of [-1, 1]) {
        fbox(b, f, bayLen - 0.07, 0.11, 0.055, cu, ly, sz * (depth / 2 - 0.03), 'painted_steel_yellow',
          { chamfer: 0.01, collide: true, surface: 'metal' });
        // End connectors.
        for (const sx of [-1, 1]) fbox(b, f, 0.03, 0.16, 0.075, cu + sx * (bayLen / 2 - 0.035), ly, sz * (depth / 2 - 0.03), 'painted_steel_yellow', { chamfer: 0.006 });
      }
      // Timber deck boards with gaps.
      const boards = 3;
      for (let d2 = 0; d2 < boards; d2++) {
        const lz = -depth / 2 + 0.15 + d2 * (depth - 0.3) / (boards - 1);
        fbox(b, f, bayLen - 0.09, 0.028, (depth - 0.3) / boards * 0.82, cu, ly + 0.07, lz, 'wood_plank', { chamfer: 0.005 });
      }
      // Load.
      if (rng() < fill) {
        const px = f.p(cu, 0, 0);
        loadedPallet(b, rng, { x: px[0], y: y + ly + 0.085, z: px[2], rotY: rotY + R(rng, -0.06, 0.06), kind: (rng() * 4) | 0, ground: false });
      } else if (rng() < 0.4) {
        const px = f.p(cu + R(rng, -0.4, 0.4), 0, 0);
        pallet(b, rng, { x: px[0], y: y + ly + 0.085, z: px[2], rotY: rotY + R(rng, -0.2, 0.2), simple: true });
      }
    }
  }
  // Aisle floor marking along the front.
  const px0 = f.p(0, 0, depth / 2 + 0.55);
  b.add(cbox(b, totalLen, 0.012, 0.1, 'road_marking', 0.004), 'road_marking', {
    pos: [px0[0], y + 0.006, px0[2]], rotY, collide: false,
  });
  contactDress(b, rng, { x, z, y, w: totalLen + 0.4, d: depth + 1.0, rotY, amount: 0.6, frags: 6 });
  if (doubleSided) { /* caller places a second rack back-to-back */ }
}

// ---------------------------------------------------------------- lights ---

/**
 * Industrial pendant lamp. The shade is opaque metal, the *lens* is emissive —
 * without a visible source a lit interior reads as ambient fog.
 * Returns the world position for the caller's PointLight.
 */
export function hangingLamp(b, rng, o) {
  const { x, y, z, drop = 1.4, radius = 0.44, mat = 'sheet_metal_bare' } = o;
  const f = frame(x, y, z, 0);
  fpipe(b, f, 0.026, drop, 0, -drop / 2, 0, 'metal_rusted', 'y', { segments: 6 });
  fbox(b, f, 0.14, 0.07, 0.14, 0, -0.03, 0, 'metal_rusted', { chamfer: 0.012 });
  fbox(b, f, 0.13, 0.12, 0.13, 0, -drop - 0.02, 0, 'sheet_metal_bare', { chamfer: 0.016 });
  // Conical shade, open at the bottom.
  const cone = new THREE.ConeGeometry(radius, 0.3, 10, 1, true);
  b.add(cone, mat, { pos: f.p(0, -drop - 0.2, 0), rot: [Math.PI, 0, 0], collide: false });
  // Rolled rim.
  b.add(ctorus(radius, 0.022, 4, 10), mat, { pos: f.p(0, -drop - 0.35, 0), rot: [Math.PI / 2, 0, 0], collide: false });
  // Emissive lens + a bright inner reflector so the shade is lit from inside.
  fpipe(b, f, radius * 0.42, 0.11, 0, -drop - 0.26, 0, 'lamp_glow', 'y', { segments: 14 });
  b.add(new THREE.ConeGeometry(radius * 0.9, 0.24, 10, 1, true), 'lamp_glow_dim',
    { pos: f.p(0, -drop - 0.22, 0), rot: [Math.PI, 0, 0], collide: false });
  // Wire cage under the lamp.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI;
    b.add(ctorus(radius * 0.55, 0.008, 4, 10, Math.PI), 'metal_rusted',
      { pos: f.p(0, -drop - 0.36, 0), rot: [0, a, 0], collide: false });
  }
  return [x, y - drop - 0.34, z];
}

/** Twin-head area floodlight on a bracket. */
export function floodlight(b, rng, o) {
  const { x, y, z, rotY = 0, heads = 2, size = 1 } = o;
  const f = frame(x, y, z, rotY);
  fbox(b, f, 0.09, 0.09, 0.5, 0, 0, 0.25, 'metal_rusted', { chamfer: 0.01 });
  for (let i = 0; i < heads; i++) {
    const lx = (i - (heads - 1) / 2) * 0.52 * size;
    fbox(b, f, 0.44 * size, 0.3 * size, 0.2 * size, lx, -0.1, 0.52, 'sheet_metal_bare', { chamfer: 0.02, rot: [0.35, rotY, 0] });
    fbox(b, f, 0.4 * size, 0.26 * size, 0.03 * size, lx, -0.14, 0.62, 'lamp_glow_cool', { chamfer: 0.008, rot: [0.35, rotY, 0] });
    fbox(b, f, 0.48 * size, 0.06 * size, 0.24 * size, lx, 0.06, 0.53, 'sheet_metal_bare', { chamfer: 0.01, rot: [0.35, rotY, 0] });
    fpipe(b, f, 0.014, 0.3, lx, -0.16, 0.3, 'rubber', 'z', { segments: 5 });
  }
  return f.p(0, -0.16, 0.7);
}

// -------------------------------------------------------- wall openings ---

/**
 * A window that has thickness. 320 mm of wall is a *lot* of depth to throw
 * away: the glazing sits 150 mm back, the jamb/head/sill returns are real
 * geometry, there is a projecting sill with a drip, a lintel over, a frame
 * with mullion and transom, four separately-breakable panes, and a dark box
 * behind so you are looking into a room rather than at the skybox.
 *
 * The frame's local +Z is the *outward* face normal.
 */
export function windowUnit(b, rng, o) {
  const {
    x, y, z, rotY = 0, w = 1.7, h = 1.5, thick = 0.32, inset = 0.15,
    revealMat = 'concrete_stained', frameMat = 'sheet_metal_bare',
    broken = 0.35, interior = true, sill = true, bars = false, boarded = false,
    cols = 2, rows = 2,
  } = o;
  const f = frame(x, y, z, rotY);
  const half = thick / 2;

  // --- reveal lining: a 40 mm liner set just inside the opening on all four
  //     sides, running the full wall depth. This is the piece that makes the
  //     wall read as 320 mm of material rather than a printed rectangle.
  const lt = 0.045;
  for (const sx of [-1, 1]) {
    fbox(b, f, lt, h + lt * 2, thick - 0.01, sx * (w / 2 - lt / 2), 0, 0, revealMat, { chamfer: 0.008 });
  }
  fbox(b, f, w, lt, thick - 0.01, 0, h / 2 - lt / 2, 0, revealMat, { chamfer: 0.008 });
  fbox(b, f, w, lt, thick - 0.01, 0, -h / 2 + lt / 2, 0, revealMat, { chamfer: 0.008 });

  // --- outer surround: proud architrave, catches a hard shadow line.
  fbox(b, f, w + 0.26, 0.08, 0.05, 0, h / 2 + 0.075, half + 0.02, revealMat, { chamfer: 0.012 });
  for (const sx of [-1, 1]) {
    fbox(b, f, 0.08, h + 0.15, 0.05, sx * (w / 2 + 0.07), 0, half + 0.02, revealMat, { chamfer: 0.012 });
  }
  // --- lintel over the head.
  fbox(b, f, w + 0.4, 0.16, thick + 0.06, 0, h / 2 + 0.18, 0, revealMat, { chamfer: 0.018 });

  // --- projecting sill, sloped, with a drip nib on the underside.
  if (sill) {
    fbox(b, f, w + 0.34, 0.07, thick + 0.18, 0, -h / 2 - 0.06, 0.03, revealMat, { chamfer: 0.014, rot: [-0.09, rotY, 0] });
    fbox(b, f, w + 0.34, 0.035, 0.03, 0, -h / 2 - 0.11, half + 0.1, 'dirt_dark', { chamfer: 0.006 });
    // Staining running down the wall from each end of the sill.
    for (const sx of [-1, 1]) {
      fbox(b, f, 0.1, R(rng, 0.4, 1.1), 0.012, sx * (w / 2 + 0.14), -h / 2 - 0.4, half + 0.005, 'dirt_dark', { chamfer: 0.01 });
    }
  }

  // --- the frame itself, set back.
  const fz = half - inset;
  const fw = 0.055;
  fbox(b, f, w - lt * 2 + 0.02, fw, 0.075, 0, h / 2 - lt - fw / 2, fz, frameMat, { chamfer: 0.008 });
  fbox(b, f, w - lt * 2 + 0.02, fw, 0.075, 0, -h / 2 + lt + fw / 2, fz, frameMat, { chamfer: 0.008 });
  for (const sx of [-1, 1]) {
    fbox(b, f, fw, h - lt * 2, 0.075, sx * (w / 2 - lt - fw / 2), 0, fz, frameMat, { chamfer: 0.008 });
  }
  const iw = w - lt * 2 - fw * 2, ih = h - lt * 2 - fw * 2;
  for (let c = 1; c < cols; c++) {
    fbox(b, f, 0.04, ih + fw, 0.07, -iw / 2 + c * iw / cols, 0, fz, frameMat, { chamfer: 0.006 });
  }
  for (let r = 1; r < rows; r++) {
    fbox(b, f, iw + fw, 0.04, 0.07, 0, -ih / 2 + r * ih / rows, fz, frameMat, { chamfer: 0.006 });
  }

  // --- panes, individually shot out.
  let anyOpen = false;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const px = -iw / 2 + (c + 0.5) * iw / cols;
      const py = -ih / 2 + (r + 0.5) * ih / rows;
      const gone = rng() < broken * 0.55;
      if (gone) { anyOpen = true; continue; }
      const br = rng() < broken;
      if (br) anyOpen = true;
      fbox(b, f, iw / cols - 0.045, ih / rows - 0.045, 0.012, px, py, fz - 0.012,
        br ? 'glass_broken' : 'glass_dirty', { chamfer: 0.003, collide: !br, surface: 'glass' });
    }
  }

  // --- interior: a dark box behind the opening so a broken pane shows a room.
  if (interior) {
    fbox(b, f, w + 0.1, h + 0.1, 0.06, 0, 0, -half - 0.5, 'rubber', { chamfer: 0.01 });
    for (const sx of [-1, 1]) fbox(b, f, 0.06, h + 0.1, 0.55, sx * (w / 2 + 0.02), 0, -half - 0.25, 'rubber', { chamfer: 0.01 });
    fbox(b, f, w + 0.1, 0.06, 0.55, 0, h / 2 + 0.02, -half - 0.25, 'rubber', { chamfer: 0.01 });
    fbox(b, f, w + 0.1, 0.06, 0.55, 0, -h / 2 - 0.02, -half - 0.25, 'rubber', { chamfer: 0.01 });
  }

  // --- security bars or boarding on some openings.
  if (bars) {
    for (let i = 0; i < 5; i++) {
      fpipe(b, f, 0.014, h - lt * 2, -iw / 2 + i * iw / 4, 0, half - 0.05, 'metal_rusted', 'y', { segments: 6 });
    }
    fbox(b, f, w - lt * 2, 0.03, 0.03, 0, 0, half - 0.05, 'metal_rusted', { chamfer: 0.005 });
  }
  if (boarded && anyOpen) {
    for (let i = 0; i < 3; i++) {
      fbox(b, f, w * R(rng, 0.7, 1.05), R(rng, 0.16, 0.26), 0.025, R(rng, -0.1, 0.1), R(rng, -h / 3, h / 3), fz + 0.06,
        'wood_plank', { chamfer: 0.006, rot: [0, rotY, R(rng, -0.14, 0.14)] });
    }
  }
}

/** A doorway with real jambs, a frame, a threshold and a leaf that hangs open. */
export function doorUnit(b, rng, o) {
  const {
    x, y, z, rotY = 0, w = 1.6, h = 2.24, thick = 0.32,
    revealMat = 'concrete_stained', frameMat = 'metal_rusted', leaves = 2,
    open = 0.7, interior = true, missing = false,
  } = o;
  const f = frame(x, y, z, rotY);
  const half = thick / 2;
  const lt = 0.06;
  for (const sx of [-1, 1]) fbox(b, f, lt, h, thick - 0.01, sx * (w / 2 - lt / 2), h / 2, 0, revealMat, { chamfer: 0.01 });
  fbox(b, f, w, lt, thick - 0.01, 0, h - lt / 2, 0, revealMat, { chamfer: 0.01 });
  fbox(b, f, w + 0.5, 0.2, thick + 0.08, 0, h + 0.1, 0, revealMat, { chamfer: 0.02 });   // lintel
  // Steel frame set into the reveal.
  const fz = half - 0.09;
  for (const sx of [-1, 1]) fbox(b, f, 0.07, h - lt, 0.11, sx * (w / 2 - lt - 0.035), (h - lt) / 2, fz, frameMat, { chamfer: 0.008 });
  fbox(b, f, w - lt * 2, 0.07, 0.11, 0, h - lt - 0.035, fz, frameMat, { chamfer: 0.008 });
  // Threshold plate + a worn concrete step outside.
  fbox(b, f, w, 0.03, thick + 0.05, 0, 0.015, 0, 'sheet_metal_bare', { chamfer: 0.006 });
  fbox(b, f, w + 0.5, 0.09, 0.5, 0, 0.045, half + 0.25, revealMat, { chamfer: 0.02, collide: true });

  if (!missing) {
    const lw = (w - lt * 2 - 0.1) / leaves;
    for (let i = 0; i < leaves; i++) {
      const s = leaves === 1 ? 1 : (i === 0 ? -1 : 1);
      const ang = open * R(rng, 0.5, 1.15) * s;
      const pivot = s * (w / 2 - lt - 0.03);
      const cx = pivot - s * (lw / 2) * Math.cos(ang);
      const cz = fz + (lw / 2) * Math.sin(Math.abs(ang));
      fbox(b, f, lw, h - lt - 0.06, 0.05, cx, (h - lt) / 2, cz, 'sheet_metal_bare',
        { chamfer: 0.01, dyaw: -s * ang, collide: true, surface: 'metal' });
      // Stiffeners + push bar + kick plate.
      for (const ly of [0.35, 0.72]) {
        fbox(b, f, lw * 0.92, 0.035, 0.06, cx, (h - lt) * ly, cz + 0.03, 'sheet_metal_bare', { chamfer: 0.005, dyaw: -s * ang });
      }
      fbox(b, f, lw * 0.55, 0.05, 0.07, cx - s * lw * 0.1, 1.05, cz + 0.05, 'metal_rusted', { chamfer: 0.008, dyaw: -s * ang });
      fbox(b, f, lw * 0.9, 0.28, 0.02, cx, 0.2, cz + 0.035, 'metal_rusted', { chamfer: 0.006, dyaw: -s * ang });
      for (const hy of [0.35, h * 0.5, h - 0.4]) {
        fbox(b, f, 0.07, 0.13, 0.07, pivot, hy, fz, frameMat, { chamfer: 0.012 });
      }
    }
  }
  if (interior) {
    fbox(b, f, w + 0.1, h, 0.06, 0, h / 2, -half - 0.9, 'rubber', { chamfer: 0.01 });
  }
}

// ------------------------------------------------------- perimeter wall ---

/**
 * Precast panel boundary wall.
 *
 * 130 m of unbroken extruded box is the flattest surface a compound can have.
 * Real precast walls are 3 m panels dropped into slotted pilasters, which
 * gives you: a vertical shadow gap every 3 m, a pilaster rhythm every 6 m, a
 * coping course with a drip on the underside of its overhang, a splash-stained
 * band at the bottom, and a kerb where it meets the ground.
 *
 * @param o {x, z, rotY, len, height, gapEvery, damage}
 */
export function precastWall(b, rng, o) {
  const {
    x, y = 0, z, rotY = 0, len, height = 4.2, thick = 0.3,
    panelLen = 3.0, pierEvery = 2, damage = 0.14, kerb = true, razor = true,
  } = o;
  const f = frame(x, y, z, rotY);
  const panels = Math.max(1, Math.round(len / panelLen));
  const pl = len / panels;
  const gap = 0.045;

  for (let i = 0; i < panels; i++) {
    const cu = -len / 2 + (i + 0.5) * pl;
    const dmg = rng() < damage;
    const mat = dmg ? (rng() < 0.5 ? 'rebar_concrete' : 'plaster_damaged') : 'concrete_wall';
    // The panel is built as three horizontal courses so the face has a
    // horizontal joint too, and so the bottom course can be stained.
    const courses = [
      [0.0, 0.62, 'concrete_stained'],
      [0.62, height - 1.05, mat],
      [height - 0.43, 0.43, dmg ? mat : 'concrete_stained'],
    ];
    for (const [y0, hh, cm] of courses) {
      fbox(b, f, pl - gap, hh - 0.012, thick, cu, y0 + hh / 2, 0, cm,
        { chamfer: 0.018, collide: true, surface: 'concrete' });
    }
    // Recessed feature panel in the middle of each bay — a shallow rebate.
    fbox(b, f, pl - gap - 0.44, height - 1.9, 0.06, cu, height * 0.52, -thick / 2 - 0.005, 'concrete_stained', { chamfer: 0.03 });
    fbox(b, f, pl - gap - 0.44, height - 1.9, 0.06, cu, height * 0.52, thick / 2 + 0.005, 'concrete_stained', { chamfer: 0.03 });
    if (dmg) {
      // A chunk out of the top, exposed cage, and a rubble spill at the foot.
      const bu = cu + R(rng, -pl * 0.25, pl * 0.25);
      fbox(b, f, R(rng, 0.4, 1.0), R(rng, 0.3, 0.8), thick + 0.05, bu, height - R(rng, 0.2, 0.6), 0, 'rubber', { chamfer: 0.04 });
      for (let k = 0; k < 4; k++) {
        fpipe(b, f, 0.012, R(rng, 0.2, 0.5), bu + R(rng, -0.3, 0.3), height - R(rng, 0.1, 0.5), R(rng, -0.1, 0.1), 'metal_rusted', 'y',
          { segments: 5, });
      }
      const wp = f.p(bu, 0, thick / 2 + 0.5);
      rubblePile(b, rng, { x: wp[0], y: y + 0.1, z: wp[2], radius: R(rng, 0.7, 1.2), height: 0.4, count: 12, rebar: 3 });
    }
  }

  // ---- pilasters, proud of the panel face on both sides
  const piers = Math.floor(panels / pierEvery) + 1;
  for (let i = 0; i <= piers; i++) {
    const cu = -len / 2 + i * pl * pierEvery;
    if (cu > len / 2 + 0.01) break;
    fbox(b, f, 0.42, height + 0.12, thick + 0.26, cu, (height + 0.12) / 2, 0, 'concrete_wall',
      { chamfer: 0.03, collide: true, surface: 'concrete' });
    fbox(b, f, 0.52, 0.13, thick + 0.36, cu, height + 0.2, 0, 'concrete_stained', { chamfer: 0.025, collide: true, surface: 'concrete' });
    fbox(b, f, 0.5, 0.4, thick + 0.32, cu, 0.2, 0, 'concrete_stained', { chamfer: 0.03, collide: true, surface: 'concrete' });
  }

  // ---- coping course with an overhang and a drip groove underneath
  fbox(b, f, len, 0.14, thick + 0.16, 0, height + 0.07, 0, 'concrete_stained', { chamfer: 0.022, collide: true, surface: 'concrete' });
  for (const sz of [-1, 1]) {
    fbox(b, f, len, 0.035, 0.035, 0, height - 0.012, sz * (thick / 2 + 0.05), 'dirt_dark', { chamfer: 0.006 });
  }
  // Weathering streaks down from the coping.
  for (let i = 0; i < Math.round(len / 3.4); i++) {
    const cu = R(rng, -len / 2, len / 2);
    for (const sz of [-1, 1]) {
      if (rng() < 0.45) continue;
      fbox(b, f, R(rng, 0.07, 0.2), R(rng, 0.5, 2.0), 0.01, cu, height - R(rng, 0.5, 1.4), sz * (thick / 2 + 0.006), 'dirt_dark', { chamfer: 0.012 });
    }
  }

  // ---- ground junction: kerb upstand plus a splash-stained band
  if (kerb) {
    for (const sz of [-1, 1]) {
      fbox(b, f, len, 0.22, 0.14, 0, 0.11, sz * (thick / 2 + 0.07), 'concrete_stained', { chamfer: 0.02, collide: true, surface: 'concrete' });
      fbox(b, f, len, 0.4, 0.012, 0, 0.42, sz * (thick / 2 + 0.007), 'dirt_dark', { chamfer: 0.02 });
    }
    // Grit wedge along both faces.
    const segs = Math.round(len / 3.0);
    for (let i = 0; i < segs; i++) {
      for (const sz of [-1, 1]) {
        if (rng() < 0.25) continue;
        fbox(b, f, (len / segs) * R(rng, 0.6, 1.05), R(rng, 0.03, 0.08), R(rng, 0.14, 0.34),
          -len / 2 + (i + 0.5) * len / segs, 0.02, sz * (thick / 2 + R(rng, 0.16, 0.3)), 'dust',
          { chamfer: 0.03, dyaw: R(rng, -0.06, 0.06) });
      }
    }
  }

  // ---- razor wire: bracket arms carrying a real coil
  if (razor) {
    const n = Math.max(2, Math.round(len / 5.2));
    for (let i = 0; i <= n; i++) {
      const cu = -len / 2 + i * len / n;
      fbox(b, f, 0.05, 0.75, 0.05, cu, height + 0.5, -0.16, 'metal_rusted', { chamfer: 0.008, rot: [-0.5, rotY, 0] });
      fbox(b, f, 0.04, 0.45, 0.04, cu, height + 0.32, -0.02, 'metal_rusted', { chamfer: 0.006, rot: [0.9, rotY, 0] });
    }
    const coils = Math.max(4, Math.round(len / 1.5));
    for (let i = 0; i < coils; i++) {
      const cu = -len / 2 + (i + 0.5) * len / coils;
      b.add(ctorus(0.26, 0.011, 3, 8), 'metal_rusted', {
        pos: f.p(cu, height + 0.78, -0.42), rot: [0.12, rotY + Math.PI / 2, 0.25 + R(rng, -0.1, 0.1)], collide: false,
      });
    }
  }
}

// -------------------------------------------------------------- the gate ---

/** Sliding/swing gate leaves with tube frames, bracing, hinges and a latch. */
export function gateLeaf(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, w = 4.5, h = 3.4, open = 0, hingeSide = -1, mat = 'painted_steel_yellow' } = o;
  const ang = open * -hingeSide;
  const pivotX = hingeSide * w / 2;
  const f = frame(x, y, z, rotY);
  const cx = pivotX - hingeSide * (w / 2) * Math.cos(ang);
  const cz = (w / 2) * Math.sin(Math.abs(ang)) * (open > 0 ? 1 : 0);
  const dy = -hingeSide * ang;
  const put = (ww, hh, dd, lx, ly, lz, m, ch = 0.012, col = false) =>
    fbox(b, f, ww, hh, dd, cx + lx, ly, cz + lz, m, { chamfer: ch, dyaw: dy, collide: col, surface: 'metal' });

  put(w, 0.1, 0.1, 0, h - 0.05, 0, mat, 0.014, true);
  put(w, 0.1, 0.1, 0, 0.15, 0, mat, 0.014, true);
  for (const sx of [-1, 1]) put(0.1, h, 0.1, sx * (w / 2 - 0.05), h / 2, 0, mat, 0.014, true);
  put(w * 0.5, 0.08, 0.08, 0, h * 0.55, 0, mat, 0.012);
  // Diagonal brace + turnbuckle.
  const dl = Math.hypot(w - 0.2, h - 0.3);
  put(dl, 0.055, 0.055, 0, h / 2, 0, mat, 0.008);
  b.add(cbox(b, dl, 0.055, 0.055, mat, 0.008), mat, {
    pos: f.p(cx, h / 2, cz), rot: [0, rotY + dy, Math.atan2(h - 0.3, w - 0.2)], collide: false,
  });
  // Mesh infill.
  put(w - 0.16, h - 0.28, 0.02, 0, h / 2, 0, 'chainlink', 0);
  // Vertical pickets so the silhouette is not only alpha mesh.
  for (let i = 1; i < 8; i++) {
    put(0.04, h - 0.3, 0.04, -w / 2 + i * w / 8, h / 2, 0.02, mat, 0.006);
  }
  // Hinges on the pivot side, latch on the other.
  for (const hy of [0.4, h - 0.4]) {
    fbox(b, f, 0.13, 0.13, 0.16, pivotX, hy, 0, 'metal_rusted', { chamfer: 0.018 });
  }
  if (Math.abs(open) < 0.05) {
    fbox(b, f, 0.1, 0.5, 0.09, -hingeSide * (w / 2 - 0.06), 1.15, 0.07, 'metal_rusted', { chamfer: 0.012 });
  }
  // Hazard chevrons.
  put(w * 0.9, 0.18, 0.03, 0, 0.42, 0.06, 'warning_stripe', 0.006);
  put(w * 0.9, 0.18, 0.03, 0, h - 0.34, 0.06, 'warning_stripe', 0.006);
  // Ground wheel + a worn arc in the asphalt.
  const wp = f.p(cx - hingeSide * (w / 2 - 0.2), 0, cz);
  b.add(ctorus(0.09, 0.035, 4, 10), 'rubber', { pos: [wp[0], y + 0.09, wp[2]], rot: [0, rotY + dy, Math.PI / 2], collide: false });
}

/** Sentry box: walls, glazed hatch, door, overhanging roof, light. */
export function guardPost(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, w = 2.0, d = 1.8, h = 2.5 } = o;
  const f = frame(x, y, z, rotY);
  const T = 0.14;
  // Plinth.
  fbox(b, f, w + 0.4, 0.16, d + 0.4, 0, 0.08, 0, 'concrete_stained', { chamfer: 0.025, collide: true, surface: 'concrete' });
  // Back and one side solid; the front has a serving hatch; the other side a door.
  fbox(b, f, w, h, T, 0, 0.16 + h / 2, -d / 2, 'plaster_white', { chamfer: 0.018, collide: true, surface: 'plaster' });
  fbox(b, f, T, h, d, -w / 2, 0.16 + h / 2, 0, 'plaster_white', { chamfer: 0.018, collide: true, surface: 'plaster' });
  // Front: sill wall + head wall, glazed between.
  fbox(b, f, w, 0.95, T, 0, 0.16 + 0.475, d / 2, 'plaster_white', { chamfer: 0.018, collide: true, surface: 'plaster' });
  fbox(b, f, w, h - 1.85, T, 0, 0.16 + h - (h - 1.85) / 2, d / 2, 'plaster_white', { chamfer: 0.018, collide: true, surface: 'plaster' });
  windowUnit(b, rng, {
    x: f.p(0, 0, d / 2)[0], y: y + 0.16 + 0.95 + 0.45, z: f.p(0, 0, d / 2)[2], rotY,
    w: w - 0.3, h: 0.9, thick: T, inset: 0.05, broken: 0.2, interior: false, sill: true, cols: 3, rows: 1,
    revealMat: 'concrete_stained',
  });
  // Door side.
  fbox(b, f, T, h, 0.45, w / 2, 0.16 + h / 2, -d / 2 + 0.225, 'plaster_white', { chamfer: 0.018, collide: true, surface: 'plaster' });
  fbox(b, f, T, h - 2.1, d - 0.45, w / 2, 0.16 + h - (h - 2.1) / 2, 0.225, 'plaster_white', { chamfer: 0.018, collide: true, surface: 'plaster' });
  fbox(b, f, 0.05, 2.05, 0.85, w / 2 - 0.05, 0.16 + 1.03, 0.3, 'sheet_metal_bare', { chamfer: 0.01, dyaw: 0.5, collide: true, surface: 'metal' });
  // Roof with a deep overhang, fascia and a drip.
  fbox(b, f, w + 0.55, 0.13, d + 0.55, 0, 0.16 + h + 0.065, 0, 'concrete_stained', { chamfer: 0.02, collide: true, surface: 'concrete' });
  fbox(b, f, w + 0.6, 0.09, d + 0.6, 0, 0.16 + h + 0.15, 0, 'metal_rusted', { chamfer: 0.015 });
  // Interior darkness + a bit of kit inside.
  fbox(b, f, w - 0.3, h - 0.4, d - 0.3, 0, 0.16 + h / 2, -0.05, 'rubber', { chamfer: 0.05 });
  fbox(b, f, w - 0.4, 0.06, 0.5, 0, 0.16 + 0.95, d / 2 - 0.3, 'wood_plank', { chamfer: 0.01 });
  // Wall light over the door, and a stained band at the base.
  fbox(b, f, 0.22, 0.16, 0.14, w / 2 + 0.1, 0.16 + 2.2, 0.2, 'sheet_metal_bare', { chamfer: 0.02 });
  fbox(b, f, 0.16, 0.1, 0.03, w / 2 + 0.19, 0.16 + 2.18, 0.2, 'lamp_glow_cool', { chamfer: 0.006 });
  for (const sz of [-1, 1]) fbox(b, f, w + 0.05, 0.45, 0.012, 0, 0.16 + 0.24, sz * (d / 2 + 0.008), 'dirt_dark', { chamfer: 0.02 });
  contactDress(b, rng, { x, z, y, w: w + 0.9, d: d + 0.9, rotY, amount: 1.0, frags: 6 });
  return f.p(0, 0.16 + 2.18, 0.35);
}

/** Counterweighted boom barrier. */
export function boomBarrier(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, len = 5.0, raised = false } = o;
  const f = frame(x, y, z, rotY);
  // Base cabinet.
  fbox(b, f, 0.5, 0.14, 0.5, 0, 0.07, 0, 'concrete_stained', { chamfer: 0.025, collide: true });
  fbox(b, f, 0.38, 1.05, 0.36, 0, 0.14 + 0.525, 0, 'sheet_metal_bare', { chamfer: 0.025, collide: true, surface: 'metal' });
  fbox(b, f, 0.42, 0.08, 0.4, 0, 0.14 + 1.09, 0, 'sheet_metal_bare', { chamfer: 0.014 });
  fbox(b, f, 0.2, 0.28, 0.02, 0, 0.75, 0.19, 'warning_stripe', { chamfer: 0.006 });
  // Pivot + boom.
  const ang = raised ? 1.35 : 0.03;
  fpipe(b, f, 0.055, 0.3, 0, 1.28, 0, 'sheet_metal_bare', 'z', { segments: 10 });
  const cy = 1.28 + Math.sin(ang) * len / 2;
  const cxz = Math.cos(ang) * len / 2;
  b.add(cbox(b, len, 0.11, 0.09, 'warning_stripe', 0.014), 'warning_stripe', {
    pos: f.p(cxz, cy, 0), rot: [0, rotY, ang], collide: true, surface: 'metal',
  });
  // Counterweight arm and weights.
  b.add(cbox(b, 0.9, 0.08, 0.07, 'sheet_metal_bare', 0.01), 'sheet_metal_bare', {
    pos: f.p(-Math.cos(ang) * 0.45, 1.28 - Math.sin(ang) * 0.45, 0), rot: [0, rotY, ang], collide: false,
  });
  for (const u of [0, 0.09]) {
    fpipe(b, f, 0.14, 0.06, -Math.cos(ang) * (0.8 + u), 1.28 - Math.sin(ang) * (0.8 + u), 0, 'metal_rusted', 'x', { segments: 12 });
  }
  // Support rest at the far end, and a skirt of hanging drops.
  if (!raised) {
    fbox(b, f, 0.12, 0.55, 0.12, len - 0.2, 0.275, 0, 'painted_steel_yellow', { chamfer: 0.014, collide: true, surface: 'metal' });
    for (let i = 0; i < 7; i++) {
      fpipe(b, f, 0.012, 0.45, 0.6 + i * (len - 1.0) / 6, 1.05, 0, 'metal_rusted', 'y', { segments: 5 });
    }
  }
  contactDress(b, rng, { x, z, y, w: 0.9, d: 0.9, rotY, amount: 0.8, frags: 4 });
}

// --------------------------------------------------------------- misc -----

export function bollard(b, rng, o) {
  const { x, y = 0.1, z, mat = 'warning_stripe', height = 0.95, radius = 0.075 } = o;
  const f = frame(x, y, z, 0);
  fbox(b, f, radius * 3.4, 0.09, radius * 3.4, 0, 0.045, 0, 'concrete_stained', { chamfer: 0.02, collide: true });
  fpipe(b, f, radius, height, 0, 0.09 + height / 2, 0, mat, 'y', { segments: 10, collide: true });
  fpipe(b, f, radius * 1.2, 0.05, 0, 0.09 + height, 0, 'sheet_metal_bare', 'y', { segments: 10 });
  contactDress(b, rng, { x, z, y, w: radius * 5, round: true, amount: 0.5, frags: 2 });
}

export function trafficCone(b, rng, o) {
  const { x, y = 0.1, z, rotY = rng() * TAU, knocked = false } = o;
  const f = frame(x, y, z, rotY);
  const rot = knocked ? [R(rng, 1.2, 1.7), rotY, R(rng, -0.4, 0.4)] : null;
  const base = knocked ? 0.16 : 0;
  b.add(cbox(b, 0.36, 0.035, 0.36, 'rubber', 0.02), 'rubber', { pos: f.p(0, base + 0.018, 0), rot, rotY, collide: false });
  b.add(new THREE.ConeGeometry(0.14, 0.5, 10, 1, false), 'rubber', { pos: f.p(0, base + 0.28, 0), rot, rotY, collide: false });
  b.add(new THREE.ConeGeometry(0.105, 0.13, 10, 1, true), 'sheet_metal_bare', { pos: f.p(0, base + 0.36, 0), rot, rotY, collide: false });
}

/** Stacked long material: timber, pipe bundles, rebar. */
export function stackedMaterial(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, len = 4.0, kind = (rng() * 3) | 0 } = o;
  const f = frame(x, y, z, rotY);
  // Bearers underneath.
  for (const u of [-0.35, 0.35]) {
    fbox(b, f, 0.12, 0.11, 1.3, u * len, 0.055, 0, 'wood_plank', { chamfer: 0.01, collide: true, surface: 'wood' });
  }
  if (kind === 0) {
    // Sawn timber: layers with cross-sticks between them.
    let ly = 0.11;
    for (let layer = 0; layer < 6; layer++) {
      const n = 5 - (layer > 3 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        if (layer > 3 && rng() < 0.3) continue;
        fbox(b, f, len * R(rng, 0.92, 1.0), 0.05, 0.2, R(rng, -0.06, 0.06), ly + 0.025, (i - (n - 1) / 2) * 0.23, 'wood_plank',
          { chamfer: 0.008, dyaw: R(rng, -0.02, 0.02), collide: layer < 3, surface: 'wood' });
      }
      ly += 0.05;
      if (layer % 2 === 1) {
        for (const u of [-0.3, 0.3]) fbox(b, f, 0.1, 0.03, 1.2, u * len, ly + 0.015, 0, 'wood_plank', { chamfer: 0.005 });
        ly += 0.03;
      }
    }
  } else if (kind === 1) {
    // Pipe bundle, close-packed in rows that step in.
    let ly = 0.11;
    const rad = 0.11;
    for (let row = 0; row < 4; row++) {
      const n = 5 - row;
      for (let i = 0; i < n; i++) {
        const m = pick(rng, ['metal_rusted', 'sheet_metal_bare', 'paint_green']);
        fpipe(b, f, rad, len * R(rng, 0.9, 1.0), R(rng, -0.1, 0.1), ly + rad, (i - (n - 1) / 2) * rad * 2.05, m, 'x',
          { segments: 10, collide: row < 2 });
      }
      ly += rad * 1.78;
    }
    for (const u of [-0.32, 0.32]) {
      fbox(b, f, 0.09, 0.85, 0.09, u * len, 0.5, 0.58, 'wood_plank', { chamfer: 0.008 });
      fbox(b, f, 0.09, 0.85, 0.09, u * len, 0.5, -0.58, 'wood_plank', { chamfer: 0.008 });
    }
  } else {
    // Rebar bundles, wire-tied.
    for (let bnd = 0; bnd < 3; bnd++) {
      const lz = (bnd - 1) * 0.36;
      for (let i = 0; i < 12; i++) {
        const a = rng() * TAU, rr = rng() * 0.13;
        fpipe(b, f, 0.012, len * R(rng, 0.85, 1.0), R(rng, -0.15, 0.15), 0.11 + 0.15 + Math.sin(a) * rr, lz + Math.cos(a) * rr,
          'metal_rusted', 'x', { segments: 5 });
      }
      for (const u of [-0.3, 0.3]) {
        b.add(ctorus(0.15, 0.008, 4, 10), 'metal_rusted', { pos: f.p(u * len, 0.26, lz), rot: [0, rotY, Math.PI / 2], collide: false });
      }
    }
  }
  contactDress(b, rng, { x, z, y, w: len + 0.4, d: 1.6, rotY, amount: 0.9, frags: 5 });
}

/** Workbench with a vice, tools and clutter underneath. */
export function workbench(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, len = 2.4 } = o;
  const f = frame(x, y, z, rotY);
  const H = 0.9, D = 0.75;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    fbox(b, f, 0.07, H, 0.07, sx * (len / 2 - 0.1), H / 2, sz * (D / 2 - 0.08), 'metal_rusted', { chamfer: 0.008, collide: true, surface: 'metal' });
  }
  fbox(b, f, len, 0.06, D, 0, H, 0, 'wood_plank', { chamfer: 0.012, collide: true, surface: 'wood' });
  fbox(b, f, len - 0.1, 0.04, D - 0.1, 0, 0.28, 0, 'sheet_metal_bare', { chamfer: 0.008 });
  fbox(b, f, len, 0.06, 0.05, 0, H + 0.03, -D / 2, 'wood_plank', { chamfer: 0.008 });
  // Vice.
  fbox(b, f, 0.2, 0.14, 0.16, -len * 0.34, H + 0.1, D * 0.2, 'sheet_metal_bare', { chamfer: 0.02 });
  fpipe(b, f, 0.014, 0.3, -len * 0.34, H + 0.16, D * 0.34, 'sheet_metal_bare', 'x', { segments: 6 });
  // Clutter on top and boxes under.
  for (let i = 0; i < 6; i++) {
    const s = R(rng, 0.06, 0.22);
    fbox(b, f, s * R(rng, 1, 3), s * R(rng, 0.4, 1), s * R(rng, 0.7, 1.3), R(rng, -len * 0.35, len * 0.42), H + 0.03 + s * 0.3, R(rng, -0.25, 0.25),
      pick(rng, ['sheet_metal_bare', 'metal_rusted', 'wood_crate', 'paint_red']), { chamfer: 0.012, dyaw: rng() * TAU });
  }
  for (let i = 0; i < 3; i++) {
    fbox(b, f, R(rng, 0.3, 0.5), R(rng, 0.2, 0.4), R(rng, 0.3, 0.5), R(rng, -len * 0.35, len * 0.35), 0.15, R(rng, -0.15, 0.15),
      pick(rng, ['wood_crate', 'sheet_metal_bare']), { chamfer: 0.016, dyaw: rng() * TAU });
  }
  contactDress(b, rng, { x, z, y, w: len + 0.4, d: D + 0.4, rotY, amount: 0.7, frags: 5 });
}

/** Tall sheet-steel locker / control cabinet bank. */
export function cabinet(b, rng, o) {
  const { x, y = 0.1, z, rotY = 0, bays = 3, w = 0.6, h = 1.95, d = 0.5, mat = 'sheet_metal_bare' } = o;
  const f = frame(x, y, z, rotY);
  const W = bays * w;
  fbox(b, f, W + 0.04, 0.1, d + 0.04, 0, 0.05, 0, 'metal_rusted', { chamfer: 0.012, collide: true, surface: 'metal' });
  fbox(b, f, W, h, d, 0, 0.1 + h / 2, 0, mat, { chamfer: 0.016, collide: true, surface: 'metal' });
  for (let i = 0; i < bays; i++) {
    const cu = -W / 2 + (i + 0.5) * w;
    fbox(b, f, w - 0.03, h - 0.1, 0.03, cu, 0.1 + h / 2, d / 2 + 0.01, mat, { chamfer: 0.01 });
    fbox(b, f, 0.03, 0.12, 0.05, cu + w * 0.36, 0.1 + h * 0.55, d / 2 + 0.03, 'sheet_metal_bare', { chamfer: 0.008 });
    // Louvres at the top of each door.
    for (let k = 0; k < 4; k++) {
      fbox(b, f, w * 0.5, 0.022, 0.02, cu, 0.1 + h - 0.2 - k * 0.05, d / 2 + 0.03, 'rubber', { chamfer: 0.004 });
    }
    if (rng() < 0.4) fbox(b, f, 0.16, 0.12, 0.008, cu, 0.1 + h * 0.72, d / 2 + 0.03, 'warning_stripe', { chamfer: 0.003 });
  }
  fbox(b, f, W + 0.06, 0.06, d + 0.06, 0, 0.1 + h + 0.02, 0, mat, { chamfer: 0.012 });
  contactDress(b, rng, { x, z, y, w: W + 0.3, d: d + 0.3, rotY, amount: 0.6, frags: 3 });
}

/** Roller shutter door in a wall opening: curtain, guides, box, bottom bar. */
export function rollerShutter(b, rng, o) {
  const { x, y, z, rotY = 0, w = 4.0, h = 4.2, openAmount = 0.0, mat = 'corrugated_roof' } = o;
  const f = frame(x, y, z, rotY);
  const curtainH = h * (1 - openAmount);
  const slats = Math.max(4, Math.round(curtainH / 0.12));
  for (let i = 0; i < slats; i++) {
    fbox(b, f, w, 0.115, 0.05, 0, 0.06 + i * (curtainH / slats), 0, mat, { chamfer: 0.014, collide: i < 18, surface: 'metal' });
  }
  fbox(b, f, w, 0.14, 0.08, 0, curtainH, 0, 'metal_rusted', { chamfer: 0.016 });
  for (const sx of [-1, 1]) {
    fbox(b, f, 0.13, h, 0.16, sx * (w / 2 + 0.06), h / 2, 0, 'painted_steel_yellow', { chamfer: 0.014, collide: true, surface: 'metal' });
  }
  fbox(b, f, w + 0.34, 0.45, 0.38, 0, h + 0.24, 0, 'sheet_metal_bare', { chamfer: 0.03 });
  fbox(b, f, w, 0.2, 0.014, 0, 0.28, 0.032, 'dirt_dark', { chamfer: 0.02 });
}

/** Steel drum stove / brazier — a bit of human presence. */
export function brazier(b, rng, o) {
  const { x, y = 0.1, z, rotY = rng() * TAU } = o;
  const f = frame(x, y, z, rotY);
  fpipe(b, f, 0.2925, 0.6, 0, 0.3 + 0.16, 0, 'metal_rusted', 'y', { segments: 16, collide: true });
  fpipe(b, f, 0.27, 0.06, 0, 0.72, 0, 'rubber', 'y', { segments: 16 });
  for (let i = 0; i < 5; i++) {
    fbox(b, f, R(rng, 0.1, 0.3), 0.05, 0.05, R(rng, -0.15, 0.15), 0.74, R(rng, -0.15, 0.15), 'wood_plank',
      { chamfer: 0.008, rot: [R(rng, -0.3, 0.3), rotY + rng() * TAU, R(rng, -0.3, 0.3)] });
  }
  for (let i = 0; i < 3; i++) {
    fbox(b, f, 0.12, 0.16, 0.12, Math.cos(i * 2.1) * 0.25, 0.08, Math.sin(i * 2.1) * 0.25, 'rebar_concrete', { chamfer: 0.02, collide: true });
  }
  b.add(cbox(b, 1.5, 0.014, 1.4, 'dirt_dark', 0.1), 'dirt_dark', { pos: [x, y + 0.006, z], rotY, collide: false });
  contactDress(b, rng, { x, z, y, w: 1.1, round: true, amount: 0.7, frags: 5, fragMat: 'wood_plank' });
}

export { R as rand, pick as pickOne, TAU };
