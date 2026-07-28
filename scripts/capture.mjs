#!/usr/bin/env node
/*
 * Headless capture harness.
 *
 * Loads the running dev server, waits for the game to finish booting, then
 * drives the camera to a set of fixed poses and writes a PNG for each. This is
 * what the visual-review agents look at — deterministic framing means a
 * before/after comparison is actually a comparison, not two different shots.
 *
 * Usage:
 *   node scripts/capture.mjs [--out shots/round1] [--url http://127.0.0.1:5188]
 *                            [--width 1920] [--height 1080] [--only pose1,pose2]
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; })
);

const URL_ = args.url || 'http://127.0.0.1:5188';
const OUT = args.out || 'shots/latest';
const W = parseInt(args.width || '1920', 10);
const H = parseInt(args.height || '1080', 10);

/**
 * Camera poses. Chosen to cover the range a reviewer needs: wide establishing
 * shots for composition and lighting, mid shots for material read, and tight
 * shots for the viewmodel and surface detail.
 */
const POSES = [
  // yaw 0 looks toward -Z (north, into the compound); yaw PI looks +Z (the gate).
  //
  // pos[1] is the FOOT height (0 = standing on the ground). It is NOT an eye
  // height: several poses carried 1.65 here after the convention changed, which
  // started the player 1.65 m in the air to fall onto whatever was below. The
  // harness now flags any pose whose achieved eye height drifts from foot+1.63
  // (or foot+1.02 crouched), which is how these were found.
  //
  // No per-pose `fov`. The game runs at 60 vertical; overriding it meant every
  // review was judged on a 75-85 degree render the player never sees.
  { name: '01_courtyard_wide',    pos: [4, 0, 20],        yaw: -0.42,     pitch: 0.02 },
  { name: '02_admin_facade',      pos: [0, 0, -14],       yaw: 0,         pitch: 0.10 },
  { name: '03_container_alley',   pos: [-32, 0, -20],     yaw: Math.PI,   pitch: 0.0 },
  // Central aisle, clear of the racking rows at x = 24.5 / 31 / 37.5.
  { name: '04_warehouse_int',     pos: [28, 0, 9],        yaw: 0,         pitch: 0.04 },
  { name: '05_gate_looking_out',  pos: [0, 0, 40],        yaw: Math.PI,   pitch: -0.02 },
  { name: '06_wreck_closeup',     pos: [-6.5, 0, -1.5],   yaw: 0.51,      pitch: -0.05, crouch: true },
  { name: '07_sandbags_ground',   pos: [-6, 0, 11],       yaw: 0.15,      pitch: -0.20, crouch: true },
  { name: '08_roof_overlook',     pos: [0, 10.95, -26],   yaw: Math.PI,   pitch: -0.14 },
  { name: '09_into_sun',          pos: [10, 0, 10],       yaw: 0,         pitch: 0.22, faceSun: true },
  { name: '10_viewmodel_ads',     pos: [4, 0, 24],        yaw: 0,         pitch: -0.02, ads: true },
  { name: '11_viewmodel_hip',     pos: [-14, 0, 10],      yaw: -0.6,      pitch: -0.03 },
  { name: '12_material_detail',   pos: [0, 0, -15.5],     yaw: 0,         pitch: 0.04, crouch: true },
  // Catwalk deck sits at y = 5.2 with a 0.12 grating; stand just inboard of it.
  { name: '13_warehouse_catwalk', pos: [41.6, 5.32, 12],  yaw: 0.55,      pitch: -0.14 },
  { name: '14_alley_containers',  pos: [-30, 0, -8],      yaw: 0.9,       pitch: 0.02 },
];

