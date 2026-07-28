#!/usr/bin/env node
/*
 * Key-to-fill measurement, by sun differencing.
 *
 * The previous version scanned one horizontal line and called its darkest
 * decile "shadow". That was wrong in two ways: the scanline crossed the
 * viewmodel (whose dark handguard became the "shadow" sample), and the pose had
 * drifted to a spot with no cast shadow in frame at all. It reported 79:1 for a
 * scene whose real ratio was 3.7:1.
 *
 * This measures the same pixel twice instead: once normally (key + fill) and
 * once with the sun's intensity zeroed (fill alone). Their ratio IS the
 * key-to-fill ratio by construction — no need to guess which pixels are
 * shadowed, and it is immune to what happens to be in frame.
 *
 * The viewmodel is hidden and auto-exposure is disabled for the measurement,
 * and only pixels receiving meaningful direct sun are counted.
 *
 * Usage: node scripts/keyfill.mjs [--url http://...]
 */

import puppeteer from 'puppeteer';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; })
);

// Ground-level poses looking across open, sunlit ground with geometry casting
// into frame, so a large fraction of pixels is bare ground.
const POSES = [
  { name: 'courtyard',   pos: [4, 0.02, 20],  yaw: -0.42, pitch: -0.22 },
  { name: 'apron_north', pos: [0, 0.02, -14], yaw: 0,     pitch: -0.30 },
  { name: 'open_south',  pos: [0, 0.02, 34],  yaw: 0,     pitch: -0.26 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

(async () => {
  const browser = await puppeteer.launch({
    protocolTimeout: 900000, headless: true,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(args.url || 'http://127.0.0.1:5188', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => !!window.__game, { timeout: 300000, polling: 400 });
  await page.evaluate(() => {
    document.getElementById('overlay')?.classList.add('hidden');
    document.getElementById('loading')?.remove();
    // The viewmodel is the darkest thing in most frames and is not part of the
    // scene's lighting, so it must not participate in the measurement.
    window.__game.weapons.root.visible = false;
    // Auto-exposure would silently compensate between the lit and unlit frames
    // and destroy the comparison.
    window.__game.postfx.params.autoExposure = false;
  });
  await sleep(2500);

  const grab = () => page.evaluate(() => {
    const g = window.__game, r = g.renderer, rt = g.postfx.gradeRT;
    const buf = new Uint8Array(rt.width * rt.height * 4);
    r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
    return Array.from(buf);
  });

  for (const pose of POSES) {
    await page.evaluate((p) => {
      const g = window.__game, pl = g.player;
      pl.position.set(p.pos[0], p.pos[1], p.pos[2]);
      pl.yaw = p.yaw; pl.pitch = p.pitch; pl.velocity.set(0, 0, 0);
      for (let i = 0; i < 60; i++) pl.update(1 / 120, g);
    }, pose);
    await sleep(900);
    const lit = await grab();

    // Same frame, sun removed: what remains is exactly the fill.
    await page.evaluate(() => {
      const s = window.__game.sky.sunLight;
      s.userData._i = s.intensity;
      s.intensity = 0;
    });
    await sleep(900);
    const fill = await grab();
    await page.evaluate(() => {
      const s = window.__game.sky.sunLight;
      s.intensity = s.userData._i;
    });

    // Ratio of MEANS, not mean of ratios: pixels whose fill is near zero make
    // L/F explode, and averaging those makes the result meaningless (it read
    // 177:1 for a scene measuring 6:1). A median is reported alongside as a
    // distribution-shape check.
    let n = 0, sumL = 0, sumF = 0;
    const ratios = [];
    let fr = 0, fg = 0, fb = 0, lr = 0, lg = 0, lb = 0;
    for (let i = 0; i < lit.length; i += 4) {
      const L = lin(lit[i] / 255) * 0.2126 + lin(lit[i + 1] / 255) * 0.7152 + lin(lit[i + 2] / 255) * 0.0722;
      const F = lin(fill[i] / 255) * 0.2126 + lin(fill[i + 1] / 255) * 0.7152 + lin(fill[i + 2] / 255) * 0.0722;
      if (L - F < 0.02 || F < 1e-5) continue;   // no meaningful direct sun here
      sumL += L; sumF += F;
      if ((i >> 2) % 13 === 0) ratios.push(L / F);
      n++;
      fr += lin(fill[i] / 255); fg += lin(fill[i + 1] / 255); fb += lin(fill[i + 2] / 255);
      lr += lin(lit[i] / 255);  lg += lin(lit[i + 1] / 255);  lb += lin(lit[i + 2] / 255);
    }
    if (!n) { console.log(pose.name.padEnd(13), 'no sunlit pixels in frame'); continue; }
    const ratio = sumL / sumF;
    ratios.sort((a, b) => a - b);
    const median = ratios[ratios.length >> 1] ?? ratio;
    console.log(pose.name.padEnd(13), JSON.stringify({
      // The median is the headline: it answers "how much brighter is a typical
      // sunlit pixel than the same pixel would be under fill alone", which is
      // the definition. The mean is reported too, but a handful of very bright
      // fill pixels (sky-facing surfaces, speculars) drag it well below the
      // perceptual ratio.
      keyFill: +median.toFixed(2),
      stops: +Math.log2(median).toFixed(2),
      meanRatio: +ratio.toFixed(2),
      shadowBlueRed: +(fb / Math.max(fr, 1e-6)).toFixed(3),
      sunlitBlueRed: +(lb / Math.max(lr, 1e-6)).toFixed(3),
      sunlitPixels: `${(100 * n / (lit.length / 4)).toFixed(1)}%`,
    }));
  }

  const info = await page.evaluate(() => {
    const g = window.__game;
    let hemi = 0;
    g.scene.traverse((o) => { if (o.isHemisphereLight) hemi = o.intensity; });
    return {
      envIntensity: g.scene.environmentIntensity,
      hemi: +hemi.toFixed(3),
      sunIntensity: +g.sky.sunLight.intensity.toFixed(2),
      exposure: g.postfx.params.exposure,
    };
  });
  console.log('lighting     ', JSON.stringify(info));
  console.log('\ntarget: keyFill 5-8 (2.3-3 stops), shadowBlueRed 1.15-1.25, sunlitBlueRed 0.80-0.90');
  await browser.close();
})();
