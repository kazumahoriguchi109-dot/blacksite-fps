/*
 * Isolates the sun shadow's actual contribution.
 *
 * "There is no cast shadow" is not something you can settle by looking at a
 * screenshot — a dark patch could be AO, the blob decal, or the ground simply
 * being unlit. So render the same frame twice, once with sun.castShadow off,
 * and difference them. Every pixel that changes is a pixel the shadow map is
 * actually darkening. Nothing else in the frame moves.
 *
 *   node scripts/shadowdiff.mjs
 *
 * Writes shots/dbg/S_lit.png, S_noshadow.png, S_diff.png and prints the
 * fraction of the lower-third (ground) that the shadow map touches.
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
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu',
         '--enable-features=Vulkan', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page]', e.message));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => !!window.__game, { timeout: 300000, polling: 400 });
// Dismiss the start overlay. Without this the whole diagnostic screenshots the
// title screen and reports a confident 0.00% — which is how it first ran.
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  document.getElementById('loading')?.remove();
});
await sleep(2500);
await mkdir(OUT, { recursive: true });

// Park the camera in front of two enemies on open ground and freeze everything
// that could move between the two renders.
const info = await page.evaluate(() => {
  const g = window.__game;
  const THREE = g.THREE;

  /*
   * Find ground that is actually in sunlight.
   *
   * The obvious staging (origin, looking north) drops the squad into the
   * admin building's shadow. Everything then behaves correctly — no direct
   * sun means no long cast shadow — and the frame looks exactly like the
   * bug it was meant to disprove. So don't guess: shoot a ray at the sun
   * from each candidate and keep only the ones that reach it unobstructed.
   */
  const sunDir = g.sky.sunDirection;                 // points sun -> scene
  const toSun = sunDir.clone().negate().normalize();
  const rc = new THREE.Raycaster();
  rc.far = 400;
  rc.firstHitOnly = true;

  const clear = (x, z) => {
    rc.set(new THREE.Vector3(x, 1.0, z), toSun);
    return rc.intersectObject(g.scene, true).filter((h) => {
      const m = h.object;
      return m.isMesh && m.castShadow && m.visible;
    }).length === 0;
  };

  let spot = null;
  outer:
  for (let r = 6; r <= 34 && !spot; r += 4) {
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      // The squad's own footprint plus a few metres of shadow run must be clear.
      if (clear(x, z) && clear(x + 2, z) && clear(x - 2, z)
          && clear(x + toSun.x * -4, z + toSun.z * -4)) { spot = [x, z]; break outer; }
    }
  }
  if (!spot) return { enemies: 0, reason: 'no sunlit ground found' };

  /*
   * View the squad from the SIDE, not from the sun.
   *
   * Standing on the sun line puts every shadow directly behind its caster,
   * where the caster hides it — the frame then shows no shadows for a purely
   * geometric reason. Offset perpendicular to the sun so the shadows lie
   * across the frame and their length is measurable.
   */
  const [sx, sz] = spot;
  const back = new THREE.Vector3(toSun.x, 0, toSun.z).normalize();
  const side = new THREE.Vector3(-back.z, 0, back.x);
  const eye = new THREE.Vector3(sx, 0, sz)
    .addScaledVector(side, 6.0)
    .addScaledVector(back, 2.5);
  g.player.position.set(eye.x, 0.02, eye.z);
  g.player.velocity.set(0, 0, 0);
  // Three's camera looks down -Z, so forward = (-sin yaw, 0, -cos yaw) and the
  // yaw that points at a direction f is atan2(-f.x, -f.z). Getting this
  // backwards aimed the first attempt at the sun with the squad behind it.
  const fwd = new THREE.Vector3(sx - eye.x, 0, sz - eye.z).normalize();
  g.player.yaw = Math.atan2(-fwd.x, -fwd.z);
  g.player.pitch = -0.16;
  g.player.recoilPitch = 0; g.player.recoilYaw = 0; g.player.shakeTrauma = 0;
  g.player.bobAmount = 0;
  for (let i = 0; i < 60; i++) { g.player.update(1 / 120, g); g.weapons?.update(1 / 120, g); }

  // Enemies do not exist until a wave is spawned. Assuming they were already
  // there is what made the first run measure an empty courtyard.
  g.ai.spawnWave(3);
  // Freeze the director, or it walks them off the mark between the two renders
  // and the difference is dominated by movement rather than by shadows.
  if (!g.ai.__frozen) { g.ai.__realUpdate = g.ai.update.bind(g.ai); g.ai.update = () => {}; g.ai.__frozen = true; }
  const live = g.ai.enemies.filter((e) => e.alive);
  // Spread them across the sun line so the shadows do not overlap each other.
  const park = () => live.slice(0, 3).forEach((e, i) => {
    const o = (i - 1) * 1.8;
    e.root.position.set(sx + side.x * o, 0, sz + side.z * o);
    e.root.rotation.y = g.player.yaw + Math.PI;
    if (e.position) e.position.copy(e.root.position);
  });
  park();
  for (let i = 0; i < 90; i++) g.ai.__realUpdate?.(1 / 120, g);
  park();

  const sun = g.sky?.sunLight;
  return {
    enemies: live.length,
    spot: [+sx.toFixed(1), +sz.toFixed(1)],
    sunElevationDeg: +(Math.asin(-sunDir.y) * 180 / Math.PI).toFixed(1),
    sunDir: g.sky?.sunDirection ? [+g.sky.sunDirection.x.toFixed(3), +g.sky.sunDirection.y.toFixed(3), +g.sky.sunDirection.z.toFixed(3)] : null,
    sunIntensity: sun?.intensity ?? null,
    castShadow: sun?.castShadow ?? null,
    mapSize: sun?.shadow ? [sun.shadow.mapSize.width, sun.shadow.mapSize.height] : null,
    bias: sun?.shadow?.bias ?? null,
    normalBias: sun?.shadow?.normalBias ?? null,
  };
});
console.log('scene', JSON.stringify(info));
if (!info.enemies) {
  console.error('!! no live enemies were placed — the frame under test is not the one described.');
  await browser.close();
  process.exit(1);
}

