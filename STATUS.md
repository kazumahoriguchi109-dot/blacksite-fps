# STATUS — save point

Last saved: 2026-07-28. The build is playable and healthy at this commit.

## Resume in one minute

```bash
cd /Users/horiguchikazuma/Documents/Kazuma_Context_Vault/15_Personal_Projects/blacksite-fps
npm install     # only if node_modules is missing
npm run dev     # http://127.0.0.1:5188
```

First load takes ~11 s (every texture is generated in the browser). Click
**Deploy**. Controls are in `README.md`; **F3** shows the performance overlay.

Verify nothing has rotted:

```bash
node scripts/playtest.mjs      # expect 36/36
node scripts/boottime.mjs      # expect ~11 s
```

## Where it stands

**Measured at this save point**
- 36/36 automated gameplay checks pass
- Boots in 11.4 s
- 60 fps in combat with 5 enemies · 42–45 fps typical · 25 fps worst observed
- 753 draw calls, 1.15 M triangles in a wide establishing view
- Key-to-fill 2.9–3.3 stops, shadow blue/red 1.08–1.43
- White clipping < 0.25%, black clipping < 6% in every heading

**Independent verdict: "competent indie."** Four harsh-critic passes have been
run. It is not AAA and no reviewer has said otherwise. The remaining gap is
authored art and content volume, not a bug list.

## What is done

Rendering: hand-written post chain (HBAO, bloom, volumetric shafts, height fog,
camera motion blur, ACES + graded, SMAA, CAS sharpen), auto-exposure with
centre-weighted log-luminance metering, spatial-chunked geometry with frustum
culling, fixed-slot light rig, adaptive resolution, interior lighting
attenuation, specular AA, an environment colour script.

Content: procedural PBR materials, a physically-derived sky with volumetric
cumulus, a walled industrial map with real building massing, three weapons at
real dimensions with anatomical hands, procedural enemies with cover AI and a
nav grid, procedural WebAudio, wave-based game mode with respawn.

## What is NOT done — ranked, from the fourth review

1. **Clouds regressed into a regular lattice** of identically-sized, identically
   -slanted lozenges. `src/world/Sky.js`. Suspected: `cloudShear` 0.55 over a
   2.70 km slab extrudes each weather cell into a slanted cylinder seen end-on.
   Suggested: shear → ~0.15, thickness → ~1.2 km, add a low-frequency amplitude
   mask so cells vary 3–4× in size, blue-noise the march start.
2. **Draw-call budget blown**: 753 vs a 450 budget, 1.15 M vs 900 k triangles.
   `src/world/Level.js`, `src/world/Props.js`, `src/world/Builder.js`.
3. **Enemies still weak at 12 m** — rifle not reading in silhouette, contact
   shadow too faint, camo too high-frequency. `src/ai/Enemy.js`.
4. **Viewmodel hip pose oversized**; support hand grips the top of the rail
   rather than under the handguard. `src/weapons/Weapon.js`, `models.js`.
5. **Materials**: brick is a perfect running-bond grid; sandbags read as flat
   tiles rather than bags with sag; barrels are candy-striped.
6. **Interior lamps are decorative** — no light pools on the floor.
7. **Colour script is a flat saturation multiply**, not a value-and-hue plan.
8. **HUD has no hierarchy** under fire.
9. `ca: 0.0008` is a null effect. Grain dithers visibly in shadows.
10. The muzzle flash sits behind the support forearm in the hip pose — a
    muzzle/hand relationship problem in the viewmodel pose, not in FX.

## Known-good tooling

Everything under `scripts/` drives the real game headlessly. `REVIEW.md`
explains the loop. Several of these exist because earlier review rounds were
invalidated by bugs *in the tools*:

| | |
|---|---|
| `capture.mjs` | 14 fixed poses; `--whitebox` for a lighting-only pass. Hard-fails if any subsystem is stubbed. Reports achieved eye height per pose. |
| `playtest.mjs` | drives movement, firing, reloading, ADS, grenades, AI, damage, game mode; asserts state changes |
| `keyfill.mjs` | key-to-fill by sun differencing (renders each frame twice, once with the sun zeroed) |
| `aodebug.mjs` | dumps the AO buffer directly |
| `ratchet.mjs` | regression test for the interior-lighting compounding bug |
| `profile.mjs`, `boottime.mjs`, `overview.mjs`, `enemyshot.mjs`, `fxcost.mjs` | |

## Traps — do not re-introduce these

- **Never `*=` a value you do not own.** The interior lighting multiplied
  `scene.environmentIntensity` each frame assuming Sky rewrote it. Sky does not.
  It compounded to 2.4e-64 and permanently deleted the sky fill after one walk
  through a doorway. Assign from a cached base that re-adopts on external write.
- **Merging level geometry by material alone kills frustum culling.** That was
  4 fps vs 54 fps at 2 M triangles. Keep the 22 m spatial chunking.
- **Never toggle `light.visible` at runtime.** The light count is baked into the
  shader permutation; use the fixed-slot `LightRig`.
- **The review instrument lies if you let it.** Bugs found in it so far: forced
  75–85° FOV, inverted `faceSun`, whitebox crash leaving stale PNGs, whitebox
  deleting the sky dome, `pos.y` meaning feet vs eye, poses clamped to standing,
  settling faster than eye adaptation, AI not frozen for enemy shots, Vite
  double-boot, and Vite watching `shots/` so every capture triggered a reload.
