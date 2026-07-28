#!/usr/bin/env node
/*
 * FX diagnostic probe v2 — why decals/flash/tracers do or do not appear.
 *
 * Read-only against the running dev server. Retries navigation because the dev
 * server occasionally drops a connection mid-boot.
 *
 * Usage: node scripts/fxprobe2.mjs
 */
import puppeteer from 'puppeteer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The dev server intermittently rebinds its listening socket (a save during a
 * run is enough), which shows up as ERR_CONNECTION_REFUSED / ERR_EMPTY_RESPONSE
 * mid-boot and then a 240 s wait for a `window.__game` that is never coming.
 * So: retry the whole load, not just the navigation.
 */
async function boot(browser) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
    try {
      let ok = false;
      for (let i = 0; i < 10 && !ok; i++) {
        try {
          const r = await page.goto('http://127.0.0.1:5188', {
            waitUntil: 'domcontentloaded', timeout: 60000,
          });
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
      await sleep(3000);
      return page;
    } catch (e) {
      console.log(`  boot attempt ${attempt + 1} failed: ${e.message.split('\n')[0]}`);
      await page.close().catch(() => {});
      await sleep(3000);
    }
  }
  throw new Error('could not boot the game');
}

(async () => {
  const browser = await puppeteer.launch({
    protocolTimeout: 900000,
    headless: true,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await boot(browser);

  const out = await page.evaluate(async () => {
    const g = window.__game;
    const res = {};
    const V3 = g.camera.position.constructor;

    // ---------------------------------------------------------- collider ----
    const col = g.world?.collider;
    res.collider = {
      present: !!col,
      identityMatrix: col ? col.matrixWorld.elements.every((v, i) =>
        Math.abs(v - [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1][i]) < 1e-6) : null,
      hasBVH: !!col?.geometry?.boundsTree,
      hasShapecast: typeof col?.geometry?.boundsTree?.shapecast === 'function',
      tris: col?.geometry?.index ? col.geometry.index.count / 3
        : (col?.geometry?.attributes?.position?.count ?? 0) / 3,
      inScene: !!col?.parent,
      visible: col?.visible,
    };
    res.decalMesh = {
      inScene: !!g.fx.decals.mesh.parent,
      visible: g.fx.decals.mesh.visible,
      layers: g.fx.decals.mesh.layers.mask,
      drawRange: g.fx.decals.geometry.drawRange.count,
      surfaceOffset: g.fx.decals.surfaceOffset,
    };

    // ------------------------------------------------- aim at a real wall ---
    g.player.spawn(g.world.spawnPoints[0], 0);
    g.player.pitch = 0;
    g.input.down.clear();
    for (let i = 0; i < 90; i++) g.player.update(1 / 120, g);

    const cam = g.camera;
    const dir = cam.getWorldDirection(new V3());
    const rc = new (Object.getPrototypeOf(g.weapons.ballistics._ray).constructor)();
    rc.firstHitOnly = true;
    rc.set(cam.position, dir);
    rc.far = 200;
    const hits = col ? rc.intersectObject(col, false) : [];
    res.hit = hits.length ? {
      dist: +hits[0].distance.toFixed(3),
      point: hits[0].point.toArray().map((v) => +v.toFixed(3)),
      localNormal: hits[0].face?.normal.toArray().map((v) => +v.toFixed(3)) ?? null,
    } : null;

    g.fx.clear();
    if (hits.length) {
      const h = hits[0];
      const n = h.face.normal.clone();
      // step 1: raw decal projection
      const slot = g.fx.decals.spawn(h.point, n, 'concrete', 0.22, { life: 45 });
      res.decalDirect = {
        slot,
        srcVerts: g.fx.decals._srcCount,
        drawRange: g.fx.decals.geometry.drawRange.count,
      };
      g.fx.decals.update(0.2);
      res.decalDirect.count = g.fx.decals.count;
      res.decalDirect.fade0 = g.fx.decals._fadeData[Math.max(0, slot) * 4];

      // step 2: full impact path
      g.fx.impact(h.point, n, 'concrete');
      g.fx.decals.update(0.2);
      res.decalAfterImpact = g.fx.decals.count;
      res.particlesAfterImpact = g.fx.particles.liveCount;
    }

    // --------------------------------------------- real weapon fire path ----
    g.fx.clear();
    let flashSeen = 0, lightPeak = 0;
    for (let i = 0; i < 24; i++) {
      g.input.down.add('Mouse0');
      g.player.update(1 / 120, g);
      g.weapons.update(1 / 120, g);
      g.fx.update(1 / 120, g);
      flashSeen = Math.max(flashSeen, g.fx._flashes.filter((f) => f.active).length);
      lightPeak = Math.max(lightPeak, g.fx._muzzleLight.light.intensity);
    }
    g.input.down.delete('Mouse0');
    res.realFire = {
      decalHits: g.fx._decalHits,
      decalMisses: g.fx._decalMisses,
      expComp: g.fx._expComp,
      expMode: g.fx._expMode,       // 0 async, 1 sync, 2 estimate
      flashLayer: g.fx._flashLayer,
      flashChildLayers: g.fx._flashes[0].core.layers.mask,
      livePetals: g.fx._flashes.map((f) => f.live),
      decals: g.fx.decals.count,
      particles: g.fx.particles.liveCount,
      shells: g.fx._shells.filter((s) => s.active).length,
      flashes: flashSeen,
      muzzleLightPeak: +lightPeak.toFixed(1),
      muzzleLightLayers: g.fx._muzzleLight.light.layers.mask,
      flashGroupLayers: g.fx._flashes[0].group.layers.mask,
      particleMeshLayers: g.fx.particles.meshes[0].layers.mask,
      decalDrawRange: g.fx.decals.geometry.drawRange.count,
    };

    // ------------------------------------------------- camera / viewmodel ---
    const muzzle = g.weapons.current?.model?.muzzle;
    if (muzzle) {
      muzzle.updateWorldMatrix(true, false);
      const mp = muzzle.getWorldPosition(new V3());
      const local = cam.worldToLocal(mp.clone());
      res.muzzle = {
        world: mp.toArray().map((v) => +v.toFixed(3)),
        camLocal: local.toArray().map((v) => +v.toFixed(3)),
        distToCam: +mp.distanceTo(cam.position).toFixed(3),
        layers: muzzle.layers.mask,
      };
      // where does it land on screen under each camera?
      const proj = (c) => {
        c.updateMatrixWorld();
        const v = mp.clone().project(c);
        return [+((v.x * 0.5 + 0.5) * 1600).toFixed(0), +((-v.y * 0.5 + 0.5) * 900).toFixed(0)];
      };
      res.muzzleScreen = { world: proj(cam), view: proj(g.viewCamera) };
    }
    res.fov = { world: cam.fov, view: g.viewCamera?.fov, near: cam.near };

    // ------------------------------------------------------- exposure -------
    try {
      const p = g.postfx;
      const rt = p.adaptRT[p.adaptIndex];
      const buf = new Uint16Array(4);
      g.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, buf);
      // decode half float
      const h = buf[0];
      const s = (h & 0x8000) ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const f = h & 0x3ff;
      let val;
      if (e === 0) val = s * Math.pow(2, -14) * (f / 1024);
      else if (e === 31) val = f ? NaN : s * Infinity;
      else val = s * Math.pow(2, e - 15) * (1 + f / 1024);
      res.adaptedLum = val;
      const P = p.params;
      res.ev = P.exposure * Math.min(P.evMax, Math.max(P.evMin, P.keyValue / Math.max(val, 2e-4)));
      res.evParams = { key: P.keyValue, min: P.evMin, max: P.evMax, exp: P.exposure };
      res.hasAsyncRead = typeof g.renderer.readRenderTargetPixelsAsync === 'function';
    } catch (e) { res.exposureErr = String(e); }

    res.env = {
      environmentIntensity: g.scene.environmentIntensity,
      sunIntensity: g.sky?.sunLight?.intensity,
      fogDensity: g.postfx?.params?.fogDensity,
    };
    res.fxConfig = { tracerSpeed: g.fx.config.tracerSpeed, tracerEvery: g.fx.config.tracerEvery,
                     muzzleLightPeak: g.fx.config.muzzleLightPeak };
    return res;
  });

  console.log('---JSON---');
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
