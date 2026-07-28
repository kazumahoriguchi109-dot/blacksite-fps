import * as THREE from 'three';

/*
 * Navigation — walkable-grid rasterisation, A*, and line-of-sight services.
 *
 * The level is a single merged BVH mesh, so there is no authored navmesh to
 * read. We build one by sampling: a 2D grid is rasterised over the map bounds
 * and, for every column, a single BVH traversal collects *every* triangle the
 * vertical line passes through. Sorting those hits top-down and walking a
 * solid/air parity counter gives the exact set of air pockets in that column;
 * the lowest floor with 2 m of clear air above it is the standable surface.
 *
 * Parity matters. The naive "raycast down, take the first hit" approach puts
 * the nav surface on roofs and on the tops of crates, containers and walls.
 * Counting solid entries/exits instead means a column under a perimeter wall
 * correctly reports "no air here" rather than "floor at ground level".
 *
 * A flood fill from the spawn points then discards everything the ground floor
 * cannot actually reach (container tops, catwalks, roofs, wall copings), which
 * is what stops agents from planning paths into geometry they cannot climb.
 *
 * Everything is preallocated. The only allocation after build() is none:
 * A* uses stamped scratch arrays, the heap is a flat Int32Array, and
 * line-of-sight tests run through a shapecast with hoisted callbacks.
 */

// ---------------------------------------------------------------- tuning ---

const DEFAULTS = {
  cell: 0.75,          // grid resolution in metres
  headroom: 2.0,       // air required above a floor for it to be standable
  stepHeight: 0.45,    // max height change between adjacent cells
  slopeMin: 0.62,      // cos(~52 deg) — matches the player's max slope
  extent: 58,          // hard clamp on the sampled area (half-width, metres)
  maxCells: 65536,     // grow the cell size rather than exceed this
  maxExpansions: 2600, // A* node budget per query
  plansPerTick: 1,     // baseline re-plans per update across ALL agents
  urgentPlansPerTick: 1, // extra allowance for high-priority requests
  agentRadius: 0.36,   // used by the string-pull clearance test
  lookahead: 14,       // string-pull forward scan cap (cells)
};

const MAX_COL_HITS = 64;    // triangles collected per sampled column
const MAX_CELL_PATH = 512;  // cells kept from one A* result
const MAX_SEG_SAMPLES = 32; // samples per string-pull visibility segment

// ------------------------------------------------------------- NavPath -----

/**
 * A smoothed path. Points are world-space waypoints; the agent walks them in
 * order. Preallocated and recycled — an agent owns exactly one for its life.
 */
export class NavPath {
  constructor(maxPoints = 32) {
    this.max = maxPoints;
    this.pts = new Float32Array(maxPoints * 3);
    this.count = 0;
    this.index = 0;
    this.valid = false;
    this.partial = false;      // truncated — re-plan before the end is reached
    this.goal = new THREE.Vector3();
    this.age = 0;
  }

  reset() {
    this.count = 0; this.index = 0; this.valid = false; this.partial = false; this.age = 0;
  }

  get done() { return !this.valid || this.index >= this.count; }

  /** Remaining waypoints including the current one. */
  get remaining() { return this.valid ? Math.max(0, this.count - this.index) : 0; }

  point(i, out) {
    const o = i * 3;
    return out.set(this.pts[o], this.pts[o + 1], this.pts[o + 2]);
  }

  current(out) {
    if (!this.valid || this.count === 0) return out.set(0, 0, 0);
    return this.point(Math.min(this.index, this.count - 1), out);
  }

  last(out) {
    if (!this.valid || this.count === 0) return out.set(0, 0, 0);
    return this.point(this.count - 1, out);
  }

  advance() { this.index++; }
}

// ---------------------------------------------------------- Navigation -----

