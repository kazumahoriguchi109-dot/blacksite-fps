import * as THREE from 'three';

/*
 * Player controller.
 *
 * Movement is a small state machine (ground / air / slide / mantle) integrated
 * at a fixed timestep, with capsule-vs-BVH depenetration for collision. The
 * camera rig is deliberately separate from the collision capsule: the capsule
 * moves in clean physics space, and the camera layers bob / sway / lean /
 * recoil / landing dip on top. Mixing those two is what makes hobby FPS
 * cameras feel mushy.
 *
 * Tuning follows arcade-military convention, not realism: gravity is ~1.8x
 * earth so jumps are snappy, and ground acceleration is very high so input
 * feels instant while air control stays low.
 */

const UP = new THREE.Vector3(0, 1, 0);

export const MOVE = {
  gravity: 18.5,
  walkSpeed: 4.35,
  sprintSpeed: 6.6,
  crouchSpeed: 2.25,
  adsSpeed: 2.7,
  groundAccel: 70,
  airAccel: 14,
  groundFriction: 11,
  airFriction: 0.25,
  jumpVelocity: 5.9,
  slideBoost: 8.2,
  slideFriction: 2.6,
  slideMinSpeed: 2.8,
  slideMaxTime: 1.15,
  standHeight: 1.78,
  crouchHeight: 1.16,
  eyeStand: 1.63,
  eyeCrouch: 1.02,
  eyeSlide: 0.78,
  radius: 0.34,
  stepHeight: 0.42,
  maxSlope: Math.cos(THREE.MathUtils.degToRad(52)),
  coyoteTime: 0.11,
  jumpBuffer: 0.12,
  mantleMaxHeight: 1.35,
  mantleMinHeight: 0.45,
  mantleReach: 0.85,
  mantleDuration: 0.42,
};

