#!/usr/bin/env node
/*
 * High-zoom viewmodel probe.
 *
 * The full-frame capture harness renders the hands about 200 px tall, which is
 * nowhere near enough to tell whether a finger actually closes on the grip.
 * This drives a private camera positioned in *weapon model space* (the same
 * coordinates models.js is authored in) so each shot can be a 900x900 crop of a
 * single hand.
 *
 * Usage:
 *   node scripts/handprobe.mjs --out shots/probe1 [--weapon rifle] [--size 900]
 *                              [--views fire_back,fire_side,...]
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; })
);

const URL_ = args.url || 'http://127.0.0.1:5188';
const OUT = args.out || 'shots/probe';
const SIZE = parseInt(args.size || '900', 10);
const WEAPON = args.weapon || 'rifle';

/*
 * eye / at are in weapon-model local space (metres, -Z forward, origin at the
 * web of the firing hand). `fov` is vertical degrees.
 */
const VIEWS = [
  // ---- firing hand -------------------------------------------------------
  { name: 'fire_back',   eye: [0.30, 0.03, 0.20],  at: [0.00, -0.045, -0.005], fov: 26 },
  { name: 'fire_side',   eye: [0.34, -0.04, -0.10], at: [0.005, -0.050, -0.015], fov: 26 },
  { name: 'fire_trigger', eye: [0.22, -0.10, -0.22], at: [0.005, -0.048, -0.024], fov: 24 },
  { name: 'fire_below',  eye: [0.16, -0.26, -0.02], at: [0.000, -0.060, -0.010], fov: 28 },
  { name: 'fire_front',  eye: [0.18, 0.02, -0.30], at: [0.000, -0.045, -0.010], fov: 26 },
  // ---- support hand ------------------------------------------------------
  { name: 'supp_back',   eye: [-0.26, 0.10, 0.02],  at: [0.000, 0.055, -0.248], fov: 28 },
  { name: 'supp_left',   eye: [-0.34, 0.02, -0.24], at: [0.000, 0.055, -0.248], fov: 28 },
  { name: 'supp_top',    eye: [-0.10, 0.30, -0.20], at: [0.000, 0.055, -0.248], fov: 28 },
  { name: 'supp_front',  eye: [-0.16, 0.06, -0.50], at: [0.000, 0.055, -0.248], fov: 28 },
  { name: 'supp_under',  eye: [-0.20, -0.22, -0.30], at: [0.000, 0.050, -0.248], fov: 28 },
  // ---- the player's own eye, zoomed in ----------------------------------
  // The viewmodel sits to the RIGHT of the camera (hipPos.x = +0.150), so in
  // weapon space the eye is to the weapon's LEFT. Getting this backwards means
  // reviewing a side of the model the player never sees.
  { name: 'eye_zoom',    eye: [-0.146, 0.114, 0.375], at: [0.00, -0.01, -0.16], fov: 30 },
  { name: 'eye_fire',    eye: [-0.146, 0.114, 0.375], at: [0.005, -0.040, -0.010], fov: 15 },
  { name: 'eye_supp',    eye: [-0.146, 0.114, 0.375], at: [0.000, 0.060, -0.248], fov: 15 },
  { name: 'ads_supp',   eye: [-0.010, 0.062, 0.330], at: [0.000, 0.062, -0.238], fov: 22 },
  { name: 'eye_ads_fire', eye: [-0.010, 0.062, 0.330], at: [0.005, -0.040, -0.010], fov: 16 },
];