export class Navigation {
  /**
   * @param {object} level  a Level instance (needs `collider` with a boundsTree)
   * @param {object} opts   see DEFAULTS
   */
  constructor(level, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.level = level;
    this.cell = o.cell;
    this.headroom = o.headroom;
    this.stepHeight = o.stepHeight;
    this.slopeMin = o.slopeMin;
    this.extent = o.extent;
    this.maxCells = o.maxCells;
    this.maxExpansions = o.maxExpansions;
    this.plansPerTick = o.plansPerTick;
    this.urgentPlansPerTick = o.urgentPlansPerTick;
    this.agentRadius = o.agentRadius;
    this.lookahead = o.lookahead;

    this.ready = false;
    this.tree = null;

    this.nx = 0; this.nz = 0;
    this.originX = 0; this.originZ = 0;
    this.topY = 40;

    this.walk = null;      // Uint8Array — 1 if standable and reachable
    this.floorY = null;    // Float32Array — surface height per cell
    this.extraCost = null; // Float32Array — proximity-to-wall penalty

    // --- per-tick budgets ---
    this._plans = 0;
    this._urgent = 0;
    this._los = 0;
    this.losPerTick = 4;

    this.stats = {
      cells: 0, walkable: 0, buildMs: 0,
      plans: 0, planFail: 0, planNodes: 0, losTests: 0,
    };

    // --- column sampling scratch ---
    this._colX = 0; this._colZ = 0; this._colN = 0;
    this._colYs = new Float32Array(MAX_COL_HITS);
    this._colNys = new Float32Array(MAX_COL_HITS);
    this._colCb = {
      // A vertical line only needs an XZ overlap test — far cheaper than a ray.
      intersectsBounds: (box) => (
        this._colX >= box.min.x - 1e-4 && this._colX <= box.max.x + 1e-4 &&
        this._colZ >= box.min.z - 1e-4 && this._colZ <= box.max.z + 1e-4
      ),
      intersectsTriangle: (tri) => { this._collectColumnTri(tri); return false; },
    };

    // --- body-clearance scratch ---
    this._clearSeg = new THREE.Line3();
    this._clearBox = new THREE.Box3();
    this._cp1 = new THREE.Vector3();
    this._cp2 = new THREE.Vector3();
    this._clearCb = {
      intersectsBounds: (box) => box.intersectsBox(this._clearBox),
      intersectsTriangle: (tri) =>
        tri.closestPointToSegment(this._clearSeg, this._cp1, this._cp2) < this.agentRadius,
    };

    // --- line-of-sight scratch ---
    this._losRay = new THREE.Ray();
    this._losBox = new THREE.Box3();
    this._losHit = new THREE.Vector3();
    this._losFarSq = 0;
    this._losCb = {
      intersectsBounds: (box) => (
        box.intersectsBox(this._losBox) && this._losRay.intersectsBox(box)
      ),
      intersectsTriangle: (tri) => {
        const p = this._losRay.intersectTriangle(tri.a, tri.b, tri.c, false, this._losHit);
        if (p === null) return false;
        return p.distanceToSquared(this._losRay.origin) <= this._losFarSq;
      },
    };

    // --- general scratch ---
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    // A* scratch (sized in build())
    this._g = null; this._f = null; this._parent = null;
    this._stamp = null; this._stampVal = 0;
    this._closed = null;
    this._heap = null; this._hpos = null; this._heapSize = 0;
    this._cellPath = new Int32Array(MAX_CELL_PATH);
  }

  // ============================================================== build ====

