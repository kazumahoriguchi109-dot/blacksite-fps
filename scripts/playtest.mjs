#!/usr/bin/env node
/*
 * Gameplay smoke test.
 *
 * Screenshots prove the renderer works; they prove nothing about whether the
 * game plays. This drives the real systems — movement, collision, firing,
 * reloading, ballistics, AI, FX — and asserts observable state changes, then
 * captures action frames so the FX can be looked at.
 *
 * Usage: node scripts/playtest.mjs [--out shots/play] [--headed]
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; })
);
const OUT = args.out || 'shots/play';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    protocolTimeout: 900000,
    headless: !args.headed,
    args: ['--no-sandbox', '--enable-gpu', '--use-angle=metal',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto('http://127.0.0.1:5188', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => !!window.__game, { timeout: 240000, polling: 400 });
  await page.evaluate(() => {
    document.getElementById('overlay')?.classList.add('hidden');
    document.getElementById('loading')?.remove();
  });
  await sleep(2500);

  // ---------------------------------------------------------- movement ----
  console.log('\n· movement & collision');
  const mv = await page.evaluate(async () => {
    const g = window.__game, p = g.player;
    p.spawn(g.world.spawnPoints[0], 0);
    const start = p.position.clone();
    // Walk forward for 1.5 s of simulated time.
    g.input.down.add('KeyW');
    for (let i = 0; i < 180; i++) { p.update(1 / 120, g); g.weapons.update(1 / 120, g); }
    const walked = p.position.distanceTo(start);
    const groundedAfterWalk = p.grounded;
    g.input.down.delete('KeyW');

    // Jump.
    g.input._pressedThisFrame.add('Space');
    p.update(1 / 120, g);
    g.input._pressedThisFrame.clear();
    const vyAfterJump = p.velocity.y;
    let peak = p.position.y;
    for (let i = 0; i < 240; i++) { p.update(1 / 120, g); peak = Math.max(peak, p.position.y); }
    const landed = p.grounded;

    // Walk into the perimeter wall and confirm we do not pass through it.
    p.spawn(new g.player.position.constructor(-22, 0.2, 46), Math.PI);
    g.input.down.add('KeyW');
    for (let i = 0; i < 600; i++) { p.update(1 / 120, g); }
    g.input.down.delete('KeyW');
    const stoppedAtWall = p.position.z;

    // Sprint should exceed walk speed.
    p.spawn(g.world.spawnPoints[0], 0);
    g.input.down.add('KeyW'); g.input.down.add('ShiftLeft');
    for (let i = 0; i < 240; i++) { p.update(1 / 120, g); g.weapons.update(1 / 120, g); }
    const sprintSpeed = p.speed2D;
    g.input.down.clear();

    return { walked, groundedAfterWalk, vyAfterJump, jumpHeight: peak - 0.2, landed,
             stoppedAtWall, sprintSpeed };
  });
  check('walks forward', mv.walked > 4, `${mv.walked.toFixed(2)} m in 1.5 s`);
  check('stays grounded while walking', mv.groundedAfterWalk);
  check('jump imparts upward velocity', mv.vyAfterJump > 4, `vy=${mv.vyAfterJump.toFixed(2)}`);
  check('jump apex is sane', mv.jumpHeight > 0.65 && mv.jumpHeight < 2.2, `${mv.jumpHeight.toFixed(2)} m`);
  check('lands again', mv.landed);
  check('perimeter wall blocks the player',
        mv.stoppedAtWall > 47 && mv.stoppedAtWall < 52.5,
        `stopped at z=${mv.stoppedAtWall.toFixed(2)} (wall face at ~51.8)`);
  check('sprint is faster than walk', mv.sprintSpeed > 5.5, `${mv.sprintSpeed.toFixed(2)} m/s`);

  // ------------------------------------------------------------ weapons ---
  console.log('\n· weapons, ballistics & FX');
  const wp = await page.evaluate(async () => {
    const g = window.__game, w = g.weapons, p = g.player;
    p.spawn(g.world.spawnPoints[0], 0);
    p.pitch = 0;
    // Step the player once with no input so stale movement state (notably
    // `sprinting`, which legitimately blocks firing) is cleared first.
    g.input.down.clear();
    for (let i = 0; i < 30; i++) p.update(1 / 120, g);
    const before = { mag: w.current.mag, sprinting: p.sprinting, state: w.state };

    // Fire a short burst and sample DURING it — recoil, spread and trauma all
    // decay within a second, so measuring after a 400-frame window reads zero.
    for (let i = 0; i < 72; i++) {
      g.input.down.add('Mouse0');
      p.update(1 / 120, g);
      w.update(1 / 120, g);
    }
    const afterFire = { mag: w.current.mag, recoil: p.recoilPitch, spread: w.spread,
                        trauma: p.shakeTrauma };
    // Then empty the magazine so the reload check below has something to do.
    for (let i = 0; i < 330; i++) {
      g.input.down.add('Mouse0');
      p.update(1 / 120, g);
      w.update(1 / 120, g);
    }
    g.input.down.delete('Mouse0');

    // Reload back to full.
    w.reload();
    const reloading = w.state === 'reloading';
    for (let i = 0; i < 480; i++) w.update(1 / 120, g);
    const afterReload = { mag: w.current.mag, state: w.state, reserve: w.current.reserve };

    // Weapon switching.
    w.switchTo('pistol');
    for (let i = 0; i < 120; i++) w.update(1 / 120, g);
    const switched = w.currentKind;

    w.switchTo('rifle');
    for (let i = 0; i < 120; i++) w.update(1 / 120, g);

    // ADS should change the blend and narrow the FOV.
    w.forceAim = true;
    for (let i = 0; i < 200; i++) { p.update(1 / 120, g); w.update(1 / 120, g); }
    const adsT = w.adsT, adsFov = g.camera.fov;
    w.forceAim = false;
    for (let i = 0; i < 200; i++) { p.update(1 / 120, g); w.update(1 / 120, g); }

    return { before, afterFire, reloading, afterReload, switched, adsT, adsFov,
             hipFov: g.camera.fov };
  });
  check('firing consumes ammo', wp.afterFire.mag < wp.before.mag,
        `${wp.before.mag} -> ${wp.afterFire.mag} (pre: sprinting=${wp.before.sprinting}, state=${wp.before.state})`);
  check('firing applies recoil', Math.abs(wp.afterFire.recoil) > 0.001,
        `pitch=${wp.afterFire.recoil.toFixed(4)}`);
  check('firing grows spread', wp.afterFire.spread > 0.045, wp.afterFire.spread.toFixed(4));
  check('firing shakes the camera', wp.afterFire.trauma > 0, wp.afterFire.trauma.toFixed(3));
  check('reload enters the reloading state', wp.reloading);
  check('reload refills the magazine', wp.afterReload.mag === 30,
        `mag=${wp.afterReload.mag} reserve=${wp.afterReload.reserve}`);
  check('reload finishes', wp.afterReload.state === 'idle');
  check('weapon switching works', wp.switched === 'pistol');
  check('ADS engages', wp.adsT > 0.9, `adsT=${wp.adsT.toFixed(2)}`);
  check('ADS narrows FOV', wp.adsFov < wp.hipFov - 5,
        `${wp.hipFov.toFixed(1)} -> ${wp.adsFov.toFixed(1)}`);

  // ----------------------------------------------------- grenades & light ---
  console.log('\n· grenades & flashlight');
  const gr = await page.evaluate(async () => {
    const g = window.__game, G = g.grenades;
    if (!G) return { available: false };
    g.player.spawn(g.world.spawnPoints[0], 0);
    g.player.pitch = 0.12;
    const before = G.count;
    const thrown = G.throwGrenade(1);
    const live0 = G.pool.filter((p) => p.active).length;
    const startPos = G.pool.find((p) => p.active)?.mesh.position.clone();
    // Fly for 1 s and confirm it actually travelled and fell.
    for (let i = 0; i < 120; i++) G.update(1 / 120, g);
    const p0 = G.pool.find((p) => p.active);
    const travelled = p0 && startPos ? p0.mesh.position.distanceTo(startPos) : 0;
    const restingOnGround = p0 ? p0.mesh.position.y : null;
    // Run past the fuse and confirm it detonates.
    for (let i = 0; i < 400; i++) G.update(1 / 120, g);
    const live1 = G.pool.filter((p) => p.active).length;

    // Flashlight toggle through the real input path.
    const f = g.flashlight;
    const i0 = f.intensity;
    g.input._pressedThisFrame.add('KeyF');
    return { available: true, before, thrown, live0, travelled, restingOnGround,
             live1, count: G.count, flashlightStart: i0 };
  });
  if (!gr.available) check('grenade system present', false);
  else {
    check('grenade throws', gr.thrown && gr.live0 === 1, `live=${gr.live0}`);
    check('grenade flies and falls', gr.travelled > 3,
          `${gr.travelled.toFixed(1)} m, resting y=${(gr.restingOnGround ?? 0).toFixed(2)}`);
    check('grenade detonates on fuse', gr.live1 === 0);
    check('grenade count decrements', gr.count === gr.before - 1,
          `${gr.before} -> ${gr.count}`);
  }

  // ------------------------------------------------------------------ AI ---
  console.log('\n· AI');
  const ai = await page.evaluate(async () => {
    const g = window.__game;
    if (!g.ai?.spawnWave) return { available: false };
    g.ai.spawnWave(6);
    for (let i = 0; i < 600; i++) g.ai.update(1 / 120, g);
    const enemies = g.ai.enemies?.filter((e) => e.alive) ?? [];
    const moved = enemies.filter((e) => e.root && e.root.position.lengthSq() > 0).length;
    const zones = enemies[0]?.getHitZones?.();
    // Shoot the nearest enemy in the head and confirm damage lands.
    let killed = false, damaged = false;
    if (enemies.length) {
      const e = enemies[0];
      const hpBefore = e.health;
      e.applyDamage?.(45, 'chest', new g.player.position.constructor(0, 0, 1));
      damaged = e.health < hpBefore;
      e.applyDamage?.(500, 'head', new g.player.position.constructor(0, 0, 1));
      killed = !e.alive;
    }
    return { available: true, count: enemies.length, moved,
             zoneCount: zones?.length ?? 0,
             zoneKinds: zones ? [...new Set(zones.map((z) => z.zone))] : [],
             damaged, killed };
  });
  if (!ai.available) {
    check('AI module present', false, 'AIDirector not loaded');
  } else {
    check('enemies spawn', ai.count > 0, `${ai.count} alive`);
    check('enemies are placed in the world', ai.moved > 0);
    check('enemies expose hit zones', ai.zoneCount > 0,
          `${ai.zoneCount} zones: ${ai.zoneKinds.join(', ')}`);
    check('enemies take damage', ai.damaged);
    check('headshots kill', ai.killed);
  }

  // -------------------------------------------------------- game mode ------
  console.log('\n· game mode');
  const gm = await page.evaluate(async () => {
    const g = window.__game, m = g.mode;
    if (!m) return { available: false };
    g.player.spawn(g.world.spawnPoints[0], 0);
    m.start();
    const briefing = m.state;
    for (let i = 0; i < 400; i++) m.update(1 / 120, g);   // past the briefing
    const afterBrief = { state: m.state, wave: m.wave,
                         enemies: g.ai.enemies.filter((e) => e.alive).length };

    // Kill everything and confirm the wave completes.
    for (const e of g.ai.enemies) if (e.alive) e.applyDamage?.(999, 'chest', g.player.position);
    for (let i = 0; i < 400; i++) m.update(1 / 120, g);
    const cleared = { state: m.state, score: m.score, kills: m.kills };

    // Kill the player and confirm respawn.
    g.player.applyDamage(999, g.player.position);
    m.update(1 / 120, g);
    const died = m.state;
    for (let i = 0; i < 700; i++) { m.update(1 / 120, g); g.player.update(1 / 120, g); }
    const respawned = { dead: g.player.dead, hp: g.player.health, state: m.state };
    return { available: true, briefing, afterBrief, cleared, died, respawned };
  });
  if (!gm.available) check('game mode present', false);
  else {
    check('wave starts after briefing', gm.afterBrief.state === 'fighting' && gm.afterBrief.wave === 1,
          `state=${gm.afterBrief.state} wave=${gm.afterBrief.wave} enemies=${gm.afterBrief.enemies}`);
    check('wave spawns enemies', gm.afterBrief.enemies > 0);
    check('clearing a wave scores and advances', gm.cleared.score > 0 && gm.cleared.kills > 0,
          `score=${gm.cleared.score} kills=${gm.cleared.kills} state=${gm.cleared.state}`);
    check('player death is detected', gm.died === 'dead');
    check('player respawns alive at full health',
          !gm.respawned.dead && gm.respawned.hp > 99,
          `hp=${gm.respawned.hp} state=${gm.respawned.state}`);
  }

  // ------------------------------------------------------------- player ----
  console.log('\n· player damage & audio');
  const misc = await page.evaluate(async () => {
    const g = window.__game, p = g.player;
    p.spawn(g.world.spawnPoints[0], 0);
    const hp0 = p.health;
    p.applyDamage(35, p.position);
    const hp1 = p.health;
    for (let i = 0; i < 1200; i++) p.update(1 / 120, g);   // 10 s -> regen
    const hp2 = p.health;
    p.applyDamage(1000, p.position);
    const dead = p.dead;

    let audioOk = false, voices = null;
    try {
      await g.audio.unlock?.();
      g.audio.play('rifleFire', { volume: 0.2 });
      g.audio.play('impactConcrete', { position: p.position });
      voices = g.audio._voices?.length ?? g.audio.activeVoices ?? null;
      audioOk = true;
    } catch (e) { audioOk = false; }
    return { hp0, hp1, hp2, dead, audioOk, voices };
  });
  check('player takes damage', misc.hp1 < misc.hp0, `${misc.hp0} -> ${misc.hp1.toFixed(0)}`);
  check('health regenerates', misc.hp2 > misc.hp1, `-> ${misc.hp2.toFixed(0)}`);
  check('player can die', misc.dead);
  check('audio engine accepts play()', misc.audioOk);

  // --------------------------------------------------- action screenshots ---
  console.log('\n· capturing action frames');
  await page.evaluate(() => {
    const g = window.__game, p = g.player, w = g.weapons;
    p.spawn(g.world.spawnPoints[0], 0);
    p.dead = false; p.health = 100;
    p.position.set(4, 0.02, 18); p.yaw = 0; p.pitch = -0.02;
    for (let i = 0; i < 60; i++) { p.update(1 / 120, g); w.update(1 / 120, g); }
    g.ai?.spawnWave?.(5);
  });
  await sleep(900);
  // Hold the trigger down through several real frames so muzzle flash, tracers,
  // shells, impacts and decals are all live in the captured frame.
  await page.evaluate(() => { window.__game.input.down.add('Mouse0'); });
  await sleep(420);
  await page.screenshot({ path: path.join(OUT, 'A_firing.png') });
  await sleep(380);
  await page.screenshot({ path: path.join(OUT, 'B_firing2.png') });
  await page.evaluate(() => { window.__game.input.down.delete('Mouse0'); });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, 'C_after_impacts.png') });

  await page.evaluate(() => {
    const g = window.__game;
    g.weapons.reload();
  });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, 'D_reloading.png') });

  const fx = await page.evaluate(() => {
    const g = window.__game;
    return { fps: Math.round(g.fps), calls: g.renderer.info.render.calls,
             tris: g.renderer.info.render.triangles,
             enemies: g.ai?.enemies?.filter((e) => e.alive).length ?? 0 };
  });
  console.log('  runtime', JSON.stringify(fx));

  const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  await writeFile(path.join(OUT, 'console.log'), logs.join('\n'));
  check('no page errors', errs.length === 0, errs.length ? `${errs.length} errors` : '');
  if (errs.length) console.log(errs.slice(0, 12).join('\n'));

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await writeFile(path.join(OUT, 'playtest.json'),
    JSON.stringify({ results, runtime: fx }, null, 2));

  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
})();