export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.camera = ctx.camera;

    this.position = new THREE.Vector3(0, 2, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    // --- state ---
    this.grounded = false;
    this.wasGrounded = false;
    this.crouching = false;
    this.sprinting = false;
    this.sliding = false;
    this.mantling = false;
    this.dead = false;

    this.height = MOVE.standHeight;
    this.eyeHeight = MOVE.eyeStand;
    this._eyeCurrent = MOVE.eyeStand;

    this.slideTimer = 0;
    this.coyote = 0;
    this.jumpBuffered = 0;
    this.airTime = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.surface = 'concrete';

    this.health = 100;
    this.maxHealth = 100;
    this.regenDelay = 0;

    // --- camera rig state ---
    this.bobPhase = 0;
    this.bobAmount = 0;
    this._swayOffset = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this.lean = 0;            // -1 left .. 1 right
    this._leanTarget = 0;
    this.landDip = 0;
    this._landDipVel = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.shakeTrauma = 0;
    // three's PerspectiveCamera.fov is VERTICAL. 60 vertical at 16:9 is ~91
    // horizontal, which is the range shipped shooters actually use; the
    // previous 80 vertical was 112 horizontal and stretched every frame edge.
    this.fov = 60;
    this.baseFov = 60;
    this._fovTarget = 60;

    this.mantleFrom = new THREE.Vector3();
    this.mantleTo = new THREE.Vector3();
    this.mantleT = 0;

    // --- scratch (no allocation in update) ---
    this._s = {
      v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
      v4: new THREE.Vector3(), v5: new THREE.Vector3(),
      seg: new THREE.Line3(), box: new THREE.Box3(),
      tri1: new THREE.Vector3(), tri2: new THREE.Vector3(),
      mat: new THREE.Matrix4(), q: new THREE.Quaternion(),
      e: new THREE.Euler(0, 0, 0, 'YXZ'),
      ray: new THREE.Raycaster(),
      dir: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(),
      wish: new THREE.Vector3(),
    };
    this._s.ray.firstHitOnly = true;

    this.onFootstep = null;   // (surface, isRun) => void
    this.onLand = null;       // (impactSpeed) => void
    this._stepDistance = 0;
  }

  spawn(pos, yaw = 0) {
    this.position.copy(pos);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.health = this.maxHealth;
    this.dead = false;
    this.sliding = false; this.crouching = false; this.mantling = false;
  }

  get speed2D() { return Math.hypot(this.velocity.x, this.velocity.z); }
  get isMoving() { return this.speed2D > 0.4; }

  // ---------------------------------------------------------------- look ---
  _updateLook(dt, input) {
    if (this.dead) return;
    const { yaw, pitch } = input.takeLook();
    // ADS reduces sensitivity proportionally to the FOV change, which is what
    // keeps aim consistent between hip and sights.
    const fovScale = Math.tan(THREE.MathUtils.degToRad(this.fov * 0.5))
                   / Math.tan(THREE.MathUtils.degToRad(this.baseFov * 0.5));
    this.yaw += yaw * fovScale;
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch * fovScale, -1.53, 1.53);

    // Weapon sway lags the look input, then springs back.
    const s = this._s;
    this._swayVel.x += (-yaw * 26 - this._swayOffset.x * 90) * dt;
    this._swayVel.y += (-pitch * 26 - this._swayOffset.y * 90) * dt;
    this._swayVel.multiplyScalar(Math.exp(-13 * dt));
    this._swayOffset.x += this._swayVel.x * dt;
    this._swayOffset.y += this._swayVel.y * dt;
    this._swayOffset.x = THREE.MathUtils.clamp(this._swayOffset.x, -0.06, 0.06);
    this._swayOffset.y = THREE.MathUtils.clamp(this._swayOffset.y, -0.06, 0.06);
  }

  // ------------------------------------------------------------ movement ---
  _wishDirection(input) {
    const s = this._s;
    let fx = 0, fz = 0;
    if (input.anyDown('KeyW', 'ArrowUp')) fz -= 1;
    if (input.anyDown('KeyS', 'ArrowDown')) fz += 1;
    if (input.anyDown('KeyA', 'ArrowLeft')) fx -= 1;
    if (input.anyDown('KeyD', 'ArrowRight')) fx += 1;
    if (fx === 0 && fz === 0) return s.wish.set(0, 0, 0);
    const len = Math.hypot(fx, fz);
    fx /= len; fz /= len;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // Rotate the input vector into world space around Y.
    return s.wish.set(fx * cy - fz * sy, 0, fx * sy + fz * cy).normalize()
      .multiplyScalar(1);
  }

  _targetSpeed(input, aiming) {
    if (this.sliding) return MOVE.slideBoost;
    if (this.crouching) return MOVE.crouchSpeed;
    if (aiming) return MOVE.adsSpeed;
    if (this.sprinting) return MOVE.sprintSpeed;
    return MOVE.walkSpeed;
  }

  update(dt, ctx) {
    const input = ctx.input;
    this._updateLook(dt, input);

    if (this.mantling) { this._updateMantle(dt, ctx); this._updateCamera(dt, ctx); return; }
    if (this.dead) { this._updateCamera(dt, ctx); return; }

    const aiming = !!ctx.weapons?.aiming;
    const wish = this._wishDirection(input);
    const wishing = wish.lengthSq() > 0.001;

    // --- sprint: requires forward-ish input, not aiming, not crouched ---
    const wantSprint = input.anyDown('ShiftLeft', 'ShiftRight');
    const forwardDot = wishing
      ? wish.x * -Math.sin(this.yaw) + wish.z * -Math.cos(this.yaw) : 0;
    this.sprinting = wantSprint && wishing && forwardDot > 0.55 && !aiming
      && !this.crouching && this.grounded;

    // --- crouch / slide ---
    const wantCrouch = input.anyDown('ControlLeft', 'KeyC');
    if (wantCrouch && !this.crouching) {
      // Sprinting into a crouch starts a slide.
      if (this.grounded && this.speed2D > MOVE.sprintSpeed * 0.82 && !this.sliding) {
        this.sliding = true;
        this.slideTimer = MOVE.slideMaxTime;
        const sp = this.speed2D;
        if (sp > 0.01) this.velocity.multiplyScalar(MOVE.slideBoost / sp);
        ctx.audio?.play('slide', { position: this.position });
        this.shakeTrauma = Math.min(1, this.shakeTrauma + 0.18);
      }
      this.crouching = true;
    } else if (!wantCrouch && this.crouching) {
      // Only stand if there's headroom.
      if (this._hasHeadroom(ctx, MOVE.standHeight)) {
        this.crouching = false;
        this.sliding = false;
      }
    }

    if (this.sliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0 || this.speed2D < MOVE.slideMinSpeed || !this.grounded) {
        this.sliding = false;
      }
    }

    this.height = this.crouching ? MOVE.crouchHeight : MOVE.standHeight;

    // --- acceleration ---
    const accel = this.grounded ? MOVE.groundAccel : MOVE.airAccel;
    const target = this._targetSpeed(input, aiming);

    if (this.sliding) {
      // Slides don't accept steering input beyond a small nudge; they decay.
      const damp = Math.exp(-MOVE.slideFriction * dt);
      this.velocity.x *= damp; this.velocity.z *= damp;
      if (wishing) {
        this.velocity.x += wish.x * 5.0 * dt;
        this.velocity.z += wish.z * 5.0 * dt;
      }
    } else if (wishing) {
      const s = this._s;
      const desiredX = wish.x * target, desiredZ = wish.z * target;
      // Quake-style: accelerate toward the desired velocity, capped by target.
      const dvx = desiredX - this.velocity.x, dvz = desiredZ - this.velocity.z;
      const dvLen = Math.hypot(dvx, dvz);
      if (dvLen > 0.0001) {
        const step = Math.min(dvLen, accel * dt);
        this.velocity.x += (dvx / dvLen) * step;
        this.velocity.z += (dvz / dvLen) * step;
      }
    } else if (this.grounded) {
      const damp = Math.exp(-MOVE.groundFriction * dt);
      this.velocity.x *= damp; this.velocity.z *= damp;
      if (this.speed2D < 0.06) { this.velocity.x = 0; this.velocity.z = 0; }
    } else {
      const damp = Math.exp(-MOVE.airFriction * dt);
      this.velocity.x *= damp; this.velocity.z *= damp;
    }

    // --- jump with coyote time + input buffering (both are why good shooters
    //     feel responsive; without them jumps eat inputs at ledge edges) ---
    if (input.pressed('Space')) this.jumpBuffered = MOVE.jumpBuffer;
    this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);
    this.coyote = this.grounded ? MOVE.coyoteTime : Math.max(0, this.coyote - dt);

    if (this.jumpBuffered > 0 && this.coyote > 0 && !this.mantling) {
      this.velocity.y = MOVE.jumpVelocity;
      this.grounded = false;
      this.coyote = 0; this.jumpBuffered = 0;
      this.sliding = false;
      ctx.audio?.play('jump', { position: this.position });
    }

    // --- try to mantle a ledge if we're pressing into one ---
    if (!this.grounded && wishing && this.velocity.y < 2.0 && this._tryMantle(ctx, wish)) {
      this._updateCamera(dt, ctx);
      return;
    }

    // --- gravity + integrate + collide ---
    this.velocity.y -= MOVE.gravity * dt;
    this.velocity.y = Math.max(this.velocity.y, -60);

    this.wasGrounded = this.grounded;
    this._integrate(dt, ctx);

    // --- landing ---
    if (this.grounded && !this.wasGrounded) {
      const impact = Math.max(0, -this._lastFallSpeed);
      if (impact > 2.0) {
        const t = THREE.MathUtils.clamp((impact - 2) / 12, 0, 1);
        this.landDip = -0.055 - t * 0.16;
        this.shakeTrauma = Math.min(1, this.shakeTrauma + t * 0.45);
        this.onLand?.(impact);
        ctx.audio?.play('land', { position: this.position, volume: 0.4 + t * 0.6 });
        if (impact > 15) this.applyDamage((impact - 15) * 6.5, null);
      }
      this.airTime = 0;
    }
    if (!this.grounded) this.airTime += dt;

    this._updateFootsteps(dt, ctx);
    this._updateHealth(dt, ctx);
    this._updateCamera(dt, ctx);
  }

  // ------------------------------------------------------- collision ------
  /**
   * Move the capsule by velocity*dt and depenetrate it from the level BVH.
   * Depenetration (rather than swept casting) is stable, cheap, and is what
   * most shipped character controllers actually do.
   */
  _integrate(dt, ctx) {
    const collider = ctx.world?.collider;
    const s = this._s;

    this._lastFallSpeed = this.velocity.y;
    this.position.addScaledVector(this.velocity, dt);

    if (!collider?.geometry?.boundsTree) {
      // No world yet — just don't fall through the origin plane.
      if (this.position.y < 0) { this.position.y = 0; this.velocity.y = 0; this.grounded = true; }
      return;
    }

    const r = MOVE.radius;
    const halfSegment = Math.max(0.01, this.height - r * 2);

    // Capsule as a segment from (feet + r) to (head - r).
    s.seg.start.set(this.position.x, this.position.y + r, this.position.z);
    s.seg.end.set(this.position.x, this.position.y + r + halfSegment, this.position.z);

    s.box.makeEmpty();
    s.box.expandByPoint(s.seg.start);
    s.box.expandByPoint(s.seg.end);
    s.box.min.addScalar(-r); s.box.max.addScalar(r);

    const startY = s.seg.start.y;
    let bestNormalY = -1;
    const triPoint = s.tri1, capPoint = s.tri2;

    collider.geometry.boundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(s.box),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(s.seg, triPoint, capPoint);
        if (dist < r) {
          const depth = r - dist;
          const dir = capPoint.sub(triPoint);
          const l = dir.length();
          if (l < 1e-6) return;
          dir.divideScalar(l);
          s.seg.start.addScaledVector(dir, depth);
          s.seg.end.addScaledVector(dir, depth);
          if (dir.y > bestNormalY) { bestNormalY = dir.y; this.groundNormal.copy(dir); }
        }
      },
    });

    // Where the capsule ended up after depenetration.
    const newPos = s.v1.set(s.seg.start.x, s.seg.start.y - r, s.seg.start.z);
    const delta = s.v2.copy(newPos).sub(this.position);
    this.position.copy(newPos);

    // Grounded if we were pushed upward off a surface that isn't too steep.
    const pushedUp = s.seg.start.y - startY;
    this.grounded = bestNormalY > MOVE.maxSlope && pushedUp > -1e-4 && this.velocity.y <= 0.6;

    if (this.grounded) {
      this.velocity.y = 0;
    } else if (delta.lengthSq() > 1e-9) {
      // Slide along the contact plane: remove the velocity component that
      // points into the surface, so we don't stick to walls.
      const n = s.v3.copy(delta).normalize();
      const into = this.velocity.dot(n);
      if (into < 0) this.velocity.addScaledVector(n, -into);
    }

    if (this.position.y < -60) this.spawn(ctx.world?.spawnPoints?.[0] ?? s.v4.set(0, 3, 0));
  }

  /** Is there room to stand up to `h` metres here? */
  _hasHeadroom(ctx, h) {
    const collider = ctx.world?.collider;
    if (!collider?.geometry?.boundsTree) return true;
    const s = this._s;
    const r = MOVE.radius * 0.9;
    s.seg.start.set(this.position.x, this.position.y + r, this.position.z);
    s.seg.end.set(this.position.x, this.position.y + h - r, this.position.z);
    s.box.makeEmpty();
    s.box.expandByPoint(s.seg.start);
    s.box.expandByPoint(s.seg.end);
    s.box.min.addScalar(-r); s.box.max.addScalar(r);
    let blocked = false;
    collider.geometry.boundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(s.box),
      intersectsTriangle: (tri) => {
        if (tri.closestPointToSegment(s.seg, s.tri1, s.tri2) < r) { blocked = true; return true; }
        return false;
      },
    });
    return !blocked;
  }

  // --------------------------------------------------------- mantling -----
  _tryMantle(ctx, wish) {
    const collider = ctx.world?.collider;
    if (!collider) return false;
    const s = this._s;

    // Cast forward at chest height to find a wall.
    s.ray.set(
      s.v1.set(this.position.x, this.position.y + 0.9, this.position.z),
      s.v2.copy(wish).normalize()
    );
    s.ray.far = MOVE.radius + MOVE.mantleReach;
    const hits = s.ray.intersectObject(collider, false);
    if (!hits.length) return false;

    // Cast down from just past/above the wall to find the ledge top.
    const hit = hits[0];
    const probe = s.v3.copy(hit.point).addScaledVector(s.ray.ray.direction, 0.45);
    probe.y = this.position.y + MOVE.mantleMaxHeight + 0.6;
    s.ray.set(probe, s.v4.set(0, -1, 0));
    s.ray.far = MOVE.mantleMaxHeight + 1.2;
    const down = s.ray.intersectObject(collider, false);
    if (!down.length) return false;

    const ledgeY = down[0].point.y;
    const rise = ledgeY - this.position.y;
    if (rise < MOVE.mantleMinHeight || rise > MOVE.mantleMaxHeight) return false;
    if (down[0].face && down[0].face.normal.y < 0.7) return false;

    this.mantleFrom.copy(this.position);
    this.mantleTo.set(down[0].point.x, ledgeY + 0.02, down[0].point.z)
      .addScaledVector(s.ray.ray.direction.set(wish.x, 0, wish.z).normalize(), 0.12);
    this.mantling = true;
    this.mantleT = 0;
    this.velocity.set(0, 0, 0);
    ctx.audio?.play('mantle', { position: this.position });
    return true;
  }

  _updateMantle(dt, ctx) {
    this.mantleT += dt / MOVE.mantleDuration;
    const t = THREE.MathUtils.clamp(this.mantleT, 0, 1);
    // Up first, then forward — the classic two-phase vault arc.
    const up = THREE.MathUtils.smoothstep(t, 0.0, 0.55);
    const fwd = THREE.MathUtils.smoothstep(t, 0.35, 1.0);
    this.position.x = THREE.MathUtils.lerp(this.mantleFrom.x, this.mantleTo.x, fwd);
    this.position.z = THREE.MathUtils.lerp(this.mantleFrom.z, this.mantleTo.z, fwd);
    this.position.y = THREE.MathUtils.lerp(this.mantleFrom.y, this.mantleTo.y, up);
    if (t >= 1) { this.mantling = false; this.grounded = true; }
  }

  // -------------------------------------------------------- footsteps -----
  _updateFootsteps(dt, ctx) {
    if (!this.grounded || this.sliding) { return; }
    const sp = this.speed2D;
    if (sp < 0.6) { this._stepDistance = 0; return; }
    this._stepDistance += sp * dt;
    // Stride length: longer when sprinting.
    const stride = this.crouching ? 1.05 : (this.sprinting ? 1.95 : 1.5);
    if (this._stepDistance >= stride) {
      this._stepDistance -= stride;
      const surf = this.surface || 'concrete';
      this.onFootstep?.(surf, this.sprinting);
      const name = 'footstep' + surf.charAt(0).toUpperCase() + surf.slice(1);
      ctx.audio?.play(name, {
        position: this.position,
        volume: this.crouching ? 0.32 : (this.sprinting ? 1.0 : 0.68),
      });
    }
  }

  // ----------------------------------------------------------- health -----
  _updateHealth(dt, ctx) {
    this.regenDelay = Math.max(0, this.regenDelay - dt);
    if (this.regenDelay <= 0 && this.health < this.maxHealth && !this.dead) {
      this.health = Math.min(this.maxHealth, this.health + 26 * dt);
    }
    const hurt01 = 1 - THREE.MathUtils.clamp(this.health / this.maxHealth, 0, 1);
    if (ctx.postfx) {
      // Ease the damage grade so it breathes rather than flickers.
      const target = Math.pow(THREE.MathUtils.clamp((hurt01 - 0.45) / 0.55, 0, 1), 1.4);
      const p = ctx.postfx.params;
      p.hurt += (target - p.hurt) * Math.min(1, dt * 6);
    }
  }

  applyDamage(amount, fromPos) {
    if (this.dead) return;
    this.health -= amount;
    this.regenDelay = 4.2;
    this.shakeTrauma = Math.min(1, this.shakeTrauma + Math.min(0.5, amount / 60));
    this.ctx.hud?.damageFrom?.(fromPos ?? this.position);
    this.ctx.audio?.play('playerHurt', { volume: THREE.MathUtils.clamp(amount / 40, 0.3, 1) });
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.ctx.audio?.play('playerDeath');
      this.ctx.hud?.showBanner?.('YOU WERE KILLED', 'Respawning');
    }
  }

  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.shakeTrauma = Math.min(1, this.shakeTrauma + Math.abs(pitch) * 1.6);
  }

  // ----------------------------------------------------------- camera -----
  _updateCamera(dt, ctx) {
    const s = this._s;
    const cam = this.camera;
    const aiming = !!ctx.weapons?.aiming;

    // --- eye height (eased, so crouch/slide transitions read as motion) ---
    const targetEye = this.sliding ? MOVE.eyeSlide
      : (this.crouching ? MOVE.eyeCrouch : MOVE.eyeStand);
    this._eyeCurrent += (targetEye - this._eyeCurrent) * Math.min(1, dt * 13);

    // --- landing dip (critically damped spring) ---
    const k = 190, c = 2 * Math.sqrt(k) * 0.75;
    this._landDipVel += (-k * this.landDip - c * this._landDipVel) * dt;
    this.landDip += this._landDipVel * dt;

    // --- head bob: a figure-eight, amplitude tracking speed ---
    const sp = this.speed2D;
    const bobTarget = this.grounded && !this.sliding
      ? THREE.MathUtils.clamp(sp / MOVE.sprintSpeed, 0, 1) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * Math.min(1, dt * 8);
    const bobRate = this.sprinting ? 13.2 : 10.4;
    this.bobPhase += dt * bobRate * (0.4 + this.bobAmount * 0.8);
    const bobScale = (aiming ? 0.22 : 1.0) * this.bobAmount;
    const bobY = Math.sin(this.bobPhase * 2) * 0.028 * bobScale;
    const bobX = Math.cos(this.bobPhase) * 0.036 * bobScale;
    const bobRoll = Math.cos(this.bobPhase) * 0.011 * bobScale;

    // --- lean ---
    const input = ctx.input;
    this._leanTarget = 0;
    if (!this.sliding && !this.dead) {
      if (input?.isDown('KeyQ')) this._leanTarget = -1;
      if (input?.isDown('KeyE')) this._leanTarget = 1;
    }
    this.lean += (this._leanTarget - this.lean) * Math.min(1, dt * 9);

    // --- recoil recovery: fast rise, slower settle ---
    this.recoilPitch *= Math.exp(-9.5 * dt);
    this.recoilYaw *= Math.exp(-8.0 * dt);

    // --- trauma shake (squared so small hits are subtle, big hits aren't) ---
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.5);
    const tr = this.shakeTrauma * this.shakeTrauma;
    const t = ctx.time * 34;
    const shakeX = (Math.sin(t * 1.7) + Math.sin(t * 2.9)) * 0.5 * tr * 0.028;
    const shakeY = (Math.sin(t * 2.3) + Math.sin(t * 3.7)) * 0.5 * tr * 0.028;
    const shakeR = Math.sin(t * 1.3) * tr * 0.018;

    // --- assemble ---
    const eye = s.v1.set(
      this.position.x,
      this.position.y + this._eyeCurrent + bobY + this.landDip,
      this.position.z
    );
    // Lean translates sideways as well as rolling — rolling alone looks wrong.
    const rightX = Math.cos(this.yaw), rightZ = Math.sin(this.yaw);
    const leanOff = this.lean * 0.38;
    eye.x += rightX * (leanOff + bobX * 0.6) + shakeX * rightX;
    eye.z += rightZ * (leanOff + bobX * 0.6) + shakeX * rightZ;
    eye.y += shakeY;

    cam.position.copy(eye);
    s.e.set(
      this.pitch + this.recoilPitch,
      this.yaw + this.recoilYaw,
      bobRoll + this.lean * -0.13 + shakeR + (this.sliding ? 0.05 : 0),
      'YXZ'
    );
    cam.quaternion.setFromEuler(s.e);

    // --- FOV: sprint widens, ADS narrows; ease so it never snaps ---
    let fovT = this.baseFov;
    if (aiming) fovT = ctx.weapons?.adsFov ?? 55;
    else if (this.sprinting) fovT = this.baseFov + 5;
    else if (this.sliding) fovT = this.baseFov + 7;
    this._fovTarget = fovT;
    const rate = aiming ? 14 : 9;
    this.fov += (this._fovTarget - this.fov) * Math.min(1, dt * rate);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    // The viewmodel camera narrows with ADS as well, but by less — the weapon
    // should grow into the sight picture without the world FOV's full zoom.
    const vc = ctx.viewCamera;
    if (vc) {
      const vTarget = ctx.weapons?.aiming ? 42 : 55;
      vc.fov += (vTarget - vc.fov) * Math.min(1, dt * rate);
      vc.updateProjectionMatrix();
    }
  }

  get swayOffset() { return this._swayOffset; }
}