  /**
   * Rasterise the grid. Synchronous — call once, at load, after the level's
   * collider exists. Returns true on success.
   */
  build() {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const collider = this.level?.collider;
    const geo = collider?.geometry;
    const tree = geo?.boundsTree;
    if (!tree) {
      console.warn('[nav] no collider boundsTree — navigation disabled');
      return false;
    }
    this.tree = tree;

    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const e = this.extent;
    let minX = Math.max(bb.min.x, -e), maxX = Math.min(bb.max.x, e);
    let minZ = Math.max(bb.min.z, -e), maxZ = Math.min(bb.max.z, e);
    if (!(maxX > minX) || !(maxZ > minZ)) {
      console.warn('[nav] degenerate level bounds');
      return false;
    }
    this.topY = bb.max.y + 2;

    // Grow the cell size rather than blow the memory budget on a huge map.
    let cell = this.cell;
    let nx = Math.max(2, Math.ceil((maxX - minX) / cell));
    let nz = Math.max(2, Math.ceil((maxZ - minZ) / cell));
    while (nx * nz > this.maxCells) {
      cell *= 1.25;
      nx = Math.max(2, Math.ceil((maxX - minX) / cell));
      nz = Math.max(2, Math.ceil((maxZ - minZ) / cell));
    }
    this.cell = cell;
    this.nx = nx; this.nz = nz;
    this.originX = minX + cell * 0.5;
    this.originZ = minZ + cell * 0.5;

    const n = nx * nz;
    this.walk = new Uint8Array(n);
    this.floorY = new Float32Array(n);
    this.extraCost = new Float32Array(n);

    // --- sample every column, then verify body clearance ---
    for (let iz = 0; iz < nz; iz++) {
      const z = this.originZ + iz * cell;
      const row = iz * nx;
      for (let ix = 0; ix < nx; ix++) {
        const x = this.originX + ix * cell;
        const y = this._sampleColumn(x, z);
        if (y !== y) continue;                     // NaN — no standable surface
        if (!this._capsuleClear(x, y, z)) continue;
        this.walk[row + ix] = 1;
        this.floorY[row + ix] = y;
      }
    }

    this._pruneUnreachable();
    this._buildEdgeCosts();

    // --- A* scratch ---
    this._g = new Float32Array(n);
    this._f = new Float32Array(n);
    this._parent = new Int32Array(n);
    this._stamp = new Int32Array(n);
    this._closed = new Uint8Array(n);
    this._heap = new Int32Array(n + 1);
    this._hpos = new Int32Array(n);
    this._stampVal = 0;

    let walkable = 0;
    for (let i = 0; i < n; i++) if (this.walk[i]) walkable++;
    this.stats.cells = n;
    this.stats.walkable = walkable;
    this.stats.buildMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    this.ready = walkable > 16;

    if (!this.ready) console.warn('[nav] grid produced too few walkable cells');
    return this.ready;
  }

  /** Collect one triangle's vertical intersection with the current column. */
  _collectColumnTri(tri) {
    if (this._colN >= MAX_COL_HITS) return;
    const a = tri.a, b = tri.b, c = tri.c;
    const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
    const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;

    // Determinant of the XZ projection: zero for vertical triangles, which a
    // vertical line can never meaningfully cross.
    const det = e1x * e2z - e2x * e1z;
    if (det > -1e-9 && det < 1e-9) return;

    const px = this._colX - a.x, pz = this._colZ - a.z;
    const inv = 1 / det;
    const u = (px * e2z - e2x * pz) * inv;
    if (u < -1e-6) return;
    const v = (e1x * pz - px * e1z) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) return;

