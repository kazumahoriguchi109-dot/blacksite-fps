import * as THREE from 'three';
import { surfaceAtHit } from '../world/Builder.js';

/*
 * Hitscan ballistics.
 *
 * Rays are fired from the camera centre (not the muzzle) — every shipped FPS
 * does this, because muzzle-origin rays make you miss things you are clearly
 * looking at when the weapon is offset from the eye. The muzzle is only used
 * for the visual tracer origin.
 *
 * Penetration: rounds carry a "penetration budget" in equivalent millimetres
 * of concrete. Thin sheet metal and wood cost little, concrete costs a lot,
 * and damage falls off with what's been spent.
 */

// Cost in penetration-units to punch through a surface, and how much velocity
// (and therefore damage) is lost doing it.
const PENETRATION = {
  wood:     { cost: 12, damageLoss: 0.22 },
  metal:    { cost: 26, damageLoss: 0.38 },
  glass:    { cost: 3,  damageLoss: 0.05 },
  sandbag:  { cost: 55, damageLoss: 0.62 },
  plaster:  { cost: 10, damageLoss: 0.18 },
  tile:     { cost: 20, damageLoss: 0.3 },
  rubber:   { cost: 14, damageLoss: 0.25 },
  brick:    { cost: 45, damageLoss: 0.55 },
  concrete: { cost: 70, damageLoss: 0.7 },
  asphalt:  { cost: 70, damageLoss: 0.7 },
  gravel:   { cost: 90, damageLoss: 0.8 },
  dirt:     { cost: 60, damageLoss: 0.65 },
};

const ZONE_MULT = { head: 2.35, chest: 1.0, limb: 0.72 };

export class Ballistics {
  constructor(ctx) {
    this.ctx = ctx;
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    this._s = {
      origin: new THREE.Vector3(), dir: new THREE.Vector3(),
      p: new THREE.Vector3(), n: new THREE.Vector3(),
      v1: new THREE.Vector3(), v2: new THREE.Vector3(),
      q: new THREE.Quaternion(), m: new THREE.Matrix4(),
    };
    this.tracerFrom = new THREE.Vector3();
  }

  /**
   * Fire one round.
   * @param {THREE.Vector3} origin  camera position
   * @param {THREE.Vector3} dir     normalised aim direction (spread applied already)
   * @param {object} weapon         { damage, range, penetration, headMult, falloffStart, falloffEnd, falloffMin }
   * @param {THREE.Vector3} muzzlePos  for the tracer origin
   */
  fire(origin, dir, weapon, muzzlePos) {
    const ctx = this.ctx, s = this._s;
    s.origin.copy(origin);
    s.dir.copy(dir).normalize();

    let remaining = weapon.penetration ?? 30;
    let damageScale = 1.0;
    let travelled = 0;
    let lastPoint = s.v1.copy(origin);
    let firstImpact = null;

    for (let pass = 0; pass < 4; pass++) {
      const world = ctx.world?.collider;
      this._ray.set(s.origin, s.dir);
      this._ray.far = (weapon.range ?? 220) - travelled;
      if (this._ray.far <= 0) break;

      // --- enemies first: they're the thing the player cares about hitting ---
      const enemyHit = this._raycastEnemies(s.origin, s.dir, this._ray.far);
      let worldHit = null;
      if (world) {
        const hits = this._ray.intersectObject(world, false);
        if (hits.length) worldHit = hits[0];
      }

      const enemyFirst = enemyHit && (!worldHit || enemyHit.distance < worldHit.distance);

      if (enemyFirst) {
        const dist = travelled + enemyHit.distance;
        const dmg = this._damageAt(weapon, dist) * damageScale * (ZONE_MULT[enemyHit.zone] ?? 1);
        // Record the zone so the game mode can report headshot kills without
        // needing to hook into the AI's damage path.
        enemyHit.enemy.lastHitZone = enemyHit.zone;
        enemyHit.enemy.applyDamage?.(dmg, enemyHit.zone, s.dir);
        ctx.fx?.bloodImpact?.(enemyHit.point, s.n.copy(s.dir).negate());
        ctx.hud?.hitmarker?.(
          enemyHit.enemy.alive === false ? (enemyHit.zone === 'head' ? 'headshot' : 'kill')
                                         : (enemyHit.zone === 'head' ? 'headshot' : 'hit')
        );
        ctx.audio?.play(enemyHit.zone === 'head' ? 'headshot' : 'hitmarker');
        ctx.audio?.play('impactFlesh', { position: enemyHit.point, volume: 0.7 });
        if (!firstImpact) firstImpact = enemyHit.point.clone();
        // Rounds keep going through bodies but lose a lot.
        remaining -= 40;
        damageScale *= 0.45;
        travelled = dist + 0.05;
        s.origin.copy(enemyHit.point).addScaledVector(s.dir, 0.05);
        if (remaining <= 0) break;
        continue;
      }

      if (!worldHit) {
        // Nothing hit — tracer flies to max range.
        if (!firstImpact) {
          firstImpact = s.v2.copy(s.origin).addScaledVector(s.dir, this._ray.far).clone();
        }
        break;
      }

      const surface = surfaceAtHit(world, worldHit.faceIndex);
      const point = worldHit.point;
      const normal = worldHit.face
        ? s.n.copy(worldHit.face.normal)
        : s.n.copy(s.dir).negate();

      ctx.fx?.impact?.(point, normal, surface);
      ctx.audio?.play('impact' + surface.charAt(0).toUpperCase() + surface.slice(1), {
        position: point, volume: 0.75,
      });
      // Glancing hits ricochet audibly.
      if (Math.abs(normal.dot(s.dir)) < 0.34 && Math.random() < 0.5) {
        ctx.audio?.play('ricochet', { position: point, volume: 0.6 });
      }
      if (!firstImpact) firstImpact = point.clone();

      const pen = PENETRATION[surface] ?? PENETRATION.concrete;
      remaining -= pen.cost;
      if (remaining <= 0) break;
      damageScale *= (1 - pen.damageLoss);
      travelled += worldHit.distance;

      // Step past the surface and continue. 0.35 m covers typical wall thickness.
      s.origin.copy(point).addScaledVector(s.dir, 0.35);
      if (damageScale < 0.08) break;
    }

    if (firstImpact && muzzlePos) {
      this.tracerFrom.copy(muzzlePos);
      ctx.fx?.tracer?.(this.tracerFrom, firstImpact, 900);
    }
    return firstImpact;
  }

