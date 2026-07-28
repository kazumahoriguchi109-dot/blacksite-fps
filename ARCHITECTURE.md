# BLACKSITE — architecture & module contracts

Three.js (r185, ES modules, Vite). **No external asset files, ever.** Every texture,
mesh, and sound is generated procedurally at runtime. No CDN, no fetch, no binaries.

Run: `npm run dev` → http://127.0.0.1:5188

## Ground rules for every module

1. `import * as THREE from 'three';` — the only third-party import (plus
   `three-mesh-bvh` for collision, and `three/examples/jsm/...` where noted).
2. **Own your files.** Do not edit files outside the ones assigned to you.
   If you need something from another module, use the documented interface below;
   if the interface is insufficient, say so in your report rather than editing it.
3. Units are **metres**, Y is up, and the world is right-handed. A standing player
   eye is at y=1.65, crouched y=1.05. Doorways are 2.1m tall.
4. Everything you allocate per-frame must be pooled or preallocated. No `new` in
   an update loop. Assume the update loop runs at 120 Hz.
5. Every class exposes `update(dt, ctx)` and `dispose()` unless stated otherwise.
6. Materials must be `MeshStandardMaterial` or `MeshPhysicalMaterial` (the post
   stack assumes a linear HDR scene). Never set `toneMapped = false` except for
   genuinely emissive UI/FX sprites.
7. Colour: author albedo as **sRGB display values** and tag colour textures
   `THREE.SRGBColorSpace`. Data maps (normal/rough/metal/ao) are `NoColorSpace`.

## Shared context object (`ctx`)

Passed to every `update(dt, ctx)`:

```js
ctx = {
  time,          // seconds since start
  dt,            // clamped frame delta
  scene,         // THREE.Scene
  camera,        // THREE.PerspectiveCamera (the view camera)
  renderer,      // THREE.WebGLRenderer
  postfx,        // PostFX instance — mutate postfx.params.* for screen effects
  input,         // Input instance
  player,        // Player instance
  world,         // Level instance
  audio,         // AudioEngine instance
  fx,            // FXSystem instance
  hud,           // HUD instance
  ai,            // AIDirector instance
  rng,           // deterministic float() in [0,1)
}
```

## Module map

| File | Owner | Responsibility |
|---|---|---|
| `src/main.js` | core | bootstrap, fixed-timestep loop, wiring, adaptive resolution |
| `src/core/Renderer.js` | core | WebGL context, render scale |
| `src/core/LightRig.js` | core | fixed-slot point-light pool (see below) |
| `src/game/GameMode.js` | core | waves, respawn, score, killfeed |
| `src/gfx/specularAA.js` | core | normal-variance -> roughness, anisotropy |
| `src/weapons/Grenade.js` | core | thrown projectiles, swept-ray collision |
| `src/core/PostFX.js` | core | HBAO, bloom, shafts, fog, motion blur, ACES + grade, SMAA |
| `src/core/Input.js` | core | pointer lock, edge-triggered keys |
| `src/gfx/noise.js` | core | tileable perlin/worley/fbm/warp |
| `src/gfx/textures.js` | textures | `generateTextureSet(kind, opts)` |
| `src/gfx/materials.js` | textures | named material factory + registry |
| `src/world/Sky.js` | sky | physical sky dome, sun, IBL env map |
| `src/world/Level.js` | level | map geometry, collision meshes, spawns |
| `src/world/Props.js` | level | clutter: crates, barrels, pipes, debris |
| `src/player/Player.js` | core | movement FSM, capsule collision, camera rig |
| `src/weapons/Weapon.js` | core | fire/reload FSM, recoil, spread |
| `src/weapons/models.js` | weapons | procedural weapon meshes |
| `src/weapons/Ballistics.js` | core | hitscan, penetration, damage |
| `src/fx/FXSystem.js` | fx | particles, decals, tracers, muzzle flash |
| `src/ai/AIDirector.js` | ai | enemy spawning, squad logic |
| `src/ai/Enemy.js` | ai | per-enemy behaviour, animation, hit reaction |
| `src/audio/AudioEngine.js` | audio | procedural WebAudio synthesis |
| `src/ui/HUD.js` | hud | crosshair, ammo, health, hitmarkers, killfeed |

---

## Contracts

### `src/gfx/textures.js` (exists)
```js
generateTextureSet(kind, { size, seed, repeat:[u,v], surfaceOpts })
  -> { map, normalMap, roughnessMap, metalnessMap, aoMap, size }
```
Kinds: `concrete asphalt brick metal painted wood tile gravel plaster sandbag
gunmetal polymer camo`. Add more via `registerSurface(name, seed => (u,v) => ({h,r,g,b,rough,metal}))`.

