import * as THREE from 'three';
import {
  ParticleSystem, SPRITE, MODE_ADD, MODE_ALPHA, CURVE_FAST,
} from './ParticleSystem.js';
import { DecalSystem } from './DecalSystem.js';
import { makeRNG } from '../gfx/noise.js';

/*
 * FXSystem — the whole visual feedback layer for shooting.
 *
 * Everything in here is pooled and preallocated: particles live in the two
 * ParticleSystem batches, decals in one batched mesh, and the handful of real
 * meshes (muzzle flashes, brass, fireballs) are built once at construction and
 * recycled. The update loop performs no allocation.
 *
 * Colour convention: the scene is rendered to a linear HDR buffer and tone
 * mapped in PostFX, whose bloom threshold is ~1.05. Anything meant to bloom is
 * authored well above 1.0 in linear — muzzle flash cores sit around 40, sparks
 * around 9, tracers around 16. Those numbers are the main intensity dial; see
 * `config` and `setIntensity()` at the bottom of the class.
 */

const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/** Decode one IEEE-754 binary16 word. The post stack's metering target is RGBA16F. */
function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * 5.9604644775390625e-8 * frac;   // subnormal
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

// -------------------------------------------------------- surface table ----

/** Coarse material behaviour classes. */
function classifySurface(kind) {
  if (!kind) return 'concrete';
  const k = String(kind).toLowerCase();
  if (k.indexOf('flesh') >= 0 || k.indexOf('blood') >= 0 || k.indexOf('body') >= 0) return 'flesh';
  if (k.indexOf('metal') >= 0 || k.indexOf('steel') >= 0 || k.indexOf('pipe') >= 0
      || k.indexOf('barrel') >= 0 || k.indexOf('grate') >= 0) return 'metal';
  if (k.indexOf('wood') >= 0 || k.indexOf('crate') >= 0 || k.indexOf('plank') >= 0) return 'wood';
  if (k.indexOf('gravel') >= 0 || k.indexOf('sand') >= 0 || k.indexOf('dirt') >= 0
      || k.indexOf('soil') >= 0) return 'dirt';
  return 'concrete';
}

// ------------------------------------------------------ geometry helpers ---

/** Vertex colour for a flash card at normalised heat `c` (1 = core, 0 = tip). */
function flashHeat(col, o, c) {
  col[o] = c;
  col[o + 1] = c * (0.50 + 0.50 * c);      // green lags -> white core, orange body
  col[o + 2] = c * c * c * 0.9;            // blue only survives in the core
}

/**
 * Flat star card, triangle-fanned.
 *
 * Three rings (centre / shoulder / tip) rather than a single fan: a one-ring fan
 * interpolates linearly from a white centre straight to black tips, which reads
 * as a flat paper cut-out and, once it is 30 px on screen, as an orange scratch.
 * The shoulder ring puts most of the falloff in the inner third, so the card
 * reads as a hot core with soft flame petals. Hue is baked into the vertex
 * colour; the material colour carries intensity only.
 */
