// TEMPORARY measurement rig for the sky/ambient pass. Adapted from keyfill.mjs.
// Delete when the sky work is done.
//
// Two measurements, both off the final graded render target:
//
//  RIG  — a patch of flat, fully sunlit ground is sampled twice: once normally
//         (key + fill) and once with the sun's intensity zeroed (fill only).
//         Identical pixels, identical material, so the ratio is a clean
//         key-to-fill with no AO / geometry confound. This is "sunlit ground vs
//         its own cast shadow" in the strict sense.
//  SCENE — percentile scan over a real frame that contains both sunlit ground
//         and a real cast shadow (pose F: pole + barrel shadows on concrete).
//
// Flags: --nofix   restore Sky.js's own defaults for the three knobs main.js
//                  overrides (i.e. measure as if the workaround were deleted)
//        --scan    dump candidate poses
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const NOFIX = args.includes('--nofix');
const SCAN = args.includes('--scan');

const b = await puppeteer.launch({
  protocolTimeout: 900000, headless: true,
  args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720 });
await p.goto('http://127.0.0.1:5188', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
await p.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  document.getElementById('loading')?.remove();
});
await new Promise(r => setTimeout(r, 2500));

// Hide the viewmodel — it is near-black and poisons every luminance percentile.
await p.evaluate(() => {
  const g = window.__game;
  const wg = g.weapons?.group || g.weapons?.root || g.weapons?.viewModel || g.weapons?.container;
  if (wg) wg.visible = false;
  g.scene.traverse(o => {
    if (o.isMesh && /^(rifle|smg|pistol|weapon|vm)[._]/i.test(o.name || '')) o.visible = false;
  });
});

if (NOFIX) {
  const restored = await p.evaluate(() => {
    const sky = window.__game.sky;
    const src = sky.constructor.toString();
    const pick = k => {
      const m = src.match(new RegExp('\\b' + k + ':\\s*([0-9.]+)'));
      return m ? parseFloat(m[1]) : null;
    };
    sky.params.envIntensity = pick('envIntensity');
    sky.params.hemiIntensity = pick('hemiIntensity');
    sky.params.sunIntensity = pick('sunIntensity');
    sky.applyParams();
    sky.setTimeOfDay(sky.timeOfDay);
    return { env: sky.params.envIntensity, hemi: sky.params.hemiIntensity, sun: sky.params.sunIntensity };
  });
  console.log('RESTORED', JSON.stringify(restored));
  await new Promise(r => setTimeout(r, 1500));
}

const POSES = {
  A: [10, 6, -1.35, -0.34],   // flat lit concrete, fills the lower half
  B: [6, 30, 0.0, -0.25],
  C: [0, 10, 2.4, -0.30],
  D: [-6, 18, 1.2, -0.35],
  E: [14, 22, -2.2, -0.30],
  F: [4, 0, 1.9, -0.40],      // long pole/barrel shadows across sunlit concrete
};

async function pose(name) {
  const [x, z, yaw, pitch] = POSES[name];
  await p.evaluate((x, z, yaw, pitch) => {
    const g = window.__game, pl = g.player;
    pl.position.set(x, 0.02, z); pl.yaw = yaw; pl.pitch = pitch;
    for (let i = 0; i < 90; i++) { pl.update(1 / 120, g); g.weapons?.update(1 / 120, g); }
  }, x, z, yaw, pitch);
  await new Promise(r => setTimeout(r, 900));
}

const lin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

// Mean sRGB of a rectangle of the graded RT (fractions, origin bottom-left).
async function patch(fx, fy, fw, fh) {
  return p.evaluate((fx, fy, fw, fh) => {
    const g = window.__game, r = g.renderer, rt = g.postfx.gradeRT;
    const W = rt.width, H = rt.height;
    const x = Math.floor(W * fx), y = Math.floor(H * fy);
    const w = Math.floor(W * fw), h = Math.floor(H * fh);
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, x, y, w, h, buf);
    let R = 0, G = 0, B = 0; const n = w * h;
    for (let i = 0; i < buf.length; i += 4) { R += buf[i]; G += buf[i + 1]; B += buf[i + 2]; }
    return [R / n / 255, G / n / 255, B / n / 255];
  }, fx, fy, fw, fh);
}

