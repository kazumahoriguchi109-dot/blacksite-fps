# Visual review loop — how to see your own work

A Vite dev server is already running at **http://127.0.0.1:5188**. Do not start
another one. Vite hot-reloads, so any file you save is live within a second.

## Capture screenshots

```bash
cd /Users/horiguchikazuma/Documents/Kazuma_Context_Vault/15_Personal_Projects/blacksite-fps
node scripts/capture.mjs --out shots/<your-round-name> --width 1600 --height 900
```

Add `--only pose1,pose2` to capture a subset (much faster). Pose names:

```
01_courtyard_wide   02_admin_facade      03_container_alley   04_warehouse_int
05_gate_looking_out 06_wreck_closeup     07_sandbags_ground   08_roof_overlook
09_into_sun         10_viewmodel_ads     11_viewmodel_hip     12_material_detail
13_warehouse_catwalk 14_alley_containers
```

Each run writes PNGs plus:
- `stats.json` — fps, draw calls, triangles
- `diag.json`  — sun direction/colour, light list, shadow config, all PostFX params
- `console.log` / `console-errors.log`

**Read the PNGs with the Read tool** — it renders images. That is how you see
your work. Never claim a visual result you have not looked at.

The harness boots the game, forces a fixed camera pose, settles every spring,
then screenshots — so two runs are directly comparable.

## Notes

- First boot takes 30–90 s because every texture is generated at runtime. The
  harness waits up to 240 s and retries if hot-reload interrupts it.
- Other agents are editing concurrently. If a capture looks wrong in a file you
  do not own, report it rather than editing that file.
- `window.__game` exposes the live context (`player`, `world`, `postfx`, `sky`,
  `weapons`, `fx`) if you want to write your own probe script with Puppeteer;
  copy `scripts/shadowdiag.mjs` as a template.