### `src/gfx/materials.js`
```js
getMaterial(name, opts) -> THREE.MeshStandardMaterial   // cached by name+opts
listMaterials() -> string[]
```

### `src/world/Sky.js`
```js
class Sky {
  constructor(renderer, scene)
  sunDirection: THREE.Vector3   // normalised, points *from sun toward scene*
  sunColor: THREE.Color
  sunLight: THREE.DirectionalLight
  ambientColor: THREE.Color
  fogColor: THREE.Color         // zenith-ish haze colour
  fogColorGround: THREE.Color
  setTimeOfDay(t01)             // 0=dawn .5=noon 1=dusk
  update(dt, ctx)
}
```
Must produce a `PMREMGenerator` env map and assign `scene.environment`.

### `src/world/Level.js`
```js
class Level {
  constructor(ctx)
  root: THREE.Group             // added to scene by main
  collider: THREE.Mesh          // single merged mesh with a computed BVH
  spawnPoints: THREE.Vector3[]  // player spawns
  enemySpawns: THREE.Vector3[]
  navGrid                       // see Navigation contract
  build()                       // async ok — main awaits it
  update(dt, ctx)
}
```
Collision is a **merged BVH mesh** (`three-mesh-bvh`), not per-object raycasts.
Tag surfaces for footsteps/impacts by writing `mesh.userData.surface = 'concrete'|...`.

### `src/fx/FXSystem.js`
```js
class FXSystem {
  constructor(ctx)
  update(dt, ctx)
  // one-shot emitters, all pooled:
  impact(point, normal, surfaceKind)     // sparks/dust/debris + decal
  bloodImpact(point, normal)
  tracer(from, to, speed)
  muzzleFlash(matrixWorld, scale)
  shellEject(position, velocity, kind)
  explosion(point, radius)
  smoke(point, amount)
}
```

### `src/audio/AudioEngine.js`
```js
class AudioEngine {
  constructor()
  async unlock()                          // called on first user gesture
  update(dt, ctx)
  play(name, { position, volume, pitch, distance })   // 3D if position given
  setListener(camera)
}
```
Names: `rifleFire smgFire pistolFire dryFire magOut magIn boltBack boltForward
footstepConcrete footstepGravel footstepMetal impactConcrete impactMetal impactFlesh
ricochet explosion grenadeBounce hitmarker headshot playerHurt playerDeath
enemyDeath reloadRustle adsIn adsOut meleeSwing meleeHit`. All **synthesised** —
noise bursts through shaped filters, FM clicks, convolution reverb from generated
impulse responses. No sample files.

### `src/ui/HUD.js`
```js
class HUD {
  constructor(rootEl, ctx)
  update(dt, ctx)
  setAmmo(mag, reserve); setHealth(hp01); setWeaponName(s)
  hitmarker(kind)        // 'hit' | 'armor' | 'kill' | 'headshot'
  damageFrom(worldPos)   // directional damage indicator
  killfeed(attacker, victim, weapon, headshot)
  setObjective(text); showBanner(title, sub)
}
```

### `src/ai/AIDirector.js` / `src/ai/Enemy.js`
```js
class AIDirector { constructor(ctx); update(dt, ctx); spawnWave(n); enemies: Enemy[] }
class Enemy {
  root: THREE.Group; health; alive;
  hitBoxes: { head, chest, limbs }   // THREE.Box3 or meshes with userData.zone
  update(dt, ctx); applyDamage(amount, zone, dir); dispose()
}
```

### `src/weapons/models.js`
```js
buildWeaponModel(kind) -> { group, muzzle: THREE.Object3D, ejectPort: THREE.Object3D,
                            magazine: THREE.Object3D, charging: THREE.Object3D,
                            sight: THREE.Object3D, adsOffset: THREE.Vector3 }
```
Kinds: `rifle smg pistol`. Built from real proportions in metres (a 5.56 carbine is
~0.84 m long). `adsOffset` positions the sight exactly on the camera axis.

---

## Engine constraints that content must respect

**Spatial chunking.** `Builder` buckets geometry by material *and* by a 22 m
spatial cell, then merges each bucket. Merging by material alone gives a low
draw-call count and *zero* frustum culling — the whole map is submitted every
frame and again for every shadow pass. Do not "optimise" by reducing the number
of buckets; the culling is worth far more than the draw calls. Measured: 4 fps
unchunked vs 54 fps chunked at 2 M triangles.

**Light budget.** Three's forward renderer evaluates every light per fragment
and bakes the light count into the shader permutation. `LightRig` keeps 8 real
`PointLight`s and retargets them each frame to whichever virtual lights matter
most to the camera, cross-fading on a swap. Level code may add as many point
lights as it likes — `lightRig.adopt(scene)` absorbs them after the level builds.
Never toggle `light.visible` at runtime; that changes the permutation and forces
a recompile of every material.

