# BLACKSITE

A first-person shooter built in Three.js. Every texture, mesh, animation and
sound is generated procedurally at runtime — the repository contains no images,
no models, and no audio files.

### ▶ [Play in the browser](https://kazumahoriguchi109-dot.github.io/blacksite-fps/)

Needs a desktop browser with WebGL2 (Chrome, Edge, Firefox or Safari 15+) and a
mouse — it locks the pointer, so it will not play on a phone or tablet. **The
first load takes 10-20 seconds on a blank screen**: the entire material
catalogue is synthesised in the browser before the level can be built, and the
loading bar reports which material it is on. Nothing is downloaded but the code
itself (~300 kB gzipped), so it is slow once and instant after.

Then click **Deploy** and the browser will ask for pointer lock. Press **Esc**
to get the cursor back.

To run it locally instead:

```bash
npm install
npm run dev      # http://127.0.0.1:5188
```

## Controls

| | |
|---|---|
| WASD | move |
| Shift | sprint |
| Ctrl / C | crouch — sprint into it to slide |
| Space | jump (with coyote time and input buffering); vault ledges automatically |
| Mouse | look · **LMB** fire · **RMB** aim down sights |
| R | reload · **V** melee · **G** grenade |
| 1 / 2 / 3 | rifle / SMG / pistol (mouse wheel also cycles) |
| Q / E | lean |
| F3 | performance overlay |
| Esc | release the cursor |

## What's in it

**Measured state.** 36/36 automated gameplay checks pass. Boots in ~11 s. 60 fps
in combat with 5 enemies (516 draw calls, 694k triangles); ~45 fps on a static
wide shot at 1600x900 with adaptive resolution disabled. Key-to-fill measures
2.9-3.3 stops with neutral shadows; white clipping is under 0.25% and black
clipping under 6% in every heading tested.

**Rendering.** A hand-written post chain rather than Three's `EffectComposer`,
because every downstream effect needs a real depth buffer: the scene renders
once into an HDR target that owns a `DepthTexture`, then HBAO (horizon-based,
with a depth-aware bilateral blur), depth-occluded volumetric light shafts, a
Jimenez-style bloom mip chain, and a resolve pass that applies AO, analytic
exponential height fog with sun inscattering, and camera motion blur by
reprojecting through the previous frame's view-projection. Then ACES tonemapping
with a committed split-tone grade, chromatic aberration, vignette, SMAA, and a
contrast-adaptive sharpen with film grain applied after it.

**Auto-exposure.** Centre-weighted log-luminance is metered from the HDR buffer
through a 64→16→4→1 reduction into a 1x1 ping-pong holding the temporally
adapted value, with a faster attack than decay. Without it the scene had exactly
one working orientation: facing the sun clipped 23.8% of the frame to pure white
and collapsed the dynamic range to 1.4 stops.

**Lighting.** Physically-derived sky: a ray-marched single-scattering LUT
(Rayleigh + Mie with a Henyey–Greenstein phase, plus ozone absorption) driving
an HDR sky dome, a `PMREMGenerator` IBL, and a directional sun whose cascade is
snapped to shadow-map texels so edges don't crawl as you walk. Point lights go
through a fixed-slot rig (see below).

**Materials.** Procedural PBR: each surface is a function sampled per texel that
returns height, albedo, roughness and metalness; normals are derived from the
height field by Sobel filter and AO from the cavity between the height and a
blurred copy, so all four maps always agree. Every noise basis is tileable.
Albedo is calibrated against real-world sRGB reflectance.

**Weapons.** Three weapons built to real dimensions (838 mm carbine, 368 mm
barrel, MIL-STD-1913 rail extruded one tooth at a time). The viewmodel renders
through its own camera at a narrower FOV with a compressed depth range, so it
neither fisheyes at wide world FOV nor clips through walls. Animation is
entirely procedural springs — recoil is split into aim recoil (moves the shots,
recovers partially) and visual recoil (kicks the model, recovers fully).

**Ballistics.** Hitscan from the camera centre with a penetration budget in
equivalent millimetres of concrete; rounds punch through sheet metal and wood,
lose damage doing it, and stop in concrete. Damage falls off with distance and
is multiplied by hit zone.

**AI.** A nav grid built by capsule-testing the level BVH, A* with string-pulled
paths, and a nine-state behaviour machine that uses cover, flanks, and suppresses
a last-known position. A director hands out a limited number of "firing tokens"
so all enemies never shoot at once.

## Two engine decisions worth knowing

**Spatial chunking.** `Builder` buckets geometry by material *and* by a 22 m
spatial cell. Merging by material alone gives a wonderful draw-call count and
zero frustum culling — the entire map is submitted every frame and again for
every shadow pass. Chunking costs a few hundred draw calls and buys the culling
back. This was the difference between 4 fps and 54 fps at 2 M triangles.

**Fixed-slot light rig.** Three's forward renderer evaluates every light for
every fragment and bakes the light count into the shader permutation, so a level
with ~35 point lights is both slow and prone to recompilation hitches.
`LightRig` keeps 8 real lights and retargets them to whichever virtual lights
matter most to the camera, cross-fading on a swap. Level authors add as many
lights as they like; the renderer only ever sees eight.

## Tooling

Everything under `scripts/` drives the real game in headless Chrome.

| | |
|---|---|
| `node scripts/capture.mjs --out shots/x` | screenshots from 14 fixed camera poses, plus `stats.json`, `diag.json` and console logs. `--whitebox` swaps all materials for neutral grey to judge lighting alone. |
| `node scripts/playtest.mjs` | drives movement, collision, firing, reloading, ADS, AI and damage and asserts observable state changes; also captures action frames |
| `node scripts/profile.mjs` | frame-cost breakdown by subsystem |
| `node scripts/keyfill.mjs` | measures key-to-fill ratio and shadow colour cast off the render target |
| `node scripts/boottime.mjs` | per-stage boot timing |

`ARCHITECTURE.md` documents the module contracts; `REVIEW.md` documents the
visual review loop.

## Honest limitations

This is a browser game built from procedural content. It is not a Call of Duty
competitor and nothing here should be read as claiming otherwise: there is no
authored art, no motion capture, no photogrammetry, no baked global illumination,
one map, and a fraction of the geometry and shading budget a native AAA engine
spends. What it does have is a coherent rendering pipeline, real game feel, and
no external assets at all.
