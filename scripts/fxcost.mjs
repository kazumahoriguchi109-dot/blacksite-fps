#!/usr/bin/env node
/* What do the weapon FX actually cost? Draw calls and triangles with the FX
 * pools empty vs. mid-burst, from the same camera pose. */
import puppeteer from 'puppeteer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    protocolTimeout: 900000, headless: true,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(() => {
    const FakeWS = class extends EventTarget {
      constructor() { super(); this.readyState = 3; this.url = ''; this.protocol = ''; }
      send() {} close() {}
    };
    FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
    window.WebSocket = FakeWS;
  });
  await page.goto('http://127.0.0.1:5188', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!window.__game, { timeout: 180000, polling: 400 });
  await page.evaluate(() => {
    document.getElementById('overlay')?.classList.add('hidden');
    document.getElementById('loading')?.remove();
  });
  await sleep(3500);

  await page.evaluate(() => {
    const g = window.__game;
    g.input.down.clear();
    g.player.spawn(new g.player.position.constructor(4, 0.02, 18), 0);
    g.player.pitch = -0.02;
    for (let i = 0; i < 240; i++) { g.player.update(1 / 120, g); g.weapons.update(1 / 120, g); }
    g.fx.clear();
  });
  await sleep(1500);
  const idle = await page.evaluate(() => ({
    calls: window.__game.renderer.info.render.calls,
    tris: window.__game.renderer.info.render.triangles,
    fps: Math.round(window.__game.fps),
  }));

  await page.evaluate(() => { window.__game.input.down.add('Mouse0'); });
  await sleep(2400);                       // a whole magazine
  const firing = await page.evaluate(() => ({
    calls: window.__game.renderer.info.render.calls,
    tris: window.__game.renderer.info.render.triangles,
    fps: Math.round(window.__game.fps),
    shells: window.__game._ ? 0 : window.__game.fx._shells.filter((s) => s.active).length,
    particles: window.__game.fx.particles.liveCount,
    decals: window.__game.fx.decals.count,
  }));
  await page.evaluate(() => { window.__game.input.down.delete('Mouse0'); });

  console.log(JSON.stringify({ idle, firing,
    delta: { calls: firing.calls - idle.calls, tris: firing.tris - idle.tris } }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
