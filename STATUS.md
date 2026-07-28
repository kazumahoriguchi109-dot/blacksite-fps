# STATUS — save point

Last saved: 2026-07-28. The build is playable and healthy at this commit.
Save points: `playable-v1` (first playable), `v2` (AO + draw-call budget),
`v3` (clouds rebuilt), `v4` (surfaces authored, sandbags rebuilt, enemies
readable, colour script) — current.

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
- Boots in 10.8 s
- 45–60 fps in combat with 5 enemies
- **399 draw calls** (budget 450), 1.32 M triangles in a wide establishing view
- Enemy uniform vs asphalt at 12 m: value +0.107 (was −0.012), silhouette
  107–121 px (was 95)
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

1. **Clouds share a family resemblance** at mid distance — rounded, flat-based
   puffs of similar proportion. No lattice and no countable rhythm any more, but
   a viewer could say "all the small clouds are the same kind of cloud". Cause:
   the 3D erosion volume is a fixed world size (465 m coarsest lobe), so a 900 m
   puff gets barely one lobe across it. A proper fix needs a second volume fetch
   at a cloud-size-dependent scale, which does not fit at performance parity.
   Cloud march stipple is reduced, not eliminated — visible pixel-peeped at 3x.
2. **Triangles still above target**: 1.27 M vs a 900 k goal (draw calls are now
   under budget). `src/world/Level.js`, `src/world/Props.js`.
3. **Enemies at 20 m on sunlit asphalt** now match the ground in value (−0.004).
   There is no single value that beats both sunlit asphalt (0.26) and asphalt in
   shadow (0.12); the fix traded a uniformly-dark figure for a two-tier one so
   that one tier always contrasts, but mean edge contrast against arbitrary
   backdrops went 0.095 → 0.083. A rim/backlight term is the likely next move.
   An enemy actively firing still presents a foreshortened weapon — mitigated by
   shoulder timing, not solved.
4. **Support hand grips the top of the rail** rather than under the handguard.
   `src/weapons/models.js`. (Hip pose size is fixed.)
5. **Brick still repeats** — a 2.70 m tile across a 20 m elevation, findable if
   you look. The *grid* is gone; the repeat is not.
6. **Interior lamps are decorative** — no light pools on the floor.
7. **HUD has no hierarchy** under fire.
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