const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;
const poses = only ? POSES.filter((p) => only.includes(p.name)) : POSES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    protocolTimeout: 900000,
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-gpu',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--disable-dev-shm-usage',
      `--window-size=${W},${H}`,
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  console.log(`> loading ${URL_}`);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 180000 });

  // The game generates every texture at runtime, so booting takes a while.
  console.log('> waiting for boot (texture generation)…');
  try {
    await page.waitForFunction(() => !!window.__game, { timeout: 180000, polling: 500 });
  } catch (e) {
    await writeFile(path.join(OUT, 'BOOT_FAILED.log'), logs.join('\n'));
    console.error('! game never booted — see BOOT_FAILED.log');
    console.error(logs.slice(-40).join('\n'));
    await browser.close();
    process.exit(1);
  }

  // Agents are actively editing source while this runs, so Vite HMR can reload
  // the page underneath us. Re-establish the game handle before every step.
  const waitGame = async () => {
    await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
    await page.evaluate(() => {
      document.getElementById('overlay')?.classList.add('hidden');
      document.getElementById('loading')?.remove();
    });
  };
  const retry = async (fn, label) => {
    for (let i = 0; i < 4; i++) {
      try { return await fn(); }
      catch (e) {
        if (i === 3) throw e;
        console.log(`  … page reloaded during ${label}, retrying`);
        await waitGame();
        await sleep(1800);
      }
    }
  };

  await waitGame();
  await sleep(2500);

  // --whitebox: swap every world material for neutral grey. This is the
  // standard grey-box lighting pass — it isolates light, shadow, AO and
  // composition from material noise, which is the only way to judge them.
  const applyWhitebox = () => page.evaluate(() => {
      const g = window.__game;
      // Clone a *plain* standard material (never a Physical one — those carry
      // transmission/clearcoat that would render the whole map black).
      let src = null;
      g.scene.traverse((o) => {
        if (!src && o.isMesh && o.material?.isMeshStandardMaterial
            && !o.material.isMeshPhysicalMaterial) src = o.material;
      });
      if (!src) return;
      const flat = src.clone();
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
                       'alphaMap', 'emissiveMap', 'bumpMap', 'displacementMap',
                       'lightMap', 'envMap']) flat[k] = null;
      flat.color.setRGB(0.32, 0.32, 0.32);
      flat.emissive?.setRGB(0, 0, 0);
      flat.roughness = 0.88;
      flat.metalness = 0.0;
      flat.transparent = false; flat.alphaTest = 0; flat.opacity = 1;
      flat.side = 0;
      flat.envMapIntensity = 1.0;
      flat.needsUpdate = true;
      // Identify the viewmodel by its render layer, not by mesh name — names
      // change as the weapon module is iterated on, and a stale name filter
      // silently white-boxes the gun and makes the shot unreadable.
      const VIEWMODEL_LAYER = 1;
      const isViewmodel = (o) => o.layers.test({ mask: 1 << VIEWMODEL_LAYER })
        || /^(rifle|smg|pistol|weapon)\./.test(o.name || '');
      // The sky dome is a BackSide ShaderMaterial. Replacing it with a
      // FrontSide standard material culls it to nothing from inside, leaving
      // the blurred PMREM background in its place — so every whitebox frame
      // had no clouds, no sun disc, and a luminance the meter locked onto
      // wrongly. Leave any custom shader (and the sky mesh) alone.
      const isSky = (o) => o === g.sky?.mesh || !!o.material?.isShaderMaterial;
      g.scene.traverse((o) => {
        if (o.isMesh && o.material && !isViewmodel(o) && !isSky(o) && o.name !== 'collider') {
          o.material = flat;
        }
      });
  });
  if (args.whitebox) {
    await retry(applyWhitebox, 'whitebox');
    await sleep(700);
  }


  const stats = await retry(() => page.evaluate(() => {
    const g = window.__game;
    return {
      fps: Math.round(g.fps),
      calls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
      programs: g.renderer.info.programs?.length ?? 0,
      textures: g.renderer.info.memory.textures,
      geometries: g.renderer.info.memory.geometries,
      renderScale: +(g.drs?.scale ?? 1).toFixed(3),
      bufferSize: [g.rendererWrapper?.bufferWidth, g.rendererWrapper?.bufferHeight],
    };
  }), 'stats');
  console.log('> stats', stats);

  // Lighting / scene diagnostics — this is how we tune exposure, fog and
  // shadows without guessing from screenshots alone.
  const diag = await retry(() => page.evaluate(() => {
    const g = window.__game;
    const sky = g.sky, sun = sky?.sunLight;
    const lights = [];
    let meshes = 0, casters = 0, receivers = 0;
    g.scene.traverse((o) => {
      if (o.isLight) lights.push(`${o.type}:${(o.intensity ?? 0).toFixed(2)}${o.castShadow ? '*' : ''}`);
      if (o.isMesh) { meshes++; if (o.castShadow) casters++; if (o.receiveShadow) receivers++; }
    });
    const c3 = (c) => c ? [c.r, c.g, c.b].map((v) => +v.toFixed(3)) : null;
    return {
      sunDirection: sky?.sunDirection?.toArray().map((v) => +v.toFixed(3)),
      sunColor: c3(sky?.sunColor),
      fogColor: c3(sky?.fogColor),
      fogColorGround: c3(sky?.fogColorGround),
      ambientColor: c3(sky?.ambientColor),
      sunLight: sun ? {
        intensity: sun.intensity, castShadow: sun.castShadow,
        position: sun.position.toArray().map((v) => +v.toFixed(1)),
        color: c3(sun.color),
        shadow: sun.shadow ? {
          left: sun.shadow.camera.left, right: sun.shadow.camera.right,
          top: sun.shadow.camera.top, bottom: sun.shadow.camera.bottom,
          near: sun.shadow.camera.near, far: sun.shadow.camera.far,
          mapSize: sun.shadow.mapSize.x, bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
        } : null,
      } : null,
      lightCount: lights.length, lights: lights.slice(0, 12),
      meshes, casters, receivers,
      shadowMapEnabled: g.renderer.shadowMap.enabled,
      shadowMapType: g.renderer.shadowMap.type,
      sceneEnvironment: !!g.scene.environment,
      sceneBackground: g.scene.background ? g.scene.background.constructor.name : null,
      postfx: JSON.parse(JSON.stringify(g.postfx.params, (k, v) => (v && v.isVector3 ? v.toArray() : v))),
      modules: {
        sky: g.sky?.constructor?.name, fx: g.fx?.constructor?.name,
        hud: g.hud?.constructor?.name, audio: g.audio?.constructor?.name,
        ai: g.ai?.constructor?.name, weaponModel: g.weapons?.current?.model?.group?.children?.length,
      },
    };
  }), 'diag');
  await writeFile(path.join(OUT, 'diag.json'), JSON.stringify(diag, null, 2));
  console.log('> diag written');

  // A module that failed to import degrades to a stub with only a console.warn,
  // and the run would otherwise be written out and reviewed as if it were real.
  const REQUIRED = { sky: 'Sky', fx: 'FXSystem', hud: 'HUD', ai: 'AIDirector' };
  const stubbed = Object.entries(REQUIRED)
    .filter(([k, want]) => diag.modules?.[k] !== want)
    .map(([k, want]) => `${k}: expected ${want}, got ${diag.modules?.[k]}`);
  if (stubbed.length) {
    console.error('! refusing to capture — subsystems are stubbed:');
    for (const line of stubbed) console.error('   ' + line);
    await writeFile(path.join(OUT, 'STUBBED.log'), stubbed.join('\n'));
    await browser.close();
    process.exit(2);
  }

  for (const p of poses) {
    await retry(() => page.evaluate((pose) => {
      const g = window.__game;
      const pl = g.player;
      // pose.pos[1] is the FOOT height (0 = standing on the ground). Stance is
      // declared, not implied by an arbitrary eye number: a crouched eye is
      // 1.02 m and a standing eye 1.63 m, so any other value was unreachable
      // and used to be silently clamped to standing.
      pl.position.set(pose.pos[0], Math.max(0.02, pose.pos[1]), pose.pos[2]);
      // Drive the real crouch input so the capsule, eye height and camera all
      // agree, rather than poking a height the controller will undo.
      if (pose.crouch) g.input.down.add('ControlLeft');
      else g.input.down.delete('ControlLeft');
      pl.velocity.set(0, 0, 0);
      pl.yaw = pose.yaw;
      pl.pitch = pose.pitch;
      pl.recoilPitch = 0; pl.recoilYaw = 0; pl.shakeTrauma = 0;
      pl.bobAmount = 0; pl.landDip = 0; pl.lean = 0;
      // Always render at the game's real FOV. A per-pose override here made
      // every captured frame 15-25 degrees wider than what the player sees.
      pl.baseFov = pose.fov ?? 60;
      pl.fov = pose.fov ?? 60;

      // Face the sun directly when the pose asks for it, so we always get a
      // real into-the-light shot regardless of the current time of day.
      if (pose.faceSun && g.sky?.sunDirection) {
        // sunDirection points FROM the sun TOWARD the scene, so to look AT the
        // sun the camera forward must be -sunDirection. Camera forward at yaw y
        // is (sin y, 0, -cos y), so yaw = atan2(d.x, d.z). The previous
        // atan2(-d.x, -d.z) pointed 180 degrees away — every "into sun" shot
        // captured so far was an away-from-sun shot.
        const d = g.sky.sunDirection;
        pl.yaw = Math.atan2(d.x, d.z);
        pl.pitch = Math.asin(Math.max(-1, Math.min(1, -d.y))) * 0.9;
      }

      if (g.weapons) {
        // forceAim survives the weapon's "pointer not locked -> stop aiming"
        // branch, which previously made every ADS capture identical to hip.
        g.weapons.forceAim = !!pose.ads;
        g.weapons.aiming = !!pose.ads;
        g.weapons.adsT = pose.ads ? 1 : 0;
      }
      // Settle every spring so the frame is not mid-transition.
      for (let i = 0; i < 90; i++) {
        pl.update(1 / 120, g);
        g.weapons?.update(1 / 120, g);
      }
    }, p), p.name);

    const eye = await retry(() => page.evaluate(() =>
      +(window.__game.camera.position.y).toFixed(2)), `eye ${p.name}`);
    if (args.whitebox) await retry(applyWhitebox, `whitebox ${p.name}`);
    await sleep(900);   // let the pose settle; springs and SMAA need a few frames
    // I-2: eye adaptation takes 1-3 s to converge, so a short settle left every
    // frame mid-adaptation and each pose depended on the one before it. Snap it
    // instead of freezing, so the frame shows the exposure a player would see.
    await retry(() => page.evaluate(() => window.__game.postfx.snapExposure?.()), `snap ${p.name}`);
    await sleep(320);
    const file = path.join(OUT, `${p.name}.png`);
    await retry(() => page.screenshot({ path: file }), `${p.name} shot`);
    // Collision ejects the player if a pose lands inside geometry, which
    // silently reframes the shot — 04_warehouse_int spent several rounds
    // outdoors on top of a rack this way. Expected eye is foot + 1.63
    // standing, foot + 1.02 crouched.
    const expected = (p.pos[1] || 0.02) + (p.crouch ? 1.02 : 1.63);
    const drift = Math.abs(eye - expected);
    console.log(`  ✓ ${p.name}  (eye ${eye} m)`
      + (drift > 0.4 ? `  ** EJECTED: expected ${expected.toFixed(2)} m — pose is inside geometry **` : ''));
  }

  await writeFile(path.join(OUT, 'stats.json'), JSON.stringify({ stats, poses: poses.map(p => p.name) }, null, 2));
  const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  if (errs.length) {
    await writeFile(path.join(OUT, 'console-errors.log'), errs.join('\n'));
    console.log(`> ${errs.length} console errors written to console-errors.log`);
  }
  await writeFile(path.join(OUT, 'console.log'), logs.join('\n'));

  await browser.close();
  console.log(`> done -> ${OUT}`);
})();
