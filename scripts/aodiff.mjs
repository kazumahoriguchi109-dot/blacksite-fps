/*
 * Does AO actually reach the screen?
 *
 * `aodebug.mjs` dumps the AO buffer, which tells you the buffer is populated —
 * not that any of it survives to the composite. AO used to be multiplied in
 * before fog and before the additive bloom/shaft terms, so a perfectly good
 * buffer was undone downstream and creases stayed flat. That is the bug this
 * measures: render the graded frame with aoStrength at its real value and at
 * zero, and difference the two.
 *
 *   node scripts/aodiff.mjs
 *
 * Writes shots/dbg/AO_on.png, AO_off.png, AO_composite_diff.png.
 */
import puppeteer from 'puppeteer';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const URL = process.env.URL || 'http://127.0.0.1:5188/';
const OUT = 'shots/dbg';
const W = 1400, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page]', e.message));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 300000, polling: 400 });
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  document.getElementById('loading')?.remove();
});
await sleep(2500);
await mkdir(OUT, { recursive: true });

// A wall/ground junction filling the frame — the exact shot a review called out
// as running "the full 1600 px width with zero darkening".
const info = await page.evaluate(() => {
  const g = window.__game;
  g.player.position.set(-8.5, 0.02, -2.0);
  g.player.velocity.set(0, 0, 0);
  g.player.yaw = 2.05; g.player.pitch = -0.30;
  g.player.recoilPitch = 0; g.player.recoilYaw = 0; g.player.shakeTrauma = 0;
  g.player.bobAmount = 0;
  for (let i = 0; i < 90; i++) { g.player.update(1 / 120, g); g.weapons?.update(1 / 120, g); }
  return { aoStrength: g.postfx.params.aoStrength, eye: +g.camera.position.y.toFixed(2) };
});
console.log('scene', JSON.stringify(info));

await page.evaluate(() => window.__game.postfx.snapExposure?.());
await sleep(600);
const onB64 = await page.screenshot({ encoding: 'base64' });
await writeFile(path.join(OUT, 'AO_on.png'), Buffer.from(onB64, 'base64'));

// Exposure is pinned first: AO changes scene luminance, so auto-exposure would
// chase it and partly cancel the very difference being measured.
await page.evaluate(() => {
  const g = window.__game;
  g.postfx.freezeExposure = true;
  g.postfx.params.aoStrength = 0;
});
await sleep(600);
const offB64 = await page.screenshot({ encoding: 'base64' });
await writeFile(path.join(OUT, 'AO_off.png'), Buffer.from(offB64, 'base64'));

const res = await page.evaluate(async (a, b) => {
  const load = (d) => new Promise((r) => {
    const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + d;
  });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const W = ia.width, H = ia.height;
  const mk = (im) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, 0, 0);
    return x.getImageData(0, 0, W, H).data;
  };
  const A = mk(ia), B = mk(ib);
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H);

  let touched = 0, maxDrop = 0, sum = 0;
  for (let i = 0; i < W * H * 4; i += 4) {
    const lOn = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
    const lOff = 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
    const d = lOff - lOn;                 // positive = AO darkened it
    if (d > maxDrop) maxDrop = d;
    if (d > 4) { touched++; sum += d; }
    const v = Math.max(0, Math.min(255, d * 8));
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return { W, H, touched, maxDrop, meanDrop: touched ? sum / touched : 0,
           png: out.toDataURL('image/png').split(',')[1] };
}, onB64, offB64);

await writeFile(path.join(OUT, 'AO_composite_diff.png'), Buffer.from(res.png, 'base64'));
await browser.close();

const pct = 100 * res.touched / (res.W * res.H);
console.log(`AO darkens ${pct.toFixed(1)}% of the frame, `
  + `mean ${res.meanDrop.toFixed(1)}/255 where it acts, max ${res.maxDrop.toFixed(0)}/255`);
console.log(pct < 5
  ? 'VERDICT: AO is not reaching the composite in any meaningful amount.'
  : 'VERDICT: AO survives to the composite.');
console.log('> shots/dbg/AO_on.png AO_off.png AO_composite_diff.png');
