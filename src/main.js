import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

import { Renderer } from './core/Renderer.js';
import { PostFX } from './core/PostFX.js';
import { Input } from './core/Input.js';
import { Level } from './world/Level.js';
import { Player } from './player/Player.js';
import { WeaponSystem } from './weapons/Weapon.js';
import { GrenadeSystem } from './weapons/Grenade.js';
import { GameMode } from './game/GameMode.js';
import { generateTextureSet } from './gfx/textures.js';
import { upgradeSceneMaterials, desaturateWorld } from './gfx/specularAA.js';
import { LightRig } from './core/LightRig.js';

// Accelerated raycasting for every geometry that has a BVH built.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Viewmodel field of view, independent of the world FOV.
const VIEWMODEL_FOV = 55;

const bar = document.getElementById('bar');
const lmsg = document.getElementById('lmsg');
const loading = document.getElementById('loading');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');

let progress = 0;
const step = async (msg, frac) => {
  progress = frac;
  if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
  if (lmsg) lmsg.textContent = msg;
  // Yield so the loading UI actually paints between heavy synchronous stages.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
};

/**
 * Optional modules are loaded dynamically so a missing or broken subsystem
 * degrades to a stub instead of taking the whole game down.
 */
async function tryImport(path, label) {
  try {
    return await import(/* @vite-ignore */ path);
  } catch (e) {
    console.warn(`[boot] optional module "${label}" unavailable:`, e.message);
    return null;
  }
}

