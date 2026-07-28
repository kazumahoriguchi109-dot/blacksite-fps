import * as THREE from 'three';
import { Navigation, NavPath } from './Navigation.js';
import { Enemy, STATE } from './Enemy.js';

/*
 * AI director — pool ownership, wave placement, work scheduling, and the
 * aggression budget.
 *
 * The pool is built once. `spawnWave` recycles corpses and dormant agents;
 * nothing is constructed after load, so there is no mid-firefight hitch from
 * geometry generation or material compilation.
 *
 * The important part is the aggression budget. Sixteen soldiers who each
 * independently decide to shoot the moment they see you produce a wall of
 * simultaneous hitscan that no player can read or counter — the single
 * clearest tell of hobby AI. Shipped shooters gate this: a small number of
 * agents hold "permission to kill" at any moment, permission rotates on a
 * timer, and everyone else manoeuvres or suppresses at heavily reduced
 * lethality. That is what makes a firefight legible, and it is implemented
 * here as tokens plus a global minimum spacing between burst starts.
 *
 * Expensive work is staggered by design. At the 120 Hz fixed step this module
 * issues at most 2 line-of-sight raycasts, 3 cover-evaluation raycasts and
 * 2 A* queries per tick, no matter how many agents are alive. Everything an
 * agent needs every frame — range, steering, ground height, animation — is
 * either arithmetic or a grid lookup.
 */

const POOL_SIZE = 16;

const DIRECTOR = {
  losPerTick: 2,          // agents given a fresh LoS test each tick
  coverPerTick: 1,        // cover evaluations (each spends up to 3 raycasts)
  burstStagger: 0.22,     // minimum seconds between any two burst starts
  tokenInterval: 1.1,     // how often firing permission is re-dealt
  tokenMinHold: 0.9,      // a holder keeps it at least this long
  maxAttackersBase: 1,
  maxAttackersCap: 3,
  separationRadius: 1.35,
  separationForce: 3.2,
  waveGap: 7.0,           // seconds between a wipe and the next wave
  gunshotNoiseRadius: 55,
  footstepNoiseRadius: 14,
};

export class AIDirector {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'ai';

    this.rng = mulberry32(0x5EED1A);
    this.time = 0;
    this.tick = 0;

    /** @type {Enemy[]} Ballistics iterates this; it filters on `alive`. */
    this.enemies = [];

    this.nav = new Navigation(ctx?.world ?? null, {
      cell: 0.75,
      headroom: 2.0,
      stepHeight: 0.45,
      plansPerTick: 1,
      urgentPlansPerTick: 1,
      maxExpansions: 2600,
    });
    try {
      this.nav.build();
      if (this.nav.ready) {
        console.info(
          `[ai] navgrid ${this.nav.nx}x${this.nav.nz} @${this.nav.cell.toFixed(2)}m — ` +
          `${this.nav.stats.walkable}/${this.nav.stats.cells} walkable in ` +
          `${this.nav.stats.buildMs.toFixed(0)}ms`
        );
      }
    } catch (e) {
      console.warn('[ai] navigation build failed — agents will steer directly:', e.message);
    }
    // The level contract advertises a navGrid; publish ours if nobody has.
    if (ctx?.world && !ctx.world.navGrid) ctx.world.navGrid = this.nav;

    for (let i = 0; i < POOL_SIZE; i++) {
      const e = new Enemy(this, i, new NavPath(32));
      this.root.add(e.root);
      this.enemies.push(e);
    }

    // --- cover arbitration ---
    this._coverOwner = new Int16Array(Math.max(1, ctx?.world?.coverPoints?.length ?? 1)).fill(-1);
    this._coverBudget = 0;

    // --- aggression budget ---
    this._tokenTimer = 0;
    this._lastBurstAt = -99;
    this._lastShotAt = -99;
    this._tokenHeldSince = new Float32Array(POOL_SIZE);

    // --- scheduling ---
    this._senseCursor = 0;
    this._coverCursor = 0;

    // --- waves ---
    this.wave = 0;
    this.autoWaves = true;
    this._waveTimer = 0;
    this._waveActive = false;
    this._clearAnnounced = false;

    // --- player noise detection (weapons fire is the loudest tell there is) ---
    this._lastPlayerAmmo = -1;

    this._s = {
      v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
    };

