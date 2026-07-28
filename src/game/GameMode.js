import * as THREE from 'three';

/*
 * Wave survival mode.
 *
 * Turns the sandbox into a game: waves of increasing size, a respawn loop, a
 * score, and the feedback (killfeed, banners, objective text) that tells the
 * player what is happening. Deliberately thin — it owns pacing and messaging
 * and delegates everything else.
 *
 * Enemy deaths are detected by watching the `alive` flag rather than by hooking
 * `applyDamage`, so this stays decoupled from however the AI reports damage.
 */

const CALLSIGNS = [
  'VIPER-1', 'VIPER-2', 'REAPER-3', 'HOSTILE-04', 'HOSTILE-07',
  'HOSTILE-11', 'RONIN-2', 'GHOST-6', 'HOSTILE-19', 'BRAVO-5',
];

export class GameMode {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = 'idle';        // idle | briefing | fighting | intermission | dead
    this.stateT = 0;
    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.bestWave = 0;
    this.respawnDelay = 3.4;

    this._aliveFlags = new WeakMap();
    this._pendingSpawn = 0;
    this._lastAlive = 0;
    this._scratch = new THREE.Vector3();
  }

  start() {
    this.state = 'briefing';
    this.stateT = 0;
    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.ctx.hud?.showBanner?.('SECTOR 7', 'Hostiles inbound');
    this.ctx.hud?.setObjective?.('SECURE THE COMPOUND');
  }

  /** Wave size ramps but plateaus at what the AI director can hold. */
  _waveSize(n) { return Math.min(12, 3 + Math.floor(n * 1.35)); }

  _beginWave() {
    this.wave++;
    this.bestWave = Math.max(this.bestWave, this.wave);
    const n = this._waveSize(this.wave);
    this.ctx.ai?.spawnWave?.(n);
    this.ctx.hud?.showBanner?.(`WAVE ${this.wave}`, `${n} hostiles`);
    this.ctx.hud?.setObjective?.(`WAVE ${this.wave} — ELIMINATE ALL HOSTILES`);
    this.ctx.audio?.play?.('weaponSwitch', { volume: 0.4 });
    this.state = 'fighting';
    this.stateT = 0;
    // Every wave resupplies grenades — otherwise they are a one-shot novelty.
    this.ctx.grenades?.resupply?.();
  }

  _aliveEnemies() {
    const list = this.ctx.ai?.enemies;
    if (!list) return 0;
    let n = 0;
    for (const e of list) if (e.alive) n++;
    return n;
  }

  /** Watch the alive flags and report deaths as they happen. */
  _pollDeaths() {
    const list = this.ctx.ai?.enemies;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const was = this._aliveFlags.get(e);
      if (was === undefined) { this._aliveFlags.set(e, e.alive); continue; }
      if (was && !e.alive) {
        this._aliveFlags.set(e, false);
        this._onEnemyKilled(e, i);
      } else if (!was && e.alive) {
        this._aliveFlags.set(e, true);
      }
    }
  }

  _onEnemyKilled(enemy, index) {
    this.kills++;
    const headshot = enemy.lastHitZone === 'head';
    if (headshot) this.headshots++;
    this.score += headshot ? 150 : 100;

    const weapon = this.ctx.weapons?.current?.def?.name ?? 'RIFLE';
    const name = CALLSIGNS[index % CALLSIGNS.length];
    this.ctx.hud?.killfeed?.('YOU', name, weapon, headshot);
    this.ctx.hud?.setScore?.(this.score);
    this.ctx.audio?.play?.(headshot ? 'headshot' : 'enemyDeath', {
      position: enemy.root?.position,
    });
  }

  update(dt, ctx) {
    this.stateT += dt;
    const player = ctx.player;

    // Death and respawn — without this, dying is a dead end.
    if (player?.dead && this.state !== 'dead') {
      this.state = 'dead';
      this.stateT = 0;
      ctx.hud?.showBanner?.('YOU WERE KILLED', 'Respawning');
      ctx.hud?.setObjective?.('');
    }

    // If the player comes back alive by any route other than our own respawn
    // (a debug reset, a test harness, a future revive), recover immediately.
    // Otherwise the "YOU WERE KILLED / RESPAWNING" banner keeps sitting over a
    // frame where health reads 100 — which an art review flagged as the HUD
    // contradicting itself under fire.
    if (this.state === 'dead' && player && !player.dead && player.health > 0) {
      this.state = 'fighting';
      this.stateT = 2.5;      // skip the "wave cleared" grace period
      ctx.hud?.showBanner?.(`WAVE ${this.wave}`, 'Back in the fight');
      ctx.hud?.setObjective?.(`WAVE ${this.wave} — ELIMINATE ALL HOSTILES`);
    }

    switch (this.state) {
      case 'briefing':
        if (this.stateT > 2.6) this._beginWave();
        break;

      case 'fighting': {
        this._pollDeaths();
        const alive = this._aliveEnemies();
        // Give the director a moment to actually place them before checking.
        if (this.stateT > 2.0 && alive === 0) {
          this.state = 'intermission';
          this.stateT = 0;
          const bonus = 250 + this.wave * 50;
          this.score += bonus;
          ctx.hud?.setScore?.(this.score);
          ctx.hud?.showBanner?.('SECTOR CLEAR', `+${bonus} · Wave ${this.wave} complete`);
          ctx.hud?.setObjective?.('REGROUP — NEXT WAVE INBOUND');
        }
        break;
      }

      case 'intermission':
        this._pollDeaths();
        if (this.stateT > 6.5) this._beginWave();
        break;

      case 'dead':
        if (this.stateT > this.respawnDelay) {
          const spawns = ctx.world?.spawnPoints;
          // Respawn as far from the surviving hostiles as we can manage.
          let best = spawns?.[0] ?? this._scratch.set(0, 1, 0);
          if (spawns?.length && ctx.ai?.enemies?.length) {
            let bestScore = -Infinity;
            for (const s of spawns) {
              let d = Infinity;
              for (const e of ctx.ai.enemies) {
                if (!e.alive || !e.root) continue;
                d = Math.min(d, s.distanceTo(e.root.position));
              }
              if (d > bestScore) { bestScore = d; best = s; }
            }
          }
          player.spawn(best, Math.PI);
          player.health = player.maxHealth;
          if (ctx.postfx) ctx.postfx.params.hurt = 0;
          ctx.grenades?.resupply?.();
          // Give the weapon back a full magazine so respawning isn't a punishment.
          const w = ctx.weapons?.current;
          if (w) { w.mag = w.def.magSize; ctx.weapons._syncHud?.(); }
          ctx.hud?.showBanner?.(`WAVE ${this.wave}`, 'Back in the fight');
          ctx.hud?.setObjective?.(`WAVE ${this.wave} — ELIMINATE ALL HOSTILES`);
          this.state = 'fighting';
          this.stateT = 2.5;   // skip the "wave cleared" grace period
        }
        break;
    }
  }
}
