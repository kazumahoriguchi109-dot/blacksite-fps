import * as THREE from 'three';
import { Ballistics } from './Ballistics.js';

/*
 * Weapon system: state machine, recoil, and the viewmodel rig.
 *
 * The viewmodel is parented to the camera and animated entirely procedurally —
 * there is no skeletal animation here. Everything is springs and eased curves,
 * which for a first-person weapon is actually how a lot of it is authored
 * anyway (the "sway/bob/kick" layer sits on top of animation in real engines).
 *
 * Two details that matter a lot for feel:
 *  - recoil is split into *aim* recoil (moves where bullets go, recovers only
 *    partially) and *visual* recoil (kicks the model, fully recovers). Coupling
 *    them makes a gun feel either weightless or uncontrollable.
 *  - the weapon physically retracts when the muzzle is close to geometry, so
 *    you don't push the barrel through walls.
 */

export const WEAPON_DEFS = {
  rifle: {
    name: 'MK18 CQBR',
    magSize: 30, reserve: 210,
    rpm: 750, auto: true,
    damage: 33, headMult: 2.35, penetration: 34,
    range: 240, falloffStart: 32, falloffEnd: 95, falloffMin: 0.44,
    adsTime: 0.235, adsFov: 38,
    spreadHip: 0.036, spreadAds: 0.0035, spreadMove: 0.030, spreadJump: 0.055,
    spreadPerShot: 0.0075, spreadMax: 0.085, spreadRecover: 0.13,
    recoilPitch: 0.0125, recoilYaw: 0.0038, recoilVisual: 0.030,
    reloadTime: 2.15, reloadEmptyTime: 2.85,
    fireSound: 'rifleFire', shellKind: 'rifle',
    muzzleScale: 0.62, shakeScale: 1.0,
    hipOffset: [-0.004, 0.014, 0.010],
  },
  smg: {
    name: 'VECTOR .45',
    magSize: 32, reserve: 224,
    rpm: 1050, auto: true,
    damage: 24, headMult: 1.9, penetration: 20,
    range: 160, falloffStart: 18, falloffEnd: 58, falloffMin: 0.36,
    adsTime: 0.185, adsFov: 43,
    spreadHip: 0.030, spreadAds: 0.0060, spreadMove: 0.022, spreadJump: 0.048,
    spreadPerShot: 0.0052, spreadMax: 0.072, spreadRecover: 0.17,
    recoilPitch: 0.0072, recoilYaw: 0.0034, recoilVisual: 0.019,
    reloadTime: 1.85, reloadEmptyTime: 2.45,
    fireSound: 'smgFire', shellKind: 'smg',
    muzzleScale: 0.52, shakeScale: 0.7,
    hipOffset: [-0.004, 0.020, 0.006],
  },
  pistol: {
    name: 'M18 SIDEARM',
    magSize: 17, reserve: 102,
    rpm: 420, auto: false,
    damage: 36, headMult: 2.1, penetration: 16,
    range: 120, falloffStart: 16, falloffEnd: 48, falloffMin: 0.4,
    adsTime: 0.155, adsFov: 45,
    spreadHip: 0.028, spreadAds: 0.0045, spreadMove: 0.026, spreadJump: 0.05,
    spreadPerShot: 0.011, spreadMax: 0.075, spreadRecover: 0.20,
    recoilPitch: 0.0165, recoilYaw: 0.0052, recoilVisual: 0.034,
    reloadTime: 1.55, reloadEmptyTime: 2.15,
    fireSound: 'pistolFire', shellKind: 'pistol',
    muzzleScale: 0.44, shakeScale: 0.85,
    hipOffset: [-0.012, 0.046, -0.020],
  },
};

const ORDER = ['rifle', 'smg', 'pistol'];