    this.stats = { alive: 0, engaged: 0, attackers: 0 };
  }

  // ============================================================== spawning ==

  get aliveCount() {
    let n = 0;
    for (const e of this.enemies) if (e.active && e.alive) n++;
    return n;
  }

  /**
   * Place `n` hostiles at level spawn points, weighted away from the player so
   * nobody materialises in his face.
   */
  spawnWave(n) {
    const ctx = this.ctx;
    const spawns = ctx?.world?.enemySpawns;
    if (!spawns || !spawns.length) return 0;
    const p = ctx.player?.position;
    const s = this._s;

    // Score every spawn point per placement. Reuse is penalised rather than
    // forbidden, so a wave larger than the authored spawn list still places —
    // repeats get scattered around their point instead of stacking on it.
    const count = spawns.length;
    const used = new Uint8Array(count);
    let placed = 0;

    for (let k = 0; k < n; k++) {
      const e = this._takeFree();
      if (!e) break;

      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < count; i++) {
        const sp = spawns[i];
        let score = this.rng() * 6 - used[i] * 14;
        if (p) {
          const d = Math.hypot(sp.x - p.x, sp.z - p.z);
          // Sweet spot: far enough to be fair, near enough to matter.
          score += d < 18 ? -(18 - d) * 2.4 : -Math.abs(d - 40) * 0.16;
        }
        // Spread the wave out rather than stacking one corner.
        for (const other of this.enemies) {
          if (!other.active || !other.alive) continue;
          const d2 = Math.hypot(sp.x - other.root.position.x, sp.z - other.root.position.z);
          if (d2 < 6) score -= (6 - d2) * 1.2;
        }
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) break;

      s.v1.copy(spawns[best]);
      if (used[best]) {
        // Already claimed this point — scatter around it and re-snap.
        const a = this.rng() * Math.PI * 2;
        const r = 2.5 + this.rng() * 4.5;
        s.v1.x += Math.cos(a) * r;
        s.v1.z += Math.sin(a) * r;
      }
      used[best]++;

      // Drop them onto the nav surface so nobody spawns floating or buried.
      if (!this.nav.ready || !this.nav.snap(s.v1, s.v2, 6)) s.v2.copy(s.v1);

      const yaw = p ? Math.atan2(-(p.x - s.v2.x), -(p.z - s.v2.z)) : this.rng() * Math.PI * 2;
      e.spawn(s.v2, yaw);
      e.lastProgress.copy(s.v2);
      placed++;
    }

    if (placed > 0) {
      this.wave++;
      this._waveActive = true;
      this._waveTimer = 0;
      this._clearAnnounced = false;
    }
    return placed;
  }

  _takeFree() {
    // Prefer a never-used slot, then the oldest corpse.
    for (const e of this.enemies) if (!e.active) return e;
    let oldest = null;
    for (const e of this.enemies) {
      if (e.alive) continue;
      if (!oldest || e.corpseTimer > oldest.corpseTimer) oldest = e;
    }
    if (oldest) { oldest.despawn(); return oldest; }
    return null;
  }

  // ================================================================ update ==

  update(dt, ctx) {
    this.time += dt;
    this.tick++;

    this.nav.beginTick();
    this._coverBudget = DIRECTOR.coverPerTick;

    this._detectPlayerNoise(ctx);
    this._servePerception(ctx);
    this._updateTokens(dt, ctx);
    this._separation(dt);

    for (let i = 0; i < this.enemies.length; i++) this.enemies[i].update(dt, ctx);

    this._updateWaves(dt, ctx);
  }

  /**
   * Give a rotating handful of agents a fresh line-of-sight test. Nobody gets
   * one every tick — at 120 Hz, two per tick still means every agent in a
   * full pool is re-tested roughly eight times a second.
   */
  _servePerception(ctx) {
    if (!ctx.player) return;
    const n = this.enemies.length;
    let served = 0;
    for (let scanned = 0; scanned < n && served < DIRECTOR.losPerTick; scanned++) {
      this._senseCursor = (this._senseCursor + 1) % n;
      const e = this.enemies[this._senseCursor];
      if (!e.active || !e.alive) continue;
      // Distant idle agents do not need to be polled as often as a soldier
      // who is mid-firefight.
      if (!e.alerted && e.distToPlayer > 55 && (this.tick & 7) !== 0) continue;
      e.senseNow(ctx);
      served++;
    }
  }

  /** Watch the player's magazine — a shot fired is the loudest thing in the map. */
  _detectPlayerNoise(ctx) {
    const w = ctx.weapons;
    const p = ctx.player;
    if (!p) return;

    if (w) {
      const mag = w.ammoMag ?? -1;
      if (this._lastPlayerAmmo >= 0 && mag >= 0 && mag < this._lastPlayerAmmo) {
        this.notifyNoise(p.position.x, p.position.y, p.position.z,
          DIRECTOR.gunshotNoiseRadius, 1.0);
      }
      this._lastPlayerAmmo = mag;
    }

    // Sprinting is audible at short range; crouch-walking is not.
    if ((this.tick % 24) === 0 && p.grounded && !p.crouching) {
      const sp = p.speed2D ?? 0;
      if (sp > 5.2) {
        this.notifyNoise(p.position.x, p.position.y, p.position.z,
          DIRECTOR.footstepNoiseRadius, 0.4);
      }
    }
  }

  /**
   * Broadcast an audible event. Attenuates with distance; walls are ignored on
   * purpose (sound goes around corners, and pretending otherwise makes agents
   * feel deaf).
   */
  notifyNoise(x, y, z, radius, strength = 1) {
    const r2 = radius * radius;
    for (const e of this.enemies) {
      if (!e.active || !e.alive) continue;
      const dx = e.root.position.x - x, dz = e.root.position.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / radius;
      e.onNoise(x, y, z, strength * falloff * falloff);
    }
  }

  // ==================================================== aggression budget ===

  /**
   * Re-deal permission to kill. Holders keep it for a minimum time so the
   * firefight has a readable rhythm instead of flickering between agents.
   */
  _updateTokens(dt, ctx) {
    this._tokenTimer -= dt;

    let engaged = 0;
    for (const e of this.enemies) {
      if (!e.active || !e.alive) continue;
      if (e.hasLos && e.alerted) engaged++;
      // Losing sight or dying hands the token straight back.
      if (e.token && (!e.hasLos || e.reloadTimer > 0)
          && this.time - this._tokenHeldSince[e.id] > DIRECTOR.tokenMinHold) {
        e.token = false;
        this._tokenTimer = Math.min(this._tokenTimer, 0);
      }
    }
    this.stats.engaged = engaged;

    if (this._tokenTimer > 0) return;
    this._tokenTimer = DIRECTOR.tokenInterval;

    const maxAttackers = Math.min(
      DIRECTOR.maxAttackersCap,
      DIRECTOR.maxAttackersBase + Math.floor(engaged / 3)
    );

    // Score candidates: close, already aiming, and — crucially — not the agent
    // who just had a turn.
    let granted = 0;
    for (let pass = 0; pass < maxAttackers; pass++) {
      let best = null, bestScore = -Infinity;
      for (const e of this.enemies) {
        if (!e.active || !e.alive || e.token) continue;
        if (!e.hasLos || e.reloadTimer > 0 || e.reaction > 0) continue;
        let score = 26 - Math.min(26, e.distToPlayer);
        score += e.losTime * 2.2;
        score += e.inCover ? 3.5 : 0;
        // Rotation pressure — whoever has waited longest gets priority.
        score += Math.min(8, this.time - this._tokenHeldSince[e.id]) * 1.4;
        score += this.rng() * 3;
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (!best) break;
      best.token = true;
      this._tokenHeldSince[best.id] = this.time;
      granted++;
    }

    // Trim if the cap dropped (agents died, or fewer are engaged now).
    let held = 0;
    for (const e of this.enemies) if (e.token && e.active && e.alive) held++;
    if (held > maxAttackers) {
      for (const e of this.enemies) {
        if (held <= maxAttackers) break;
        if (!e.token || !e.active || !e.alive) continue;
        if (this.time - this._tokenHeldSince[e.id] < DIRECTOR.tokenMinHold) continue;
        e.token = false;
        held--;
      }
    }
    for (const e of this.enemies) if (!e.active || !e.alive) e.token = false;
    this.stats.attackers = held;
  }

  /**
   * Gate on starting a burst. Even permitted agents cannot open up in the same
   * instant as someone else — staggering burst *starts* is most of what makes
   * incoming fire feel like a fight rather than an execution.
   */
  requestFireSlot(enemy) {
    if (this.time - this._lastBurstAt < DIRECTOR.burstStagger) return false;
    this._lastBurstAt = this.time;
    return true;
  }

  onShotFired(enemy, ctx) {
    this._lastShotAt = this.time;
    // Friendly fire is a cue: squadmates who heard it look toward the target.
    if ((this.tick & 3) === 0 && enemy.hasLastKnown) {
      for (const e of this.enemies) {
        if (e === enemy || !e.active || !e.alive || e.alerted) continue;
        const dx = e.root.position.x - enemy.root.position.x;
        const dz = e.root.position.z - enemy.root.position.z;
        if (dx * dx + dz * dz > 900) continue;
        e.onNoise(enemy.lastKnown.x, enemy.lastKnown.y, enemy.lastKnown.z, 0.7);
      }
    }
  }

  // ============================================================ cover pool ==

  takeCoverSlot() {
    if (this._coverBudget <= 0) return false;
    this._coverBudget--;
    return true;
  }

  isCoverClaimed(index, by) {
    if (index < 0 || index >= this._coverOwner.length) return true;
    const o = this._coverOwner[index];
    return o !== -1 && o !== by.id;
  }

  claimCover(index, by) {
    if (index < 0 || index >= this._coverOwner.length) return;
    this._coverOwner[index] = by.id;
  }

  releaseCover(index, by) {
    if (index < 0 || index >= this._coverOwner.length) return;
    if (this._coverOwner[index] === by.id) this._coverOwner[index] = -1;
  }

  // ============================================================== reactions ==

  onEnemyHurt(enemy, amount, dir) {
    // Taking fire tells the squad roughly where it came from.
    if (!enemy.hasLastKnown) return;
    for (const e of this.enemies) {
      if (e === enemy || !e.active || !e.alive) continue;
      const dx = e.root.position.x - enemy.root.position.x;
      const dz = e.root.position.z - enemy.root.position.z;
      if (dx * dx + dz * dz > 625) continue;   // 25 m
      e.onNoise(enemy.lastKnown.x, enemy.lastKnown.y, enemy.lastKnown.z, 0.55);
    }
  }

  onEnemyKilled(enemy) {
    enemy.token = false;
    // A man going down is loud, and it should visibly rattle the squad: they
    // give up ground and look for cover rather than standing in the open.
    for (const e of this.enemies) {
      if (e === enemy || !e.active || !e.alive) continue;
      const dx = e.root.position.x - enemy.root.position.x;
      const dz = e.root.position.z - enemy.root.position.z;
      if (dx * dx + dz * dz > 900) continue;
      e.onNoise(enemy.lastKnown.x, enemy.lastKnown.y, enemy.lastKnown.z, 0.8);
      if (!e.inCover && e.state === STATE.ENGAGE) e.tacticTimer = 0;
    }
  }

  // ============================================================ separation ==

  /** Keep bodies from occupying the same cell. O(n^2) over 16 is trivial. */
  _separation(dt) {
    const list = this.enemies;
    const R = DIRECTOR.separationRadius;
    const R2 = R * R;
    let alive = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.active || !a.alive) continue;
      alive++;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.active || !b.alive) continue;
        const dx = a.root.position.x - b.root.position.x;
        const dz = a.root.position.z - b.root.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (1 - d / R) * DIRECTOR.separationForce;
        const nx = dx / d, nz = dz / d;
        a.separation.x += nx * push; a.separation.z += nz * push;
        b.separation.x -= nx * push; b.separation.z -= nz * push;
      }
    }
    this.stats.alive = alive;
  }

  // ================================================================= waves ==

  _updateWaves(dt, ctx) {
    if (!this.autoWaves) return;
    if (!this._waveActive) return;
    if (this.aliveCount > 0) { this._waveTimer = 0; this._clearAnnounced = false; return; }

    this._waveTimer += dt;
    if (!this._clearAnnounced) {
      this._clearAnnounced = true;
      ctx.hud?.showBanner?.('SECTOR CLEAR', 'Contacts inbound');
    }
    if (this._waveTimer >= DIRECTOR.waveGap) {
      this._waveActive = false;
      const n = Math.min(POOL_SIZE, 5 + this.wave);
      if (this.spawnWave(n) > 0) {
        ctx.hud?.showBanner?.(`WAVE ${this.wave}`, `${n} hostiles`);
      }
    }
  }

  // =============================================================== teardown ==

  dispose() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.root.clear();
    this.nav.dispose();
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

export default AIDirector;
