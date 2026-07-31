/*
 * Bisect a visual defect by hiding meshes, material class by material class.
 *
 * This is the tool that finally identified the skyline hairlines. Raycasting at
 * them found nothing, a per-mesh "long and thin on screen" search found nothing,
 * and an inventory of geometry above 18 m found nothing — all because spatial
 * chunking merges hundreds of props into a handful of meshes, so no per-mesh
 * property describes any individual prop. Hiding a whole material class and
 * re-shooting sidesteps that entirely: whatever disappears was made of that.
 *
 *   node scripts/isolate.mjs --hide '^facade_far' --hide 'metal|steel'
 *   node scripts/isolate.mjs --hide '^facade_far' --fov 16 --yaw 3.14
 *
 * Writes shots/dbg/ISO_0.png (everything) then ISO_1.png, ISO_2.png … each with
 * one more class hidden. Post-processing is off so what you see is what the
 * geometry actually is.
 */
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const hides = [];
let fov = 16, yaw = 3.14, pitch = -0.02, pos = [0, 10.95, -26];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--hide') hides.push(argv[++i]);
  else if (argv[i] === '--fov') fov = Number(argv[++i]);
  else if (argv[i] === '--yaw') yaw = Number(argv[++i]);
  else if (argv[i] === '--pitch') pitch = Number(argv[++i]);
  else if (argv[i] === '--pos') pos = argv[++i].split(',').map(Number);
}
if (!hides.length) {
  console.error('nothing to hide — pass at least one --hide <regex>');
  process.exit(1);
}

const OUT = 'shots/dbg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.goto('http://127.0.0.1:5188', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => !!window.__game, { timeout: 300000, polling: 400 });
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  document.getElementById('loading')?.remove();
});
await sleep(3000);
await mkdir(OUT, { recursive: true });

await page.evaluate(({ pos, yaw, pitch, fov }) => {
  const g = window.__game;
  g.player.position.set(pos[0], pos[1], pos[2]);
  g.player.yaw = yaw; g.player.pitch = pitch;
  g.player.velocity.set(0, 0, 0);
  g.player.baseFov = fov; g.player.fov = fov;
  for (let i = 0; i < 90; i++) { g.player.update(1 / 120, g); g.weapons?.update(1 / 120, g); }
  g.postfx.enabled = false;      // grade and bloom only obscure what is there
}, { pos, yaw, pitch, fov });
await sleep(900);
await page.screenshot({ path: path.join(OUT, 'ISO_0.png') });
console.log('  ISO_0.png  everything');

for (let i = 0; i < hides.length; i++) {
  const n = await page.evaluate((src) => {
    const g = window.__game, re = new RegExp(src);
    let n = 0;
    g.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const m = (Array.isArray(o.material) ? o.material[0] : o.material)?.name || '';
      if (re.test(m)) { o.visible = false; n++; }
    });
    return n;
  }, hides[i]);
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, `ISO_${i + 1}.png`) });
  console.log(`  ISO_${i + 1}.png  −/${hides[i]}/  (${n} meshes hidden)`);
}

await browser.close();
console.log(`> ${OUT}/ISO_0..${hides.length}.png`);