/** Deterministic per-weapon recoil pattern: rises, then drifts to one side. */
function makeRecoilPattern(seed, n = 40) {
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const pat = new Float32Array(n * 2);
  let drift = 0;
  for (let i = 0; i < n; i++) {
    // Vertical climb decelerates after the first ~8 rounds.
    const t = i / n;
    const vert = (1 - Math.exp(-i * 0.55)) * (1 - t * 0.35);
    // Horizontal walks, but biased so a pattern is learnable rather than random.
    drift += (rnd() - 0.42) * 0.55;
    drift = THREE.MathUtils.clamp(drift, -1.6, 1.6);
    pat[i * 2] = vert;
    pat[i * 2 + 1] = drift * (0.25 + t * 0.85);
  }
  return pat;
}

export class WeaponSystem {
  constructor(ctx, modelFactory) {
    this.ctx = ctx;
    this.modelFactory = modelFactory;
    this.ballistics = new Ballistics(ctx);

    this.root = new THREE.Group();      // parented to the camera
    this.root.name = 'viewmodel';
    this.root.matrixAutoUpdate = true;

    /** @type {Record<string, any>} */
    this.slots = {};
    this.current = null;
    this.currentKind = null;

    this.aiming = false;
    this.adsT = 0;
    this.adsFov = 55;

    this.state = 'idle';   // idle | firing | reloading | switching | melee
    this.stateT = 0;
    this.fireCooldown = 0;
    this.shotIndex = 0;
    this.sinceFire = 99;
    this.spread = 0.03;
    this.dynamicSpread = 0;
    this.triggerHeld = false;
    this.wantReload = false;

    this._patterns = {
      rifle: makeRecoilPattern(0x51ee, 60),
      smg: makeRecoilPattern(0x9a31, 60),
      pistol: makeRecoilPattern(0x2bb7, 30),
    };

    // Viewmodel rig state (springs).
    this._pos = new THREE.Vector3();
    this._posVel = new THREE.Vector3();
    this._rot = new THREE.Vector3();
    this._rotVel = new THREE.Vector3();
    this._kick = 0; this._kickVel = 0;
    /** Viewmodel materials, so the weapon can follow the world's lighting. */
    this._vmMaterials = [];
    this._bobPhase = 0;
    this._pullback = 0;

    this._s = {
      v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(),
      q: new THREE.Quaternion(), e: new THREE.Euler(),
      m: new THREE.Matrix4(), ray: new THREE.Raycaster(),
      dir: new THREE.Vector3(), muzzle: new THREE.Vector3(),
    };
    this._s.ray.firstHitOnly = true;

    // Hip-fire rest pose, in camera space. Right-handed, slightly below the
    // eye line and canted in — the standard FPS "ready" pose.
    //
    // The z distance matters as much as the height: the viewmodel frustum is
    // 55 degrees vertical, so at 0.30 m the visible half-height is only 0.156 m
    // and the pistol grip (~0.10 m below the model origin) fell outside it,
    // cropping the firing hand entirely. At 0.38 m the half-height is 0.198 m,
    // which brings the hand into frame AND reads closer to a shipped viewmodel,
    // where the weapon occupies less of the screen than it did here.
    // y computed, not eyeballed: the viewmodel camera is 55 deg vertical, so at
    // the firing hand's distance (~0.355 m) the visible half-height is 0.185 m.
    // At -0.128 the bottom of the firing fist sat at camera-space y = -0.192,
    // about 7 mm outside the frustum — the little finger and the cuff were
    // being sliced by the frame edge. -0.106 puts it at -0.170 with ~15 mm of
    // margin. ADS is unaffected; it uses the sight offset, not this.
    this.hipPos = new THREE.Vector3(0.150, -0.106, -0.385);
    this.hipRot = new THREE.Vector3(0.018, -0.055, 0.028);
    this.sprintPos = new THREE.Vector3(0.20, -0.185, -0.34);
    this.sprintRot = new THREE.Vector3(-0.16, 0.62, -0.30);
  }

