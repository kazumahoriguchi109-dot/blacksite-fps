/*
 * Verify a real deployment, not a dev server.
 *
 * This exists because the first Pages deploy "worked": it returned 200, the
 * game booted, the menu appeared, and `window.__game` came up with a player, a
 * weapon system and an AI director attached. It was also running entirely on
 * fallback stubs — no procedural materials, no sky, no weapon models, no FX —
 * because the optional modules were dynamic imports the bundler had been told
 * to ignore, so every one of them 404'd. The degrade-to-stub path did its job
 * and hid the failure completely.
 *
 * So booting is not the test. The test is that nothing 404'd and every optional
 * subsystem is the real one.
 *
 *   node scripts/livecheck.mjs                      # the published site
 *   node scripts/livecheck.mjs http://127.0.0.1:4173/   # a local `vite preview`
 *
 * Exits non-zero if any request failed or any subsystem fell back.
 */
import puppeteer from 'puppeteer';

const URL = process.argv[2] || 'https://kazumahoriguchi109-dot.github.io/blacksite-fps/';

const browser = await puppeteer.launch({
  headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

const failures = [];
const consoleWarns = [];
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failures.push(`404/failed: ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) failures.push(`HTTP ${r.status()}: ${r.url()}`); });
page.on('console', (m) => { if (m.text().includes('[boot]')) consoleWarns.push(m.text()); });

console.log(`checking ${URL}`);
const t0 = Date.now();
const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
console.log(`  HTTP ${resp.status()}`);
try {
  await page.waitForFunction(() => !!window.__game, { timeout: 300000, polling: 500 });
} catch {
  // A bare "Waiting failed" says nothing. The page errors are the diagnosis.
  console.log('\nFAIL — the game never finished booting.');
  const stage = await page.evaluate(() => document.getElementById('lmsg')?.textContent || '(no loading message)');
  console.log(`  last loading stage: ${stage}`);
  if (failures.length) {
    console.log('  errors:');
    for (const f of [...new Set(failures)].slice(0, 12)) console.log(`    ${f}`);
  } else {
    console.log('  no page errors were reported — it is stuck, not crashed.');
  }
  await browser.close();
  process.exit(1);
}
const bootSecs = (Date.now() - t0) / 1000;
console.log(`  booted in ${bootSecs.toFixed(1)}s`);

// Read what boot recorded. Do NOT infer from object shape: a stubbed subsystem
// looks like a real one — ctx.mat is a function either way — and an earlier
// version of this check duly reported three false failures against a dev server
// where all three were fine.
const subs = await page.evaluate(() => {
  const g = window.__game;
  return {
    loaded: g.loaded ? { ...g.loaded } : null,
    calls: g.renderer.info.render.calls,
    tris: g.renderer.info.render.triangles,
  };
});

if (!subs.loaded) {
  console.log('\nFAIL — ctx.loaded is absent; this build predates the boot manifest.');
  await browser.close();
  process.exit(1);
}
const missing = Object.entries(subs.loaded).filter(([, v]) => !v).map(([k]) => k);
const EXPECTED = 8;
const seen = Object.keys(subs.loaded).length;
console.log(`  optional modules: ${seen - missing.length}/${seen} loaded`);
if (seen < EXPECTED) {
  missing.push(`only ${seen} of ${EXPECTED} modules were even attempted`);
}

console.log(`  draw calls ${subs.calls}, triangles ${subs.tris.toLocaleString()}`);
for (const w of consoleWarns) console.log(`  ${w}`);

await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  document.getElementById('loading')?.remove();
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: 'shots/dbg/LIVE.png' });
await browser.close();

let bad = false;
if (failures.length) {
  bad = true;
  console.log(`\nFAIL — ${failures.length} failed request(s)/error(s):`);
  for (const f of [...new Set(failures)].slice(0, 12)) console.log(`  ${f}`);
}
if (missing.length) {
  bad = true;
  console.log(`\nFAIL — running on fallback stubs for: ${missing.join(', ')}`);
}
if (bad) process.exit(1);
console.log('\nOK — every subsystem is the real one and nothing 404\'d.');
console.log('> shots/dbg/LIVE.png');
