#!/usr/bin/env node
/* TEMP probe — drives the HUD through every state that changes behaviour and
 * captures each one over the hardest background in the map (into the sun).
 *
 *   node scripts/_hudstates.mjs [--out shots/hud_states] [--pose sun|int]
 */
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; })
);
const OUT = args.out || 'shots/hud_states';
const POSE = args.pose || 'sun';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({
  protocolTimeout: 900000, headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
         '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });

await page.goto('http://127.0.0.1:5188', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  document.getElementById('loading')?.remove();
});
await sleep(2500);

/* Vite hot-reload can re-boot the page out from under us (STATUS.md lists this
 * as a known harness trap). Wait until __game has been the SAME object for a
 * few seconds before driving anything. */
async function settle() {
  for (let i = 0; i < 60; i++) {
    await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
    await page.evaluate(() => { window.__probeMark = window.__game; });
    await sleep(3000);
    const same = await page.evaluate(() => !!window.__game && window.__probeMark === window.__game)
      .catch(() => false);
    if (same) return;
    console.log('  … page re-booted, waiting');
  }
  throw new Error('page never settled');
}
await settle();

async function pose(kind) {
  await page.evaluate((k) => {
    const g = window.__game, pl = g.player;
    if (k === 'int') { pl.position.set(30, 0.02, 6); pl.yaw = 2.0; pl.pitch = -0.02; }
    else { pl.position.set(10, 0.02, 10); pl.pitch = 0.22; }
    g.input.down.delete('ControlLeft');
    pl.velocity.set(0, 0, 0);
    pl.recoilPitch = 0; pl.recoilYaw = 0; pl.shakeTrauma = 0;
    pl.bobAmount = 0; pl.landDip = 0; pl.lean = 0;
    pl.baseFov = 60; pl.fov = 60;
    if (k !== 'int' && g.sky?.sunDirection) {
      const d = g.sky.sunDirection;
      pl.yaw = Math.atan2(d.x, d.z);
      pl.pitch = Math.asin(Math.max(-1, Math.min(1, -d.y))) * 0.9;
    }
    if (g.weapons) { g.weapons.forceAim = false; g.weapons.aiming = false; g.weapons.adsT = 0; }
    for (let i = 0; i < 90; i++) { pl.update(1 / 120, g); g.weapons?.update(1 / 120, g); }
  }, kind);
  await sleep(900);
  await page.evaluate(() => window.__game.postfx.snapExposure?.());
  await sleep(320);
}

await pose(POSE);

const shot = async (name) => {
  try {
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('  ✓', name);
  } catch (e) { console.log('  ✗', name, e.message); }
};
// set the magazine through the real sync path, not by poking the field
const setMag = (n) => page.evaluate((v) => {
  const g = window.__game;
  g.weapons.current.mag = v;
  g.weapons._syncHud();
}, n);

/* ---- 1: taking fire from three bearings, hp 34, killfeed stacked --------- */
await page.evaluate(() => {
  const g = window.__game, hud = g.hud, cam = g.camera;
  g.player.health = 34; g.player.dead = false;
  const p = cam.position;
  const off = (ax, az) => ({ x: p.x + ax, y: p.y, z: p.z + az });
  const f = { x: -Math.sin(g.player.yaw), z: Math.cos(g.player.yaw) };
  // right flank, behind, and front-left, in world space relative to the camera
  hud.damageFrom(off(f.z * 9, -f.x * 9));
  hud.damageFrom(off(f.x * 9, f.z * 9));
  hud.damageFrom(off(-f.z * 6 - f.x * 6, f.x * 6 - f.z * 6));
  for (let i = 0; i < 4; i++) hud.killfeed('YOU', 'HOSTILE-0' + (i + 1), 'rifle', i === 1);
});
await sleep(260);
await shot('S1_under_fire');

/* ---- 2: hitmarker + low ammo -------------------------------------------- */
await page.evaluate(() => {
  const g = window.__game, hud = g.hud;
  g.player.health = 100;
  // keep one hitmarker permanently fresh so the screenshot cannot miss it
  window.__hm = setInterval(() => g.hud.hitmarker('headshot'), 90);
});
await setMag(4);
await sleep(300);
await shot('S2_hitmarker_lowammo');
await page.evaluate(() => clearInterval(window.__hm));

/* ---- 3: empty magazine --------------------------------------------------- */
await setMag(0);
await page.evaluate(() => {
  window.__game.hud.killfeed('YOU', 'HOSTILE-05', 'shotgun', false);
});
await sleep(700);
await shot('S3_empty');

/* ---- 4: reloading -------------------------------------------------------- */
await page.evaluate(() => { window.__game.weapons.reload(); });
await sleep(650);
await shot('S4_reloading');

/* ---- 5: critical health, no death ---------------------------------------- */
await sleep(1400);
await page.evaluate(() => {
  const g = window.__game;
  g.player.health = 12; g.player.regenDelay = 9;
  g.hud.damageFrom(null);
});
await sleep(400);
await shot('S5_critical');

/* ---- 6: dead + death banner ---------------------------------------------- */
await page.evaluate(() => {
  const g = window.__game;
  g.player.health = 0; g.player.dead = true;
  g.hud.showBanner('YOU WERE KILLED', 'Respawning');
});
await sleep(900);
await shot('S6_dead');

/* ---- 7: respawn banner over the same blown sky --------------------------- */
await page.evaluate(() => {
  const g = window.__game;
  g.player.health = 100; g.player.dead = false;
  g.weapons.current.mag = g.weapons.current.def.magSize;
  g.weapons._syncHud();
  g.hud.showBanner('WAVE 2', 'Back in the fight');
  g.hud.setObjective('WAVE 2 — ELIMINATE ALL HOSTILES');
});
await sleep(900);
await shot('S7_respawn_banner');

/* ---- 8: clean idle, everything settled ----------------------------------- */
await sleep(2600);
await shot('S8_idle');

const st = await page.evaluate(() => {
  const h = window.__game.hud;
  return { hp: h.hp, dead: h.dead, mag: h.mag, banner: h.banner.active, crit: h.banner.critical };
});
console.log('  hud state', JSON.stringify(st));
await browser.close();