// Percentile scan over a rectangle: 10th vs 90th luminance decile.
async function scan(fx, fy, fw, fh) {
  return p.evaluate((fx, fy, fw, fh) => {
    const g = window.__game, r = g.renderer, rt = g.postfx.gradeRT;
    const W = rt.width, H = rt.height;
    const x = Math.floor(W * fx), y = Math.floor(H * fy);
    const w = Math.floor(W * fw), h = Math.floor(H * fh);
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, x, y, w, h, buf);
    const lum = [], br = [];
    for (let i = 0; i < w * h; i++) {
      const R = buf[i * 4] / 255, G = buf[i * 4 + 1] / 255, B = buf[i * 4 + 2] / 255;
      lum.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
      br.push(R > 0.004 ? B / R : 0);
    }
    const s = [...lum].sort((a, b) => a - b);
    const pct = q => s[Math.floor(q * (s.length - 1))];
    const dark = pct(0.10), light = pct(0.90);
    let bd = 0, nd = 0, bl = 0, nl = 0;
    for (let i = 0; i < lum.length; i++) {
      if (lum[i] <= dark + 0.012) { bd += br[i]; nd++; }
      if (lum[i] >= light - 0.012) { bl += br[i]; nl++; }
    }
    const L = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return {
      shadowLum: +dark.toFixed(4), litLum: +light.toFixed(4),
      ratio: +(L(light) / Math.max(L(dark), 1e-5)).toFixed(2),
      stops: +(Math.log2(L(light) / Math.max(L(dark), 1e-5))).toFixed(2),
      shadowBR: +(bd / Math.max(nd, 1)).toFixed(3),
      litBR: +(bl / Math.max(nl, 1)).toFixed(3),
    };
  }, fx, fy, fw, fh);
}

if (SCAN) {
  for (const k of Object.keys(POSES)) {
    await pose(k);
    await p.screenshot({ path: `shots/dbg/pose_${k}.png` });
    console.log('pose', k, JSON.stringify(await scan(0.05, 0.06, 0.55, 0.34)));
  }
} else {
  // ---- RIG: identical pixels, sun on vs sun off -------------------------
  await pose('A');
  await p.screenshot({ path: 'shots/dbg/probe_lit.png' });
  const REG = [0.06, 0.30, 0.44, 0.26];
  const CLit = await patch(...REG);
  const saved = await p.evaluate(() => {
    const s = window.__game.sky.sunLight; const v = s.intensity; s.intensity = 0; return v;
  });
  await new Promise(r => setTimeout(r, 500));
  await p.screenshot({ path: 'shots/dbg/probe_fill.png' });
  const CFill = await patch(...REG);
  await p.evaluate(v => { window.__game.sky.sunLight.intensity = v; }, saved);
  await new Promise(r => setTimeout(r, 400));

  const lLit = 0.2126 * lin(CLit[0]) + 0.7152 * lin(CLit[1]) + 0.0722 * lin(CLit[2]);
  const lFil = 0.2126 * lin(CFill[0]) + 0.7152 * lin(CFill[1]) + 0.0722 * lin(CFill[2]);
  console.log('RIG   ' + JSON.stringify({
    ratio: +(lLit / Math.max(lFil, 1e-6)).toFixed(2),
    stops: +Math.log2(lLit / Math.max(lFil, 1e-6)).toFixed(2),
    shadowBR: +(CFill[2] / Math.max(CFill[0], 1e-4)).toFixed(3),
    litBR: +(CLit[2] / Math.max(CLit[0], 1e-4)).toFixed(3),
    litRGB: CLit.map(v => +v.toFixed(3)),
    shadowRGB: CFill.map(v => +v.toFixed(3)),
  }));

  // ---- SCENE: real cast shadows on sunlit concrete ----------------------
  await pose('F');
  await p.screenshot({ path: 'shots/dbg/probe_scene.png' });
  console.log('SCENE ' + JSON.stringify(await scan(0.05, 0.06, 0.62, 0.40)));
  await pose('B');
  console.log('SCENE2' + JSON.stringify(await scan(0.05, 0.10, 0.60, 0.30)));
}

const d = await p.evaluate(() => {
  const g = window.__game;
  const c3 = c => c ? [+c.r.toFixed(3), +c.g.toFixed(3), +c.b.toFixed(3)] : null;
  let hemi = null, hc = null, hg = null;
  g.scene.traverse(o => { if (o.isHemisphereLight) { hemi = o.intensity; hc = c3(o.color); hg = c3(o.groundColor); } });
  return {
    envI: g.scene.environmentIntensity, ambient: c3(g.sky.ambientColor),
    sunI: +g.sky.sunLight.intensity.toFixed(2), sunC: c3(g.sky.sunLight.color),
    hemiI: hemi && +hemi.toFixed(3), hemiC: hc, hemiG: hg,
    fog: c3(g.sky.fogColor), fogG: c3(g.sky.fogColorGround),
    exposure: g.postfx.params.exposure,
  };
});
console.log('LIGHTING', JSON.stringify(d));
await b.close();
