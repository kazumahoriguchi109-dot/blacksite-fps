#!/usr/bin/env node
/*
 * The viewmodel is blown out in playtest.mjs's action frames but not in a clean
 * capture from the identical pose. Something the playtest sequence does leaves
 * a light on. This replicates that sequence and dumps every light that can
 * reach the viewmodel layer, with its intensity and distance to the camera.
 */
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = 'shots/lightdump';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mkdir(OUT, { recursive: true });
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

  const dump = () => page.evaluate(() => {
    const g = window.__game;
    const V3 = g.camera.position.constructor;
    const out = [];
    g.scene.traverse((o) => {
      if (!o.isLight) return;
      if (!(o.intensity > 0.05)) return;
      const p = o.getWorldPosition(new V3());
      out.push({
        type: o.type, name: o.name || '', i: +o.intensity.toFixed(2),
        d: +p.distanceTo(g.camera.position).toFixed(2),
        layers: o.layers.mask, dist: o.distance ?? null, decay: o.decay ?? null,
      });
    });
    out.sort((a, b) => (b.i / Math.max(0.05, b.d * b.d)) - (a.i / Math.max(0.05, a.d * a.d)));
    return {
      lights: out.slice(0, 10),
      exposure: g.postfx.params.exposure,
      hurt: g.postfx.params.hurt,
      envIntensity: +(g.scene.environmentIntensity ?? 0).toFixed(3),
      sun: +(g.sky?.sunLight?.intensity ?? 0).toFixed(2),
    };
  });

  // --- clean baseline -------------------------------------------------------
  await page.evaluate(() => {
    const g = window.__game;
    g.input.down.clear();
    g.player.spawn(new g.player.position.constructor(4, 0.02, 18), 0);
    g.player.pitch = -0.02;
    for (let i = 0; i < 240; i++) { g.player.update(1 / 120, g); g.weapons.update(1 / 120, g); }
  });
  await sleep(1800);
  const clean = await dump();
  await page.screenshot({ path: path.join(OUT, 'clean.png') });

  // --- replicate the playtest sequence -------------------------------------
  await page.evaluate(async () => {
    const g = window.__game;
    // grenades (explosion light) with no fx.update, as playtest does
    g.player.pitch = 0.12;
    g.grenades?.throwGrenade?.(1);
    for (let i = 0; i < 520; i++) g.grenades?.update(1 / 120, g);
    g.input._pressedThisFrame.add('KeyF');
  });
  await sleep(400);
  await page.evaluate(async () => {
    const g = window.__game;
    g.ai?.spawnWave?.(6);
    for (let i = 0; i < 600; i++) g.ai.update(1 / 120, g);
    const m = g.mode;
    if (m) {
      m.start();
      for (let i = 0; i < 400; i++) m.update(1 / 120, g);
      for (const e of g.ai.enemies) if (e.alive) e.applyDamage?.(999, 'chest', g.player.position);
      for (let i = 0; i < 400; i++) m.update(1 / 120, g);
      g.player.applyDamage(999, g.player.position);
      m.update(1 / 120, g);
      for (let i = 0; i < 700; i++) { m.update(1 / 120, g); g.player.update(1 / 120, g); }
    }
    g.player.spawn(new g.player.position.constructor(4, 0.02, 18), 0);
    g.player.dead = false; g.player.health = 100; g.player.pitch = -0.02;
    for (let i = 0; i < 60; i++) { g.player.update(1 / 120, g); g.weapons.update(1 / 120, g); }
    g.ai?.spawnWave?.(5);
  });
  await sleep(1800);
  const after = await dump();
  await page.screenshot({ path: path.join(OUT, 'after_sequence.png') });

  console.log(JSON.stringify({ clean, after }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