async function boot() {
  await step('Creating context', 0.02);

  const container = document.getElementById('app');
  const renderer = new Renderer(container);
  const scene = new THREE.Scene();
  // Far plane must clear the 350 m backdrop ring with margin, or the outer
  // buildings clip in and out as the camera turns.
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.02, 700);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  const input = new Input(renderer.domElement);
  const postfx = new PostFX(renderer.renderer, scene, camera);
  renderer.onResize = (w, h) => {
    postfx.setSize(w, h);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    if (ctx.viewCamera) {
      ctx.viewCamera.aspect = camera.aspect;
      ctx.viewCamera.updateProjectionMatrix();
    }
  };
  postfx.setSize(renderer.bufferWidth, renderer.bufferHeight);

  let seed = 0x1234;
  const rng = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  const ctx = {
    time: 0, dt: 0, frame: 0,
    scene, camera, renderer: renderer.renderer, rendererWrapper: renderer,
    postfx, input, rng,
    player: null, world: null, weapons: null,
    audio: null, fx: null, hud: null, ai: null, sky: null,
    mat: null,
  };

  // ---------------------------------------------------------- materials ---
  await step('Generating materials', 0.08);
  const matsMod = await tryImport('./gfx/materials.js', 'materials');
  const extraMod = await tryImport('./gfx/surfaces_extra.js', 'surfaces_extra');
  extraMod?.registerAll?.();

  // Texture generation is synchronous and dominates boot: at 512 px the full
  // catalogue costs ~22 s, and cost scales with area. 320 px keeps roughly
  // 160 px/m of texel density on a 2 m tile while cutting generation to ~40%.
  // Set before any material is built, or the cache keeps the old size.
  matsMod?.setMaterialDefaults?.({ size: 320 });

  const fallbackCache = new Map();
  const FALLBACK_KIND = {
    asphalt_road: 'asphalt', road_marking: 'concrete', gravel: 'gravel',
    concrete_wall: 'concrete', concrete_floor: 'concrete', concrete_stained: 'concrete',
    rebar_concrete: 'concrete', brick_red: 'brick', brick_painted: 'brick',
    plaster_white: 'plaster', plaster_damaged: 'plaster',
    metal_panel: 'metal', metal_rusted: 'metal', metal_grate: 'metal',
    sheet_metal_bare: 'metal', corrugated_roof: 'metal', chainlink: 'metal',
    painted_steel_blue: 'painted', painted_steel_yellow: 'painted', warning_stripe: 'painted',
    wood_plank: 'wood', wood_crate: 'wood', tile_floor: 'tile',
    sandbag: 'sandbag', rubber: 'polymer', tarp: 'camo',
    glass_dirty: 'tile', glass_broken: 'tile',
  };
  function fallbackMaterial(name) {
    if (fallbackCache.has(name)) return fallbackCache.get(name);
    const kind = FALLBACK_KIND[name] ?? 'concrete';
    const set = generateTextureSet(kind, { size: 256, seed: hash(name), repeat: [1, 1] });
    const m = new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap,
      metalnessMap: set.metalnessMap, aoMap: set.aoMap,
      roughness: 1, metalness: 1, envMapIntensity: 1,
    });
    m.name = name;
    fallbackCache.set(name, m);
    return m;
  }
  // Metres per texture repeat, from the material catalogue when available.
  // Level geometry bakes this into its UVs so texel density is uniform.
  ctx.materialTile = (name) => {
    if (EXTRA_MATERIALS[name]) return 2.0;   // untextured; UV scale is irrelevant
    if (matsMod?.materialTile) {
      try { return matsMod.materialTile(name); } catch {}
    }
    return 2.0;
  };
  /*
   * Materials the level authors against that are not in the procedural
   * catalogue: soot and dirt overlays, and emissive lamp glows. Without these
   * they fell through to the concrete fallback, which is why scorch marks,
   * contact dirt and every light fixture were rendering as pale grey — the
   * lamps in particular were opaque concrete discs wrapped in bloom.
   */
  const EXTRA_MATERIALS = {
    dirt_dark: () => new THREE.MeshStandardMaterial({
      color: 0x2b2620, roughness: 0.96, metalness: 0.0,
      transparent: true, opacity: 0.82, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    dust: () => new THREE.MeshStandardMaterial({
      color: 0x9c9184, roughness: 0.98, metalness: 0.0,
      transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    paint_green: () => new THREE.MeshStandardMaterial({
      color: 0x3d4a35, roughness: 0.62, metalness: 0.35,
    }),
    paint_red: () => new THREE.MeshStandardMaterial({
      color: 0x6b2a22, roughness: 0.60, metalness: 0.35,
    }),
    // Lamp glows are the visible source inside a fixture. They must sit above
    // the bloom threshold (1.15) to actually glow, but not so far above that
    // they smear into a shapeless blob.
    lamp_glow: () => new THREE.MeshStandardMaterial({
      color: 0x120e08, roughness: 1, metalness: 0,
      emissive: 0xffd9a0, emissiveIntensity: 4.2,
    }),
    lamp_glow_cool: () => new THREE.MeshStandardMaterial({
      color: 0x0b0e12, roughness: 1, metalness: 0,
      emissive: 0xcfe2ff, emissiveIntensity: 3.6,
    }),
    lamp_glow_dim: () => new THREE.MeshStandardMaterial({
      color: 0x0f0c08, roughness: 1, metalness: 0,
      emissive: 0xffc98a, emissiveIntensity: 1.6,
    }),
  };
  const extraCache = new Map();

  ctx.mat = (name, opts) => {
    if (EXTRA_MATERIALS[name]) {
      if (!extraCache.has(name)) {
        const m = EXTRA_MATERIALS[name]();
        m.name = name;
        extraCache.set(name, m);
      }
      return extraCache.get(name);
    }
    if (matsMod?.getMaterial) {
      try { return matsMod.getMaterial(name, opts); }
      catch (e) { console.warn(`[mat] "${name}" failed, using fallback:`, e.message); }
    }
    return fallbackMaterial(name);
  };

  if (matsMod?.preloadMaterialsAsync && matsMod?.listMaterials) {
    const names = matsMod.listMaterials();
    await matsMod.preloadMaterialsAsync(names, (done, total, name) => {
      const frac = 0.08 + 0.30 * (done / Math.max(1, total));
      if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
      if (lmsg) lmsg.textContent = `Generating materials — ${name} (${done}/${total})`;
    });
  }

  // ---------------------------------------------------------------- sky ---
  await step('Building atmosphere', 0.42);
  const skyMod = await tryImport('./world/Sky.js', 'sky');
  if (skyMod?.Sky) {
    ctx.sky = new skyMod.Sky(renderer.renderer, scene);
  } else {
    ctx.sky = makeFallbackSky(scene);
  }
  if (ctx.sky.sunLight && !ctx.sky.sunLight.parent) scene.add(ctx.sky.sunLight);

  // Widen the shadow filter kernel. three's PCF radius is in texels, and the
  // default of 1 gives a single-tap staircase at every distance; ~5 texels over
  // a 4096 map spanning 104 m is about a 13 cm penumbra, which reads correctly
  // for a sun this low without smearing contact shadows.
  if (ctx.sky.sunLight?.shadow) ctx.sky.sunLight.shadow.radius = 5;

  // Put the low sun in the west so it rakes ACROSS the compound. With the
  // default azimuth the sun sat due north, directly behind the admin block,
  // which dropped the entire playable courtyard into one flat shadow.
  if (ctx.sky.params) {
    // Art direction only. The exposure/fill workaround that used to live here
    // has been deleted: Sky.js now derives its fill from a cosine-weighted
    // hemisphere plus ground bounce and measures better than the override did
    // (key:fill 5.46:1 vs 3.68:1, shadow blue/red 1.17 vs 1.21).
    // Sun angle chosen by measurement, not eye: scripts/sunsweep.mjs sweeps
    // azimuth and elevation and reports the fraction of each review pose that
    // is in shadow, by sun differencing. A composed daylight frame runs 40-60%
    // shadow; the previous angle measured ~40% and the scene read as a flatly
    // lit inventory of objects. This lands at 50% with the admin block and the
    // warehouse both throwing across the main play space.
    // 270 (due north) measured best on shadow fraction but puts the player
    // spawn fully backlit; 200 gives side-light — 48% shadow, readable form on
    // both the admin block and the warehouse, and a shadow mass in the
    // foreground. Compared side by side in shots/dbg/SUN_*.png.
    ctx.sky.params.sunAzimuthStart = 200.0;
    ctx.sky.params.sunAzimuthEnd = 200.0;
    ctx.sky.params.fogColorGroundScale = 0.16;
    ctx.sky.setTimeOfDay?.(0.905);   // ~21 deg elevation
  }

  // -------------------------------------------------------------- level ---
  await step('Constructing Sector 7', 0.5);
  const world = new Level(ctx);
  await world.build();
  scene.add(world.root);
  ctx.world = world;

  // A forward renderer evaluates every light per fragment and bakes the light
  // count into the shader. The level ships ~35 point lights, which measured at
  // ~4 fps. Fold them into a fixed 8-slot pool that retargets to whatever is
  // nearest the camera; the shader permutation then never changes.
  // Distance shadow culling. The shadow pass re-renders every caster, and the
  // sun's ortho frustum only spans ~104 m anyway, so geometry well outside it
  // is pure waste. Toggling castShadow is a render-list flag — no recompile.
  const shadowChunks = [];
  world.root.traverse((o) => {
    if (o.isMesh && o.castShadow && o.geometry?.boundingSphere) {
      shadowChunks.push({ mesh: o, center: o.geometry.boundingSphere.center.clone(),
                          radius: o.geometry.boundingSphere.radius });
    }
  });
  const SHADOW_CULL_DIST = 78;
  let shadowCullAcc = 0;
  function updateShadowCulling(dt) {
    shadowCullAcc -= dt;
    if (shadowCullAcc > 0) return;
    shadowCullAcc = 0.2;
    const p = camera.position;
    for (let i = 0; i < shadowChunks.length; i++) {
      const c = shadowChunks[i];
      const d = c.center.distanceTo(p) - c.radius;
      c.mesh.castShadow = d < SHADOW_CULL_DIST;
    }
  }
  console.info(`[shadows] ${shadowChunks.length} shadow-casting chunks under distance culling`);

  // Colour script: pull the environment's saturation down so the map reads as
  // one place rather than an asset-pack dump. Characters and the viewmodel are
  // deliberately excluded — they need to stay separated from the terrain.
  const cs = desaturateWorld(world.root);
  console.info(`[gfx] colour script: ${cs.count} materials`, cs.byPlan);

  /*
   * Interior lighting attenuation.
   *
   * The sky IBL is applied uniformly, so a player walking from the open
   * courtyard into a fully enclosed steel warehouse experienced no change in
   * light at all — an art review called this "the single strongest 'this is a
   * demo' signal in the build".
   *
   * A cheap, robust proxy: cast up from the eye. Under a roof, attenuate the
   * sky contribution and let the interior lamps (already managed by the light
   * rig) carry the room. Eased, so crossing a doorway reads as a transition
   * rather than a switch.
   */
  const INDOOR = {
    probe: new THREE.Raycaster(),
    up: new THREE.Vector3(0, 1, 0),
    factor: 0,
    target: 0,
    acc: 0,
    // Tuned against a capture, not guessed: 0.30/0.22 gave a genuinely
    // photographic result (dark shed, blown skylights) but the racking and
    // floor went unreadable, and a player has to fight in there.
    iblScale: 0.52,     // sky image-based light indoors, relative to outdoors
    hemiScale: 0.42,
    fogScale: 0.15,     // aerial haze should not fill an interior
    // Bases captured from whoever authored them; re-adopted if Sky rewrites.
    baseIbl: scene.environmentIntensity ?? 1,
    baseHemi: 1,
    appliedIbl: -1,
    appliedHemi: -1,
    baseFog: postfx.params.fogDensity,
    baseShaft: postfx.params.shaftStrength,
  };
  INDOOR.probe.firstHitOnly = true;
  for (const child of scene.children) {
    if (child.isHemisphereLight) INDOOR.baseHemi = child.intensity;
  }
  ctx.indoor = INDOOR;

  function updateIndoorLighting(dt) {
    INDOOR.acc -= dt;
    if (INDOOR.acc <= 0) {
      INDOOR.acc = 0.12;
      let roofed = 0;
      if (world.collider) {
        INDOOR.probe.set(camera.position, INDOOR.up);
        INDOOR.probe.far = 20;
        roofed = INDOOR.probe.intersectObject(world.collider, false).length ? 1 : 0;
      }
      INDOOR.target = roofed;
    }
    INDOOR.factor += (INDOOR.target - INDOOR.factor) * Math.min(1, dt * 2.4);
    const f = INDOOR.factor;

    /*
     * ASSIGN from a cached base — never `*=`.
     *
     * This originally multiplied the live values each frame, on the assumption
     * that Sky rewrote them every frame and would reset the base. It does not:
     * Sky writes them only in applyParams()/_deriveLighting()/_renderEnv(), and
     * _renderEnv() only fires when the sun moves past a threshold. With a fixed
     * time of day nothing ever restored them, so the multiply compounded on
     * every rendered frame — measured going 0.548 -> 2.4e-64 after one walk
     * through a doorway, and never recovering. That permanently deleted the sky
     * fill for the rest of the session, outdoors included.
     *
     * The base is re-adopted whenever Sky writes a value we didn't write, so the
     * two systems compose instead of fighting.
     */
    if (scene.environmentIntensity !== INDOOR.appliedIbl) {
      INDOOR.baseIbl = scene.environmentIntensity;
    }
    const ibl = INDOOR.baseIbl * THREE.MathUtils.lerp(1, INDOOR.iblScale, f);
    scene.environmentIntensity = ibl;
    INDOOR.appliedIbl = ibl;

    for (const child of scene.children) {
      if (!child.isHemisphereLight) continue;
      if (child.intensity !== INDOOR.appliedHemi) INDOOR.baseHemi = child.intensity;
      const hemi = INDOOR.baseHemi * THREE.MathUtils.lerp(1, INDOOR.hemiScale, f);
      child.intensity = hemi;
      INDOOR.appliedHemi = hemi;
    }

    // Scale from PostFX's own authored values rather than constants baked in
    // here, or any tuning done in PostFX.js is silently clobbered every frame.
    postfx.params.fogDensity = INDOOR.baseFog * THREE.MathUtils.lerp(1, INDOOR.fogScale, f);
    postfx.params.shaftStrength = INDOOR.baseShaft * (1 - f);
  }

  const lightRig = new LightRig(scene, { slots: 8, updateHz: 12 });
  const adopted = lightRig.adopt(scene);
  ctx.lightRig = lightRig;

  /*
   * Practical lights were authored against a scene lit uniformly by a bright
   * sky IBL, where they only ever needed to be a hint. Now that interiors
   * attenuate that IBL and auto-exposure lifts the room to compensate, a 17-26
   * candela fixture at 5 m contributes about 5% of what the eye has adapted to
   * — the fixtures glow but cast no pool, which a review correctly called out
   * as "decorative". Indoors the practicals ARE the light, so they have to
   * carry the room.
   *
   * Scaled here rather than in the level so one number governs the whole
   * relationship, and so it stays with the exposure model that created the
   * problem. Outdoors these are invisible either way at daylight exposure.
   */
  const PRACTICAL_BOOST = 4.2;
  for (const v of lightRig.virtual) {
    v.intensity *= PRACTICAL_BOOST;
    // Reach has to grow with intensity or the pool is clipped by the falloff
    // sphere long before it fades, which reads as a hard circle on the floor.
    v.distance *= 1.45;
  }
  console.info(`[lights] adopted ${adopted} practicals into ${lightRig.slotCount} slots`);

  // ------------------------------------------------------------- player ---
  await step('Deploying operator', 0.55);
  const player = new Player(ctx);
  player.spawn(world.spawnPoints[0], 0);   // yaw 0 faces -Z, into the compound
  ctx.player = player;

  // ------------------------------------------------------------ weapons ---
  await step('Loading weapons', 0.62);
  const modelsMod = await tryImport('./weapons/models.js', 'weapon models');
  const modelFactory = async (kind) => {
    if (modelsMod?.buildWeaponModel) {
      try { return modelsMod.buildWeaponModel(kind); }
      catch (e) { console.warn(`[weapons] "${kind}" failed, using placeholder:`, e.message); }
    }
    return placeholderWeapon(kind);
  };
  const weapons = new WeaponSystem(ctx, modelFactory);
  await weapons.init();

  // The weapon lives on layer 1 and is drawn by its own camera at a narrower
  // FOV. At an 80-degree world FOV a same-projection viewmodel fisheyes badly
  // and reads as oversized; every shipped FPS separates the two.
  const VIEWMODEL_LAYER = 1;
  const viewCamera = new THREE.PerspectiveCamera(
    VIEWMODEL_FOV, window.innerWidth / window.innerHeight, 0.01, 4
  );
  viewCamera.layers.set(VIEWMODEL_LAYER);
  camera.add(viewCamera);              // inherits the camera's world transform
  camera.layers.disable(VIEWMODEL_LAYER);
  weapons.root.traverse((o) => o.layers.set(VIEWMODEL_LAYER));
  weapons.viewmodelLayer = VIEWMODEL_LAYER;
  camera.add(weapons.root);
  postfx.viewmodelCamera = viewCamera;
  ctx.viewCamera = viewCamera;
  ctx.weapons = weapons;

  const grenades = new GrenadeSystem(ctx);
  scene.add(grenades.root);
  ctx.grenades = grenades;

  // Flashlight: a spot light rigged to the camera. Useful in the warehouse and
  // the admin block interior, both of which are genuinely dark.
  const flashlight = new THREE.SpotLight(0xf2f0e6, 0, 34, Math.PI / 7, 0.42, 1.6);
  flashlight.position.set(0.12, -0.06, 0);
  flashlight.target.position.set(0, 0, -1);
  flashlight.castShadow = false;
  flashlight.layers.enable(VIEWMODEL_LAYER);
  camera.add(flashlight);
  camera.add(flashlight.target);
  ctx.flashlight = flashlight;
  let flashlightOn = false;

  // Lights are gathered per-camera by layer, so they must opt in to the
  // viewmodel layer or the weapon renders black.
  scene.traverse((o) => { if (o.isLight) o.layers.enable(VIEWMODEL_LAYER); });

  // ----------------------------------------------------------------- fx ---
  await step('Priming effects', 0.74);
  const fxMod = await tryImport('./fx/FXSystem.js', 'fx');
  ctx.fx = fxMod?.FXSystem ? new fxMod.FXSystem(ctx) : stubFX();
  if (ctx.fx.root && !ctx.fx.root.parent) scene.add(ctx.fx.root);
  // FX HDR values were authored against a much weaker bloom (threshold 1.05,
  // strength 0.048). Bloom is now threshold 1.15 / strength 0.22, so the same
  // emissive intensities blow the muzzle flash across half the frame.
  ctx.fx.setIntensity?.(1.0, 0.42);

  // -------------------------------------------------------------- audio ---
  await step('Synthesising audio', 0.82);
  const audioMod = await tryImport('./audio/AudioEngine.js', 'audio');
  ctx.audio = audioMod?.AudioEngine ? new audioMod.AudioEngine() : stubAudio();
  ctx.audio.setListener?.(camera);

  // ---------------------------------------------------------------- hud ---
  await step('Initialising HUD', 0.9);
  const hudMod = await tryImport('./ui/HUD.js', 'hud');
  ctx.hud = hudMod?.HUD ? new hudMod.HUD(document.getElementById('hud'), ctx) : stubHUD();
  ctx.hud.setWeaponName?.(weapons.current.def.name);
  ctx.hud.setAmmo?.(weapons.ammoMag, weapons.ammoReserve);

  // ----------------------------------------------------------------- ai ---
  await step('Spawning contacts', 0.96);
  const aiMod = await tryImport('./ai/AIDirector.js', 'ai');
  ctx.ai = aiMod?.AIDirector ? new aiMod.AIDirector(ctx) : { enemies: [], update() {}, spawnWave() {} };
  if (ctx.ai.root && !ctx.ai.root.parent) scene.add(ctx.ai.root);

  // Procedural normal maps are very high frequency, which aliases the specular
  // lobe under minification (the crawling shimmer on corrugated steel and
  // gravel). Fold the per-pixel normal variance into roughness and max out
  // anisotropic filtering across everything that exists by now.
  const upgraded = upgradeSceneMaterials(scene, renderer.renderer, { strength: 0.55, clamp: 0.30 });
  console.info(`[gfx] specular AA on ${upgraded.patched} materials, anisotropy ${upgraded.maxAniso}x`);

  const mode = new GameMode(ctx);
  ctx.mode = mode;

  await step('Ready', 1.0);
  loading?.classList.add('done');
  setTimeout(() => loading?.remove(), 700);

  // ----------------------------------------------------------- the loop ---
  const FIXED = 1 / 120;
  let acc = 0;
  let last = performance.now() / 1000;
  let fpsAccum = 0, fpsFrames = 0;
  ctx.fps = 60;

  // ---- adaptive resolution -------------------------------------------------
  // Trade internal resolution to hold the frame budget. Moves in small steps
  // and only after a sustained trend, so it never oscillates visibly.
  const DRS = {
    enabled: true,
    target: 1 / 60,      // seconds per frame we are aiming for
    min: 0.62, max: 1.0,
    scale: 1.0,
    cooldown: 0,
    window: [], windowSize: 45,
  };
  ctx.drs = DRS;

  function updateAdaptiveResolution(dt) {
    if (!DRS.enabled) return;
    DRS.window.push(dt);
    if (DRS.window.length > DRS.windowSize) DRS.window.shift();
    DRS.cooldown -= dt;
    if (DRS.cooldown > 0 || DRS.window.length < DRS.windowSize) return;

    // Use the median, not the mean — a single GC spike shouldn't drop quality.
    const sorted = DRS.window.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    let next = DRS.scale;
    if (median > DRS.target * 1.22) next = DRS.scale - 0.06;
    else if (median < DRS.target * 0.86) next = DRS.scale + 0.04;
    next = Math.min(DRS.max, Math.max(DRS.min, next));

    if (Math.abs(next - DRS.scale) > 0.001) {
      DRS.scale = next;
      renderer.setRenderScale(next);
      DRS.cooldown = 0.9;
      DRS.window.length = 0;
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now() / 1000;
    let dt = now - last;
    last = now;
    // A long stall (tab switch, GC) must not teleport the simulation.
    if (dt > 0.25) dt = 0.25;
    ctx.time += dt;
    ctx.dt = dt;
    ctx.frame++;

    fpsAccum += dt; fpsFrames++;
    if (fpsAccum > 0.5) { ctx.fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0; }
    updateAdaptiveResolution(dt);

    // Fixed-step simulation keeps movement and springs framerate-independent.
    acc += dt;
    let steps = 0;
    while (acc >= FIXED && steps < 8) {
      acc -= FIXED; steps++;
      player.update(FIXED, ctx);
      weapons.update(FIXED, ctx);
      grenades.update(FIXED, ctx);
      ctx.ai?.update?.(FIXED, ctx);

      // Grenade throw and flashlight toggle.
      if (input.pressed('KeyG') && !player.dead) grenades.throwGrenade(1);
      if (input.pressed('KeyF')) {
        flashlightOn = !flashlightOn;
        ctx.audio?.play('weaponSwitch', { volume: 0.25 });
      }
      flashlight.intensity += ((flashlightOn ? 55 : 0) - flashlight.intensity)
        * Math.min(1, FIXED * 14);
    }

    lightRig.update(dt, camera);
    updateShadowCulling(dt);
    mode.update(dt, ctx);
    world.update(dt, ctx);
    ctx.sky?.update?.(dt, ctx);
    updateIndoorLighting(dt);   // must run after Sky writes the IBL intensity
    ctx.fx?.update?.(dt, ctx);
    ctx.audio?.update?.(dt, ctx);
    ctx.hud?.update?.(dt, ctx);

    // Feed the post stack the current lighting so fog and shafts match the sky.
    if (ctx.sky) {
      if (ctx.sky.sunDirection) postfx.sunDir.copy(ctx.sky.sunDirection);
      if (ctx.sky.sunColor) postfx.sunColor.copy(ctx.sky.sunColor);
      // The sky's raw fog colours are strongly blue-dominant (measured b/r 3.7),
      // which tints everything past ~40 m cyan. Pull them toward neutral while
      // keeping a cool bias, and hold them under 1.0 so distance doesn't blow out.
      if (ctx.sky.fogColor) neutralise(postfx.fogColor.copy(ctx.sky.fogColor), 0.45, 1.0);
      if (ctx.sky.fogColorGround) neutralise(postfx.fogColorGround.copy(ctx.sky.fogColorGround), 0.30, 0.9);
    }

    // Newly-added lights (muzzle flash, explosions) must reach the viewmodel
    // layer too; cheap to re-assert every 30 frames rather than hook creation.
    if ((ctx.frame & 31) === 0) {
      scene.traverse((o) => { if (o.isLight && !o.layers.test(viewCamera.layers)) o.layers.enable(1); });
    }

    renderer.renderer.info.reset();
    postfx.render(dt, ctx.time);
    ctx.updateStats?.(dt);
    input.endFrame();
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------- start ----
  const start = async () => {
    overlay?.classList.add('hidden');
    input.requestLock();
    try { await ctx.audio?.unlock?.(); } catch {}
    mode.start();
  };
  startBtn?.addEventListener('click', start);
  renderer.domElement.addEventListener('click', () => { if (!input.locked) start(); });
  input.on('lockchange', (locked) => {
    if (!locked) overlay?.classList.remove('hidden');
  });

  // ---- F3 stats overlay ----------------------------------------------------
  const stats = document.createElement('div');
  stats.style.cssText = 'position:fixed;top:8px;left:8px;z-index:60;font:11px/1.5 ui-monospace,'
    + 'Menlo,monospace;color:#9fe0a0;background:rgba(0,0,0,.55);padding:6px 9px;'
    + 'pointer-events:none;white-space:pre;display:none;border-left:2px solid #ff8a3d';
  document.body.appendChild(stats);
  let statsOn = false, statsT = 0;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3') { statsOn = !statsOn; stats.style.display = statsOn ? 'block' : 'none'; }
  });
  ctx.updateStats = (dt) => {
    if (!statsOn) return;
    statsT += dt;
    if (statsT < 0.25) return;
    statsT = 0;
    const i = renderer.renderer.info;
    stats.textContent =
      `fps    ${ctx.fps.toFixed(0)}\n` +
      `frame  ${(1000 / Math.max(1, ctx.fps)).toFixed(1)} ms\n` +
      `calls  ${i.render.calls}\n` +
      `tris   ${(i.render.triangles / 1000).toFixed(0)}k\n` +
      `res    ${(DRS.scale * 100).toFixed(0)}%  ${renderer.bufferWidth}x${renderer.bufferHeight}\n` +
      `geom   ${i.memory.geometries}  tex ${i.memory.textures}\n` +
      `enemy  ${ctx.ai?.enemies?.filter((e) => e.alive).length ?? 0}\n` +
      `lights ${ctx.lightRig?.activeCount ?? 0}/${ctx.lightRig?.virtual.length ?? 0}\n` +
      `nades  ${ctx.grenades?.count ?? 0}\n` +
      `wave   ${ctx.mode?.wave ?? 0}  kills ${ctx.mode?.kills ?? 0}  score ${ctx.mode?.score ?? 0}\n` +
      `pos    ${player.position.x.toFixed(1)} ${player.position.y.toFixed(1)} ${player.position.z.toFixed(1)}`;
  };

  // Expose for debugging / the visual-review tooling.
  window.__game = ctx;
  window.__postfx = postfx;
}

// ------------------------------------------------------------- fallbacks ---

/** Pull a colour toward its own luminance, then clamp its peak channel. */
function neutralise(c, keepSaturation, maxChannel) {
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  c.setRGB(
    THREE.MathUtils.lerp(lum, c.r, keepSaturation),
    THREE.MathUtils.lerp(lum, c.g, keepSaturation),
    THREE.MathUtils.lerp(lum, c.b, keepSaturation)
  );
  const peak = Math.max(c.r, c.g, c.b);
  if (peak > maxChannel) c.multiplyScalar(maxChannel / peak);
  return c;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function makeFallbackSky(scene) {
  const sun = new THREE.DirectionalLight(0xffe0b8, 3.2);
  sun.position.set(-60, 40, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = -60; c.right = 60; c.top = 60; c.bottom = -60; c.near = 0.5; c.far = 220;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0x8fb4de, 0x3a3630, 0.85);
  scene.add(hemi);
  scene.background = new THREE.Color(0x6d86a4);
  return {
    sunLight: sun,
    sunDirection: new THREE.Vector3(60, -40, -30).normalize(),
    sunColor: new THREE.Color(1.0, 0.86, 0.68),
    fogColor: new THREE.Color(0.44, 0.55, 0.70),
    fogColorGround: new THREE.Color(0.32, 0.33, 0.34),
    update() {},
  };
}

function placeholderWeapon(kind) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.55, metalness: 0.85 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.42), mat);
  body.position.set(0, 0, -0.12);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.36, 10), mat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.46);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.06), mat);
  grip.position.set(0, -0.09, 0.02);
  grip.rotation.x = -0.22;
  group.add(body, barrel, grip);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.012, -0.64); group.add(muzzle);
  const ejectPort = new THREE.Object3D(); ejectPort.position.set(0.035, 0.02, -0.05); group.add(ejectPort);
  const sight = new THREE.Object3D(); sight.position.set(0, 0.055, -0.2); group.add(sight);
  return {
    group, muzzle, ejectPort, sight,
    magazine: new THREE.Group(), charging: new THREE.Group(),
    adsOffset: new THREE.Vector3(0, -0.055, -0.20),
  };
}

function stubFX() {
  return {
    root: new THREE.Group(), update() {},
    impact() {}, bloodImpact() {}, tracer() {}, muzzleFlash() {},
    shellEject() {}, explosion() {}, smoke() {},
  };
}
function stubAudio() {
  return { async unlock() {}, update() {}, play() {}, setListener() {} };
}
function stubHUD() {
  return {
    update() {}, setAmmo() {}, setHealth() {}, setWeaponName() {},
    hitmarker() {}, damageFrom() {}, killfeed() {}, setObjective() {}, showBanner() {},
  };
}

boot().catch((e) => {
  console.error('[boot] fatal:', e);
  if (lmsg) {
    lmsg.textContent = 'Failed to start — see console';
    lmsg.style.color = '#ff6b6b';
  }
});