  _damageAt(weapon, dist) {
    const a = weapon.falloffStart ?? 28;
    const b = weapon.falloffEnd ?? 90;
    const min = weapon.falloffMin ?? 0.42;
    if (dist <= a) return weapon.damage;
    const t = THREE.MathUtils.clamp((dist - a) / (b - a), 0, 1);
    return weapon.damage * THREE.MathUtils.lerp(1, min, t);
  }

  /** Sphere-swept test against enemy hit zones. Cheap and forgiving, which is
   *  what you want — precise mesh raycasts against animated bodies feel worse. */
  _raycastEnemies(origin, dir, maxDist) {
    const enemies = this.ctx.ai?.enemies;
    if (!enemies || !enemies.length) return null;
    const s = this._s;
    let best = null;

    for (const e of enemies) {
      if (!e.alive || !e.root) continue;
      const zones = e.getHitZones?.();
      if (!zones) continue;
      for (const z of zones) {
        // z = { center: Vector3, radius: number, zone: 'head'|'chest'|'limb' }
        const oc = s.v1.copy(z.center).sub(origin);
        const t = oc.dot(dir);
        if (t < 0 || t > maxDist) continue;
        const closest = s.v2.copy(dir).multiplyScalar(t).sub(oc);
        const d2 = closest.lengthSq();
        if (d2 > z.radius * z.radius) continue;
        // Exact entry point on the sphere.
        const back = Math.sqrt(Math.max(0, z.radius * z.radius - d2));
        const dist = t - back;
        if (dist < 0) continue;
        if (!best || dist < best.distance) {
          best = {
            enemy: e, zone: z.zone, distance: dist,
            point: new THREE.Vector3().copy(origin).addScaledVector(dir, dist),
          };
        }
      }
    }
    return best;
  }

  /** Explosion damage with line-of-sight occlusion. */
  explode(center, radius, maxDamage) {
    const ctx = this.ctx;
    ctx.fx?.explosion?.(center, radius);
    ctx.audio?.play('explosion', { position: center });

    const targets = [];
    if (ctx.ai?.enemies) for (const e of ctx.ai.enemies) if (e.alive) targets.push(e);
    if (ctx.player && !ctx.player.dead) targets.push(ctx.player);

    const s = this._s;
    for (const t of targets) {
      const pos = t.position ?? t.root?.position;
      if (!pos) continue;
      const d = s.v1.copy(pos).setY(pos.y + 0.9).sub(center);
      const dist = d.length();
      if (dist > radius) continue;
      // Occlusion check — walls should actually protect you.
      let blocked = false;
      if (ctx.world?.collider && dist > 0.4) {
        this._ray.set(center, s.v2.copy(d).divideScalar(dist));
        this._ray.far = dist - 0.2;
        blocked = this._ray.intersectObject(ctx.world.collider, false).length > 0;
      }
      const falloff = 1 - (dist / radius);
      const dmg = maxDamage * falloff * falloff * (blocked ? 0.25 : 1);
      if (dmg < 1) continue;
      if (t.applyDamage) t.applyDamage(dmg, 'chest', s.v2.copy(d).normalize());
    }
  }
}