    // Geometric normal (winding-derived — the collider carries no normals).
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) return;

    const i = this._colN++;
    this._colYs[i] = a.y + u * e1y + v * e2y;
    this._colNys[i] = ny / len;
  }

  /**
   * @returns {number} height of the lowest standable surface in this column,
   *                   or NaN if there is none.
   */
  _sampleColumn(x, z) {
    this._colX = x; this._colZ = z; this._colN = 0;
    this.tree.shapecast(this._colCb);

    const n = this._colN;
    if (n === 0) return NaN;

    // Sort descending by height (insertion sort — n is small and near-sorted).
    const ys = this._colYs, nys = this._colNys;
    for (let i = 1; i < n; i++) {
      const y = ys[i], ny = nys[i];
      let j = i - 1;
      while (j >= 0 && ys[j] < y) { ys[j + 1] = ys[j]; nys[j + 1] = nys[j]; j--; }
      ys[j + 1] = y; nys[j + 1] = ny;
    }

    // Walk downward keeping a solid-depth counter. Descending across an
    // upward-facing triangle enters solid; across a downward-facing one exits.
    let depth = 0;
    let airTop = this.topY;
    let best = NaN;
    for (let i = 0; i < n; i++) {
      const y = ys[i], ny = nys[i];
      if (ny > 0) {
        if (depth === 0 && ny >= this.slopeMin && (airTop - y) >= this.headroom) {
          best = y; // keep going — we want the *lowest* valid surface
        }
        depth++;
      } else {
        depth--;
        if (depth <= 0) { depth = 0; airTop = y; }
      }
    }
    return best;
  }

  /**
   * Is there room for a body standing on this cell?
   *
   * The vertical column test alone is not enough: a cell is 0.75 m across but
   * a perimeter wall is 0.42 m thick and a chainlink panel is 0.05 m, so a
   * single sampling line slips straight between two cells that sit on opposite
   * sides of a wall — and the grid then happily paths through it. Testing an
   * actual body capsule against the BVH closes every gap thicker than
   * cell - 2*radius, which for these numbers is 3 cm.
   *
   * The capsule matches the player's: radius 0.36, standing between 0.60 and
   * 1.60 m above the surface. Its lower cap clears 0.24 m, so curbs, floor
   * lips and rails an agent would simply step over do not block a cell.
   */
  _capsuleClear(x, floor, z) {
    const seg = this._clearSeg;
    seg.start.set(x, floor + 0.60, z);
    seg.end.set(x, floor + 1.60, z);
    const r = this.agentRadius;
    const b = this._clearBox;
    b.min.set(x - r, floor + 0.60 - r, z - r);
    b.max.set(x + r, floor + 1.60 + r, z + r);
    return !this.tree.shapecast(this._clearCb);
  }

  /**
   * Discard walkable cells that the ground cannot reach. Keeps the largest
   * connected component plus any component containing a spawn point.
   */
  _pruneUnreachable() {
    const n = this.nx * this.nz;
    const comp = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    const sizes = [];
    let id = 0;

    for (let s = 0; s < n; s++) {
      if (!this.walk[s] || comp[s] !== -1) continue;
      let head = 0, tail = 0;
      queue[tail++] = s;
      comp[s] = id;
      let size = 0;
      while (head < tail) {
        const c = queue[head++];
        size++;
        const cx = c % this.nx, cz = (c / this.nx) | 0;
        const cy = this.floorY[c];
        for (let k = 0; k < 8; k++) {
          const dx = NB_DX[k], dz = NB_DZ[k];
          const ax = cx + dx, az = cz + dz;
          if (ax < 0 || az < 0 || ax >= this.nx || az >= this.nz) continue;
          const ni = az * this.nx + ax;
          if (!this.walk[ni] || comp[ni] !== -1) continue;
          if (Math.abs(this.floorY[ni] - cy) > this.stepHeight) continue;
          if (dx !== 0 && dz !== 0) {
            // No corner cutting: both orthogonal neighbours must be open.
            const oa = cz * this.nx + ax, ob = az * this.nx + cx;
            if (!this.walk[oa] || !this.walk[ob]) continue;
          }
          comp[ni] = id;
          queue[tail++] = ni;
        }
      }
      sizes.push(size);
      id++;
    }
    if (id === 0) return;

    const keep = new Uint8Array(id);
    let biggest = 0;
    for (let i = 1; i < id; i++) if (sizes[i] > sizes[biggest]) biggest = i;
    keep[biggest] = 1;

    const seeds = [];
    if (this.level?.spawnPoints) for (const p of this.level.spawnPoints) seeds.push(p);
    if (this.level?.enemySpawns) for (const p of this.level.enemySpawns) seeds.push(p);
    for (const p of seeds) {
      const ci = this._nearestWalkableRaw(p.x, p.z, 6);
      if (ci >= 0 && comp[ci] >= 0) keep[comp[ci]] = 1;
    }

    for (let i = 0; i < n; i++) {
      if (this.walk[i] && !keep[comp[i]]) { this.walk[i] = 0; this.floorY[i] = 0; }
    }
  }

  /** Penalise cells that hug obstacles so agents stop shaving corners. */
  _buildEdgeCosts() {
    const { nx, nz } = this;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (!this.walk[i]) continue;
        let blocked = 0;
        for (let k = 0; k < 8; k++) {
          const ax = ix + NB_DX[k], az = iz + NB_DZ[k];
          if (ax < 0 || az < 0 || ax >= nx || az >= nz) { blocked++; continue; }
          if (!this.walk[az * nx + ax]) blocked++;
        }
        this.extraCost[i] = Math.min(blocked, 4) * 0.42;
      }
    }
  }

  // ============================================================ queries ====

  cellIndex(x, z) {
    if (!this.ready) return -1;
    const ix = Math.round((x - this.originX) / this.cell);
    const iz = Math.round((z - this.originZ) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }

  cellCenterX(i) { return this.originX + (i % this.nx) * this.cell; }
  cellCenterZ(i) { return this.originZ + ((i / this.nx) | 0) * this.cell; }

  isWalkableAt(x, z) {
    const i = this.cellIndex(x, z);
    return i >= 0 && this.walk[i] === 1;
  }

  /** Standing surface height at a world XZ, or NaN if off-mesh. */
  sampleFloorAt(x, z) {
    const i = this.cellIndex(x, z);
    if (i < 0 || !this.walk[i]) return NaN;
    return this.floorY[i];
  }

  /** Nearest walkable cell within `radius` metres — spiral search, no alloc. */
  _nearestWalkableRaw(x, z, radius = 5) {
    if (!this.walk) return -1;
    const ix = Math.round((x - this.originX) / this.cell);
    const iz = Math.round((z - this.originZ) / this.cell);
    const R = Math.max(1, Math.ceil(radius / this.cell));
    for (let r = 0; r <= R; r++) {
      let best = -1, bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only the ring at radius r.
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ax = ix + dx, az = iz + dz;
          if (ax < 0 || az < 0 || ax >= this.nx || az >= this.nz) continue;
          const i = az * this.nx + ax;
          if (!this.walk[i]) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Snap a world position onto the nav surface. Returns false if off-mesh. */
  snap(pos, out, radius = 4) {
    const i = this._nearestWalkableRaw(pos.x, pos.z, radius);
    if (i < 0) return false;
    out.set(this.cellCenterX(i), this.floorY[i], this.cellCenterZ(i));
    return true;
  }

  /** Cheap grid probe used for steering — is the point `d` metres ahead open? */
  clearAhead(x, z, dx, dz, d) {
    const i = this.cellIndex(x + dx * d, z + dz * d);
    return i >= 0 && this.walk[i] === 1;
  }

  // ================================================== line of sight (3D) ===

  /**
   * True if nothing in the level blocks the segment a→b.
   * One BVH shapecast, no allocation, early-out on the first blocking triangle.
   */
  rayClear(ax, ay, az, bx, by, bz) {
    const tree = this.tree;
    if (!tree) return true;
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return true;
    const inv = 1 / len;
    this._losRay.origin.set(ax, ay, az);
    this._losRay.direction.set(dx * inv, dy * inv, dz * inv);
    this._losFarSq = len * len;

    const b = this._losBox;
    b.min.set(Math.min(ax, bx), Math.min(ay, by), Math.min(az, bz));
    b.max.set(Math.max(ax, bx), Math.max(ay, by), Math.max(az, bz));
    b.expandByScalar(0.02);

    this.stats.losTests++;
    return !tree.shapecast(this._losCb);
  }

  /** Vector3 convenience wrapper. */
  segmentClear(a, b) { return this.rayClear(a.x, a.y, a.z, b.x, b.y, b.z); }

  // ============================================================== paths ====

  /** Called once per simulation tick by the director. */
  beginTick() {
    this._plans = this.plansPerTick;
    this._urgent = this.urgentPlansPerTick;
    this._los = this.losPerTick;
  }

  /** Budgeted LoS slot request — returns true if the caller may raycast. */
  takeLosSlot() {
    if (this._los <= 0) return false;
    this._los--;
    return true;
  }

  get planBudgetLeft() { return this._plans + this._urgent; }

  /**
   * Plan a path. Respects the per-tick re-plan budget.
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {NavPath} path      filled on success
   * @param {boolean} urgent    may draw on the reserved urgent budget
   * @returns {'ok'|'busy'|'fail'}
   */
  requestPath(from, to, path, urgent = false) {
    if (!this.ready) return 'fail';
    if (this._plans > 0) this._plans--;
    else if (urgent && this._urgent > 0) this._urgent--;
    else return 'busy';
    return this._findPath(from, to, path) ? 'ok' : 'fail';
  }

  _findPath(from, to, path) {
    this.stats.plans++;
    const start = this._nearestWalkableRaw(from.x, from.z, 3);
    const goal = this._nearestWalkableRaw(to.x, to.z, 5);
    if (start < 0 || goal < 0) { this.stats.planFail++; return false; }

    path.reset();
    path.goal.copy(to);

    if (start === goal) {
      this._pushPoint(path, to.x, this.floorY[goal], to.z);
      path.valid = true;
      return true;
    }

    const cells = this._astar(start, goal);
    if (cells <= 0) { this.stats.planFail++; return false; }

    this._stringPull(cells, from, path);
    if (path.count === 0) { this.stats.planFail++; return false; }

    // Use the caller's exact point only when it genuinely lies inside the cell
    // we routed to. Snapping an off-mesh target (a spot behind a wall, say)
    // onto the end of a valid path would walk the agent straight into it.
    if (this._cellPath[cells - 1] === goal && !path.partial
        && this.cellIndex(to.x, to.z) === goal) {
      const o = (path.count - 1) * 3;
      path.pts[o] = to.x;
      path.pts[o + 2] = to.z;
      path.pts[o + 1] = this.floorY[goal];
    }
    path.valid = true;
    return true;
  }

  /**
   * A* over the 8-connected grid. Writes the cell chain into `_cellPath`
   * (start → goal) and returns its length, or 0 on failure.
   */
  _astar(start, goal) {
    const { nx, nz, cell } = this;
    const g = this._g, f = this._f, parent = this._parent;
    const stamp = this._stamp, closed = this._closed;
    const walk = this.walk, floorY = this.floorY, extra = this.extraCost;
    const s = ++this._stampVal;

    const gx = goal % nx, gz = (goal / nx) | 0;
    this._heapSize = 0;

    stamp[start] = s; g[start] = 0; closed[start] = 0; parent[start] = -1;
    f[start] = this._h(start % nx, (start / nx) | 0, gx, gz);
    this._heapPush(start);

    let expansions = 0;
    let found = false;

    while (this._heapSize > 0) {
      const cur = this._heapPop();
      if (cur === goal) { found = true; break; }
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++expansions > this.maxExpansions) break;

      const cx = cur % nx, cz = (cur / nx) | 0;
      const cy = floorY[cur];
      const gcur = g[cur];

      for (let k = 0; k < 8; k++) {
        const dx = NB_DX[k], dz = NB_DZ[k];
        const ax = cx + dx, az = cz + dz;
        if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
        const ni = az * nx + ax;
        if (!walk[ni]) continue;
        if (stamp[ni] === s && closed[ni]) continue;

        const dy = floorY[ni] - cy;
        if (dy > this.stepHeight || dy < -this.stepHeight * 2.2) continue;
        if (dx !== 0 && dz !== 0) {
          if (!walk[cz * nx + ax] || !walk[az * nx + cx]) continue;
        }

        const step = (dx !== 0 && dz !== 0) ? 1.41421356 : 1.0;
        const cost = step * cell * (1 + extra[ni]) + Math.abs(dy) * 1.6;
        const ng = gcur + cost;

        if (stamp[ni] !== s) {
          stamp[ni] = s; closed[ni] = 0; g[ni] = ng; parent[ni] = cur;
          f[ni] = ng + this._h(ax, az, gx, gz);
          this._heapPush(ni);
        } else if (ng < g[ni]) {
          g[ni] = ng; parent[ni] = cur;
          f[ni] = ng + this._h(ax, az, gx, gz);
          this._heapDecrease(ni);
        }
      }
    }
    this.stats.planNodes += expansions;

    // On failure fall back to the closest node we actually reached, so agents
    // still make progress toward an unreachable target instead of freezing.
    let end = goal;
    if (!found) {
      let best = -1, bestH = Infinity;
      for (let i = 0; i < this._heapSize; i++) {
        const c = this._heap[i];
        const h = f[c] - g[c];
        if (h < bestH) { bestH = h; best = c; }
      }
      if (best < 0) return 0;
      end = best;
    }

    // Walk parents back, then reverse in place.
    let len = 0;
    let c = end;
    while (c !== -1 && len < MAX_CELL_PATH) { this._cellPath[len++] = c; c = parent[c]; }
    if (len < 2) return 0;
    for (let i = 0, j = len - 1; i < j; i++, j--) {
      const t = this._cellPath[i]; this._cellPath[i] = this._cellPath[j]; this._cellPath[j] = t;
    }
    return len;
  }

  /** Octile heuristic, mildly weighted so the search stays tight. */
  _h(ax, az, bx, bz) {
    const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    const lo = Math.min(dx, dz), hi = Math.max(dx, dz);
    return (hi - lo + lo * 1.41421356) * this.cell * 1.04;
  }

  // --- binary heap keyed by f[] ------------------------------------------

  _heapPush(c) {
    const heap = this._heap, hpos = this._hpos, f = this._f;
    let i = this._heapSize++;
    heap[i] = c; hpos[c] = i;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[heap[p]] <= f[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      hpos[heap[p]] = p; hpos[heap[i]] = i;
      i = p;
    }
  }

  _heapDecrease(c) {
    const heap = this._heap, hpos = this._hpos, f = this._f;
    let i = hpos[c];
    if (i < 0 || i >= this._heapSize || heap[i] !== c) { this._heapPush(c); return; }
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[heap[p]] <= f[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      hpos[heap[p]] = p; hpos[heap[i]] = i;
      i = p;
    }
  }

  _heapPop() {
    const heap = this._heap, hpos = this._hpos, f = this._f;
    const top = heap[0];
    const last = --this._heapSize;
    if (last > 0) {
      heap[0] = heap[last]; hpos[heap[0]] = 0;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < last && f[heap[l]] < f[heap[m]]) m = l;
        if (r < last && f[heap[r]] < f[heap[m]]) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        hpos[heap[m]] = m; hpos[heap[i]] = i;
        i = m;
      }
    }
    hpos[top] = -1;
    return top;
  }

  // --- string pulling -----------------------------------------------------

  _pushPoint(path, x, y, z) {
    if (path.count >= path.max) { path.partial = true; return false; }
    const o = path.count * 3;
    path.pts[o] = x; path.pts[o + 1] = y; path.pts[o + 2] = z;
    path.count++;
    return true;
  }

  /**
   * Collapse the cell chain into the fewest waypoints that still have clear
   * ground between them. Without this, agents walk visible staircase zig-zags.
   */
  _stringPull(count, from, path) {
    const cells = this._cellPath;
    let anchorX = from.x, anchorZ = from.z;
    let next = 1;

    while (next < count) {
      let best = next;
      const cap = Math.min(count - 1, next + this.lookahead);
      for (let k = next; k <= cap; k++) {
        const c = cells[k];
        if (!this._navClear(anchorX, anchorZ, this.cellCenterX(c), this.cellCenterZ(c))) break;
        best = k;
      }
      const c = cells[best];
      const px = this.cellCenterX(c), pz = this.cellCenterZ(c);
      if (!this._pushPoint(path, px, this.floorY[c], pz)) break;
      anchorX = px; anchorZ = pz;
      next = best + 1;
    }
    if (next < count) path.partial = true;
  }

  /**
   * Ground-level visibility test on the grid — walkable the whole way, with
   * agent-radius clearance and no step the agent could not climb.
   */
  _navClear(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-5) return true;
    const steps = Math.min(MAX_SEG_SAMPLES, Math.max(2, Math.ceil(len / (this.cell * 0.5))));
    const r = this.agentRadius;
    const px = (-dz / len) * r, pz = (dx / len) * r;

    let i0 = this.cellIndex(ax, az);
    if (i0 < 0 || !this.walk[i0]) return false;
    let prevY = this.floorY[i0];

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + dx * t, z = az + dz * t;
      const ci = this.cellIndex(x, z);
      if (ci < 0 || !this.walk[ci]) return false;
      const l = this.cellIndex(x + px, z + pz);
      if (l < 0 || !this.walk[l]) return false;
      const rr = this.cellIndex(x - px, z - pz);
      if (rr < 0 || !this.walk[rr]) return false;
      const y = this.floorY[ci];
      if (Math.abs(y - prevY) > this.stepHeight) return false;
      prevY = y;
    }
    return true;
  }

  dispose() {
    this.walk = null; this.floorY = null; this.extraCost = null;
    this._g = null; this._f = null; this._parent = null;
    this._stamp = null; this._closed = null; this._heap = null; this._hpos = null;
    this.tree = null;
    this.ready = false;
  }
}

// 8-connected neighbour offsets: 4 orthogonal first (cheaper paths win ties).
const NB_DX = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const NB_DZ = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);

export default Navigation;