if (!info.castShadow) console.log('!! sun.castShadow is FALSE — no shadow can exist at all');

await page.evaluate(() => window.__game.postfx.snapExposure?.());
await sleep(500);
const litB64 = await page.screenshot({ encoding: 'base64' });
await writeFile(path.join(OUT, 'S_lit.png'), Buffer.from(litB64, 'base64'));

/*
 * Second frame: only the ENEMIES stop casting.
 *
 * Killing the whole shadow map conflates the squad with the buildings, and the
 * buildings dominate — the first version happily reported "19.8% of the ground
 * band" while not one pixel of that came from a person. Toggle just the squad
 * and the remaining difference is, by construction, their shadows and nothing
 * else.
 */
await page.evaluate(() => {
  const g = window.__game;
  g.postfx.freezeExposure = true;
  (g.ai?.enemies || []).forEach((e) => {
    if (e.shadow) e.shadow.visible = false;          // the blob decal is not a shadow
    e.root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  });
  g.scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
  });
});
await sleep(900);
const noEnemyB64 = await page.screenshot({ encoding: 'base64' });
await writeFile(path.join(OUT, 'S_noenemyshadow.png'), Buffer.from(noEnemyB64, 'base64'));

// Third frame: shadow map off entirely, for the whole-scene reference number.
const off = await page.evaluate(() => {
  const g = window.__game;
  g.postfx.freezeExposure = true;
  g.renderer.shadowMap.enabled = false;
  if (g.sky?.sunLight) g.sky.sunLight.castShadow = false;
  // Hide the blob decal too, so the diff shows ONLY real shadow-map darkening.
  (g.ai?.enemies || []).forEach((e) => { if (e.shadow) e.shadow.visible = false; });

  // Shadow state is baked into the shader permutation. Flipping castShadow
  // without forcing a recompile leaves every material sampling the stale
  // shadow map, so both renders come out byte-identical and the diff reports
  // a confident 0.00% — which reads as "no shadows exist" when it actually
  // means "the experiment never ran". Same class of trap as toggling
  // light.visible. Recompile everything.
  let n = 0;
  g.scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) { mm.needsUpdate = true; n++; }
  });
  return { recompiled: n };
});
console.log('shadow off ->', JSON.stringify(off));
await sleep(900);
const offB64 = await page.screenshot({ encoding: 'base64' });
await writeFile(path.join(OUT, 'S_noshadow.png'), Buffer.from(offB64, 'base64'));
console.log('frames differ:', litB64 !== offB64);

