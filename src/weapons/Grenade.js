import * as THREE from 'three';

/*
 * Thrown fragmentation grenades.
 *
 * Projectiles are integrated at the fixed timestep and collide by raycasting
 * the swept segment against the level BVH, which is both cheaper and more
 * reliable than a sphere cast for something this small and this fast — a
 * grenade at 18 m/s moves 15 cm per tick, so tunnelling is the only real risk
 * and a swept ray removes it entirely.
 *
 * Everything is pooled: a match's worth of grenades allocates nothing.
 */

const POOL_SIZE = 12;
const FUSE = 3.2;              // seconds from throw to detonation
const RADIUS = 0.033;          // an M67 is about 64 mm across
const RESTITUTION = 0.32;      // grenades barely bounce; they thud and roll
const FRICTION = 0.62;
const GRAVITY = 18.5;          // matches the player controller

export class GrenadeSystem {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'grenades';

    this.count = 3;            // grenades the player is carrying
    this.maxCount = 3;
    this.cooldown = 0;

    const geo = this._buildGrenadeGeometry();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x39402f, roughness: 0.62, metalness: 0.55,
    });
    this._geo = geo; this._mat = mat;

    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      this.root.add(mesh);
      this.pool.push({
        mesh, active: false, fuse: 0,
        vel: new THREE.Vector3(), spin: new THREE.Vector3(),
        prev: new THREE.Vector3(), rested: 0,
      });
    }

    this._s = {
      ray: new THREE.Raycaster(),
      dir: new THREE.Vector3(), next: new THREE.Vector3(),
      n: new THREE.Vector3(), v: new THREE.Vector3(),
    };
    this._s.ray.firstHitOnly = true;
  }

  /** A body with a moulded grip pattern, a fuse assembly and a spoon. */
  _buildGrenadeGeometry() {
    const parts = [];
    const body = new THREE.SphereGeometry(RADIUS, 14, 10);
    body.scale(1, 1.18, 1);
    parts.push(body);
    const fuse = new THREE.CylinderGeometry(RADIUS * 0.34, RADIUS * 0.40, RADIUS * 0.55, 10);
    fuse.translate(0, RADIUS * 1.22, 0);
    parts.push(fuse);
    const spoon = new THREE.BoxGeometry(RADIUS * 0.20, RADIUS * 1.05, RADIUS * 0.10);
    spoon.translate(RADIUS * 0.42, RADIUS * 0.85, 0);
    parts.push(spoon);
    // Merge by hand to avoid pulling in BufferGeometryUtils for three primitives.
    // Expand to non-indexed FIRST — de-indexing multiplies the vertex count, so
    // sizing the buffer from the indexed counts overflows it.
    const flat = parts.map((g) => {
      const ng = g.index ? g.toNonIndexed() : g;
      if (ng !== g) g.dispose();
      return ng;
    });
    let total = 0;
    for (const g of flat) total += g.attributes.position.count;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    let o = 0;
    for (const g of flat) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, o * 3), 3));
    out.computeBoundingSphere();
    return out;
  }

  _free() { return this.pool.find((p) => !p.active) ?? null; }

  /**
   * Throw from the camera.
   * @param {number} power 0..1 — a short press lobs, a held press throws hard
   */
  throwGrenade(power = 1) {
    if (this.count <= 0 || this.cooldown > 0) return false;
    const p = this._free();
    if (!p) return false;
    const ctx = this.ctx, cam = ctx.camera, s = this._s;

    this.count--;
    this.cooldown = 0.85;

    cam.getWorldDirection(s.dir);
    // Start slightly ahead and below the eye so it doesn't clip the viewmodel.
    p.mesh.position.copy(cam.position).addScaledVector(s.dir, 0.42);
    p.mesh.position.y -= 0.12;
    p.prev.copy(p.mesh.position);

    const speed = THREE.MathUtils.lerp(9.0, 19.0, THREE.MathUtils.clamp(power, 0, 1));
    p.vel.copy(s.dir).multiplyScalar(speed);
    p.vel.y += 2.4;                       // a natural throw arcs upward
    // Inherit the thrower's momentum, which is what makes running throws feel right.
    if (ctx.player) p.vel.addScaledVector(ctx.player.velocity, 0.55);

    p.spin.set(
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 14,
      (Math.random() - 0.5) * 22
    );
    p.fuse = FUSE;
    p.rested = 0;
    p.active = true;
    p.mesh.visible = true;

    ctx.audio?.play('grenadePin');
    ctx.hud?.setGrenades?.(this.count);
    return true;
  }

  update(dt, ctx) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const s = this._s;
    const collider = ctx.world?.collider;

    for (const p of this.pool) {
      if (!p.active) continue;

      p.fuse -= dt;
      if (p.fuse <= 0) { this._detonate(p, ctx); continue; }

      p.vel.y -= GRAVITY * dt;
      p.prev.copy(p.mesh.position);
      s.next.copy(p.mesh.position).addScaledVector(p.vel, dt);

      if (collider) {
        const delta = s.dir.copy(s.next).sub(p.prev);
        const dist = delta.length();
        if (dist > 1e-5) {
          delta.divideScalar(dist);
          s.ray.set(p.prev, delta);
          s.ray.far = dist + RADIUS;
          const hits = s.ray.intersectObject(collider, false);
          if (hits.length) {
            const h = hits[0];
            s.n.copy(h.face ? h.face.normal : delta.clone().negate());
            // Land just off the surface so the next tick doesn't start inside it.
            p.mesh.position.copy(h.point).addScaledVector(s.n, RADIUS * 1.05);

            const vn = p.vel.dot(s.n);
            if (vn < 0) {
              // Split into normal and tangential, bounce one, damp the other.
              s.v.copy(s.n).multiplyScalar(vn);
              p.vel.sub(s.v);                      // tangential
              p.vel.multiplyScalar(FRICTION);
              p.vel.addScaledVector(s.n, -vn * RESTITUTION);
            }
            p.spin.multiplyScalar(0.55);

            const impact = Math.abs(vn);
            if (impact > 1.2) {
              ctx.audio?.play('grenadeBounce', {
                position: p.mesh.position,
                volume: THREE.MathUtils.clamp(impact / 9, 0.15, 1),
              });
            }
            if (p.vel.lengthSq() < 0.35) p.rested += dt; else p.rested = 0;
          } else {
            p.mesh.position.copy(s.next);
            p.rested = 0;
          }
        }
      } else {
        p.mesh.position.copy(s.next);
      }

      // Settle: once it has stopped, stop spinning it too.
      if (p.rested > 0.25) {
        p.vel.multiplyScalar(Math.exp(-6 * dt));
        p.spin.multiplyScalar(Math.exp(-7 * dt));
      }
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;

      if (p.mesh.position.y < -30) this._recycle(p);
    }
  }

  _detonate(p, ctx) {
    const pos = p.mesh.position;
    ctx.player && (ctx.player.shakeTrauma = Math.min(
      1, ctx.player.shakeTrauma + 1.4 / (1 + ctx.player.position.distanceTo(pos) * 0.35)
    ));
    // Ballistics owns the damage falloff and the line-of-sight occlusion test.
    ctx.weapons?.ballistics?.explode(pos, 8.5, 145);
    this._recycle(p);
  }

  _recycle(p) {
    p.active = false;
    p.mesh.visible = false;
    p.vel.set(0, 0, 0);
    p.spin.set(0, 0, 0);
  }

  resupply() {
    this.count = this.maxCount;
    this.ctx.hud?.setGrenades?.(this.count);
  }

  dispose() {
    this._geo.dispose();
    this._mat.dispose();
  }
}
