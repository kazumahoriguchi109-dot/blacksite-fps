#!/usr/bin/env node
/*
 * Weapon-FX capture: fire the real weapon at close range in daylight and again
 * in the warehouse interior, so the flash, tracer, decals, dust, brass and
 * smoke can be looked at in both lighting conditions from one boot.
 *
 * Usage: node scripts/fxshots.mjs --out shots/fx_v2
 */
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; })
);
const OUT = args.out || 'shots/fx';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(browser) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    // Block Vite's HMR client: a concurrent save by another agent otherwise
    // reloads the page mid-capture and destroys the execution context. Stubbing
    // WebSocket is much cheaper than request interception.
    // Must be a *complete* WebSocket stand-in: Vite injects an import of
    // /@vite/client into every transformed module, so if that module throws
    // while evaluating, the entire graph fails and the game never boots.
    await page.evaluateOnNewDocument(() => {
      const FakeWS = class extends EventTarget {
        constructor() {
          super();
          this.readyState = 3; this.url = ''; this.protocol = ''; this.bufferedAmount = 0;
        }
        send() {} close() {}
      };
      FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
    try {
      let ok = false;
      for (let i = 0; i < 10 && !ok; i++) {
        try {
          const r = await page.goto('http://127.0.0.1:5188',
            { waitUntil: 'domcontentloaded', timeout: 60000 });
          ok = !!r && r.status() < 400;
        } catch (e) {
          console.log(`  nav retry ${i + 1}: ${e.message.split('\n')[0]}`);
          await sleep(2500);
        }
      }
      if (!ok) throw new Error('navigation never succeeded');
      await page.waitForFunction(() => !!window.__game, { timeout: 120000, polling: 400 });
      await page.evaluate(() => {
        document.getElementById('overlay')?.classList.add('hidden');
        document.getElementById('loading')?.remove();
      });
      await sleep(3500);
      return page;
    } catch (e) {
      console.log(`  boot attempt ${attempt + 1} failed: ${e.message.split('\n')[0]}`);
      await page.close().catch(() => {});
      await sleep(3000);
    }
  }
  throw new Error('could not boot the game');
}

/** Put the player somewhere, settle every spring, and let exposure converge. */
async function pose(page, pos, yaw, pitch) {
  await page.evaluate((p, y, pi) => {
    const g = window.__game;
    g.input.down.clear();
    g.player.spawn(new g.player.position.constructor(p[0], p[1], p[2]), y);
    g.player.pitch = pi;
    g.player.dead = false;
    g.player.health = 100;
    g.fx.clear();
    for (let i = 0; i < 240; i++) { g.player.update(1 / 120, g); g.weapons.update(1 / 120, g); }
    g.weapons.current.mag = g.weapons.current.def.magSize;
  }, pos, yaw, pitch);
  await sleep(1600);   // real frames: eye adaptation + FX update
}

/*
 * A 48 ms flash against an ~80 ms cycle means roughly half of all frames have
 * no flash in them at all — which is correct, and also means a single capture
 * proves nothing either way. Take four during the burst.
 */
async function burst(page, out, tag, holdMs, settleMs) {
  await page.evaluate(() => { window.__game.input.down.add('Mouse0'); });
  await sleep(holdMs);
  for (let i = 1; i <= 4; i++) {
    await page.screenshot({ path: path.join(out, `${tag}_firing${i}.png`) });
    await sleep(70);
  }
  await page.evaluate(() => { window.__game.input.down.delete('Mouse0'); });
  await sleep(settleMs);
  await page.screenshot({ path: path.join(out, `${tag}_after.png`) });
}

const state = (page) => page.evaluate(() => {
  const g = window.__game;
  const P = g.postfx.params;
  return {
    expMode: g.fx._expMode, expComp: +g.fx._expComp.toFixed(3),
    decalHits: g.fx._decalHits, decalMisses: g.fx._decalMisses,
    decals: g.fx.decals.count, particles: g.fx.particles.liveCount,
    shells: g.fx._shells.filter((s) => s.active).length,
    envIntensity: +(g.scene.environmentIntensity ?? 0).toFixed(3),
    evRange: [P.evMin, P.evMax],
    fps: Math.round(g.fps), calls: g.renderer.info.render.calls,
    tris: g.renderer.info.render.triangles,
  };
});

(async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    protocolTimeout: 900000,
    headless: true,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await boot(browser);
  const report = {};

  // 1. Daylight, close to the admin-block facade so decals and dust are legible.
  console.log('· exterior, near wall');
  await pose(page, [0, 0.02, -6.5], 0, 0.02);
  await burst(page, OUT, 'A_ext_near', 480, 900);
  report.exteriorNear = await state(page);

  // 2. Daylight, the courtyard framing the review used.
  console.log('· exterior, courtyard');
  await pose(page, [4, 0.02, 18], 0, -0.02);
  await page.evaluate(() => window.__game.ai?.spawnWave?.(5));
  await sleep(700);
  await burst(page, OUT, 'B_ext_wide', 480, 900);
  report.exteriorWide = await state(page);

  // 3. Warehouse interior: sky IBL and fog both drop, so the same flash has to
  //    read against a much darker plate.
  console.log('· warehouse interior');
  await pose(page, [32, 0.02, 16], 0, 0.04);
  await sleep(2200);                        // let eye adaptation settle down
  await burst(page, OUT, 'C_interior', 480, 900);
  report.interior = await state(page);

  // 4. ADS, where the world FOV narrows to 38 and the viewmodel stays at 55.
  console.log('· ADS');
  await pose(page, [0, 0.02, -6.5], 0, 0.02);
  await page.evaluate(() => { window.__game.weapons.forceAim = true; });
  await sleep(700);
  await burst(page, OUT, 'D_ads', 420, 800);
  await page.evaluate(() => { window.__game.weapons.forceAim = false; });
  report.ads = await state(page);

  // 5. Flash freeze. A 48 ms flash is two rendered frames, so a screenshot
  //    mostly misses it. Stretching the decay lets the geometry — core, petals,
  //    gas cone, scale relative to the barrel — actually be inspected. Not a
  //    gameplay frame: it is the flash held open.
  console.log('· flash freeze (diagnostic)');
  await pose(page, [0, 0.02, -6.5], 0, 0.02);
  await page.evaluate(() => {
    const g = window.__game;
    g.fx.config.muzzleFlashDuration = 1.2;
    g.input.down.add('Mouse0');
  });
  await sleep(120);
  await page.evaluate(() => { window.__game.input.down.delete('Mouse0'); });
  await sleep(160);
  await page.screenshot({ path: path.join(OUT, 'E_flashfreeze.png') });
  await page.evaluate(() => { window.__game.fx.config.muzzleFlashDuration = 0.048; });

  console.log(JSON.stringify(report, null, 1));
  await writeFile(path.join(OUT, 'fxstate.json'), JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