  async init() {
    for (const kind of ORDER) {
      const model = await this.modelFactory(kind);
      const def = WEAPON_DEFS[kind];
      model.group.visible = false;
      model.group.traverse((o) => {
        // The viewmodel must never be culled by the frustum (it's tiny and
        // camera-parented) and must not cast shadows into the world.
        o.frustumCulled = false;
        // receiveShadow must be ON. With it off, the weapon was lit by the full
        // directional sun everywhere — it rendered as a blinding white object
        // inside a pitch-black warehouse, and was the brightest thing in almost
        // every frame when it should be among the darkest. It still never casts.
        if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; o.renderOrder = 2; }
        if (o.isMesh && o.material && !Array.isArray(o.material)) {
          const m = o.material;
          if (m.userData.baseEnvIntensity === undefined) {
            m.userData.baseEnvIntensity = m.envMapIntensity ?? 1;
            this._vmMaterials.push(m);
          }
        }
      });
      this.root.add(model.group);
      this.slots[kind] = {
        kind, def, model,
        mag: def.magSize, reserve: def.reserve,
      };
    }
    this.switchTo('rifle', true);
  }

  get weapon() { return this.current; }
  get ammoMag() { return this.current?.mag ?? 0; }
  get ammoReserve() { return this.current?.reserve ?? 0; }

  switchTo(kind, instant = false) {
    if (!this.slots[kind] || this.currentKind === kind) return;
    if (this.state === 'reloading') this.state = 'idle';
    if (this.current) this.current.model.group.visible = false;
    this.current = this.slots[kind];
    this.currentKind = kind;
    this.current.model.group.visible = true;
    this.adsFov = this.current.def.adsFov;
    this.shotIndex = 0;
    this.dynamicSpread = 0;
    if (!instant) {
      this.state = 'switching';
      this.stateT = 0;
      this._pos.y -= 0.34;   // drop the new weapon in from below
      this.ctx.audio?.play('weaponSwitch');
    }
    this.ctx.hud?.setWeaponName?.(this.current.def.name);
    this._syncHud();
  }

  nextWeapon(dir) {
    const i = ORDER.indexOf(this.currentKind);
    this.switchTo(ORDER[(i + dir + ORDER.length) % ORDER.length]);
  }

  _syncHud() {
    this.ctx.hud?.setAmmo?.(this.current?.mag ?? 0, this.current?.reserve ?? 0);
  }

  // ------------------------------------------------------------- firing ---
  tryFire() {
    const w = this.current;
    if (!w || this.state === 'reloading' || this.state === 'switching' || this.state === 'melee') return;
    if (this.ctx.player?.dead) return;
    if (this.fireCooldown > 0) return;
    if (this.ctx.player?.sprinting && this.adsT < 0.2) return;

    if (w.mag <= 0) {
      this.ctx.audio?.play('dryFire');
      this.fireCooldown = 0.22;
      this.wantReload = true;
      return;
    }

    const def = w.def;
    w.mag--;
    this.fireCooldown = 60 / def.rpm;
    this.sinceFire = 0;
    this.state = 'firing';

    // --- aim recoil from the pattern ---
    const pat = this._patterns[this.currentKind];
    const n = pat.length / 2;
    const i = Math.min(this.shotIndex, n - 1);
    const aimScale = this.aiming ? 0.72 : 1.0;
    const crouchScale = this.ctx.player?.crouching ? 0.78 : 1.0;
    const kp = def.recoilPitch * pat[i * 2] * aimScale * crouchScale;
    const ky = def.recoilYaw * pat[i * 2 + 1] * aimScale * crouchScale;
    this.ctx.player?.addRecoil(kp, ky);
    this.shotIndex++;

    // --- visual recoil (springs) ---
    this._kickVel += def.recoilVisual * 62 * (this.aiming ? 0.6 : 1);
    this._rotVel.x -= def.recoilVisual * 34 * (this.aiming ? 0.5 : 1);
    this._rotVel.y += (Math.random() - 0.5) * def.recoilVisual * 22;
    this._rotVel.z += (Math.random() - 0.5) * def.recoilVisual * 26;
    this._posVel.x += (Math.random() - 0.5) * def.recoilVisual * 1.6;
    this._posVel.y += def.recoilVisual * 0.9;

    // --- spread growth ---
    this.dynamicSpread = Math.min(def.spreadMax, this.dynamicSpread + def.spreadPerShot);

    // --- the shot itself ---
    const cam = this.ctx.camera;
    const s = this._s;
    cam.getWorldDirection(s.dir);
    const spread = this.computeSpread();
    if (spread > 0) {
      // Uniform disc in the plane perpendicular to the aim direction.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      s.v1.set(1, 0, 0);
      if (Math.abs(s.dir.x) > 0.9) s.v1.set(0, 1, 0);
      s.v2.copy(s.v1).cross(s.dir).normalize();
      s.v3.copy(s.dir).cross(s.v2).normalize();
      s.dir.addScaledVector(s.v2, Math.cos(a) * r).addScaledVector(s.v3, Math.sin(a) * r).normalize();
    }

    w.model.muzzle?.getWorldPosition(s.muzzle);
    this.ballistics.fire(cam.position, s.dir, def, s.muzzle);

    // --- feedback ---
    const fx = this.ctx.fx;
    if (w.model.muzzle) {
      w.model.muzzle.updateWorldMatrix(true, false);
      fx?.muzzleFlash?.(w.model.muzzle.matrixWorld, def.muzzleScale * (this.aiming ? 0.75 : 1));
    }
    if (w.model.ejectPort) {
      w.model.ejectPort.updateWorldMatrix(true, false);
      w.model.ejectPort.getWorldPosition(s.v1);
      s.v2.set(1, 0.55, -0.25).applyQuaternion(cam.quaternion).multiplyScalar(2.6);
      fx?.shellEject?.(s.v1, s.v2, def.shellKind);
    }
    this.ctx.audio?.play(def.fireSound, { volume: 1.0 });
    this.ctx.player && (this.ctx.player.shakeTrauma = Math.min(
      1, this.ctx.player.shakeTrauma + 0.11 * def.shakeScale * (this.aiming ? 0.55 : 1)
    ));
    this._syncHud();

    if (w.mag <= 0) this.wantReload = true;
  }

  computeSpread() {
    const def = this.current.def;
    const p = this.ctx.player;
    let base = THREE.MathUtils.lerp(def.spreadHip, def.spreadAds, smootherstep(this.adsT));
    if (p) {
      const moveT = THREE.MathUtils.clamp(p.speed2D / 6.6, 0, 1);
      base += def.spreadMove * moveT * (this.aiming ? 0.45 : 1);
      if (!p.grounded) base += def.spreadJump;
      if (p.crouching && p.speed2D < 0.5) base *= 0.72;
    }
    return base + this.dynamicSpread;
  }

  reload() {
    const w = this.current;
    if (!w || this.state === 'reloading' || this.state === 'switching') return;
    if (w.mag >= w.def.magSize || w.reserve <= 0) return;
    this.state = 'reloading';
    this.stateT = 0;
    this.reloadEmpty = w.mag === 0;
    this.reloadDuration = this.reloadEmpty ? w.def.reloadEmptyTime : w.def.reloadTime;
    this._reloadStage = 0;
    this.wantReload = false;
    this.aiming = false;
    this.ctx.audio?.play('magOut');
  }

  melee() {
    if (this.state === 'melee' || this.state === 'switching') return;
    this.state = 'melee';
    this.stateT = 0;
    this._meleeHit = false;
    this.ctx.audio?.play('meleeSwing');
  }

  // ------------------------------------------------------------- update ---
  update(dt, ctx) {
    const input = ctx.input;
    const w = this.current;
    if (!w) return;
    const def = w.def;
    const p = ctx.player;

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.sinceFire += dt;
    this.stateT += dt;

    // --- input ---
    if (input && !p?.dead) {
      const held = input.isDown('Mouse0');
      if (def.auto) { if (held) this.tryFire(); }
      else if (held && !this.triggerHeld) this.tryFire();
      this.triggerHeld = held;

      const wantAds = (this.forceAim || input.isDown('Mouse2'))
        && this.state !== 'reloading' && this.state !== 'melee' && !p?.sprinting;
      this.aiming = wantAds;

      if (input.pressed('KeyR')) this.reload();
      if (input.pressed('KeyV')) this.melee();
      if (input.pressed('Digit1')) this.switchTo('rifle');
      if (input.pressed('Digit2')) this.switchTo('smg');
      if (input.pressed('Digit3')) this.switchTo('pistol');
      if (input.mouse.wheel) this.nextWeapon(input.mouse.wheel > 0 ? 1 : -1);
    } else {
      this.aiming = !!this.forceAim;
      this.triggerHeld = false;
    }

    if (this.wantReload && this.state === 'idle' && !this.triggerHeld) this.reload();

    // --- ADS blend ---
    const adsTarget = this.aiming ? 1 : 0;
    const adsRate = 1 / Math.max(0.05, def.adsTime);
    this.adsT = THREE.MathUtils.clamp(
      this.adsT + (adsTarget - this.adsT > 0 ? adsRate : -adsRate * 1.25) * dt, 0, 1
    );
    if (adsTarget === 1 && this.adsT < 0.02) ctx.audio?.play('adsIn');

    // --- spread recovery ---
    if (this.sinceFire > 0.06) {
      this.dynamicSpread = Math.max(0, this.dynamicSpread - def.spreadRecover * dt);
      if (this.dynamicSpread <= 0 && this.sinceFire > 0.35) this.shotIndex = 0;
    }
    this.spread = this.computeSpread();

    // --- state machine ---
    if (this.state === 'firing' && this.sinceFire > 0.12) this.state = 'idle';
    if (this.state === 'switching' && this.stateT > 0.42) this.state = 'idle';
    if (this.state === 'reloading') this._updateReload(dt, ctx);
    if (this.state === 'melee') this._updateMelee(dt, ctx);

    this._updateViewmodel(dt, ctx);
  }

  _updateReload(dt, ctx) {
    const w = this.current;
    const t = this.stateT / this.reloadDuration;
    const model = w.model;

    // Staged audio + magazine animation.
    if (this._reloadStage === 0 && t > 0.18) {
      this._reloadStage = 1;
      ctx.audio?.play('reloadRustle');
    }
    if (this._reloadStage === 1 && t > 0.52) {
      this._reloadStage = 2;
      ctx.audio?.play('magIn');
    }
    if (this._reloadStage === 2 && this.reloadEmpty && t > 0.76) {
      this._reloadStage = 3;
      ctx.audio?.play('boltBack');
    }
    if (this._reloadStage === 3 && t > 0.86) {
      this._reloadStage = 4;
      ctx.audio?.play('boltForward');
    }

    // Magazine drops away and a fresh one seats.
    if (model.magazine) {
      let drop = 0;
      if (t < 0.5) drop = smootherstep(THREE.MathUtils.clamp((t - 0.15) / 0.35, 0, 1));
      else drop = 1 - smootherstep(THREE.MathUtils.clamp((t - 0.5) / 0.28, 0, 1));
      model.magazine.position.y = -drop * 0.20;
      model.magazine.position.z = drop * 0.035;
      model.magazine.rotation.x = drop * 0.42;
    }
    // Charging handle cycles on an empty reload.
    if (model.charging && this.reloadEmpty) {
      const c = THREE.MathUtils.clamp((t - 0.74) / 0.16, 0, 1);
      model.charging.position.z = Math.sin(c * Math.PI) * 0.075;
    }

    if (this.stateT >= this.reloadDuration) {
      const need = w.def.magSize - w.mag;
      const take = Math.min(need, w.reserve);
      w.mag += take; w.reserve -= take;
      this.state = 'idle';
      this.shotIndex = 0;
      if (model.magazine) model.magazine.position.set(0, 0, 0), model.magazine.rotation.set(0, 0, 0);
      if (model.charging) model.charging.position.z = 0;
      this._syncHud();
    }
  }

  _updateMelee(dt, ctx) {
    const T = 0.55;
    const t = this.stateT / T;
    if (!this._meleeHit && t > 0.32) {
      this._meleeHit = true;
      const s = this._s;
      ctx.camera.getWorldDirection(s.dir);
      const hit = this.ballistics._raycastEnemies(ctx.camera.position, s.dir, 2.4);
      if (hit) {
        hit.enemy.applyDamage?.(135, 'chest', s.dir);
        ctx.audio?.play('meleeHit', { position: hit.point });
        ctx.hud?.hitmarker?.('kill');
      }
    }
    if (this.stateT >= T) this.state = 'idle';
  }

  // -------------------------------------------------------- viewmodel -----
  _updateViewmodel(dt, ctx) {
    const s = this._s;
    const w = this.current;
    const p = ctx.player;
    const model = w.model;
    const ads = smootherstep(this.adsT);

    // --- target pose ---
    let tx, ty, tz, rx, ry, rz;
    const sprintT = p ? THREE.MathUtils.clamp(
      (p.sprinting ? 1 : 0) * (1 - ads), 0, 1) : 0;
    this._sprintBlend = (this._sprintBlend ?? 0) + (sprintT - (this._sprintBlend ?? 0)) * Math.min(1, dt * 9);
    const sb = this._sprintBlend;

    const adsOff = model.adsOffset ?? new THREE.Vector3(0, -0.035, -0.16);
    // Per-weapon hip lift, so the firing hand actually sits inside the
    // viewmodel frustum. ADS is unaffected — the sight must stay on axis.
    const ho = w.def.hipOffset;
    const hx = this.hipPos.x + (ho ? ho[0] : 0);
    const hy = this.hipPos.y + (ho ? ho[1] : 0);
    const hz = this.hipPos.z + (ho ? ho[2] : 0);
    tx = THREE.MathUtils.lerp(hx, adsOff.x, ads);
    ty = THREE.MathUtils.lerp(hy, adsOff.y, ads);
    tz = THREE.MathUtils.lerp(hz, adsOff.z, ads);
    rx = THREE.MathUtils.lerp(this.hipRot.x, 0, ads);
    ry = THREE.MathUtils.lerp(this.hipRot.y, 0, ads);
    rz = THREE.MathUtils.lerp(this.hipRot.z, 0, ads);

    tx = THREE.MathUtils.lerp(tx, this.sprintPos.x, sb);
    ty = THREE.MathUtils.lerp(ty, this.sprintPos.y, sb);
    tz = THREE.MathUtils.lerp(tz, this.sprintPos.z, sb);
    rx = THREE.MathUtils.lerp(rx, this.sprintRot.x, sb);
    ry = THREE.MathUtils.lerp(ry, this.sprintRot.y, sb);
    rz = THREE.MathUtils.lerp(rz, this.sprintRot.z, sb);

    // Reload lowers and cants the weapon toward the off hand.
    if (this.state === 'reloading') {
      const t = this.stateT / this.reloadDuration;
      const a = Math.sin(THREE.MathUtils.clamp(t, 0, 1) * Math.PI);
      ty -= a * 0.075; tz += a * 0.045; tx -= a * 0.03;
      rx += a * 0.30; rz -= a * 0.34; ry += a * 0.14;
    }
    // Weapon switch: swing up from below.
    if (this.state === 'switching') {
      const t = THREE.MathUtils.clamp(this.stateT / 0.42, 0, 1);
      const a = 1 - smootherstep(t);
      ty -= a * 0.30; rx += a * 0.85;
    }
    // Melee: a hard thrust arc.
    if (this.state === 'melee') {
      const t = THREE.MathUtils.clamp(this.stateT / 0.55, 0, 1);
      const thrust = Math.sin(t * Math.PI);
      const wind = Math.sin(THREE.MathUtils.clamp(t / 0.32, 0, 1) * Math.PI * 0.5);
      tz -= thrust * 0.22; tx += wind * 0.10 - thrust * 0.14;
      ry += wind * 0.6 - thrust * 0.9; rz -= thrust * 0.4; rx -= thrust * 0.2;
    }

    // --- weapon collision: retract when the muzzle nears geometry ---
    let pullTarget = 0;
    if (ctx.world?.collider && model.muzzle) {
      ctx.camera.getWorldDirection(s.dir);
      s.ray.set(ctx.camera.position, s.dir);
      s.ray.far = 1.35;
      const hits = s.ray.intersectObject(ctx.world.collider, false);
      if (hits.length) {
        pullTarget = THREE.MathUtils.clamp(1 - (hits[0].distance - 0.4) / 0.8, 0, 1);
      }
    }
    this._pullback += (pullTarget - this._pullback) * Math.min(1, dt * 14);
    const pb = this._pullback * (1 - ads * 0.7);
    tz += pb * 0.19; ty -= pb * 0.035; rx += pb * 0.55; ry += pb * 0.22;

    // --- bob and sway layered on top ---
    if (p) {
      const sp = THREE.MathUtils.clamp(p.speed2D / 6.6, 0, 1) * (p.grounded ? 1 : 0);
      this._bobPhase += dt * (p.sprinting ? 13.2 : 10.4) * (0.4 + sp * 0.8);
      const amp = sp * (1 - ads * 0.82);
      tx += Math.cos(this._bobPhase) * 0.020 * amp;
      ty += Math.abs(Math.sin(this._bobPhase)) * -0.016 * amp;
      rz += Math.cos(this._bobPhase) * 0.030 * amp;
      rx += Math.sin(this._bobPhase * 2) * 0.014 * amp;

      const sway = p.swayOffset;
      const swayScale = 1 - ads * 0.72;
      tx += sway.x * 1.15 * swayScale;
      ty += sway.y * 1.15 * swayScale;
      ry += sway.x * 3.4 * swayScale;
      rx += -sway.y * 3.0 * swayScale;
      rz += sway.x * 2.2 * swayScale;

      // Idle breathing — tiny, but its absence is noticeable.
      const br = ctx.time * 1.35;
      const idle = (1 - sp) * (1 - ads * 0.6);
      ty += Math.sin(br) * 0.0035 * idle;
      rx += Math.sin(br * 0.9 + 1.1) * 0.007 * idle;
      ry += Math.sin(br * 0.62) * 0.009 * idle;
    }

    // --- springs toward the target pose ---
    const stiff = this.aiming ? 260 : 180;
    const damp = 2 * Math.sqrt(stiff) * 0.92;
    this._posVel.x += ((tx - this._pos.x) * stiff - this._posVel.x * damp) * dt;
    this._posVel.y += ((ty - this._pos.y) * stiff - this._posVel.y * damp) * dt;
    this._posVel.z += ((tz - this._pos.z) * stiff - this._posVel.z * damp) * dt;
    this._pos.addScaledVector(this._posVel, dt);

    const rStiff = this.aiming ? 240 : 165;
    const rDamp = 2 * Math.sqrt(rStiff) * 0.9;
    this._rotVel.x += ((rx - this._rot.x) * rStiff - this._rotVel.x * rDamp) * dt;
    this._rotVel.y += ((ry - this._rot.y) * rStiff - this._rotVel.y * rDamp) * dt;
    this._rotVel.z += ((rz - this._rot.z) * rStiff - this._rotVel.z * rDamp) * dt;
    this._rot.addScaledVector(this._rotVel, dt);

    // --- recoil kick along the barrel axis ---
    const kStiff = 420, kDamp = 2 * Math.sqrt(kStiff) * 0.62;
    this._kickVel += (-this._kick * kStiff - this._kickVel * kDamp) * dt;
    this._kick += this._kickVel * dt;

    // The weapon should darken with the room. Without this it keeps its full
    // outdoor reflection indoors and reads as self-illuminated.
    const indoorF = ctx.indoor?.factor ?? 0;
    if (Math.abs(indoorF - (this._lastIndoorF ?? -1)) > 0.01) {
      this._lastIndoorF = indoorF;
      const k = THREE.MathUtils.lerp(1, 0.45, indoorF);
      for (const m of this._vmMaterials) {
        m.envMapIntensity = m.userData.baseEnvIntensity * k;
      }
    }

    const g = model.group;
    g.position.set(this._pos.x, this._pos.y, this._pos.z + this._kick * 0.011);
    g.rotation.set(this._rot.x, this._rot.y, this._rot.z);

    // Red-dot / sight brightness rises with ADS so it isn't distracting at hip.
    if (model.dot) {
      const m = model.dot.material;
      if (m) {
        m.opacity = 0.42 + ads * 0.58;
        if (m.emissiveIntensity !== undefined) m.emissiveIntensity = 6 + ads * 26;
      }
    }
  }

  dispose() {
    for (const k of Object.keys(this.slots)) {
      this.slots[k].model.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
  }
}

function smootherstep(t) {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