**Shadow casting.** `NO_SHADOW_MATERIALS` (exported from `Builder.js`) excludes
decorative materials from the shadow pass, and `main.js` additionally disables
`castShadow` on chunks more than 78 m from the camera. The sun's ortho frustum
only spans ~104 m, so anything beyond that is pure waste.

**Frame budget**, measured with 10 enemies at 1600x900:
- ≤ 900k triangles drawn in a typical view
- ≤ 450 draw calls
- ≥ 55 fps

Adaptive resolution (`ctx.drs`) trades internal resolution between 0.62x and
1.0x to hold the budget, so a regression shows up as a soft image rather than a
dropped framerate. If `ctx.drs.scale` is pinned at its floor, the frame is too
expensive — check `stats.json` rather than trusting the framerate.

**Lighting ownership.** `Sky` writes `scene.environmentIntensity` and the
hemisphere intensity only in `applyParams()` / `_deriveLighting()` /
`_renderEnv()`, and `_renderEnv()` only fires when the sun moves past a
threshold. With a fixed time of day that is *never*. So anything that wants to
modulate them must **assign from a cached base**, never `*=` the live value —
a per-frame multiply compounds to zero. `main.js`'s interior attenuation shows
the pattern: cache, re-adopt if someone else writes, assign.

**Practical lights** are boosted 4.2x at adoption in `main.js`. They were
authored when a bright sky IBL lit everything uniformly and they only had to be
a hint; with interiors attenuating that IBL and auto-exposure lifting the room,
an unboosted fixture is ~5% of what the eye has adapted to. Reach scales with
intensity or the pool clips into a hard circle.

**Colour script.** `desaturateWorld()` applies a per-class value-and-hue plan,
not a flat saturation multiply — ground near-neutral and slightly darker,
architecture mid, industrial cooler and lower, organic warmer, and hazard
marking left fully saturated as the single reserved accent. Characters and the
viewmodel are deliberately excluded so they stay separated from the terrain.

**Boot time.** Every texture is generated synchronously in the browser. The
catalogue is preloaded via `preloadMaterialsAsync` at 320 px so the loading bar
can paint. Boot is ~11 s; treat anything over ~25 s as a regression.

## Tooling

See `REVIEW.md`. `scripts/capture.mjs` (with `--whitebox`), `playtest.mjs`,
`profile.mjs`, `keyfill.mjs`, `boottime.mjs`, `overview.mjs`, `enemyshot.mjs`.

## The review instrument

`scripts/capture.mjs` is the measuring device for every visual judgement, and
**it has been wrong five separate times**, each of which silently invalidated a
round of review findings. If a result looks strange, suspect the tool first.

Rules it now enforces, and why:
- **`pos[1]` is FOOT height, not eye height.** Poses that carried an eye height
  started the player in mid-air to fall onto whatever was beneath.
  `04_warehouse_int` landed on top of a storage rack *outside* the building, so
  every "warehouse interior" frame in four review rounds was a courtyard shot.
- Every capture prints its achieved eye height and warns **EJECTED** when
  collision has displaced the player from the requested pose. Trust that warning.
- Poses declare a **stance** (`crouch: true`), because an arbitrary eye height
  is not reachable — a crouched eye is 1.02 m and a standing eye 1.63 m.
- No per-pose `fov`. The game runs at 60 vertical; overriding it meant reviews
  judged frames the player never sees.
- `--whitebox` must skip the sky dome. It is a BackSide `ShaderMaterial`;
  replacing it with a FrontSide standard material culls it to nothing and leaves
  the blurred PMREM background in its place.
- The run **hard-fails if any subsystem is stubbed**, because a failed dynamic
  import degrades to a stub with only a `console.warn`.
- Auto-exposure is snapped per pose. It converges over 1-3 s; a short settle
  left every frame mid-adaptation and made each pose depend on the previous one.

## Quality bar

This is being reviewed by a deliberately harsh critic against shipped AAA shooters.
The things that separate "a Three.js demo" from "a game":

- **Silhouette and detail density.** Bare boxes read as prototype. Everything needs
  chamfers, trim, bolts, pipes, cable runs, signage, wear at contact points.
- **Value range.** Real scenes have deep shadows *and* blown highlights. Flat
  mid-grey everything is the #1 tell.
- **Grounding.** Objects need contact shadows and dirt where they meet the floor.
- **Motion.** Nothing snaps. Every state change is eased over 80–250 ms.
- **Weight.** Recoil kicks the camera *and* the viewmodel, with separate recovery
  curves. Footsteps have cadence. Reloads take real time (~2.1 s tactical).
- **Feedback.** Every shot: flash, smoke, tracer, shell, decal, dust, sound, and
  screen shake proportional to calibre.
