#!/usr/bin/env node
/*
 * Why is the muzzle flash geometry not on screen?
 *
 * Holds the flash open, then captures the same frame four ways:
 *   1_asis        — as shipped
 *   2_nodepth     — flash materials with depthTest off (isolates occlusion)
 *   3_huge        — flash scaled 6x (isolates "too small / wrong place")
 *   4_worldlayer  — flash moved back to layer 0 (isolates the viewmodel pass)
 * plus a numeric dump of the rig state.
 */
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = 'shots/flashdiag';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(browser) {
  for (let a = 0; a < 5; a++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    // Other agents are editing the same tree. Vite's HMR client answers any
    // save with location.reload(), which destroys the execution context in the
    // middle of a probe. Stubbing WebSocket keeps the client from ever
    // connecting — far cheaper than request interception, which routes every
    // module fetch through CDP and triples boot time.
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
        } catch (e) { await sleep(2500); }
      }
      if (!ok) throw new Error('nav failed');
      await page.waitForFunction(() => !!window.__game, { timeout: 120000, polling: 400 });
      await page.evaluate(() => {
        document.getElementById('overlay')?.classList.add('hidden');
        document.getElementById('loading')?.remove();
      });
      await sleep(3500);
      return page;
    } catch (e) {
      console.log(`  boot ${a + 1} failed: ${e.message.split('\n')[0]}`);
      await page.close().catch(() => {});
      await sleep(3000);
    }
  }
  throw new Error('no boot');
}

const holdFlash = (page) => page.evaluate(async () => {
  const g = window.__game;
  g.fx.config.muzzleFlashDuration = 6.0;
  g.input.down.add('Mouse0');
  await new Promise((r) => setTimeout(r, 90));
  g.input.down.delete('Mouse0');
});

(async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    protocolTimeout: 900000, headless: true,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await boot(browser);

  await page.evaluate(() => {
    const g = window.__game;
    g.input.down.clear();
    g.player.spawn(new g.player.position.constructor(0, 0.02, -6.5), 0);
    g.player.pitch = 0.02;
    for (let i = 0; i < 240; i++) { g.player.update(1 / 120, g); g.weapons.update(1 / 120, g); }
  });
  await sleep(1600);

  await holdFlash(page);
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, '1_asis.png') });

  const dump = await page.evaluate(() => {
    const g = window.__game;
    const f = g.fx._flashes.find((x) => x.active) || g.fx._flashes[0];
    const V3 = g.camera.position.constructor;
    f.core.updateWorldMatrix(true, false);
    const wp = f.core.getWorldPosition(new V3());
    const ndcView = wp.clone().project(g.viewCamera);
    const ndcWorld = wp.clone().project(g.camera);
    const scr = (n) => [Math.round((n.x * 0.5 + 0.5) * 1600), Math.round((-n.y * 0.5 + 0.5) * 900)];
    return {
      active: f.active, t: +f.t.toFixed(3), dur: f.dur,
      groupVisible: f.group.visible,
      coreVisible: f.core.visible,
      corePetalVisible: f.petals.map((p) => p.visible),
      holderScale: f.holder.scale.x,
      coreScale: f.core.scale.toArray(),
      coreColor: f.coreMat.color.toArray().map((v) => +v.toFixed(2)),
      petalColor: f.petalMat.color.toArray().map((v) => +v.toFixed(2)),
      coreWorld: wp.toArray().map((v) => +v.toFixed(3)),
      screenViewCam: scr(ndcView), ndcViewZ: +ndcView.z.toFixed(5),
      screenWorldCam: scr(ndcWorld),
      layers: {
        group: f.group.layers.mask, core: f.core.layers.mask,
        petal: f.petals[0].layers.mask, cone: f.cone.layers.mask,
        viewCam: g.viewCamera.layers.mask, worldCam: g.camera.layers.mask,
      },
      fxRootInScene: !!g.fx.root.parent && g.fx.root.parent === g.scene,
      fxRootVisible: g.fx.root.visible,
      rootLayers: g.fx.root.layers.mask,
      // Is anything of the weapon in front of the flash at that pixel?
      weaponMeshDepths: (() => {
        const out = [];
        g.weapons.root.traverse((o) => {
          if (o.isMesh && o.visible && out.length < 6) {
            const p = o.getWorldPosition(new V3());
            out.push([o.name || '?', +p.distanceTo(g.camera.position).toFixed(3)]);
          }
        });
        return out;
      })(),
      muzzleDist: (() => {
        const m = g.weapons.current.model.muzzle;
        return +m.getWorldPosition(new V3()).distanceTo(g.camera.position).toFixed(3);
      })(),
      viewCamNearFar: [g.viewCamera.near, g.viewCamera.far],
      vmDepthRange: g.postfx.viewmodelDepthRange,
    };
  });
  console.log('STATE', JSON.stringify(dump, null, 1));

  // --- 2: no depth test ----------------------------------------------------
  await page.evaluate(() => {
    const g = window.__game;
    for (const f of g.fx._flashes) {
      f.coreMat.depthTest = false; f.coreMat.needsUpdate = true;
      f.petalMat.depthTest = false; f.petalMat.needsUpdate = true;
      f.coneMat.depthTest = false; f.coneMat.needsUpdate = true;
    }
  });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, '2_nodepth.png') });

  // --- 3: huge -------------------------------------------------------------
  await page.evaluate(() => {
    for (const f of window.__game.fx._flashes) f.holder.scale.setScalar(f.scale * 6);
  });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, '3_huge.png') });

  // --- 4: back on the world layer, depth test restored ---------------------
  await page.evaluate(() => {
    const g = window.__game;
    for (const f of g.fx._flashes) {
      f.holder.scale.setScalar(f.scale);
      f.coneMat.depthTest = true; f.coneMat.needsUpdate = true;
      f.coreMat.depthTest = true; f.coreMat.needsUpdate = true;
      f.petalMat.depthTest = true; f.petalMat.needsUpdate = true;
      f.group.traverse((o) => o.layers.set(0));
    }
    g.fx._flashLayer = 0;      // stop _syncFlashLayer putting it back
  });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, '4_worldlayer.png') });

  await writeFile(path.join(OUT, 'state.json'), JSON.stringify(dump, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
