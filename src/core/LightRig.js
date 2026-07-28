import * as THREE from 'three';

/*
 * Forward-rendering light manager.
 *
 * Three's forward renderer evaluates EVERY light for every fragment, and the
 * light count is baked into the shader permutation. A level with 37 point
 * lights therefore costs 37 light evaluations per pixel and recompiles every
 * material whenever a light is toggled — measured at ~4 fps here.
 *
 * The fix is the standard one: keep a small, FIXED pool of real lights (so the
 * shader permutation never changes) and retarget them each frame to whichever
 * "virtual" lights currently matter most to the camera. Level authors add as
 * many virtual lights as they like; the renderer only ever sees `slots`.
 */

const _v = new THREE.Vector3();

export class LightRig {
  /**
   * @param {THREE.Scene} scene
   * @param {{slots?: number, updateHz?: number, fadeTime?: number}} o
   */
  constructor(scene, o = {}) {
    this.scene = scene;
    this.slotCount = o.slots ?? 8;
    this.updateInterval = 1 / (o.updateHz ?? 12);
    this.fadeTime = o.fadeTime ?? 0.22;
    this.maxRange = o.maxRange ?? 90;

    /** @type {Array<{position:THREE.Vector3,color:THREE.Color,intensity:number,distance:number,decay:number,score:number}>} */
    this.virtual = [];
    this.slots = [];
    this._acc = 0;
    this._scratchOrder = [];

    for (let i = 0; i < this.slotCount; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.castShadow = false;          // shadow-casting point lights are a cubemap each
      light.visible = true;              // never toggled: toggling changes the permutation
      light.layers.enable(1);            // must also light the viewmodel layer
      scene.add(light);
      this.slots.push({ light, target: -1, fade: 0, targetIntensity: 0 });
    }
  }

  /**
   * Take over every PointLight currently in the scene: record it as virtual and
   * remove the real one. Call after the level (and its lights) are built.
   */
  adopt(root) {
    const found = [];
    root.traverse((o) => {
      if (o.isPointLight && !this.slots.some((s) => s.light === o)) found.push(o);
    });
    for (const l of found) {
      l.getWorldPosition(_v);
      this.addVirtual({
        position: _v.clone(),
        color: l.color.clone(),
        intensity: l.intensity,
        distance: l.distance || 12,
        decay: l.decay ?? 2,
      });
      l.parent?.remove(l);
      l.dispose?.();
    }
    return found.length;
  }

  addVirtual(spec) {
    this.virtual.push({
      position: spec.position.clone(),
      color: (spec.color ?? new THREE.Color(1, 1, 1)).clone(),
      intensity: spec.intensity ?? 8,
      distance: spec.distance ?? 12,
      decay: spec.decay ?? 2,
      score: 0,
    });
    return this.virtual.length - 1;
  }

  /**
   * Rank virtual lights by how much they can actually contribute at the camera,
   * then bind the best `slotCount` to real lights, cross-fading on a swap so a
   * light never pops in or out at full brightness.
   */
  update(dt, camera) {
    // Fades run every frame; re-ranking is throttled.
    for (const s of this.slots) {
      const rate = dt / this.fadeTime;
      s.fade += (s.targetIntensity > 0 ? rate : -rate);
      s.fade = Math.min(1, Math.max(0, s.fade));
      s.light.intensity = s.targetIntensity * s.fade * s.fade;
    }

    this._acc -= dt;
    if (this._acc > 0) return;
    this._acc = this.updateInterval;

    const cam = camera.position;
    const order = this._scratchOrder;
    order.length = 0;

    for (let i = 0; i < this.virtual.length; i++) {
      const v = this.virtual[i];
      const d = v.position.distanceTo(cam);
      if (d > this.maxRange) { v.score = 0; continue; }
      // Approximate the light's reach: it stops mattering well before `distance`.
      const reach = v.distance + 4;
      const falloff = Math.max(0, 1 - d / reach);
      v.score = v.intensity * falloff * falloff;
      if (v.score > 0.01) order.push(i);
    }
    order.sort((a, b) => this.virtual[b].score - this.virtual[a].score);

    const wanted = order.slice(0, this.slotCount);

    // Keep already-bound lights in their existing slot so we don't churn.
    const bound = new Set();
    for (const s of this.slots) {
      if (s.target >= 0 && wanted.includes(s.target)) bound.add(s.target);
      else s.target = -1;
    }
    let next = 0;
    for (const s of this.slots) {
      if (s.target >= 0) continue;
      while (next < wanted.length && bound.has(wanted[next])) next++;
      if (next >= wanted.length) { s.targetIntensity = 0; continue; }
      // Only rebind once the outgoing light has faded out.
      if (s.fade > 0.02 && s.targetIntensity > 0) { s.targetIntensity = 0; continue; }
      const id = wanted[next++];
      bound.add(id);
      s.target = id;
      s.fade = 0;
    }
    for (const s of this.slots) {
      if (s.target < 0) { s.targetIntensity = 0; continue; }
      const v = this.virtual[s.target];
      s.light.position.copy(v.position);
      s.light.color.copy(v.color);
      s.light.distance = v.distance;
      s.light.decay = v.decay;
      s.targetIntensity = v.intensity;
    }
  }

  get activeCount() {
    return this.slots.filter((s) => s.light.intensity > 0.01).length;
  }

  dispose() {
    for (const s of this.slots) { s.light.parent?.remove(s.light); s.light.dispose?.(); }
    this.slots.length = 0;
    this.virtual.length = 0;
  }
}
