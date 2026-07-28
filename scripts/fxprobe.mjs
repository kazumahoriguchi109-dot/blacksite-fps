#!/usr/bin/env node
/* FX diagnostic probe — decals, flash, exposure. Read-only against the running dev server. */
import puppeteer from 'puppeteer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    protocolTimeout: 900000,
    headless: true,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:5188', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
  await page.evaluate(() => {
    document.getElementById('overlay')?.classList.add('hidden');
    document.getElementById('loading')?.remove();
  });
  await sleep(3000);

  await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
  const out = await page.evaluate(async () => {
    const g = window.__game;
    const res = {};
    const w = g.world;
    const col = w?.collider;
    res.hasCollider = !!col;
    res.colliderMatrix = col ? Array.from(col.matrixWorld.elements) : null;
    res.hasBVH = !!col?.geometry?.boundsTree;
    res.bvhKeys = col?.geometry?.boundsTree ? Object.getOwnPropertyNames(
      Object.getPrototypeOf(col.geometry.boundsTree)).slice(0, 20) : null;
    res.triCount = col?.geometry?.index ? col.geometry.index.count / 3
      : (col?.geometry?.attributes?.position?.count ?? 0) / 3;

    // --- position the player facing a wall and fire one round through the real path
    g.player.spawn(g.world.spawnPoints[0], 0);
    g.player.pitch = 0;
    g.input.down.clear();
    for (let i = 0; i < 60; i++) g.player.update(1 / 120, g);

    const fx = g.fx;
    fx.clear?.();
    const decalsBefore = fx.decals.count;

    // Raycast straight ahead to find something to shoot.
    const cam = g.camera;
    const dir = cam.getWorldDirection(new cam.position.constructor());
    const rc = new (Object.getPrototypeOf(g.weapons.ballistics._ray).constructor)();
    rc.firstHitOnly = true;
    rc.set(cam.position, dir);
    rc.far = 200;
    const hits = col ? rc.intersectObject(col, false) : [];
    res.forwardHit = hits.length ? {
      dist: hits[0].distance,
      point: hits[0].point.toArray(),
      hasFace: !!hits[0].face,
      normal: hits[0].face ? hits[0].face.normal.toArray() : null,
      faceIndex: hits[0].faceIndex,
    } : null;

    if (hits.length) {
      const h = hits[0];
      const n = h.face.normal.clone();
      const slot = fx.decals.spawn(h.point, n, 'concrete', 0.22, { life: 45 });
      res.directSpawnSlot = slot;
      res.srcCountAfter = fx.decals._srcCount;
      fx.decals.update(0.1);
      res.decalCountAfterDirect = fx.decals.count;
      res.drawRange = fx.decals.geometry.drawRange.count;

      // now the full impact path
      fx.impact(h.point, n, 'concrete');
      fx.decals.update(0.1);
      res.decalCountAfterImpact = fx.decals.count;
      res.particlesAlive = fx.particles.liveCount;
    }

    // --- fire the real weapon a few times
    for (let i = 0; i < 30; i++) {
      g.input.down.add('Mouse0');
      g.player.update(1 / 120, g);
      g.weapons.update(1 / 120, g);
      g.fx.update(1 / 120, g);
    }
    g.input.down.delete('Mouse0');
    res.afterRealFire = {
      decals: fx.decals.count,
      particles: fx.particles.liveCount,
      shellsActive: fx._shells.filter((s) => s.active).length,
      flashesActive: fx._flashes.filter((f) => f.active).length,
      muzzleLightIntensity: fx._muzzleLight.light.intensity,
      muzzleLightLayers: fx._muzzleLight.light.layers.mask,
      flashLayers: fx._flashes[0].group.layers.mask,
      flashChildLayers: fx._flashes[0].core.layers.mask,
      particleMeshLayers: fx.particles.meshes[0].layers.mask,
      decalMeshLayers: fx.decals.mesh.layers.mask,
    };

    // --- exposure readback
    try {
      const p = g.postfx;
      const rt = p.adaptRT[p.adaptIndex];
      const buf = new Float32Array(4);
      g.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, buf);
      res.adaptedLum = buf[0];
      res.evParams = { keyValue: p.params.keyValue, evMin: p.params.evMin,
                       evMax: p.params.evMax, exposure: p.params.exposure,
                       auto: p.params.autoExposure };
      res.ev = p.params.exposure * Math.min(p.params.evMax,
        Math.max(p.params.evMin, p.params.keyValue / Math.max(buf[0], 0.0002)));
      res.viewmodelDepthRange = p.viewmodelDepthRange;
    } catch (e) { res.exposureErr = String(e); }

    // sun
    res.sun = {
      intensity: g.sky?.sunLight?.intensity,
      color: g.sky?.sunLight?.color?.toArray?.(),
      envIntensity: g.scene.environmentIntensity,
    };
    const muzzle = g.weapons.current?.model?.muzzle;
    if (muzzle) {
      const mp = muzzle.getWorldPosition(new cam.position.constructor());
      res.muzzleDistToCamera = mp.distanceTo(cam.position);
      res.muzzleLayers = muzzle.layers.mask;
    }
    return res;
  });

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