// Decode and difference inside the page — there is a full canvas stack there,
// and adding an image codec to the repo for one diagnostic is not worth it.
const diff = (a, b) => page.evaluate(async (a, b) => {
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

  const groundTop = Math.floor(H * 0.55);
  let touched = 0, groundPx = 0, touchedGround = 0, maxDrop = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lL = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
      const lO = 0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2];
      const d = lO - lL;                       // positive = shadow darkened it
      if (d > maxDrop) maxDrop = d;
      const hit = d > 6;
      if (hit) touched++;
      if (y >= groundTop) { groundPx++; if (hit) touchedGround++; }
      const v = Math.max(0, Math.min(255, d * 6));   // amplify to make it visible
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  /*
   * How deep is the shadow actually, in the graded frame the player sees?
   *
   * The percentages above only say a shadow EXISTS. A shadow can be present in
   * a difference and still read as nothing on screen once fog inscatter and the
   * additive bloom/shaft terms have lifted it. So take the shadowed pixels as a
   * mask, compare them against unshadowed ground at the same image height (same
   * distance, same material, same exposure), and state the gap in stops.
   */
  let litSum = 0, litN = 0, shadSum = 0, shadN = 0;
  for (let y = groundTop; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
      const d = (0.2126 * B[i] + 0.7152 * B[i + 1] + 0.0722 * B[i + 2]) - lum;
      if (d > 12) { shadSum += lum; shadN++; }
      else if (d < 1 && lum > 8) { litSum += lum; litN++; }
    }
  }
  const litMean = litN ? litSum / litN : 0;
  const shadMean = shadN ? shadSum / shadN : 0;
  // sRGB-ish: undo the display curve before taking the ratio, or the number is
  // a property of the encoding rather than of the lighting.
  const lin = (v) => Math.pow(Math.max(v, 1) / 255, 2.2);
  const stops = shadMean > 0 ? Math.log2(lin(litMean) / lin(shadMean)) : 0;

  return {
    W, H, touched, groundPx, touchedGround, maxDrop,
    litMean, shadMean, stops,
    png: out.toDataURL('image/png').split(',')[1],
  };
}, a, b);

const enemyOnly = await diff(litB64, noEnemyB64);
const wholeMap = await diff(litB64, offB64);
await writeFile(path.join(OUT, 'S_diff_enemy.png'), Buffer.from(enemyOnly.png, 'base64'));
await writeFile(path.join(OUT, 'S_diff.png'), Buffer.from(wholeMap.png, 'base64'));
await browser.close();

const report = (label, r) => {
  const total = r.W * r.H;
  console.log(`${label}: ${(100 * r.touched / total).toFixed(2)}% of frame, `
    + `${(100 * r.touchedGround / r.groundPx).toFixed(2)}% of ground band, `
    + `max darkening ${r.maxDrop.toFixed(0)}/255`);
};
report('whole shadow map', wholeMap);
report('enemies only    ', enemyOnly);
console.log(`shadow depth on sunlit asphalt: ${enemyOnly.stops.toFixed(2)} stops `
  + `(lit ${enemyOnly.litMean.toFixed(1)} vs shadowed ${enemyOnly.shadMean.toFixed(1)} / 255)`);

// A 1.8 m figure under a 21° sun throws a ~4.7 m shadow. Three of them at 6 m
// should be an unmissable share of the ground. Anything near zero means the
// squad is not casting, whatever the whole-map number says.
const pct = 100 * enemyOnly.touchedGround / enemyOnly.groundPx;
console.log(pct < 0.5
  ? `VERDICT: the squad casts NO usable shadow (${pct.toFixed(2)}% of ground band).`
  : `VERDICT: the squad casts a real shadow (${pct.toFixed(2)}% of ground band).`);
console.log('> shots/dbg/S_lit.png S_noenemyshadow.png S_noshadow.png '
  + 'S_diff_enemy.png S_diff.png');