const only = args.views ? String(args.views).split(',').map((s) => s.trim()) : null;
const views = only ? VIEWS.filter((v) => only.includes(v.name)) : VIEWS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    protocolTimeout: 900000,
    headless: true,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
      '--disable-dev-shm-usage', `--window-size=${SIZE},${SIZE}`],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  console.log(`> loading ${URL_}`);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('> waiting for boot…');
  await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 500 });
  await page.evaluate(() => {
    document.getElementById('overlay')?.classList.add('hidden');
    document.getElementById('loading')?.remove();
  });
  await sleep(2500);

  // Agents (including this one) save source while the probe runs, and Vite's
  // HMR tears the page down under us. Re-establish the handle and retry.
  const waitGame = async () => {
    await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
    await page.evaluate(() => {
      document.getElementById('overlay')?.classList.add('hidden');
      document.getElementById('loading')?.remove();
    });
    await sleep(2000);
  };
  const retry = async (fn, label) => {
    for (let i = 0; i < 5; i++) {
      try { return await fn(); } catch (e) {
        if (i === 4) throw e;
        console.log(`  … page reloaded during ${label}, retrying`);
        await waitGame();
        await setup();
      }
    }
  };

  // Park the player somewhere open and lit, and select the weapon under test.
  const setup = () => page.evaluate((kind) => {
    const g = window.__game;
    g.player.position.set(4, 0.02, 20);
    g.player.yaw = -0.42; g.player.pitch = 0.0;
    g.weapons.switchTo(kind, true);
    g.weapons.forceAim = false; g.weapons.aiming = false; g.weapons.adsT = 0;
    for (let i = 0; i < 120; i++) { g.player.update(1 / 120, g); g.weapons.update(1 / 120, g); }
  }, WEAPON);
  await retry(setup, 'setup');
  await sleep(800);

  const tri = await retry(() => page.evaluate(() => {
    const g = window.__game;
    let t = 0;
    g.weapons.current.model.group.traverse((o) => {
      if (o.isMesh && o.geometry?.index) t += o.geometry.index.count / 3;
      else if (o.isMesh) t += o.geometry.attributes.position.count / 3;
    });
    return t;
  }), 'tris');
  console.log(`> viewmodel triangles: ${tri}`);

  for (const v of views) {
    const data = await retry(() => page.evaluate((view, sz) => {
      // Reach THREE's classes through live objects rather than importing the
      // module again — the dev server's bare-specifier resolution is not
      // available to an evaluated script, and a second copy of three would not
      // share the renderer's internal state anyway.
      const g = window.__game;
      const Vec3 = g.camera.position.constructor;
      const Cam = g.viewCamera.constructor;
      const R = g.renderer.renderer || g.renderer;
      const grp = g.weapons.current.model.group;
      grp.updateWorldMatrix(true, true);

      const cam = new Cam(view.fov, 1, 0.005, 6);
      cam.layers.set(1);
      const eye = grp.localToWorld(new Vec3(...view.eye));
      const at = grp.localToWorld(new Vec3(...view.at));
      cam.position.copy(eye);
      cam.up.copy(g.camera.up);
      cam.lookAt(at);
      cam.updateMatrixWorld(true);

      const oldTM = R.toneMapping, oldEx = R.toneMappingExposure, oldTarget = R.getRenderTarget();
      R.setRenderTarget(null);
      R.toneMapping = 4;                 // ACESFilmicToneMapping
      R.toneMappingExposure = view.exposure ?? 0.9;
      const sz0 = R.getSize(new Vec3());
      const pr0 = R.getPixelRatio();
      R.setPixelRatio(1);
      R.setSize(sz, sz, false);
      R.setClearColor(0x30363c, 1);
      const oldAuto = R.autoClear; R.autoClear = true;
      R.clear(true, true, true);
      R.render(g.scene, cam);
      const url = R.domElement.toDataURL('image/png');
      R.autoClear = oldAuto;
      R.toneMapping = oldTM; R.toneMappingExposure = oldEx;
      R.setPixelRatio(pr0);
      R.setSize(sz0.x, sz0.y, false);
      R.setRenderTarget(oldTarget);
      return url;
    }, v, SIZE), v.name);
    const buf = Buffer.from(String(data).split(',')[1], 'base64');
    await writeFile(path.join(OUT, `${v.name}.png`), buf);
    console.log(`  ✓ ${v.name}`);
  }

  await writeFile(path.join(OUT, 'console.log'), logs.join('\n'));
  await browser.close();
  console.log(`> done -> ${OUT}  (${tri} tris on the viewmodel)`);
})();