function makeStarGeometry(rand, spikes) {
  const rim = spikes * 2;
  const radii = new Float32Array(rim);
  for (let i = 0; i < rim; i++) {
    // Fat lobes, not needle spikes: a star whose inner radius is 0.17 reads as
    // a lens-flare sparkle rather than a plume of burning gas.
    radii[i] = (i % 2) === 0 ? 0.64 + rand() * 0.78 : 0.34 + rand() * 0.26;
  }
  const SH = 0.42;                          // shoulder as a fraction of a radius
  const SHC = 0.58;                         // heat at the shoulder
  const verts = rim * 9;                    // three triangles per rim segment
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  let o = 0;
  const put = (x, y, c) => {
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = 0;
    flashHeat(col, o, c);
    o += 3;
  };
  for (let i = 0; i < rim; i++) {
    const a0 = (i / rim) * TWO_PI;
    const a1 = ((i + 1) / rim) * TWO_PI;
    const r0 = radii[i];
    const r1 = radii[(i + 1) % rim];
    const tx0 = Math.cos(a0) * r0, ty0 = Math.sin(a0) * r0;
    const tx1 = Math.cos(a1) * r1, ty1 = Math.sin(a1) * r1;
    const sx0 = tx0 * SH, sy0 = ty0 * SH;
    const sx1 = tx1 * SH, sy1 = ty1 * SH;
    put(0, 0, 1);        put(sx0, sy0, SHC); put(sx1, sy1, SHC);
    put(sx0, sy0, SHC);  put(tx0, ty0, 0);   put(tx1, ty1, 0);
    put(sx0, sy0, SHC);  put(tx1, ty1, 0);   put(sx1, sy1, SHC);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Open cone with its tip at the origin, opening along -Z. Bright at the tip. */
function makeGasCone(radius, height, segments) {
  const g = new THREE.ConeGeometry(radius, height, segments, 4, true);
  g.rotateX(Math.PI / 2);          // +Y axis -> +Z, tip at +Z
  g.translate(0, 0, -height * 0.5); // tip at the origin, base at -Z
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = 1 + pos.getZ(i) / height;      // 1 at the tip, 0 at the base
    const c = Math.pow(t < 0 ? 0 : (t > 1 ? 1 : t), 2.0);
    flashHeat(col, i * 3, c);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Horizontal shockwave ring with a soft radial band baked into vertex colour. */
function makeShockRing(segments) {
  const g = new THREE.RingGeometry(0.55, 1.0, segments, 4);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.sqrt(x * x + y * y);
    const t = (r - 0.55) / 0.45;
    const c = Math.pow(Math.max(0, Math.sin(t * Math.PI)), 1.4);
    col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.rotateX(-Math.PI / 2);         // lie flat, normal +Y
  return g;
}

/** A rifle case profile revolved: rim, extractor groove, body taper, neck. */
function makeShellGeometry() {
  const p = [];
  const V = THREE.Vector2;
  p.push(new V(0.0000, 0.0000));
  p.push(new V(0.0047, 0.0004));
  p.push(new V(0.0048, 0.0022));
  p.push(new V(0.0039, 0.0034));   // extractor groove
  p.push(new V(0.0047, 0.0048));
  p.push(new V(0.0046, 0.0250));
  p.push(new V(0.0037, 0.0322));   // shoulder
  p.push(new V(0.0030, 0.0360));
  p.push(new V(0.0029, 0.0448));   // case mouth
  p.push(new V(0.0025, 0.0450));
  p.push(new V(0.0025, 0.0430));
  const g = new THREE.LatheGeometry(p, 12);
  g.translate(0, -0.0225, 0);      // spin about the centre of mass
  return g;
}

// ------------------------------------------------------------ FXSystem -----

export class FXSystem {
  constructor(ctx) {
    this.ctx = ctx || {};
    this._time = 0;

    const seededRand = makeRNG(0xf00d17);
    const ctxRng = this.ctx.rng;
    this.rand = typeof ctxRng === 'function'
      ? ctxRng
      : (ctxRng && typeof ctxRng.float === 'function' ? () => ctxRng.float() : seededRand);

    /** Every knob worth turning lives here. */
    this.config = {
      intensity: 1.0,              // global particle alpha multiplier
      hdrGain: 1.0,                // multiplies every emissive HDR colour
      muzzleAxis: -1,              // muzzle Object3D forward: -1 = local -Z
      muzzleScale: 1.0,
      // Candela at the flash peak, BEFORE exposure compensation. The light sits
      // ~0.12 m ahead of the crown, so with decay 2 the handguard (~0.25 m away)
      // sees peak/0.06 and the receiver (~0.55 m) peak/0.3 — a strong front-to-
      // back gradient at a level that lifts the weapon instead of clipping it.
      // The old value here was 110, i.e. ~1800 lux on the handguard against a
      // 14-lux sun. That is what whited out the entire viewmodel.
      muzzleLightPeak: 0.85,
      muzzleLightDistance: 9,
      muzzleFlashDuration: 0.048,  // ~48 ms: two to three rendered frames
      burstLightDistance: 26,
      // Muzzle flash geometry, in metres. A 10.3" 5.56 carbine without a
      // flash hider throws a star roughly 0.15-0.25 m across.
      flashCoreRadius: 0.018,
      flashCoreLength: 0.044,
      flashPetalRadius: 0.105,     // half-width of the largest petal
      flashPetals: [3, 5],         // inclusive count range, re-rolled every shot
      // Core deliberately lower than the petals' peak: a hot enough core simply
      // blooms over its own star and the flash reads as a white ball.
      flashHdrCore: 5.5,
      flashHdrPetal: 7.5,
      flashHdrGas: 2.2,
      // Tracers. 900 m/s is the real muzzle velocity and it is exactly why the
      // old tracer read as a static hairline: at 60 Hz that is 15 m of travel
      // per frame, so the streak teleports past the player in one frame. Every
      // shipped shooter slows the visual round down.
      tracerEvery: 2,              // 1 round in N leaves a BRIGHT tracer
      tracerSpeed: 380,            // m/s, visual only — ballistics stay hitscan
      tracerLengthCore: 6.5,       // metres of velocity-aligned stretch
      tracerLengthHalo: 8.0,
      tracerWidthCore: 0.075,      // metres — 0.03 was a sub-pixel hairline
      tracerWidthHalo: 0.30,
      tracerHdr: 13.0,
      impactSparks: 24,
      impactDust: 20,
      impactChips: 11,
      shellLife: 6.0,
      shellFade: 0.9,
      explosionLightPeak: 1400,
      decalLife: 45,
      decalSizes: { concrete: 0.21, metal: 0.16, wood: 0.20, blood: 0.36, scorch: 1.0 },
    };

    // ---- adaptive-exposure compensation -------------------------------------
    // PostFX multiplies the whole frame by an EV metered from the last frame,
    // anywhere in [evMin, evMax]. Authoring a fixed HDR value therefore means
    // the same flash is up to 7x brighter indoors than out. `_expComp` tracks
    // 1/EV (softened) so a flash lands at the same *displayed* level in both.
    this._expComp = 1;
    this._expAcc = 0;
    this._expBuf = new Uint16Array(4);   // one RGBA16F texel
    this._expMode = 0;             // 0 = async readback, 1 = sync, 2 = estimate
    this._expPending = false;

    // ---- scene graph root ---------------------------------------------------
    this.root = new THREE.Group();
    this.root.name = 'FX.Root';
    this.ctx.scene?.add(this.root);

    // ---- sub-systems --------------------------------------------------------
    this.particles = new ParticleSystem(this.ctx, { additive: 4096, alpha: 4096 });
    this.decals = new DecalSystem(this.ctx, { slots: 256 });

    // ---- scratch (never reallocated) ---------------------------------------
    this._v = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._pos2 = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._quatB = new THREE.Quaternion();
    this._m4 = new THREE.Matrix4();
    this._ray = new THREE.Ray();
    this._up = new THREE.Vector3(0, 1, 0);
    this._tint = new THREE.Color(1, 1, 1);
    this._audioOpts = { position: null, volume: 1 };

    this._nrm = new THREE.Vector3();
    this._nrmMat = new THREE.Matrix3();

    this._tracerCount = 0;
    // Diagnostics: a decal that fails to project is silent, which is exactly
    // how "the wall is clean after a magazine" gets shipped. Counted so a probe
    // (or the debug overlay) can see it.
    this._decalHits = 0;
    this._decalMisses = 0;

    this._buildLights();
    this._buildMuzzleFlashes(4);
    // 32 cases: a 30-round magazine dumped on full auto should still leave the
    // whole pile on the floor rather than recycling brass out from under itself.
    this._buildShells(32);
    this._buildExplosions(3);
  }

  // ================================================================ build ===

  _buildLights() {
    // Lights are created once and never added or removed: changing the light
    // count in the scene invalidates every cached program and causes a very
    // visible recompile hitch. Idle lights just sit at intensity 0.
    const mk = (dist) => {
      const l = new THREE.PointLight(0xffffff, 0, dist, 2);
      l.castShadow = false;
      this.root.add(l);
      return { light: l, t: 0, dur: 1, peak: 0, exp: 2 };
    };
    this._muzzleLight = mk(this.config.muzzleLightDistance);
    this._burstLight = mk(this.config.burstLightDistance);
    this._lights = [this._muzzleLight, this._burstLight];
  }

  /**
   * Muzzle flash rigs.
   *
   * Two things matter structurally here.
   *
   * 1. The flash lives on the VIEWMODEL layer. The weapon is drawn in a second
   *    pass by its own 55-degree camera into the front 6% of the depth buffer,
   *    so anything the world camera draws at the muzzle is painted over by the
   *    gun a moment later, and what does survive is projected at the wrong FOV.
   *    Putting the flash on layer 1 makes it share the weapon's camera, its
   *    depth range and its projection — so it lands exactly on the crown and
   *    sorts correctly against the barrel.
   *
   * 2. Each rig carries MAX_PETALS star cards and shows a random 3-5 of them,
   *    re-rolled with new geometry, roll and aspect every shot. Petal 0 faces
   *    down the bore (it is what you see shooting toward the camera); the rest
   *    lie in planes containing the bore, which is what gives the burst its
   *    three-dimensional star.
   */
  _buildMuzzleFlashes(count) {
    const rand = this.rand;
    const MAX_PETALS = 5;
    this._maxPetals = MAX_PETALS;

    // A bank of pre-baked star cards; each shot draws from it at random so two
    // consecutive flashes never share a silhouette.
    this._starGeos = [];
    for (let i = 0; i < 9; i++) {
      this._starGeos.push(makeStarGeometry(rand, 3 + ((rand() * 4) | 0)));
    }
    this._coneGeo = makeGasCone(1, 1, 14);          // unit cone, scaled per shot
    this._coreGeo = new THREE.SphereGeometry(1, 12, 8);

    // depthTest is OFF, deliberately.
    //
    // On this rifle the muzzle sits level with the front of the handguard, and
    // the support hand wraps it. With depth testing on, the barrel and the
    // glove eat the flash: measured against a held-open flash, all that escaped
    // was a ~15 px sliver at the edge of the handguard, which is exactly the
    // "there is no flash geometry at the muzzle" the review reported. Because
    // the flash draws in the viewmodel pass, AFTER the weapon's opaque geometry
    // and inside the same compressed depth range, switching the test off lets
    // the plume wash over the barrel — which is what incandescent gas leaving a
    // muzzle actually does. Nothing else can be between it and the lens.
    const basicAdd = () => new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 1, 1),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });

    this._flashes = [];
    for (let i = 0; i < count; i++) {
      const group = new THREE.Group();
      group.visible = false;
      const holder = new THREE.Group();
      group.add(holder);

      const coreMat = basicAdd();
      const core = new THREE.Mesh(this._coreGeo, coreMat);
      core.renderOrder = 5;
      holder.add(core);

      const petalMat = basicAdd();
      petalMat.vertexColors = true;
      const petals = [];
      for (let p = 0; p < MAX_PETALS; p++) {
        const m = new THREE.Mesh(this._starGeos[p % this._starGeos.length], petalMat);
        m.renderOrder = 5;
        m.visible = false;
        holder.add(m);
        petals.push(m);
      }

      const coneMat = basicAdd();
      coneMat.vertexColors = true;
      const cone = new THREE.Mesh(this._coneGeo, coneMat);
      cone.renderOrder = 5;
      holder.add(cone);

      group.traverse((o) => { o.frustumCulled = false; });
      this.root.add(group);
      this._flashes.push({
        group, holder, core, petals, cone,
        coreMat, petalMat, coneMat,
        active: false, t: 0, dur: 0.048, scale: 1, live: 3,
        cr: 11, cg: 8.5, cb: 6,
        pr: 5.2, pg: 5.2, pb: 5.2,
        gr: 1.9, gg: 1.9, gb: 1.9,
      });
    }
    this._flashCursor = 0;
    this._flashLayer = -1;      // resolved lazily from ctx.viewCamera
  }

  /**
   * Move the flash rigs onto whichever layer the viewmodel camera reads. Done
   * lazily because `ctx.viewCamera` is wired up after the FX system is built,
   * and re-checked cheaply so a camera swap cannot strand the flash.
   */
  _syncFlashLayer(ctx) {
    const vcam = ctx?.viewCamera;
    if (!vcam) return;
    // The viewmodel camera is set to exactly one layer; find it.
    const mask = vcam.layers.mask;
    let layer = -1;
    for (let i = 0; i < 32; i++) {
      if (mask & (1 << i)) { layer = i; break; }
    }
    if (layer < 0 || layer === this._flashLayer) return;
    this._flashLayer = layer;
    for (let i = 0; i < this._flashes.length; i++) {
      // Layers are per-object, not inherited, so every child needs setting.
      this._flashes[i].group.traverse((o) => o.layers.set(layer));
    }
  }

  _buildShells(count) {
    const geo = makeShellGeometry();
    this._shellGeo = geo;
    this._shells = [];
    for (let i = 0; i < count; i++) {
      // Fully metallic and fairly polished. Partial metalness leaves a diffuse
      // term, and a saturated diffuse yellow case tumbling 40 cm from the lens
      // reads as a plastic banana; a real conductor takes its colour from the
      // environment reflection, which gives the case a lit top, a dark
      // underside and a moving highlight as it spins.
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0x8f7133, THREE.SRGBColorSpace),
        metalness: 1.0,
        roughness: 0.29,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.root.add(mesh);
      this._shells.push({
        mesh, mat,
        active: false, resting: false,
        t: 0, life: 0,
        vel: new THREE.Vector3(),
        spinAxis: new THREE.Vector3(0, 1, 0),
        spin: 0,
        groundY: 0,
        bounces: 0,
      });
    }
    this._shellCursor = 0;
    this._spinQuat = new THREE.Quaternion();
  }

  _buildExplosions(count) {
    this._fireGeo = new THREE.IcosahedronGeometry(1, 2);
    this._ringGeo = makeShockRing(64);
    this._explosions = [];
    for (let i = 0; i < count; i++) {
      const fireMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 1, 1),
        blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, side: THREE.FrontSide,
        toneMapped: false, fog: false,
      });
      const fire = new THREE.Mesh(this._fireGeo, fireMat);
      fire.visible = false;
      fire.renderOrder = 4;
      fire.frustumCulled = false;
      this.root.add(fire);

      const ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 1, 1),
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        toneMapped: false, fog: false,
      });
      const ring = new THREE.Mesh(this._ringGeo, ringMat);
      ring.visible = false;
      ring.renderOrder = 4;
      ring.frustumCulled = false;
      this.root.add(ring);

      this._explosions.push({
        fire, fireMat, ring, ringMat,
        active: false, t: 0, dur: 0.75, radius: 3,
      });
    }
    this._explosionCursor = 0;
  }

  // =============================================================== update ===

  update(dt, ctx) {
    const c = ctx || this.ctx;
    if (ctx) this.ctx = ctx;
    this._time += dt;

    // FX pick up the scene's key light colour so smoke/dust sit in the grade.
    const sun = c?.postfx?.sunColor;
    if (sun) this._tint.setRGB(0.55 + 0.45 * sun.r, 0.55 + 0.45 * sun.g, 0.55 + 0.45 * sun.b);

    this._syncFlashLayer(c);
    this._updateExposure(dt, c);
    this.particles.update(dt, c);
    this.decals.update(dt, c);
    this._updateFlashes(dt);
    this._updateShells(dt, c);
    this._updateExplosions(dt);
    this._updateLights(dt);
  }

  // ============================================================= exposure ===

  /**
   * Track the post stack's adapted exposure so emissive FX can be authored
   * against the *displayed* frame instead of the linear buffer.
   *
   * PostFX meters the frame into a 1x1 half-float target and multiplies
   * everything by `exposure * clamp(keyValue / adaptedLum, evMin, evMax)`. That
   * multiplier swings 7.4x between a bright courtyard and the warehouse
   * interior, and nothing on the CPU side mirrors it — so we read the 1x1
   * target directly, at 5 Hz, asynchronously where the renderer supports it.
   *
   * `_expComp` is (1/EV)^0.75. A pure 1/EV would hold the flash at a literally
   * constant displayed brightness; the softened exponent lets it stay a little
   * hotter in the dark, which is both physically right and what the eye wants.
   */
  _updateExposure(dt, ctx) {
    this._expAcc -= dt;
    if (this._expAcc > 0) return;
    this._expAcc = 0.25;               // 4 Hz; adaptation itself takes ~1 s

    const postfx = ctx?.postfx;
    const P = postfx?.params;
    if (!P) return;

    if (P.autoExposure === false) {
      this._setExpComp(P.exposure ?? 1);
      return;
    }

    const rt = postfx.adaptRT?.[postfx.adaptIndex];
    const renderer = ctx?.renderer;

    if (rt && renderer && this._expMode === 0) {
      // Preferred path: a fenced 1x1 readback, which does not stall the
      // pipeline. Degrade to the synchronous read if the renderer refuses.
      if (this._expPending) return;
      let p = null;
      this._expPending = true;
      try {
        p = renderer.readRenderTargetPixelsAsync?.(rt, 0, 0, 1, 1, this._expBuf);
      } catch (err) { p = null; }
      if (p && typeof p.then === 'function') {
        p.then(() => {
          this._expPending = false;
          if (!this._applyMeteredLum(P)) this._expMode = 1;
        }).catch(() => {
          this._expPending = false;
          this._expMode = 1;
        });
        return;
      }
      this._expPending = false;
      this._expMode = 1;
    }

    if (rt && renderer && this._expMode === 1) {
      // 8 bytes, four times a second. It costs a pipeline flush, which is why
      // it is not the first choice, but it is exact.
      try {
        renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, this._expBuf);
        if (this._applyMeteredLum(P)) return;
      } catch (err) { /* fall through to the estimate */ }
      this._expMode = 2;
    }

    this._setExpComp(this._estimateEV(ctx, P));
  }

  /** Decode the metered luminance in `_expBuf` into `_expComp`. */
  _applyMeteredLum(P) {
    const lum = halfToFloat(this._expBuf[0]);
    if (!(lum > 0) || !isFinite(lum)) return false;
    const ev = (P.exposure ?? 1) * Math.min(
      P.evMax ?? 2.6,
      Math.max(P.evMin ?? 0.35, (P.keyValue ?? 0.2) / lum),
    );
    this._setExpComp(ev);
    return true;
  }

  /**
   * Fallback when the metering target cannot be read: infer EV from the rig.
   *
   * The coefficient is fitted against a measured sample — the courtyard meters
   * at adaptedLum 0.277 with environmentIntensity 0.55 and a 14.2 sun — and
   * both inputs move the right way when the player walks inside, because Sky
   * pulls `scene.environmentIntensity` down and the sun stops reaching them.
   */
  _estimateEV(ctx, P) {
    const env = ctx?.scene?.environmentIntensity ?? 1;
    const sun = ctx?.sky?.sunLight?.intensity ?? 0;
    const lum = 0.177 * env * (1 + 0.13 * sun);
    const raw = (P.keyValue ?? 0.2) / Math.max(lum, 1e-4);
    return (P.exposure ?? 1)
      * Math.min(P.evMax ?? 2.6, Math.max(P.evMin ?? 0.35, raw));
  }

  _setExpComp(ev) {
    const e = ev > 1e-3 ? ev : 1;
    const target = Math.pow(1 / e, 0.75);
    // Ease so a fast exposure swing cannot make the flash pulse between shots.
    this._expComp += (target - this._expComp) * 0.5;
    if (this._expComp < 0.25) this._expComp = 0.25;
    if (this._expComp > 3.0) this._expComp = 3.0;
  }

  _updateLights(dt) {
    for (let i = 0; i < this._lights.length; i++) {
      const s = this._lights[i];
      if (s.t <= 0) continue;
      s.t -= dt;
      if (s.t <= 0) {
        s.t = 0;
        s.light.intensity = 0;
        continue;
      }
      const k = s.t / s.dur;
      s.light.intensity = s.peak * Math.pow(k, s.exp);
    }
  }

  _fireLight(state, x, y, z, peak, dur, r, g, b, exp) {
    state.light.position.set(x, y, z);
    state.light.color.setRGB(r, g, b);
    // Exposure-compensated: a fixed candela value lands 7x hotter on screen in
    // the warehouse than it does in the courtyard.
    state.peak = peak * this.config.hdrGain * this._expComp;
    state.dur = dur;
    state.t = dur;
    state.exp = exp;
    state.light.intensity = state.peak;
  }

  _updateFlashes(dt) {
    for (let i = 0; i < this._flashes.length; i++) {
      const f = this._flashes[i];
      if (!f.active) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        f.active = false;
        f.group.visible = false;
        for (let p = 0; p < f.petals.length; p++) f.petals[p].visible = false;
        continue;
      }
      // Real flash luminance is a near-instant rise and a fast, slightly
      // super-quadratic fall. Holding the first ~15% flat guarantees at least
      // one rendered frame at full intensity however the frame lands.
      const kk = k < 0.15 ? 0 : (k - 0.15) / 0.85;
      const d = (1 - kk) * (1 - kk);
      const g = this.config.hdrGain * this._expComp;
      f.coreMat.color.setRGB(f.cr * d * g, f.cg * d * g, f.cb * d * g);
      f.petalMat.color.setRGB(f.pr * d * g, f.pg * d * g, f.pb * d * g);
      const gd = (1 - kk) * (1 - kk) * (1 - kk);
      f.coneMat.color.setRGB(f.gr * gd * g, f.gg * gd * g, f.gb * gd * g);
      // Gas keeps expanding as it cools; the star collapses back toward the
      // crown instead of ballooning, which is what stops it reading as a puff.
      const grow = 1 + kk * 0.85;
      f.cone.scale.set(f.gasR * grow, f.gasR * grow, f.gasL * (1 + kk * 1.1));
      f.holder.scale.setScalar(f.scale * (1 + 0.18 * kk - 0.30 * kk * kk));
    }
  }

  _updateShells(dt, ctx) {
    const q = this._spinQuat;
    for (let i = 0; i < this._shells.length; i++) {
      const s = this._shells[i];
      if (!s.active) continue;
      s.t += dt;

      if (!s.resting) {
        s.vel.y -= 9.81 * dt;
        s.vel.x *= 1 - 0.25 * dt;
        s.vel.z *= 1 - 0.25 * dt;
        s.mesh.position.addScaledVector(s.vel, dt);

        const floor = s.groundY + 0.0045;
        if (s.mesh.position.y <= floor && s.vel.y < 0) {
          s.mesh.position.y = floor;
          s.vel.y = -s.vel.y * 0.34;
          s.vel.x *= 0.55;
          s.vel.z *= 0.55;
          s.spin *= 0.45;
          s.bounces++;

          this._audioOpts.position = s.mesh.position;
          this._audioOpts.volume = 0.5 + 0.5 / s.bounces;
          ctx?.audio?.play?.('shellBounce', this._audioOpts);

          if (s.bounces >= 4 || (s.vel.lengthSq() < 0.05 && Math.abs(s.vel.y) < 0.35)) {
            s.resting = true;
            s.vel.set(0, 0, 0);
            s.spin = 0;
            // settle onto its side rather than freezing mid-tumble
            this._v.set(s.mesh.position.x - s.mesh.position.z, 0, s.mesh.position.z + 1);
            if (this._v.lengthSq() < 1e-6) this._v.set(1, 0, 0);
            this._v.normalize();
            s.mesh.quaternion.setFromUnitVectors(this._up, this._v);
            s.mesh.position.y = s.groundY + 0.0048;
          }
        }

        if (s.spin !== 0) {
          q.setFromAxisAngle(s.spinAxis, s.spin * dt);
          s.mesh.quaternion.premultiply(q);
        }
      }

      const remaining = s.life - s.t;
      const fade = this.config.shellFade;
      if (remaining < fade) {
        const a = remaining / fade;
        s.mat.opacity = a > 0 ? a : 0;
      }
      if (s.t >= s.life) {
        s.active = false;
        s.mesh.visible = false;
      }
    }
  }

  _updateExplosions(dt) {
    for (let i = 0; i < this._explosions.length; i++) {
      const e = this._explosions[i];
      if (!e.active) continue;
      e.t += dt;
      const k = e.t / e.dur;
      if (k >= 1) {
        e.active = false;
        e.fire.visible = false;
        e.ring.visible = false;
        continue;
      }
      const gain = this.config.hdrGain;
      const R = e.radius;

      // fireball: fast ease-out expansion, cooling from white to deep orange
      const fk = Math.min(1, e.t / (e.dur * 0.42));
      const fe = 1 - Math.pow(1 - fk, 3);
      const fs = R * (0.28 + 1.05 * fe);
      e.fire.scale.set(fs, fs * 0.92, fs);
      const fd = Math.pow(1 - fk, 2.1);
      e.fireMat.color.setRGB(
        (2.5 + 32 * fd) * gain,
        (0.35 + 14 * fd * fd) * gain,
        (0.04 + 4.0 * fd * fd * fd) * gain,
      );
      e.fireMat.opacity = fk < 1 ? 1 : 0;
      e.fire.visible = fk < 1;

      // shockwave: outruns the fireball and thins as it goes
      const rk = Math.min(1, e.t / (e.dur * 0.72));
      const re = 1 - Math.pow(1 - rk, 2.4);
      const rs = R * (0.18 + 2.55 * re);
      e.ring.scale.set(rs, 1, rs);
      const rd = Math.pow(1 - rk, 2.0);
      e.ringMat.color.setRGB(6.0 * rd * gain, 4.4 * rd * gain, 3.0 * rd * gain);
      e.ring.visible = rk < 1;
    }
  }

  // ============================================================== helpers ===

  /** Random unit vector inside the cone around `n` whose half-angle has cos = minCos. */
  _coneDir(n, minCos, out) {
    const t1 = this._t1;
    const t2 = this._t2;
    if (Math.abs(n.y) > 0.92) t1.set(1, 0, 0); else t1.set(0, 1, 0);
    t1.cross(n);
    const l = t1.length();
    if (l < 1e-6) t1.set(1, 0, 0); else t1.multiplyScalar(1 / l);
    t2.crossVectors(n, t1);

    const z = minCos + (1 - minCos) * this.rand();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = this.rand() * TWO_PI;
    const cx = Math.cos(phi) * r;
    const cy = Math.sin(phi) * r;
    out.set(
      n.x * z + t1.x * cx + t2.x * cy,
      n.y * z + t1.y * cx + t2.y * cy,
      n.z * z + t1.z * cx + t2.z * cy,
    );
    return out;
  }

  /**
   * Height of the floor beneath a point, for spark/brass bounce. Uses the
   * level's BVH when one is present; falls back to y = 0 (the architecture
   * puts the ground plane there).
   */
  _floorY(point) {
    const collider = this.ctx?.world?.collider;
    const bvh = collider?.geometry?.boundsTree;
    if (bvh && typeof bvh.raycastFirst === 'function') {
      collider.updateWorldMatrix?.(true, false);
      this._ray.origin.set(point.x, point.y + 0.08, point.z);
      this._ray.direction.set(0, -1, 0);
      this._m4.copy(collider.matrixWorld).invert();
      this._ray.applyMatrix4(this._m4);
      try {
        const hit = bvh.raycastFirst(this._ray, THREE.DoubleSide, 0, 40);
        if (hit && hit.point) {
          this._v.copy(hit.point).applyMatrix4(collider.matrixWorld);
          return this._v.y;
        }
      } catch (err) {
        // Unknown BVH build — silently fall through to the default plane.
      }
    }
    return 0;
  }

  // ============================================================== impacts ===

  /**
   * Bullet impact: per-surface debris, a projected decal, and a dust cone
   * aligned to the surface normal.
   */
  impact(point, normal, surfaceKind) {
    if (!point || !normal) return;
    const kind = classifySurface(surfaceKind);
    if (kind === 'flesh') { this.bloodImpact(point, normal); return; }

    const cfg = this.config;
    const decalKind = kind === 'metal' ? 'metal' : (kind === 'wood' ? 'wood' : 'concrete');
    const baseSize = cfg.decalSizes[decalKind] || 0.2;

    // The normal arriving from Ballistics is a raycast face normal, i.e. it is
    // in the COLLIDER's object space. It is only the world normal while the
    // collider's matrix is identity, and a decal projected along a mis-rotated
    // axis gathers no forward-facing triangles and silently vanishes. Convert.
    const n = this._worldNormal(normal);

    const slot = this.decals.spawn(point, n, decalKind,
      baseSize * (0.78 + this.rand() * 0.5), { life: cfg.decalLife });
    if (slot < 0) this._decalMisses++; else this._decalHits++;

    this._impactFlash(point, n, kind);
    this._dustCone(point, n, kind);

    if (kind === 'metal') {
      this._metalSparks(point, n);
    } else if (kind === 'wood') {
      this._woodSplinters(point, n);
    } else {
      this._concreteDebris(point, n, kind);
    }
  }

  /**
   * Convert a raycast face normal into world space.
   *
   * `Raycaster` hands back `intersection.face.normal` in the hit object's LOCAL
   * space while `intersection.point` is already world — a mismatch that is
   * invisible for as long as the collider sits at the identity and then breaks
   * decals completely the day it does not, because the projector box ends up
   * rotated off the wall and the triangle gather rejects every candidate face.
   * Cheap to make correct: the collider's normal matrix, cached per frame.
   */
  _worldNormal(n) {
    const out = this._nrm.copy(n);
    const collider = this.ctx?.world?.collider;
    const m = collider?.matrixWorld;
    if (m) {
      const e = m.elements;
      // Skip the transform entirely in the overwhelmingly common identity case.
      const rotated = e[0] !== 1 || e[5] !== 1 || e[10] !== 1
        || e[1] || e[2] || e[4] || e[6] || e[8] || e[9];
      if (rotated) {
        this._nrmMat.getNormalMatrix(m);
        out.applyMatrix3(this._nrmMat);
      }
    }
    const len = out.length();
    if (len < 1e-8) return out.set(0, 1, 0);
    return out.multiplyScalar(1 / len);
  }

  /** The 40 ms hot flash every impact makes, whatever it hits. */
  _impactFlash(point, normal, kind) {
    const ps = this.particles;
    const gain = this.config.hdrGain * this._expComp;
    const hot = kind === 'metal' ? 1.6 : 0.7;
    const d = ps.begin();
    d.x = point.x + normal.x * 0.01;
    d.y = point.y + normal.y * 0.01;
    d.z = point.z + normal.z * 0.01;
    d.sprite = SPRITE.FLASH;
    d.size = (0.10 + this.rand() * 0.09) * (kind === 'metal' ? 1.25 : 1.0);
    d.sizeEnd = d.size * 1.9;
    d.curve = CURVE_FAST;
    d.rot = this.rand() * TWO_PI;
    d.r = 16 * hot * gain; d.g = 9 * hot * gain; d.b = 4.4 * hot * gain;
    d.r2 = 3 * hot * gain; d.g2 = 1.1 * hot * gain; d.b2 = 0.3 * hot * gain;
    d.a = 1; d.a2 = 0;
    d.life = 0.045 + this.rand() * 0.03;
    d.fadeIn = 0.0015;
    ps.emit(MODE_ADD);
  }

  /** Directional dust cone along the surface normal — every impact gets one. */
  _dustCone(point, normal, kind) {
    const ps = this.particles;
    const n = this.config.impactDust;
    const tint = this._tint;
    let cr = 0.52, cg = 0.50, cb = 0.47;
    if (kind === 'metal') { cr = 0.34; cg = 0.34; cb = 0.35; }
    else if (kind === 'wood') { cr = 0.52; cg = 0.41; cb = 0.28; }
    else if (kind === 'dirt') { cr = 0.44; cg = 0.36; cb = 0.26; }

    for (let i = 0; i < n; i++) {
      const dir = this._coneDir(normal, 0.30, this._dir);
      const sp = 0.9 + this.rand() * 3.4;
      const d = ps.begin();
      d.x = point.x + dir.x * 0.03;
      d.y = point.y + dir.y * 0.03;
      d.z = point.z + dir.z * 0.03;
      d.vx = dir.x * sp;
      d.vy = dir.y * sp + 0.30;
      d.vz = dir.z * sp;
      d.sprite = this.rand() < 0.55 ? SPRITE.DUST : SPRITE.SMOKE_C;
      d.size = 0.030 + this.rand() * 0.040;
      // Bigger and longer-lived than before: a 0.2 m puff seen from 25 m away
      // is 7 px and simply does not register as "I hit that wall".
      d.sizeEnd = 0.28 + this.rand() * 0.46;
      d.curve = CURVE_FAST;
      const v = 0.85 + this.rand() * 0.4;
      d.r = cr * v * tint.r; d.g = cg * v * tint.g; d.b = cb * v * tint.b;
      d.r2 = d.r * 0.72; d.g2 = d.g * 0.72; d.b2 = d.b * 0.72;
      d.a = 0.52 + this.rand() * 0.26; d.a2 = 0;
      d.life = 0.55 + this.rand() * 0.95;
      d.drag = 2.6;
      d.grav = 0.14;
      d.rot = this.rand() * TWO_PI;
      d.rotVel = (this.rand() - 0.5) * 2.6;
      d.turb = 0.45;
      d.fadeIn = 0.05;
      ps.emit(MODE_ALPHA);
    }
  }

  _concreteDebris(point, normal, kind) {
    const ps = this.particles;
    const tint = this._tint;
    const chips = this.config.impactChips;
    const floorY = this._floorY(point);

    // light-grey chips, tumbling
    for (let i = 0; i < chips; i++) {
      const dir = this._coneDir(normal, -0.1, this._dir);
      const sp = 1.6 + this.rand() * 4.6;
      const d = ps.begin();
      d.x = point.x + dir.x * 0.02;
      d.y = point.y + dir.y * 0.02;
      d.z = point.z + dir.z * 0.02;
      d.vx = dir.x * sp;
      d.vy = dir.y * sp + 0.9;
      d.vz = dir.z * sp;
      d.sprite = this.rand() < 0.5 ? SPRITE.CHIP_A : SPRITE.CHIP_B;
      d.size = 0.008 + this.rand() * 0.014;
      d.sizeEnd = d.size;
      const v = kind === 'dirt' ? 0.34 : 0.66;
      d.r = v * 1.00 * tint.r; d.g = v * 0.97 * tint.g; d.b = v * 0.92 * tint.b;
      d.r2 = d.r; d.g2 = d.g; d.b2 = d.b;
      d.a = 1; d.a2 = 1;
      d.life = 0.7 + this.rand() * 0.9;
      d.grav = 1.0;
      d.drag = 0.25;
      d.rot = this.rand() * TWO_PI;
      d.rotVel = (this.rand() - 0.5) * 24;
      d.bounce = 0.32;
      d.groundY = floorY;
      d.fadeIn = 0.002;
      ps.emit(MODE_ALPHA);
    }

    // The puff that lingers after the dust cone has settled. This is the part
    // that persists long enough for the player to see WHERE they hit, so it is
    // deliberately larger and slightly denser than the initial cone.
    const lingering = 4;
    for (let i = 0; i < lingering; i++) {
      const dir = this._coneDir(normal, 0.55, this._dir);
      const d = ps.begin();
      d.x = point.x + dir.x * 0.06;
      d.y = point.y + dir.y * 0.06;
      d.z = point.z + dir.z * 0.06;
      d.vx = dir.x * 0.45;
      d.vy = dir.y * 0.45 + 0.30;
      d.vz = dir.z * 0.45;
      d.sprite = this.rand() < 0.5 ? SPRITE.SMOKE_A : SPRITE.SMOKE_B;
      d.size = 0.10 + this.rand() * 0.08;
      d.sizeEnd = 0.55 + this.rand() * 0.38;
      d.curve = CURVE_FAST;
      d.r = 0.46 * tint.r; d.g = 0.45 * tint.g; d.b = 0.43 * tint.b;
      d.r2 = 0.31 * tint.r; d.g2 = 0.31 * tint.g; d.b2 = 0.30 * tint.b;
      d.a = 0.36 + this.rand() * 0.16; d.a2 = 0;
      d.life = 1.5 + this.rand() * 1.2;
      d.drag = 1.5;
      d.grav = -0.03;                  // buoyant
      d.rot = this.rand() * TWO_PI;
      d.rotVel = (this.rand() - 0.5) * 0.9;
      d.turb = 0.30;
      d.fadeIn = 0.16;
      ps.emit(MODE_ALPHA);
    }
  }

  _metalSparks(point, normal) {
    const ps = this.particles;
    const gain = this.config.hdrGain * this._expComp;
    const n = this.config.impactSparks;
    const floorY = this._floorY(point);

    for (let i = 0; i < n; i++) {
      const dir = this._coneDir(normal, -0.35, this._dir);
      const rr = this.rand();
      const sp = 1.8 + rr * rr * 7.5;
      const d = ps.begin();
      d.x = point.x + dir.x * 0.015;
      d.y = point.y + dir.y * 0.015;
      d.z = point.z + dir.z * 0.015;
      d.vx = dir.x * sp;
      d.vy = dir.y * sp + 0.5;
      d.vz = dir.z * sp;
      d.sprite = SPRITE.SPARK;
      d.size = 0.006 + this.rand() * 0.007;
      d.sizeEnd = d.size * 0.45;
      d.stretch = 0.10 + this.rand() * 0.34;
      d.r = 9.5 * gain; d.g = 3.6 * gain; d.b = 0.55 * gain;
      d.r2 = 2.2 * gain; d.g2 = 0.28 * gain; d.b2 = 0.02 * gain;
      d.a = 1; d.a2 = 0;
      d.life = 0.30 + this.rand() * 0.85;
      d.grav = 1.0;
      d.drag = 0.55;
      d.bounce = 0.42;
      d.groundY = floorY;
      d.fadeIn = 0.0015;
      ps.emit(MODE_ADD);
    }

    // a few slow embers that outlive the shower and keep bouncing
    for (let i = 0; i < 5; i++) {
      const dir = this._coneDir(normal, -0.6, this._dir);
      const sp = 0.8 + this.rand() * 2.2;
      const d = ps.begin();
      d.x = point.x; d.y = point.y; d.z = point.z;
      d.vx = dir.x * sp; d.vy = dir.y * sp + 0.4; d.vz = dir.z * sp;
      d.sprite = SPRITE.EMBER;
      d.size = 0.010 + this.rand() * 0.008;
      d.sizeEnd = d.size * 0.4;
      d.r = 6.0 * gain; d.g = 1.9 * gain; d.b = 0.20 * gain;
      d.r2 = 0.9 * gain; d.g2 = 0.10 * gain; d.b2 = 0.01 * gain;
      d.a = 1; d.a2 = 0;
      d.life = 1.1 + this.rand() * 1.4;
      d.grav = 1.0;
      d.drag = 0.9;
      d.bounce = 0.45;
      d.groundY = floorY;
      d.fadeIn = 0.002;
      ps.emit(MODE_ADD);
    }

    // the glowing spall point, cooling from white-hot to dull red over ~0.4 s
    const d = ps.begin();
    d.x = point.x + normal.x * 0.006;
    d.y = point.y + normal.y * 0.006;
    d.z = point.z + normal.z * 0.006;
    d.sprite = SPRITE.GLOW;
    d.size = 0.055;
    d.sizeEnd = 0.018;
    d.r = 14 * gain; d.g = 5.2 * gain; d.b = 1.0 * gain;
    d.r2 = 0.85 * gain; d.g2 = 0.07 * gain; d.b2 = 0.004 * gain;
    d.a = 1; d.a2 = 0;
    d.life = 0.42;
    d.fadeIn = 0.001;
    this.particles.emit(MODE_ADD);
  }

  _woodSplinters(point, normal) {
    const ps = this.particles;
    const tint = this._tint;
    const floorY = this._floorY(point);
    for (let i = 0; i < this.config.impactChips + 4; i++) {
      const dir = this._coneDir(normal, 0.0, this._dir);
      const sp = 1.4 + this.rand() * 4.0;
      const d = ps.begin();
      d.x = point.x + dir.x * 0.02;
      d.y = point.y + dir.y * 0.02;
      d.z = point.z + dir.z * 0.02;
      d.vx = dir.x * sp; d.vy = dir.y * sp + 0.8; d.vz = dir.z * sp;
      d.sprite = this.rand() < 0.5 ? SPRITE.CHIP_A : SPRITE.CHIP_B;
      d.size = 0.005 + this.rand() * 0.008;
      d.sizeEnd = d.size;
      d.stretch = 0.02 + this.rand() * 0.05;   // splinters are long, not blocky
      d.r = 0.44 * tint.r; d.g = 0.31 * tint.g; d.b = 0.17 * tint.b;
      d.r2 = d.r; d.g2 = d.g; d.b2 = d.b;
      d.a = 1; d.a2 = 1;
      d.life = 0.8 + this.rand() * 1.0;
      d.grav = 1.0;
      d.drag = 0.5;
      d.rotVel = (this.rand() - 0.5) * 20;
      d.bounce = 0.25;
      d.groundY = floorY;
      d.fadeIn = 0.002;
      ps.emit(MODE_ALPHA);
    }
  }

  /** Red mist cone + droplets + (if geometry is behind it) a blood decal. */
  bloodImpact(point, normal) {
    if (!point || !normal) return;
    const ps = this.particles;
    const tint = this._tint;

    for (let i = 0; i < 20; i++) {
      const dir = this._coneDir(normal, 0.25, this._dir);
      const sp = 0.8 + this.rand() * 3.2;
      const d = ps.begin();
      d.x = point.x + dir.x * 0.02;
      d.y = point.y + dir.y * 0.02;
      d.z = point.z + dir.z * 0.02;
      d.vx = dir.x * sp; d.vy = dir.y * sp + 0.4; d.vz = dir.z * sp;
      d.sprite = SPRITE.BLOOD_MIST;
      d.size = 0.03 + this.rand() * 0.04;
      d.sizeEnd = 0.16 + this.rand() * 0.22;
      d.curve = CURVE_FAST;
      d.r = 0.44 * tint.r; d.g = 0.030 * tint.g; d.b = 0.026 * tint.b;
      d.r2 = 0.17 * tint.r; d.g2 = 0.012 * tint.g; d.b2 = 0.012 * tint.b;
      d.a = 0.55 + this.rand() * 0.3; d.a2 = 0;
      d.life = 0.30 + this.rand() * 0.45;
      d.drag = 3.4;
      d.grav = 0.25;
      d.rot = this.rand() * TWO_PI;
      d.rotVel = (this.rand() - 0.5) * 3;
      d.turb = 0.3;
      d.fadeIn = 0.03;
      ps.emit(MODE_ALPHA);
    }

    const floorY = this._floorY(point);
    for (let i = 0; i < 16; i++) {
      const dir = this._coneDir(normal, -0.2, this._dir);
      const sp = 1.2 + this.rand() * 4.5;
      const d = ps.begin();
      d.x = point.x; d.y = point.y; d.z = point.z;
      d.vx = dir.x * sp; d.vy = dir.y * sp + 1.0; d.vz = dir.z * sp;
      d.sprite = SPRITE.BLOOD_DROP;
      d.size = 0.006 + this.rand() * 0.009;
      d.sizeEnd = d.size * 0.85;
      d.stretch = 0.02 + this.rand() * 0.06;
      d.r = 0.30; d.g = 0.018; d.b = 0.016;
      d.r2 = 0.20; d.g2 = 0.012; d.b2 = 0.010;
      d.a = 1; d.a2 = 0.9;
      d.life = 0.7 + this.rand() * 0.7;
      d.grav = 1.0;
      d.drag = 0.35;
      d.bounce = 0.12;
      d.groundY = floorY;
      d.fadeIn = 0.002;
      ps.emit(MODE_ALPHA);
    }

    // Only project a decal if there is real geometry to catch it — no floating
    // quads hanging in the air where an enemy used to be.
    this.decals.spawn(point, normal, 'blood',
      this.config.decalSizes.blood * (0.7 + this.rand() * 0.7), {
        life: 60, fadeOut: 8, allowFallback: false,
      });
  }

  // =============================================================== tracer ===

  /**
   * Stretched additive streak travelling muzzle -> impact.
   *
   * Three things the previous version got wrong, all of which the review saw:
   *
   *  - **Speed.** It flew at the real 900 m/s. At 60 Hz that is 15 m of travel
   *    per frame against a 5 m streak, so the round was never in two adjacent
   *    frames in the same place: it read as a static scratch, not as travel.
   *    The visual round now flies at ~380 m/s. Ballistics are unaffected — the
   *    hit is resolved instantly by hitscan; this is purely the visible bullet.
   *  - **Width.** A 0.03 m quad at 25 m is 1.1 px on a 900 px frame, i.e. the
   *    "1 px orange hairline". The core is now 0.075 m with a 0.30 m halo.
   *  - **Taper.** SPARK is symmetric. The dedicated TRACER sprite is hot at the
   *    head and tapers to nothing at the tail.
   *
   * Every round gets a streak; one in `config.tracerEvery` gets the bright one.
   * Pass `force` to guarantee a bright tracer.
   */
  tracer(from, to, speed, force) {
    if (!from || !to) return;
    this._tracerCount++;
    const every = this.config.tracerEvery | 0;
    const bright = !!force || every <= 1 || (this._tracerCount % every) === 0;

    this._dir.subVectors(to, from);
    const dist = this._dir.length();
    if (dist < 0.35) return;
    this._dir.multiplyScalar(1 / dist);

    const cfg = this.config;
    // `speed` is advisory. Ballistics passes the real 900 m/s muzzle velocity,
    // and at 900 m/s a 40 m shot is alive for 44 ms — under three frames, each
    // one 15 m further on. That is why the tracer read as a static scratch
    // rather than as something travelling. The round is hitscan, so the visual
    // speed is free: cap it at the configured value and let the streak fly.
    const req = speed > 0 ? speed : cfg.tracerSpeed;
    const v = req < cfg.tracerSpeed ? req : cfg.tracerSpeed;
    const life = Math.max(0.030, dist / v);
    const gain = cfg.hdrGain * this._expComp * (bright ? 1 : 0.34);
    const wide = bright ? 1 : 0.55;
    const ps = this.particles;

    // Start on the barrel, not at the raw muzzle position: the tracer is drawn
    // by the world camera and the muzzle belongs to the viewmodel camera.
    const k = this._viewAlign(from, this._t2);
    const lead = 0.22 * k;
    const sx = this._t2.x + this._dir.x * lead;
    const sy = this._t2.y + this._dir.y * lead;
    const sz = this._t2.z + this._dir.z * lead;

    const core = ps.begin();
    core.x = sx; core.y = sy; core.z = sz;
    core.vx = this._dir.x * v; core.vy = this._dir.y * v; core.vz = this._dir.z * v;
    core.sprite = SPRITE.TRACER;
    core.size = cfg.tracerWidthCore * wide;
    core.sizeEnd = cfg.tracerWidthCore * wide * 0.62;
    core.stretch = cfg.tracerLengthCore;
    core.r = cfg.tracerHdr * gain;
    core.g = cfg.tracerHdr * 0.55 * gain;
    core.b = cfg.tracerHdr * 0.19 * gain;
    core.r2 = cfg.tracerHdr * 0.30 * gain;
    core.g2 = cfg.tracerHdr * 0.11 * gain;
    core.b2 = cfg.tracerHdr * 0.02 * gain;
    core.a = 1; core.a2 = 0.25;
    core.life = life;
    core.fadeIn = 0.0008;
    ps.emit(MODE_ADD);

    const halo = ps.begin();
    halo.x = sx; halo.y = sy; halo.z = sz;
    halo.vx = this._dir.x * v; halo.vy = this._dir.y * v; halo.vz = this._dir.z * v;
    halo.sprite = SPRITE.STREAK;
    halo.size = cfg.tracerWidthHalo * wide;
    halo.sizeEnd = cfg.tracerWidthHalo * wide * 0.7;
    halo.stretch = cfg.tracerLengthHalo;
    halo.r = 2.6 * gain; halo.g = 1.05 * gain; halo.b = 0.26 * gain;
    halo.r2 = 0.55 * gain; halo.g2 = 0.18 * gain; halo.b2 = 0.03 * gain;
    halo.a = 0.5; halo.a2 = 0;
    halo.life = life;
    halo.fadeIn = 0.0008;
    ps.emit(MODE_ADD);

    if (!bright) return;

    // A round-facing hot head. This carries the whole effect when the player
    // fires along the view axis: the stretched quads foreshorten to nothing
    // (correctly — a streak seen end-on has no length), so without a billboard
    // head your own tracers would be invisible in exactly the situation you
    // spend the game in.
    const head = ps.begin();
    head.x = sx; head.y = sy; head.z = sz;
    head.vx = this._dir.x * v; head.vy = this._dir.y * v; head.vz = this._dir.z * v;
    head.sprite = SPRITE.GLOW;
    head.size = cfg.tracerWidthCore * 2.8;
    head.sizeEnd = cfg.tracerWidthCore * 1.6;
    head.r = 12.0 * gain; head.g = 5.4 * gain; head.b = 1.3 * gain;
    head.r2 = 2.4 * gain; head.g2 = 0.7 * gain; head.b2 = 0.09 * gain;
    head.a = 1; head.a2 = 0.25;
    head.life = life;
    head.fadeIn = 0.0008;
    ps.emit(MODE_ADD);
  }

  // ========================================================= muzzle flash ===

  /**
   * Multi-part muzzle flash: emissive core, 3-5 randomly-rotated star petals,
   * a cone of hot gas, burning powder, smoke, and a real PointLight for ~50 ms.
   *
   * Physical scale: a 10.3" 5.56 carbine throws a star about 0.15-0.25 m across
   * and a gas plume ~0.25 m long. `config.flashPetalRadius` is the half-width
   * of the largest petal, so the default 0.085 m gives a 0.17-0.24 m burst once
   * the per-shot jitter is applied.
   *
   * @param {THREE.Matrix4} matrixWorld world transform of the muzzle
   * @param {number} [scale] calibre scale, 1 = 5.56 carbine
   */
  muzzleFlash(matrixWorld, scale = 1) {
    if (!matrixWorld) return;
    const cfg = this.config;
    const rand = this.rand;

    matrixWorld.decompose(this._pos, this._quat, this._scl);

    // forward axis of the muzzle in world space
    const fz = cfg.muzzleAxis < 0 ? -1 : 1;
    this._dir.set(0, 0, fz).applyQuaternion(this._quat).normalize();

    const f = this._flashes[this._flashCursor];
    this._flashCursor = (this._flashCursor + 1) % this._flashes.length;

    const s = scale * cfg.muzzleScale * (0.84 + rand() * 0.36);
    f.active = true;
    f.t = 0;
    f.dur = cfg.muzzleFlashDuration * (0.85 + rand() * 0.4);
    f.scale = s;
    f.group.visible = true;
    f.group.position.copy(this._pos);
    f.group.quaternion.copy(this._quat);
    f.holder.rotation.y = cfg.muzzleAxis < 0 ? 0 : Math.PI;
    f.holder.scale.setScalar(s);

    // ---- core: a small, brutally bright ellipsoid sitting on the crown ------
    const cr = cfg.flashCoreRadius;
    f.core.scale.set(
      cr * (0.82 + rand() * 0.45),
      cr * (0.82 + rand() * 0.45),
      cfg.flashCoreLength * (0.7 + rand() * 0.7),
    );
    f.core.position.z = -cfg.flashCoreLength * 0.5;
    f.cr = cfg.flashHdrCore * (0.85 + rand() * 0.35);
    f.cg = f.cr * (0.66 + rand() * 0.08);
    f.cb = f.cr * (0.34 + rand() * 0.10);

    // ---- petals: 3-5 cards, new shape / roll / aspect every single shot -----
    const lo = cfg.flashPetals[0] | 0;
    const hi = cfg.flashPetals[1] | 0;
    const n = Math.min(f.petals.length, lo + ((rand() * (hi - lo + 1)) | 0));
    f.live = n;
    const pr = cfg.flashPetalRadius;
    // Spread the bore-plane cards roughly evenly, then jitter, so a shot never
    // stacks two petals on top of each other.
    const rollBase = rand() * Math.PI;
    for (let p = 0; p < f.petals.length; p++) {
      const m = f.petals[p];
      if (p >= n) { m.visible = false; continue; }
      m.visible = true;
      m.geometry = this._starGeos[(rand() * this._starGeos.length) | 0];
      if (p === 0) {
        // Card 0 faces down the bore: this is the flash you see when someone
        // is shooting toward you, and it fills the middle of the star.
        const a = pr * (0.55 + rand() * 0.40);
        m.rotation.set(0, 0, rand() * TWO_PI);
        m.scale.set(a, a * (0.82 + rand() * 0.36), 1);
        m.position.set(0, 0, -cfg.flashCoreLength * 0.55);
      } else {
        // The rest lie in planes containing the bore. -PI/2 about X puts the
        // card's +Y along -Z, i.e. pointing forward out of the barrel.
        //
        // Evenly spaced rolls with matching scales produce a symmetrical
        // 8-pointed star that reads as a lens flare. The heavy roll jitter and
        // the wide per-card scale spread are what make it look like burning
        // gas: one or two dominant lobes and a scatter of smaller ones.
        const a = pr * (0.45 + rand() * 0.85);
        const roll = rollBase + ((p - 1) / Math.max(1, n - 1)) * Math.PI
          + (rand() - 0.5) * 1.1;
        m.rotation.order = 'ZXY';
        m.rotation.set(-Math.PI / 2, (rand() - 0.5) * 0.7, roll);
        m.scale.set(a * (0.42 + rand() * 0.62), a * (0.75 + rand() * 0.5), 1);
        m.position.set(0, 0, -a * (0.28 + rand() * 0.3));
      }
    }
    f.pr = cfg.flashHdrPetal * (0.85 + rand() * 0.35);
    f.pg = f.pr;
    f.pb = f.pr;                      // hue lives in the vertex colours

    // ---- cone of burning gas ------------------------------------------------
    f.gasR = 0.05 * (0.8 + rand() * 0.5);
    f.gasL = 0.24 * (0.8 + rand() * 0.6);
    f.cone.scale.set(f.gasR, f.gasR, f.gasL);
    f.cone.rotation.z = rand() * TWO_PI;
    f.gr = cfg.flashHdrGas * (0.8 + rand() * 0.5);
    f.gg = f.gr;
    f.gb = f.gr;

    // Paint the peak immediately so frame 0 is never the dark end of the curve.
    const g = cfg.hdrGain * this._expComp;
    f.coreMat.color.setRGB(f.cr * g, f.cg * g, f.cb * g);
    f.petalMat.color.setRGB(f.pr * g, f.pg * g, f.pb * g);
    f.coneMat.color.setRGB(f.gr * g, f.gg * g, f.gb * g);

    // ---- the light that actually illuminates the weapon and nearby walls ----
    // Sits just ahead of the crown so the handguard is lit hard, the receiver
    // moderately and the stock barely — the front-to-back gradient is most of
    // what sells a flash. Flat, uniform illumination reads as a bug.
    this._muzzleLight.light.distance = cfg.muzzleLightDistance;
    this._fireLight(
      this._muzzleLight,
      this._pos.x + this._dir.x * 0.12,
      this._pos.y + this._dir.y * 0.12,
      this._pos.z + this._dir.z * 0.12,
      cfg.muzzleLightPeak * s,
      f.dur * 1.25,
      1.0, 0.70, 0.40,
      2.0,
    );

    // Particles live on the world layer, so their origin has to be remapped
    // into the world camera's projection to sit on the barrel (see _viewAlign).
    // NB: not `_v` — `_coneDir` writes its result there, which would move the
    // emitter under the loop that is reading it.
    const k = this._viewAlign(this._pos, this._pos2);
    this._muzzleParticles(this._pos2, this._dir, s * k);
  }

  /**
   * Remap a point that belongs to the viewmodel so that the WORLD camera
   * projects it where the VIEWMODEL camera projects the original.
   *
   * The weapon is drawn by a 55-degree camera; the world (and therefore every
   * particle, tracer and shell) by a camera at 60 degrees hip / 38 ADS. A
   * muzzle-anchored effect authored at the true muzzle position therefore
   * drifts off the barrel — subtly at the hip, by a third of its offset when
   * aiming. Scaling the point's camera-space X and Y by the ratio of the two
   * half-FOV tangents puts it back on the crown at any FOV.
   *
   * @returns {number} the same ratio, to scale effect sizes by.
   */
  _viewAlign(point, out) {
    const cam = this.ctx?.camera;
    const vcam = this.ctx?.viewCamera;
    out.copy(point);
    if (!cam?.isPerspectiveCamera || !vcam?.isPerspectiveCamera) return 1;
    const a = Math.tan(cam.fov * DEG2RAD * 0.5);
    const b = Math.tan(vcam.fov * DEG2RAD * 0.5);
    if (!(b > 1e-5)) return 1;
    const k = a / b;
    if (Math.abs(k - 1) < 1e-3) return k;
    cam.updateMatrixWorld();
    cam.worldToLocal(out);       // uses a shared scratch matrix, no allocation
    out.x *= k;
    out.y *= k;
    cam.localToWorld(out);
    return k;
  }

  _muzzleParticles(origin, dir, s) {
    const ps = this.particles;
    const rand = this.rand;
    const gain = this.config.hdrGain * this._expComp;
    const tint = this._tint;

    // A small camera-facing glow so the flash still reads when the barrel is
    // pointed near the view axis and the star cards are edge-on. This used to
    // be a 0.42 m STAR sprite at HDR 26 sitting 5 cm from the lens, which is
    // the screen-filling bloom the geometry was supposed to replace.
    {
      const d = ps.begin();
      d.x = origin.x + dir.x * 0.045;
      d.y = origin.y + dir.y * 0.045;
      d.z = origin.z + dir.z * 0.045;
      d.sprite = SPRITE.FLASH;
      d.size = 0.11 * s * (0.8 + rand() * 0.45);
      d.sizeEnd = d.size * 1.25;
      d.rot = rand() * TWO_PI;
      d.r = 7.0 * gain; d.g = 4.4 * gain; d.b = 2.0 * gain;
      d.r2 = 1.2 * gain; d.g2 = 0.5 * gain; d.b2 = 0.12 * gain;
      d.a = 1; d.a2 = 0;
      d.life = 0.042 + rand() * 0.022;
      d.fadeIn = 0.001;
      ps.emit(MODE_ADD);
    }

    // Burning powder thrown forward.
    //
    // These are what the review called "a handful of 1 px orange rays that read
    // as scratches", and it was right: a 0.32 m velocity-aligned stretch 0.9 m
    // from the lens draws a 280 px straight line, and fifteen of those radiating
    // from a point look like a scratched lens, not like burning propellant. They
    // are now short, fat, fast-fading grains — a sizzle around the flash rather
    // than the loudest thing in the frame.
    const sparks = 8 + ((rand() * 5) | 0);
    for (let i = 0; i < sparks; i++) {
      const sd = this._coneDir(dir, 0.80, this._v);
      const sp = 2.6 + rand() * 7;
      const d = ps.begin();
      d.x = origin.x + dir.x * 0.04;
      d.y = origin.y + dir.y * 0.04;
      d.z = origin.z + dir.z * 0.04;
      d.vx = sd.x * sp; d.vy = sd.y * sp; d.vz = sd.z * sp;
      d.sprite = SPRITE.SPARK;
      d.size = 0.009 + rand() * 0.008;
      d.sizeEnd = d.size * 0.35;
      d.stretch = 0.022 + rand() * 0.055;
      d.r = 4.6 * gain; d.g = 1.75 * gain; d.b = 0.32 * gain;
      d.r2 = 0.8 * gain; d.g2 = 0.11 * gain; d.b2 = 0.01 * gain;
      d.a = 1; d.a2 = 0;
      d.life = 0.045 + rand() * 0.10;
      d.grav = 0.9;
      d.drag = 4.2;
      d.fadeIn = 0.001;
      ps.emit(MODE_ADD);
    }

    // Muzzle smoke. Every shot leaves a wisp; it accumulates visibly across a
    // burst, which is the cue the review was missing entirely.
    for (let i = 0; i < 4; i++) {
      const sd = this._coneDir(dir, 0.82, this._v);
      const sp = 1.0 + rand() * 2.2;
      const d = ps.begin();
      d.x = origin.x + dir.x * (0.06 + rand() * 0.10);
      d.y = origin.y + dir.y * 0.06;
      d.z = origin.z + dir.z * 0.06;
      d.vx = sd.x * sp; d.vy = sd.y * sp + 0.30; d.vz = sd.z * sp;
      d.sprite = i === 0 ? SPRITE.SMOKE_A : SPRITE.SMOKE_C;
      d.size = 0.045 * s;
      d.sizeEnd = (0.30 + rand() * 0.28) * s;
      d.curve = CURVE_FAST;
      d.r = 0.46 * tint.r; d.g = 0.452 * tint.g; d.b = 0.44 * tint.b;
      d.r2 = 0.28 * tint.r; d.g2 = 0.28 * tint.g; d.b2 = 0.285 * tint.b;
      d.a = 0.26 + rand() * 0.16; d.a2 = 0;
      d.life = 0.7 + rand() * 0.9;
      d.drag = 2.2;
      d.grav = -0.06;
      d.rot = rand() * TWO_PI;
      d.rotVel = (rand() - 0.5) * 1.5;
      d.turb = 0.45;
      d.fadeIn = 0.07;
      ps.emit(MODE_ALPHA);
    }
  }

  // ================================================================ brass ===

  /**
   * Eject a case. `velocity` should be world-space; if omitted a plausible
   * right-and-up toss is used.
   */
  shellEject(position, velocity, kind) {
    if (!position) return;
    const s = this._shells[this._shellCursor];
    this._shellCursor = (this._shellCursor + 1) % this._shells.length;
    const rand = this.rand;

    s.active = true;
    s.resting = false;
    s.t = 0;
    s.life = this.config.shellLife * (0.85 + rand() * 0.3);
    s.bounces = 0;
    s.mesh.visible = true;
    s.mat.opacity = 1;
    // The ejection port belongs to the viewmodel; the case is a world-camera
    // object, so its spawn point has to be remapped or the brass appears to
    // leave the gun from a hand's width off the receiver.
    this._viewAlign(position, this._t1);
    s.mesh.position.copy(this._t1);

    const speed = kind === 'pistol' ? 2.6 : (kind === 'smg' ? 3.0 : 3.4);
    if (velocity && typeof velocity.x === 'number') {
      s.vel.set(velocity.x, velocity.y, velocity.z);
    } else {
      s.vel.set(
        (0.6 + rand() * 0.6) * speed,
        (0.55 + rand() * 0.5) * speed * 0.55,
        (rand() - 0.5) * speed * 0.35,
      );
    }
    // always add a little scatter so two ejections never match
    s.vel.x += (rand() - 0.5) * 0.7;
    s.vel.y += (rand() - 0.5) * 0.5;
    s.vel.z += (rand() - 0.5) * 0.7;

    s.spinAxis.set(rand() - 0.5, rand() - 0.5, rand() - 0.5);
    if (s.spinAxis.lengthSq() < 1e-6) s.spinAxis.set(1, 0, 0);
    s.spinAxis.normalize();
    s.spin = 16 + rand() * 26;

    s.mesh.quaternion.set(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    s.groundY = this._floorY(position);

    // a wisp of hot smoke off the case mouth
    const d = this.particles.begin();
    d.x = position.x; d.y = position.y; d.z = position.z;
    d.vx = s.vel.x * 0.2; d.vy = s.vel.y * 0.2 + 0.3; d.vz = s.vel.z * 0.2;
    d.sprite = SPRITE.SMOKE_C;
    d.size = 0.012;
    d.sizeEnd = 0.10;
    d.curve = CURVE_FAST;
    d.r = 0.36 * this._tint.r; d.g = 0.355 * this._tint.g; d.b = 0.35 * this._tint.b;
    d.r2 = 0.24; d.g2 = 0.24; d.b2 = 0.24;
    d.a = 0.16; d.a2 = 0;
    d.life = 0.45 + rand() * 0.4;
    d.drag = 2.2;
    d.grav = -0.05;
    d.rotVel = (rand() - 0.5) * 2;
    d.turb = 0.3;
    d.fadeIn = 0.08;
    this.particles.emit(MODE_ALPHA);
  }

  // ============================================================ explosion ===

  /** Fireball + shockwave + debris + rising smoke column + a brief bright light. */
  explosion(point, radius = 3) {
    if (!point) return;
    const ps = this.particles;
    const rand = this.rand;
    const gain = this.config.hdrGain;
    const tint = this._tint;
    const R = radius;
    const floorY = this._floorY(point);

    const e = this._explosions[this._explosionCursor];
    this._explosionCursor = (this._explosionCursor + 1) % this._explosions.length;
    e.active = true;
    e.t = 0;
    e.dur = 0.62 + R * 0.05;
    e.radius = R;
    e.fire.position.copy(point);
    e.fire.rotation.set(rand() * TWO_PI, rand() * TWO_PI, rand() * TWO_PI);
    e.fire.visible = true;
    e.ring.position.set(point.x, Math.max(floorY + 0.05, point.y - R * 0.45), point.z);
    e.ring.visible = true;

    this._burstLight.light.distance = Math.max(this.config.burstLightDistance, R * 6);
    this._fireLight(
      this._burstLight,
      point.x, point.y, point.z,
      this.config.explosionLightPeak * (R / 3),
      0.42,
      1.0, 0.62, 0.28,
      1.7,
    );

    // ---- fireball particles ----
    for (let i = 0; i < 40; i++) {
      this._coneDir(this._up, -1, this._dir);
      const sp = (1.5 + rand() * 7) * (R / 3);
      const d = ps.begin();
      d.x = point.x + this._dir.x * R * 0.2;
      d.y = point.y + this._dir.y * R * 0.2;
      d.z = point.z + this._dir.z * R * 0.2;
      d.vx = this._dir.x * sp;
      d.vy = this._dir.y * sp + 1.2;
      d.vz = this._dir.z * sp;
      d.sprite = SPRITE.FIRE;
      d.size = 0.25 * R * (0.4 + rand() * 0.6);
      d.sizeEnd = d.size * (2.0 + rand());
      d.curve = CURVE_FAST;
      d.r = 22 * gain; d.g = 8 * gain; d.b = 2.0 * gain;
      d.r2 = 1.4 * gain; d.g2 = 0.2 * gain; d.b2 = 0.03 * gain;
      d.a = 1; d.a2 = 0;
      d.life = 0.28 + rand() * 0.55;
      d.drag = 2.2;
      d.grav = -0.25;
      d.rot = rand() * TWO_PI;
      d.rotVel = (rand() - 0.5) * 3;
      d.turb = 1.2;
      d.fadeIn = 0.004;
      ps.emit(MODE_ADD);
    }

    // ---- sparks ----
    for (let i = 0; i < 46; i++) {
      this._coneDir(this._up, -1, this._dir);
      const rr = rand();
      const sp = (3 + rr * rr * 22) * (R / 3);
      const d = ps.begin();
      d.x = point.x; d.y = point.y; d.z = point.z;
      d.vx = this._dir.x * sp; d.vy = this._dir.y * sp + 2; d.vz = this._dir.z * sp;
      d.sprite = SPRITE.SPARK;
      d.size = 0.008 + rand() * 0.010;
      d.sizeEnd = d.size * 0.4;
      d.stretch = 0.2 + rand() * 0.7;
      d.r = 11 * gain; d.g = 4.2 * gain; d.b = 0.7 * gain;
      d.r2 = 1.6 * gain; d.g2 = 0.2 * gain; d.b2 = 0.01 * gain;
      d.a = 1; d.a2 = 0;
      d.life = 0.5 + rand() * 1.6;
      d.grav = 1.0;
      d.drag = 0.4;
      d.bounce = 0.4;
      d.groundY = floorY;
      d.fadeIn = 0.002;
      ps.emit(MODE_ADD);
    }

    // ---- debris burst ----
    for (let i = 0; i < 34; i++) {
      this._coneDir(this._up, -0.4, this._dir);
      const sp = (3 + rand() * 12) * (R / 3);
      const d = ps.begin();
      d.x = point.x; d.y = point.y; d.z = point.z;
      d.vx = this._dir.x * sp; d.vy = this._dir.y * sp + 3; d.vz = this._dir.z * sp;
      d.sprite = rand() < 0.5 ? SPRITE.CHIP_A : SPRITE.CHIP_B;
      d.size = 0.012 + rand() * 0.05;
      d.sizeEnd = d.size;
      d.r = 0.22 * tint.r; d.g = 0.20 * tint.g; d.b = 0.18 * tint.b;
      d.r2 = d.r; d.g2 = d.g; d.b2 = d.b;
      d.a = 1; d.a2 = 1;
      d.life = 1.2 + rand() * 1.8;
      d.grav = 1.0;
      d.drag = 0.2;
      d.rot = rand() * TWO_PI;
      d.rotVel = (rand() - 0.5) * 22;
      d.bounce = 0.3;
      d.groundY = floorY;
      d.fadeIn = 0.002;
      ps.emit(MODE_ALPHA);
    }

    // ---- ground-hugging dust ring ----
    for (let i = 0; i < 26; i++) {
      const a = rand() * TWO_PI;
      const sp = (2.5 + rand() * 6) * (R / 3);
      const d = ps.begin();
      d.x = point.x; d.y = Math.max(floorY + 0.1, point.y - R * 0.4); d.z = point.z;
      d.vx = Math.cos(a) * sp; d.vy = 0.4 + rand() * 0.8; d.vz = Math.sin(a) * sp;
      d.sprite = rand() < 0.5 ? SPRITE.DUST : SPRITE.SMOKE_B;
      d.size = 0.2 * R * 0.4;
      d.sizeEnd = (1.1 + rand() * 1.2) * R * 0.5;
      d.curve = CURVE_FAST;
      d.r = 0.40 * tint.r; d.g = 0.375 * tint.g; d.b = 0.34 * tint.b;
      d.r2 = 0.22 * tint.r; d.g2 = 0.21 * tint.g; d.b2 = 0.19 * tint.b;
      d.a = 0.45 + rand() * 0.2; d.a2 = 0;
      d.life = 1.6 + rand() * 2.2;
      d.drag = 1.4;
      d.grav = 0.02;
      d.rot = rand() * TWO_PI;
      d.rotVel = (rand() - 0.5) * 1.1;
      d.turb = 0.5;
      d.fadeIn = 0.1;
      ps.emit(MODE_ALPHA);
    }

    // ---- rising smoke column ----
    for (let i = 0; i < 20; i++) {
      const a = rand() * TWO_PI;
      const rad = rand() * R * 0.4;
      const d = ps.begin();
      d.x = point.x + Math.cos(a) * rad;
      d.y = point.y + rand() * R * 0.3;
      d.z = point.z + Math.sin(a) * rad;
      d.vx = Math.cos(a) * 0.5;
      d.vy = 1.4 + rand() * 2.2;
      d.vz = Math.sin(a) * 0.5;
      d.sprite = rand() < 0.5 ? SPRITE.SMOKE_A : SPRITE.SMOKE_B;
      d.size = 0.25 * R;
      d.sizeEnd = (1.4 + rand() * 1.4) * R * 0.7;
      d.curve = CURVE_FAST;
      d.r = 0.115 * tint.r; d.g = 0.110 * tint.g; d.b = 0.105 * tint.b;
      d.r2 = 0.20 * tint.r; d.g2 = 0.20 * tint.g; d.b2 = 0.20 * tint.b;
      d.a = 0.55 + rand() * 0.25; d.a2 = 0;
      d.life = 3.0 + rand() * 3.0;
      d.drag = 0.75;
      d.grav = -0.06;
      d.rot = rand() * TWO_PI;
      d.rotVel = (rand() - 0.5) * 0.7;
      d.turb = 0.55;
      d.fadeIn = 0.13;
      ps.emit(MODE_ALPHA);
    }

    // ---- scorch mark on the ground ----
    this._v.set(point.x, floorY, point.z);
    this.decals.spawn(this._v, this._up, 'scorch', Math.min(4, R * 1.1), {
      life: 90, fadeOut: 12, allowFallback: false,
    });
  }

  // ================================================================ smoke ===

  /** Free-standing smoke puff, e.g. for smoke grenades or ambient venting. */
  smoke(point, amount = 8) {
    if (!point) return;
    const ps = this.particles;
    const rand = this.rand;
    const tint = this._tint;
    const n = amount | 0;
    for (let i = 0; i < n; i++) {
      this._coneDir(this._up, 0.1, this._dir);
      const sp = 0.4 + rand() * 1.2;
      const d = ps.begin();
      d.x = point.x + (rand() - 0.5) * 0.2;
      d.y = point.y + (rand() - 0.5) * 0.2;
      d.z = point.z + (rand() - 0.5) * 0.2;
      d.vx = this._dir.x * sp;
      d.vy = this._dir.y * sp + 0.5;
      d.vz = this._dir.z * sp;
      d.sprite = i % 3 === 0 ? SPRITE.SMOKE_C : (i % 3 === 1 ? SPRITE.SMOKE_A : SPRITE.SMOKE_B);
      d.size = 0.12 + rand() * 0.12;
      d.sizeEnd = 0.9 + rand() * 1.1;
      d.curve = CURVE_FAST;
      d.r = 0.30 * tint.r; d.g = 0.30 * tint.g; d.b = 0.30 * tint.b;
      d.r2 = 0.22 * tint.r; d.g2 = 0.22 * tint.g; d.b2 = 0.225 * tint.b;
      d.a = 0.34 + rand() * 0.2; d.a2 = 0;
      d.life = 2.2 + rand() * 2.6;
      d.drag = 0.85;
      d.grav = -0.05;
      d.rot = rand() * TWO_PI;
      d.rotVel = (rand() - 0.5) * 0.6;
      d.turb = 0.45;
      d.fadeIn = 0.18;
      ps.emit(MODE_ALPHA);
    }
  }

  // ================================================================= misc ===

  /** Global FX intensity: scales particle alpha and every emissive HDR value. */
  setIntensity(alphaScale, hdrGain = alphaScale) {
    this.config.intensity = alphaScale;
    this.config.hdrGain = hdrGain;
    this.particles.setIntensity(alphaScale);
  }

  clear() {
    this.particles.clear();
    this.decals.clear();
    for (let i = 0; i < this._shells.length; i++) {
      this._shells[i].active = false;
      this._shells[i].mesh.visible = false;
    }
    for (let i = 0; i < this._flashes.length; i++) {
      const f = this._flashes[i];
      f.active = false;
      f.group.visible = false;
      for (let p = 0; p < f.petals.length; p++) f.petals[p].visible = false;
    }
    for (let i = 0; i < this._explosions.length; i++) {
      const e = this._explosions[i];
      e.active = false; e.fire.visible = false; e.ring.visible = false;
    }
    for (let i = 0; i < this._lights.length; i++) {
      this._lights[i].t = 0;
      this._lights[i].light.intensity = 0;
    }
  }

  dispose() {
    this.particles.dispose();
    this.decals.dispose();
    for (let i = 0; i < this._starGeos.length; i++) this._starGeos[i].dispose();
    this._coneGeo.dispose();
    this._coreGeo.dispose();
    this._shellGeo.dispose();
    this._fireGeo.dispose();
    this._ringGeo.dispose();
    for (let i = 0; i < this._flashes.length; i++) {
      const f = this._flashes[i];
      f.coreMat.dispose(); f.petalMat.dispose(); f.coneMat.dispose();
    }
    for (let i = 0; i < this._shells.length; i++) this._shells[i].mat.dispose();
    for (let i = 0; i < this._explosions.length; i++) {
      this._explosions[i].fireMat.dispose();
      this._explosions[i].ringMat.dispose();
    }
    this.root.parent?.remove(this.root);
  }
}

export default FXSystem;
