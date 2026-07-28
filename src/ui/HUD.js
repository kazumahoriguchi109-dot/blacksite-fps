/**
 * BLACKSITE — HUD
 * ---------------------------------------------------------------------------
 * A single full-screen 2D canvas layered inside `#hud`. Everything is drawn
 * procedurally: no images, no webfonts, no external assets.
 *
 * Contract (ARCHITECTURE.md):
 *   new HUD(rootEl, ctx)
 *   update(dt, ctx)
 *   setAmmo(mag, reserve); setHealth(hp01); setWeaponName(s)
 *   hitmarker(kind)        // 'hit' | 'armor' | 'kill' | 'headshot'
 *   damageFrom(worldPos)
 *   killfeed(attacker, victim, weapon, headshot)
 *   setObjective(text); showBanner(title, sub)
 *   dispose()
 *
 * Layout regions
 *   centre        crosshair, hitmarkers, directional damage arcs, reload arc
 *   bottom-right  weapon name / mag / reserve / reload bar
 *   bottom-left   VITALS label / hp number / segmented health bar
 *   top-right     killfeed
 *   top-centre    compass strip + objective line
 *   upper-centre  banner (objectives / wave announcements)
 *
 * Performance notes
 *   - Every pool is preallocated; the draw loop performs no allocation.
 *   - Text is stored as pre-split char arrays with cached per-char widths;
 *     numeric labels are rebuilt from a static digit table only when the
 *     integer value actually changes (no string concatenation per frame).
 *   - Fades use ctx.globalAlpha rather than building rgba() strings.
 *   - All easing is exponential damping -> exactly framerate independent.
 *
 * Everything the HUD reads off `ctx` is optional-chained; a missing subsystem
 * degrades gracefully instead of throwing.
 */

const FONT = '"Inter", "Helvetica Neue", Arial, sans-serif';
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const HALFPI = Math.PI * 0.5;
const RAD2DEG = 57.29577951308232;

/* --------------------------------------------------------------------- util */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** framerate-independent exponential approach */
const damp = (cur, tgt, lambda, dt) => cur + (tgt - cur) * (1 - Math.exp(-lambda * dt));
const easeOutCubic = (t) => { const u = 1 - t; return 1 - u * u * u; };
const easeOutQuint = (t) => { const u = 1 - t; return 1 - u * u * u * u * u; };
const smooth01 = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
/** wrap degrees into (-180, 180] */
const wrapDeg = (d) => { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; };

function mkLabel() {
  return { chars: [], cw: [], w: 0, raw: null, num: NaN, font: null, sp: -1, lv: -1 };
}

/* ------------------------------------------------------------------ palette */

const PALETTE = {
  white:    '#e8eef5',
  bright:   '#ffffff',
  steel:    '#cfdae6',
  muted:    '#8b9aab',
  dim:      '#61707f',
  accent:   '#ff8a3d',
  accentHi: '#ffcda6',
  amber:    '#ffb545',
  red:      '#ff4a38',
  kill:     '#ff5f3c',
  cyan:     '#5fd7e8',
  shadow:   'rgba(0,0,0,0.72)',
  hole:     'rgba(0,0,0,0.85)',
  track:    'rgba(232,238,245,0.075)',
  trackHi:  'rgba(232,238,245,0.22)',
  rule:     'rgba(150,175,200,0.55)',
};

/* ==================================================================== HUD == */

export class HUD {
  constructor(rootEl, ctx) {
    this.root = (typeof rootEl === 'string' ? document.querySelector(rootEl) : rootEl) ||
                document.getElementById('hud') || document.body;

    /* ---------------------------------------------------------- tuning knobs */
    this.tune = {
      uiScale: 1.0,

      crosshair: {
        baseGap: 5.0,        // px (at uiScale 1) between centre and each tick
        tickLen: 7.0,
        thickness: 2.0,
        dotSize: 2.0,
        maxGap: 46.0,
        spreadIsDegrees: 'auto', // 'auto' | true | false  (false => radians)
        fallbackSpread: 0.012,   // used when weapon.spread is unavailable
        pxPerDeg: 7.0,
        moveOpen: 11.0,      // px added at full reference speed
        moveRefSpeed: 6.0,   // m/s that counts as "full sprint"
        fireOpen: 9.0,       // px added by a fresh shot
        fireDecay: 5.5,
        adsTighten: 0.62,    // gap multiplier at full ADS
        adsFade: 0.10,       // crosshair alpha at full ADS
        ease: 13.0,
      },

      hitmarker: {
        life: 0.34, settleIn: 0.09, fade: 0.25,
        inner: 4.0, outer: 10.0, weight: 2.0, popScale: 1.4,
        headshot: { settleIn: 0.065, weight: 3.1, scale: 1.28, popScale: 1.55 },
        killScale: 1.14,
      },

      health: {
        segments: 10, barW: 232, barH: 7, gap: 3,
        lowThreshold: 0.35, criticalThreshold: 0.15,
        pulseHz: 1.05, flashTime: 0.38, ease: 9.0,
      },

      ammo: {
        lowRatio: 0.30, emptyPulseHz: 1.45,
        reloadTime: 2.1,   // used only if the weapon exposes no progress
        barW: 152, barH: 2,
      },

      damage: {
        life: 1.2, radius: 108, spanDeg: 30, thickness: 4.0, fadeIn: 0.06,
      },

      killfeed: {
        life: 5.0, fadeIn: 0.18, fadeOut: 0.55, row: 21, slideEase: 15.0,
      },

      banner: { fadeIn: 0.45, hold: 1.9, fadeOut: 0.7, ruleW: 300 },

      compass: { width: 0.30, minW: 250, maxW: 460, spanDeg: 120, tickDeg: 15 },

      hurt: { lowAt: 0.42, lowMax: 0.75, pulseDecay: 2.6, ease: 6.5 },
    };

    this.pal = Object.assign({}, PALETTE);

    /* ------------------------------------------------------------- canvas */
    const cv = document.createElement('canvas');
    cv.id = 'hud-canvas';
    const st = cv.style;
    st.position = 'absolute';
    st.left = '0'; st.top = '0';
    st.width = '100%'; st.height = '100%';
    st.display = 'block';
    st.pointerEvents = 'none';
    st.zIndex = '1';
    this.canvas = cv;
    this.c = cv.getContext('2d', { alpha: true, desynchronized: true });
    this.root.appendChild(cv);

    this.w = 1; this.h = 1; this.dpr = 1; this.s = 1;
    this._lv = 0;                 // layout version — invalidates cached measures
    this.L = {};                  // layout table (mutated in place)
    this.F = {};                  // font string table
    this.visible = true;
    this.time = 0;

    /* ------------------------------------------------------------- state */
    this.hp = 1; this.hpDisp = 1;
    this.mag = 30; this.reserve = 120; this.magCap = 30;
    this._ammoExternal = false; this._nameExternal = false;

    this.chGap = this.tune.crosshair.baseGap;
    this.chAlpha = 1;
    this.ads = 0; this.moveT = 0; this.fireKick = 0;

    this.reloadP = -1;            // <0 == not reloading
    this._reloadOwn = -1;         // internal fallback timer
    this._extReload = -1;         // setReloadProgress() override
    this.reloadShow = 0;          // eased visibility of the reload widgets

    this.hurt = 0; this.dmgPulse = 0;

    /* labels ---------------------------------------------------------- */
    this.lWeapon = mkLabel();
    this.lMag = mkLabel();
    this.lReserve = mkLabel();
    this.lSlash = mkLabel();
    this.lVitals = mkLabel();
    this.lHp = mkLabel();
    this.lObj = mkLabel();
    this.lBanner = mkLabel();
    this.lBannerSub = mkLabel();
    this.lHeading = mkLabel();
    this.lReload = mkLabel();
    this._setText(this.lSlash, '/');
    this._setText(this.lVitals, 'vitals', true);
    this._setText(this.lWeapon, 'unarmed', true);
    this._setText(this.lReload, 'reloading', true);
    this._setNum(this.lMag, 30);
    this._setNum(this.lReserve, 120);
    this._setNum(this.lHp, 100);

    this.cardinals = [];
    const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let i = 0; i < 8; i++) { const l = mkLabel(); this._setText(l, CARD[i]); this.cardinals.push(l); }

    /* objective / banner timing --------------------------------------- */
    this.objAlpha = 0; this.objTarget = 0;
    this.banner = { active: false, t: 0, hold: this.tune.banner.hold };

    /* pools ------------------------------------------------------------ */
    this.hits = [];
    for (let i = 0; i < 24; i++) {
      this.hits.push({ active: false, t: 0, settle: 0.09, life: 0.34, fade: 0.25,
                       color: this.pal.white, weight: 2, scale: 1, pop: 1.4 });
    }
    this.dmg = [];
    for (let i = 0; i < 16; i++) {
      this.dmg.push({ active: false, t: 0, life: 1.2, x: 0, y: 0, z: 0, omni: true, ang: 0 });
    }
    this.kfMax = 6;
    this.kf = [];
    for (let i = 0; i < this.kfMax; i++) {
      this.kf.push({ active: false, t: 0, atk: mkLabel(), vic: mkLabel(),
                     weapon: 'rifle', headshot: false, y: 0, yT: 0, fresh: 1 });
    }
    this.kfN = 0;

    this.segFlash = new Float32Array(this.tune.health.segments);

    /* ---------------------------------------------------------- listeners */
    this._onResize = () => { this._needResize = true; };
    window.addEventListener('resize', this._onResize, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.root);
    }
    this._needResize = false;
    this._resize();

    // Optional: adopt an initial weapon name / ammo straight from ctx.
    this._pullFromCtx(ctx);
  }

  /* ==================================================== public API ======= */

  setAmmo(mag, reserve) {
    this._ammoExternal = true;
    const m = Math.max(0, mag | 0);
    if (m > this.magCap) this.magCap = m;
    if (m < this.mag) {
      // a shot (or several) went out — kick the crosshair open
      this.fireKick = Math.min(1, this.fireKick + 0.55 + 0.12 * (this.mag - m));
    } else if (m > this.mag) {
      this._reloadOwn = -1;            // reload completed
      this._extReload = -1;
    }
    this.mag = m;
    this._setNum(this.lMag, m);
    if (reserve !== undefined && reserve !== null) {
      this.reserve = Math.max(0, reserve | 0);
      this._setNum(this.lReserve, this.reserve);
    }
  }

  setMagCapacity(n) { if (n > 0) this.magCap = n | 0; }

  setHealth(hp01) {
    let v = typeof hp01 === 'number' && isFinite(hp01) ? hp01 : this.hp;
    if (v > 1.0001) v *= 0.01;                        // tolerate 0..100
    v = clamp(v, 0, 1);
    if (v < this.hp - 1e-4) {
      const segs = this.tune.health.segments;
      const oldS = Math.ceil(this.hp * segs);
      const newS = Math.ceil(v * segs);
      if (newS < oldS) {
        for (let i = newS; i < oldS; i++) if (i >= 0 && i < segs) this.segFlash[i] = 1;
      } else {
        const i = clamp(newS - 1, 0, segs - 1);
        if (this.segFlash[i] < 0.7) this.segFlash[i] = 0.7;
      }
      this.dmgPulse = Math.min(1, this.dmgPulse + 0.28 + (this.hp - v) * 1.9);
    }
    this.hp = v;
    this._setNum(this.lHp, Math.round(v * 100));
  }

  setWeaponName(s) {
    this._nameExternal = true;
    this._setText(this.lWeapon, s == null ? '' : s, true);
  }

  /** 'hit' | 'armor' | 'kill' | 'headshot' */
  hitmarker(kind) {
    const T = this.tune.hitmarker;
    const e = this._freeHit();
    if (!e) return;
    e.active = true; e.t = 0;
    e.settle = T.settleIn; e.fade = T.fade; e.life = T.settleIn + T.fade;
    e.weight = T.weight; e.scale = 1; e.pop = T.popScale;
    switch (kind) {
      case 'kill':
        e.color = this.pal.kill; e.scale = T.killScale; e.weight = T.weight + 0.6; break;
      case 'headshot':
        e.color = this.pal.bright;
        e.settle = T.headshot.settleIn; e.weight = T.headshot.weight;
        e.scale = T.headshot.scale; e.pop = T.headshot.popScale;
        e.life = e.settle + T.fade; break;
      case 'armor':
        e.color = this.pal.cyan; break;
      default:
        e.color = this.pal.white; break;
    }
  }

  /** worldPos: any {x,y,z}. Omit for an omnidirectional (unknown source) flash. */
  damageFrom(worldPos) {
    const e = this._freeDmg();
    this.dmgPulse = Math.min(1, this.dmgPulse + 0.45);
    if (!e) return;
    e.active = true; e.t = 0; e.life = this.tune.damage.life; e.ang = 0;
    if (worldPos && typeof worldPos.x === 'number') {
      e.x = worldPos.x; e.y = worldPos.y; e.z = worldPos.z; e.omni = false;
    } else {
      e.x = 0; e.y = 0; e.z = 0; e.omni = true;
    }
  }

  killfeed(attacker, victim, weapon, headshot) {
    const max = this.kfMax;
    // rotate the slot ring: index 0 is always newest, no allocation
    const slot = this.kf[max - 1];
    for (let i = max - 1; i > 0; i--) this.kf[i] = this.kf[i - 1];
    this.kf[0] = slot;
    slot.active = true; slot.t = 0; slot.fresh = 1;
    slot.headshot = !!headshot;
    slot.weapon = this._normWeapon(weapon);
    this._setText(slot.atk, attacker == null ? '???' : attacker, true);
    this._setText(slot.vic, victim == null ? '???' : victim, true);
    slot.y = this.L.kfY || 0; slot.yT = slot.y;
    this.kfN = Math.min(max, this.kfN + 1);
    // re-target every row immediately so the stack slides rather than snaps
    for (let i = 0; i < max; i++) this.kf[i].yT = (this.L.kfY || 0) + i * (this.L.kfRow || 21);
    slot.y = slot.yT;
  }

  setObjective(text) {
    const had = this.lObj.raw;
    this._setText(this.lObj, text == null ? '' : text, true);
    this.objTarget = this.lObj.chars.length ? 1 : 0;
    if (had !== this.lObj.raw) this.objAlpha = Math.min(this.objAlpha, 0.15);
  }

  showBanner(title, sub) {
    this._setText(this.lBanner, title == null ? '' : title, true);
    this._setText(this.lBannerSub, sub == null ? '' : sub, true);
    this.banner.active = true;
    this.banner.t = 0;
  }

  /** Optional override: 0..1 while reloading, <0 to clear. */
  setReloadProgress(p) { this._extReload = (typeof p === 'number' && p >= 0) ? clamp(p, 0, 1) : -1; }

  setVisible(v) { this.visible = !!v; this.canvas.style.display = v ? 'block' : 'none'; }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null; this.c = null;
  }

  /* ==================================================== main update ====== */

  update(dt, ctx) {
    if (!this.c) return;
    dt = (typeof dt === 'number' && dt > 0) ? Math.min(dt, 0.1) : 0.016;
    this.time += dt;

    if (this._needResize || window.devicePixelRatio !== this.dpr) this._resize();
    if (!this.visible) return;

    this._pullFromCtx(ctx);
    this._tick(dt, ctx);

    const c = this.c, L = this.L;
    c.clearRect(0, 0, this.w, this.h);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.lineJoin = 'round';
    c.lineCap = 'butt';

    this._drawCompass(ctx);
    this._drawObjective();
    this._drawKillfeed();
    this._drawHealth();
    this._drawAmmo();
    this._drawDamage(ctx);
    this._drawCrosshair();
    this._drawReloadArc();
    this._drawHitmarkers();
    this._drawBanner();

    c.globalAlpha = 1;

    // Screen state goes through the grade pass, never a red rectangle here.
    const pp = ctx && ctx.postfx && ctx.postfx.params;
    if (pp) pp.hurt = this.hurt;
  }

  /* ==================================================== ctx sampling ===== */

  _pullFromCtx(ctx) {
    const p = ctx && ctx.player;
    const w = p && p.weapon;
    if (!w) return;
    if (!this._nameExternal) {
      const n = w.displayName || w.name || w.kind;
      if (n) this._setText(this.lWeapon, n, true);
    }
    if (!this._ammoExternal) {
      const cap = w.magSize || w.magCapacity || w.clipSize;
      if (cap > 0) this.magCap = cap | 0;
      const m = typeof w.mag === 'number' ? w.mag : (typeof w.ammo === 'number' ? w.ammo : null);
      if (m !== null) { this.mag = Math.max(0, m | 0); this._setNum(this.lMag, this.mag); }
      const r = typeof w.reserve === 'number' ? w.reserve : w.reserveAmmo;
      if (typeof r === 'number') { this.reserve = Math.max(0, r | 0); this._setNum(this.lReserve, this.reserve); }
    }
  }

  _num01(v) {
    if (typeof v === 'number') return clamp(v > 1 ? 1 : v, 0, 1);
    if (v === true) return 1;
    return 0;
  }

  _readSpread(w) {
    let s = w && typeof w.spread === 'number' ? w.spread
          : (w && typeof w.currentSpread === 'number' ? w.currentSpread : null);
    if (s === null || !isFinite(s)) s = this.tune.crosshair.fallbackSpread;
    const mode = this.tune.crosshair.spreadIsDegrees;
    const asDeg = mode === true ? true : mode === false ? false : (s > 0.35);
    return Math.max(0, asDeg ? s : s * RAD2DEG);
  }

  _readReload(w, dt) {
    if (this._extReload >= 0) return this._extReload;
    if (!w) { this._reloadOwn = -1; return -1; }
    const active = !!(w.reloading || w.isReloading ||
                      w.state === 'reload' || w.state === 'reloading');
    if (!active) { this._reloadOwn = -1; return -1; }
    if (typeof w.reloadProgress === 'number') return clamp(w.reloadProgress, 0, 1);
    if (typeof w.reloadT === 'number' && w.reloadTime > 0) return clamp(w.reloadT / w.reloadTime, 0, 1);
    if (typeof w.reloadTimer === 'number' && w.reloadDuration > 0) {
      return clamp(1 - w.reloadTimer / w.reloadDuration, 0, 1);
    }
    // Nothing exposed: run our own clock so the widget still reads honestly.
    if (this._reloadOwn < 0) this._reloadOwn = 0;
    this._reloadOwn = Math.min(1, this._reloadOwn + dt / Math.max(0.05, this.tune.ammo.reloadTime));
    return this._reloadOwn;
  }

  /* ==================================================== simulation ======= */

  _tick(dt, ctx) {
    const T = this.tune, C = T.crosshair;
    const p = ctx && ctx.player;
    const w = p && p.weapon;

    /* --- ADS ------------------------------------------------------------ */
    let adsRaw = 0;
    if (p) {
      if (typeof p.adsT === 'number') adsRaw = this._num01(p.adsT);
      else if (p.ads !== undefined) adsRaw = this._num01(p.ads);
      else if (p.aiming !== undefined) adsRaw = this._num01(p.aiming);
    }
    if (!adsRaw && w) {
      if (typeof w.adsT === 'number') adsRaw = this._num01(w.adsT);
      else if (w.ads !== undefined) adsRaw = this._num01(w.ads);
    }
    this.ads = damp(this.ads, adsRaw, 11, dt);

    /* --- movement ------------------------------------------------------- */
    let sp = 0;
    const v = p && (p.velocity || p.vel || p.linearVelocity);
    if (v && typeof v.x === 'number') sp = Math.hypot(v.x, v.z || 0);
    else if (p && typeof p.speed === 'number') sp = p.speed;
    this.moveT = damp(this.moveT, clamp(sp / Math.max(0.01, C.moveRefSpeed), 0, 1), 9, dt);

    /* --- firing --------------------------------------------------------- */
    if (w && (w.firing || w.isFiring)) this.fireKick = Math.min(1, this.fireKick + dt * 6);
    this.fireKick = damp(this.fireKick, 0, C.fireDecay, dt);

    /* --- crosshair gap -------------------------------------------------- */
    const s = this.s;
    const spreadDeg = this._readSpread(w);
    let gap = C.baseGap + spreadDeg * C.pxPerDeg
            + this.moveT * C.moveOpen
            + this.fireKick * C.fireOpen;
    gap *= lerp(1, C.adsTighten, this.ads);
    gap = clamp(gap, C.baseGap * 0.55, C.maxGap) * s;
    this.chGap = damp(this.chGap, gap, C.ease, dt);

    const deadFade = this.hp <= 0 ? 0 : 1;
    this.chAlpha = damp(this.chAlpha, lerp(1, C.adsFade, this.ads) * deadFade, 9, dt);

    /* --- reload --------------------------------------------------------- */
    const rp = this._readReload(w, dt);
    this.reloadP = rp;
    this.reloadShow = damp(this.reloadShow, rp >= 0 ? 1 : 0, 12, dt);

    /* --- health --------------------------------------------------------- */
    this.hpDisp = damp(this.hpDisp, this.hp, T.health.ease, dt);
    const ft = T.health.flashTime, segs = T.health.segments;
    for (let i = 0; i < segs; i++) {
      if (this.segFlash[i] > 0) this.segFlash[i] = Math.max(0, this.segFlash[i] - dt / ft);
    }

    /* --- hurt (drives the grade pass) ------------------------------------ */
    this.dmgPulse = damp(this.dmgPulse, 0, T.hurt.pulseDecay, dt);
    const low = clamp((T.hurt.lowAt - this.hp) / Math.max(1e-3, T.hurt.lowAt), 0, 1);
    const lowBreath = 0.86 + 0.14 * Math.sin(this.time * 3.1);
    const target = Math.max(low * low * T.hurt.lowMax * lowBreath, this.dmgPulse);
    this.hurt = damp(this.hurt, target, T.hurt.ease, dt);

    /* --- pools ---------------------------------------------------------- */
    for (let i = 0; i < this.hits.length; i++) {
      const e = this.hits[i];
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= e.life) e.active = false;
    }
    for (let i = 0; i < this.dmg.length; i++) {
      const e = this.dmg[i];
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= e.life) e.active = false;
    }

    /* --- killfeed ------------------------------------------------------- */
    const K = T.killfeed;
    let alive = 0;
    for (let i = 0; i < this.kfMax; i++) {
      const e = this.kf[i];
      if (!e.active) continue;
      e.t += dt;
      if (e.t >= K.life) { e.active = false; continue; }
      alive++;
    }
    if (alive !== this.kfN) {
      // compact in place, preserving newest-first order
      let wI = 0;
      for (let i = 0; i < this.kfMax; i++) {
        const e = this.kf[i];
        if (e.active) {
          if (i !== wI) { const t = this.kf[wI]; this.kf[wI] = e; this.kf[i] = t; }
          wI++;
        }
      }
      this.kfN = wI;
    }
    for (let i = 0; i < this.kfN; i++) {
      const e = this.kf[i];
      e.yT = this.L.kfY + i * this.L.kfRow;
      e.y = damp(e.y, e.yT, K.slideEase, dt);
      e.fresh = damp(e.fresh, 0, 10, dt);
    }

    /* --- objective / banner --------------------------------------------- */
    this.objAlpha = damp(this.objAlpha, this.objTarget, 5.5, dt);
    if (this.banner.active) {
      this.banner.t += dt;
      const B = T.banner;
      if (this.banner.t >= B.fadeIn + B.hold + B.fadeOut) this.banner.active = false;
    }
  }

  _freeHit() {
    const a = this.hits;
    let oldest = null, oldT = -1;
    for (let i = 0; i < a.length; i++) {
      if (!a[i].active) return a[i];
      if (a[i].t > oldT) { oldT = a[i].t; oldest = a[i]; }
    }
    return oldest;
  }

  _freeDmg() {
    const a = this.dmg;
    let oldest = null, oldT = -1;
    for (let i = 0; i < a.length; i++) {
      if (!a[i].active) return a[i];
      if (a[i].t > oldT) { oldT = a[i].t; oldest = a[i]; }
    }
    return oldest;
  }

  /* ==================================================== layout =========== */

  _resize() {
    this._needResize = false;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const r = this.root.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width || window.innerWidth));
    const h = Math.max(1, Math.round(r.height || window.innerHeight));
    this.w = w; this.h = h; this.dpr = dpr;
    const cv = this.canvas;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    this.c.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._layout();
  }

  _layout() {
    const w = this.w, h = this.h, T = this.tune;
    const s = clamp(Math.min(h / 900, w / 1560), 0.72, 1.7) * T.uiScale;
    this.s = s;
    const L = this.L;

    L.cx = Math.round(w * 0.5);
    L.cy = Math.round(h * 0.5);
    L.margin = Math.round(40 * s);
    L.baseY = h - L.margin;

    L.chLen = 7 * s;
    L.chThick = Math.max(1, Math.round(2 * s));

    // bottom-left : health
    L.hpX = L.margin;
    L.hpBarW = T.health.barW * s;
    L.hpBarH = Math.max(3, Math.round(T.health.barH * s));
    L.hpBarY = L.baseY - Math.round(12 * s);
    L.hpNumY = L.baseY - Math.round(26 * s);
    L.hpLabY = L.baseY - Math.round(58 * s);

    // bottom-right : ammo
    L.amX = w - L.margin;
    L.amNumY = L.hpNumY;
    L.amLabY = L.hpLabY;
    L.amBarY = L.hpBarY;
    L.amBarW = T.ammo.barW * s;
    L.amBarH = Math.max(2, Math.round(T.ammo.barH * s));

    // top-right : killfeed
    L.kfX = w - Math.round(34 * s);
    L.kfY = Math.round(52 * s);
    L.kfRow = Math.round(T.killfeed.row * s);
    L.kfIconW = 24 * s;
    L.kfIconH = 10 * s;
    L.kfPad = 8 * s;

    // top-centre : compass + objective
    L.compW = clamp(w * T.compass.width, T.compass.minW * s, T.compass.maxW * s);
    L.compX = Math.round(w * 0.5);
    L.compY = Math.round(26 * s);
    L.compHeadY = L.compY + Math.round(40 * s);
    L.objY = L.compY + Math.round(64 * s);

    // centre
    L.dmgR = T.damage.radius * s;
    L.reloadR = 34 * s;

    // banner
    L.bnY = Math.round(h * 0.315);
    L.bnRule = T.banner.ruleW * s;

    const F = this.F;
    F.ammo = '700 ' + Math.round(46 * s) + 'px ' + FONT;
    F.ammoSm = '600 ' + Math.round(19 * s) + 'px ' + FONT;
    F.hp = '700 ' + Math.round(30 * s) + 'px ' + FONT;
    F.micro = '600 ' + Math.round(10 * s) + 'px ' + FONT;
    F.kf = '600 ' + Math.round(12.5 * s) + 'px ' + FONT;
    F.banner = '800 ' + Math.round(42 * s) + 'px ' + FONT;
    F.bannerSub = '600 ' + Math.round(11.5 * s) + 'px ' + FONT;
    F.compass = '700 ' + Math.round(12 * s) + 'px ' + FONT;
    F.obj = '600 ' + Math.round(11 * s) + 'px ' + FONT;

    this._lv++;   // invalidate every cached text measurement
  }

  /** snap a CSS-px coordinate onto the device pixel grid */
  _snap(v) { const d = this.dpr; return Math.round(v * d) / d; }

  /* ==================================================== text helpers ===== */

  _setText(lab, str, upper) {
    let sv = typeof str === 'string' ? str : String(str);
    if (upper) sv = sv.toUpperCase();
    if (lab.raw === sv) return;
    lab.raw = sv; lab.num = NaN;
    const ch = lab.chars; ch.length = 0;
    for (let i = 0; i < sv.length; i++) ch.push(sv.charAt(i));
    lab.font = null;
  }

  /** integer -> chars, built from a static digit table (zero string alloc) */
  _setNum(lab, n) {
    n = n | 0; if (n < 0) n = 0;
    if (lab.num === n) return;
    lab.num = n; lab.raw = null;
    const ch = lab.chars; ch.length = 0;
    if (n === 0) ch.push(DIGITS[0]);
    else {
      let d = n;
      while (d > 0) { ch.push(DIGITS[d % 10]); d = (d / 10) | 0; }
      for (let i = 0, j = ch.length - 1; i < j; i++, j--) { const t = ch[i]; ch[i] = ch[j]; ch[j] = t; }
    }
    lab.font = null;
  }

  _measure(lab, font, sp) {
    if (lab.font === font && lab.sp === sp && lab.lv === this._lv) return lab.w;
    const c = this.c;
    c.font = font;
    const ch = lab.chars, cw = lab.cw;
    cw.length = ch.length;
    let w = 0;
    for (let i = 0; i < ch.length; i++) { const m = c.measureText(ch[i]).width; cw[i] = m; w += m + sp; }
    if (ch.length) w -= sp;
    lab.w = w; lab.font = font; lab.sp = sp; lab.lv = this._lv;
    return w;
  }

  _runChars(lab, x, y) {
    const c = this.c, ch = lab.chars, cw = lab.cw, sp = lab.sp;
    let px = x;
    for (let i = 0; i < ch.length; i++) { c.fillText(ch[i], px, y); px += cw[i] + sp; }
  }

  /** align: 0 left | 1 centre | 2 right. Returns drawn width. */
  _text(lab, x, y, font, sp, align, color, alpha, shadow) {
    if (!lab.chars.length || alpha <= 0.004) return 0;
    const c = this.c;
    c.font = font;
    const w = this._measure(lab, font, sp);
    const px = align === 1 ? x - w * 0.5 : align === 2 ? x - w : x;
    c.globalAlpha = alpha;
    if (shadow !== false) {
      c.fillStyle = this.pal.shadow;
      this._runChars(lab, px + 1, y + 1);
    }
    c.fillStyle = color;
    this._runChars(lab, px, y);
    c.globalAlpha = 1;
    return w;
  }

  /* ==================================================== crosshair ======== */

  _drawCrosshair() {
    const a = this.chAlpha;
    if (a <= 0.012) return;
    const c = this.c, L = this.L, P = this.pal;
    const cx = this._snap(L.cx), cy = this._snap(L.cy);
    const gap = this.chGap;
    const len = L.chLen * lerp(1, 0.72, this.ads) * (1 + 0.18 * this.fireKick);
    const th = L.chThick;

    c.globalAlpha = a * 0.85;
    c.fillStyle = P.shadow;
    this._chRects(cx, cy, gap, len, th, 1);
    c.globalAlpha = a;
    c.fillStyle = P.white;
    this._chRects(cx, cy, gap, len, th, 0);

    // centre dot
    const d = Math.max(1, Math.round(this.tune.crosshair.dotSize * this.s));
    c.globalAlpha = a * 0.8;
    c.fillStyle = P.shadow;
    c.fillRect(this._snap(cx - d * 0.5 - 1), this._snap(cy - d * 0.5 - 1), d + 2, d + 2);
    c.globalAlpha = a;
    c.fillStyle = P.white;
    c.fillRect(this._snap(cx - d * 0.5), this._snap(cy - d * 0.5), d, d);
    c.globalAlpha = 1;
  }

  _chRects(cx, cy, gap, len, th, grow) {
    const c = this.c;
    const g = grow;
    const t = th + g * 2;
    const l = len + g * 2;
    const x0 = this._snap(cx - t * 0.5);
    const y0 = this._snap(cy - t * 0.5);
    c.fillRect(x0, this._snap(cy - gap - len - g), t, l);       // top
    c.fillRect(x0, this._snap(cy + gap - g), t, l);             // bottom
    c.fillRect(this._snap(cx - gap - len - g), y0, l, t);       // left
    c.fillRect(this._snap(cx + gap - g), y0, l, t);             // right
  }

  /* ==================================================== hitmarkers ======= */

  _drawHitmarkers() {
    const c = this.c, L = this.L, s = this.s, T = this.tune.hitmarker;
    const cx = L.cx, cy = L.cy;
    const K = 0.70710678;
    for (let i = 0; i < this.hits.length; i++) {
      const e = this.hits[i];
      if (!e.active) continue;
      let alpha, pop;
      if (e.t < e.settle) {
        const u = e.t / e.settle;
        pop = lerp(e.pop, 1, easeOutQuint(u));
        alpha = 1;
      } else {
        pop = 1;
        alpha = 1 - easeOutCubic(clamp((e.t - e.settle) / e.fade, 0, 1));
      }
      const sc = pop * e.scale * s;
      const r0 = T.inner * sc, r1 = T.outer * sc;
      const lw = e.weight * s;

      c.lineCap = 'round';
      c.globalAlpha = alpha * 0.7;
      c.strokeStyle = this.pal.shadow;
      c.lineWidth = lw + 2;
      this._hitPath(cx, cy, r0, r1, K);
      c.globalAlpha = alpha;
      c.strokeStyle = e.color;
      c.lineWidth = lw;
      this._hitPath(cx, cy, r0, r1, K);
      c.lineCap = 'butt';
    }
    c.globalAlpha = 1;
  }

  _hitPath(cx, cy, r0, r1, K) {
    const c = this.c;
    c.beginPath();
    c.moveTo(cx - r0 * K, cy - r0 * K); c.lineTo(cx - r1 * K, cy - r1 * K);
    c.moveTo(cx + r0 * K, cy - r0 * K); c.lineTo(cx + r1 * K, cy - r1 * K);
    c.moveTo(cx - r0 * K, cy + r0 * K); c.lineTo(cx - r1 * K, cy + r1 * K);
    c.moveTo(cx + r0 * K, cy + r0 * K); c.lineTo(cx + r1 * K, cy + r1 * K);
    c.stroke();
  }

  /* ==================================================== damage arcs ====== */

  _drawDamage(ctx) {
    const c = this.c, L = this.L, P = this.pal, T = this.tune.damage;
    const cam = ctx && ctx.camera;
    let me = null;
    if (cam && cam.matrixWorld) me = cam.matrixWorld.elements;

    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'butt';
    for (let i = 0; i < this.dmg.length; i++) {
      const e = this.dmg[i];
      if (!e.active) continue;
      const u = clamp(e.t / e.life, 0, 1);
      let a = (1 - easeOutCubic(u)) * 0.95;
      a *= smooth01(e.t / T.fadeIn);
      if (a <= 0.004) continue;

      // Project the attacker through the camera basis -> screen-space bearing.
      let ang = 0;
      if (!e.omni && me) {
        const dx = e.x - me[12], dy = e.y - me[13], dz = e.z - me[14];
        const rx = dx * me[0] + dy * me[1] + dz * me[2];    // camera right
        const bz = dx * me[8] + dy * me[9] + dz * me[10];   // camera "back"
        ang = Math.atan2(rx, -bz);                          // 0 = dead ahead
        e.ang = ang;
      } else if (!e.omni) {
        ang = e.ang;
      }

      const r = L.dmgR * (1 + 0.10 * u);
      const span = T.spanDeg * Math.PI / 180;
      const base = ang - HALFPI;
      c.strokeStyle = P.red;

      if (e.omni) {
        c.globalAlpha = a * 0.28;
        c.lineWidth = T.thickness * this.s * 0.8;
        c.beginPath(); c.arc(L.cx, L.cy, r, 0, Math.PI * 2); c.stroke();
        continue;
      }
      // Fake a taper with three nested sub-arcs — cheap, no gradients.
      const half = span * 0.5;
      c.globalAlpha = a * 0.22;
      c.lineWidth = T.thickness * this.s * 0.5;
      c.beginPath(); c.arc(L.cx, L.cy, r, base - half, base + half); c.stroke();
      c.globalAlpha = a * 0.40;
      c.lineWidth = T.thickness * this.s * 0.78;
      c.beginPath(); c.arc(L.cx, L.cy, r, base - half * 0.62, base + half * 0.62); c.stroke();
      c.globalAlpha = a * 0.92;
      c.lineWidth = T.thickness * this.s;
      c.beginPath(); c.arc(L.cx, L.cy, r, base - half * 0.30, base + half * 0.30); c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  }

  /* ==================================================== health =========== */

  _drawHealth() {
    const c = this.c, L = this.L, P = this.pal, T = this.tune.health, s = this.s;
    const hp = this.hpDisp;
    const segs = T.segments;
    const gap = T.gap * s;
    const segW = (L.hpBarW - gap * (segs - 1)) / segs;
    const y = L.hpBarY, hgt = L.hpBarH;

    let col = P.steel, alpha = 0.94;
    if (this.hp <= T.criticalThreshold) col = P.red;
    else if (this.hp <= T.lowThreshold) col = P.amber;
    if (this.hp <= T.lowThreshold) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 * T.pulseHz);
      alpha *= lerp(0.62, 1.0, pulse);
    }

    const fill = hp * segs;
    for (let i = 0; i < segs; i++) {
      const x = this._snap(L.hpX + i * (segW + gap));
      const wSeg = Math.max(1, this._snap(x + segW) - x);
      // empty track
      c.globalAlpha = 1;
      c.fillStyle = P.track;
      c.fillRect(x, this._snap(y), wSeg, hgt);
      // fill
      const f = clamp(fill - i, 0, 1);
      if (f > 0.001) {
        c.globalAlpha = alpha;
        c.fillStyle = col;
        c.fillRect(x, this._snap(y), Math.max(1, wSeg * f), hgt);
      }
      // damage flash on the segment(s) just lost
      const fl = this.segFlash[i];
      if (fl > 0) {
        c.globalAlpha = easeOutCubic(fl) * 0.9;
        c.fillStyle = P.bright;
        const gy = this._snap(y - 1 * s);
        c.fillRect(x, gy, wSeg, hgt + 2 * s);
      }
    }
    c.globalAlpha = 1;

    // number + label
    const numCol = this.hp <= T.criticalThreshold ? P.red
                 : this.hp <= T.lowThreshold ? P.amber : P.white;
    this._text(this.lHp, L.hpX, L.hpNumY, this.F.hp, 1 * s, 0, numCol, 0.98);
    this._text(this.lVitals, L.hpX, L.hpLabY, this.F.micro, 3.6 * s, 0, P.dim, 0.85);

    // tiny accent tick under the label
    c.globalAlpha = 0.55;
    c.fillStyle = P.accent;
    c.fillRect(this._snap(L.hpX), this._snap(L.hpLabY + 6 * s), Math.round(14 * s), Math.max(1, Math.round(1 * s)));
    c.globalAlpha = 1;
  }

  /* ==================================================== ammo ============= */

  _drawAmmo() {
    const c = this.c, L = this.L, P = this.pal, T = this.tune.ammo, s = this.s;
    const F = this.F;
    const ratio = this.magCap > 0 ? this.mag / this.magCap : 1;

    let magCol = P.white, magAlpha = 0.98;
    if (this.mag === 0) {
      magCol = P.red;
      magAlpha = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 * T.emptyPulseHz));
    } else if (ratio < T.lowRatio) {
      magCol = P.amber;
    }

    // right-aligned run:  MAG / RESERVE
    const spSm = 0.6 * s;
    const wRes = this._measure(this.lReserve, F.ammoSm, spSm);
    const wSl = this._measure(this.lSlash, F.ammoSm, spSm);
    const padX = 6 * s;
    const xRes = L.amX;
    const xSl = xRes - wRes - padX;
    const xMag = xSl - wSl - padX;

    this._text(this.lReserve, xRes, L.amNumY, F.ammoSm, spSm, 2, P.muted, 0.8);
    this._text(this.lSlash, xSl, L.amNumY, F.ammoSm, spSm, 2, P.dim, 0.6);
    this._text(this.lMag, xMag, L.amNumY, F.ammo, 1 * s, 2, magCol, magAlpha);

    // weapon name
    this._text(this.lWeapon, L.amX, L.amLabY, F.micro, 3.6 * s, 2, P.muted, 0.9);
    c.globalAlpha = 0.55;
    c.fillStyle = P.accent;
    c.fillRect(this._snap(L.amX - 14 * s), this._snap(L.amLabY + 6 * s),
               Math.round(14 * s), Math.max(1, Math.round(1 * s)));
    c.globalAlpha = 1;

    // reload bar
    const show = this.reloadShow;
    if (show > 0.01) {
      const p = clamp(this.reloadP < 0 ? 1 : this.reloadP, 0, 1);
      const bw = L.amBarW, bh = L.amBarH;
      const bx = this._snap(L.amX - bw), by = this._snap(L.amBarY);
      c.globalAlpha = show;
      c.fillStyle = P.track;
      c.fillRect(bx, by, bw, bh);
      c.fillStyle = P.accent;
      c.fillRect(bx, by, Math.max(1, bw * easeOutCubic(p)), bh);
      c.globalAlpha = show * 0.85;
      this._text(this.lReload, L.amX - bw - 10 * s, L.amBarY + bh, F.micro, 3.2 * s, 2, P.accentHi, show * 0.85);
      c.globalAlpha = 1;
    }
  }

  _drawReloadArc() {
    const show = this.reloadShow;
    if (show <= 0.01) return;
    const c = this.c, L = this.L, P = this.pal;
    const p = clamp(this.reloadP < 0 ? 1 : this.reloadP, 0, 1);
    const r = L.reloadR;
    const span = 1.05;                       // radians of total sweep
    const a0 = HALFPI - span * 0.5;          // centred on "down"
    c.lineCap = 'round';
    c.globalAlpha = show * 0.35;
    c.strokeStyle = P.trackHi;
    c.lineWidth = 2 * this.s;
    c.beginPath(); c.arc(L.cx, L.cy, r, a0, a0 + span); c.stroke();
    c.globalAlpha = show * 0.95;
    c.strokeStyle = P.accent;
    c.lineWidth = 2.4 * this.s;
    c.beginPath(); c.arc(L.cx, L.cy, r, a0, a0 + span * easeOutCubic(p)); c.stroke();
    c.lineCap = 'butt';
    c.globalAlpha = 1;
  }

  /* ==================================================== killfeed ========= */

  _drawKillfeed() {
    const c = this.c, L = this.L, P = this.pal, F = this.F, s = this.s;
    const K = this.tune.killfeed;
    const sp = 1.4 * s;

    for (let i = 0; i < this.kfN; i++) {
      const e = this.kf[i];
      if (!e.active) continue;
      let a = smooth01(e.t / K.fadeIn);
      const rem = K.life - e.t;
      if (rem < K.fadeOut) a *= smooth01(rem / K.fadeOut);
      if (a <= 0.005) continue;

      const wA = this._measure(e.atk, F.kf, sp);
      const wV = this._measure(e.vic, F.kf, sp);
      const iconW = L.kfIconW;
      const skullW = e.headshot ? 11 * s + L.kfPad * 0.6 : 0;
      const total = wA + L.kfPad + iconW + L.kfPad + skullW + wV;

      const slide = e.fresh * 14 * s;
      const left = L.kfX - total + slide;
      const y = e.y;

      this._text(e.atk, left, y, F.kf, sp, 0, P.steel, a);
      const gx = left + wA + L.kfPad;
      this._glyph(e.weapon, gx, y - 4 * s, iconW, L.kfIconH, P.accent, a * 0.95);
      let vx = gx + iconW + L.kfPad;
      if (e.headshot) {
        this._skull(vx, y - 4 * s, 9 * s, 11 * s, P.accentHi, a);
        vx += skullW;
      }
      this._text(e.vic, vx, y, F.kf, sp, 0, P.muted, a * 0.92);
    }
    c.globalAlpha = 1;
  }

  _normWeapon(w) {
    if (typeof w !== 'string') return 'rifle';
    const k = w.toLowerCase();
    if (k.indexOf('smg') >= 0 || k.indexOf('mp') === 0) return 'smg';
    if (k.indexOf('pistol') >= 0 || k.indexOf('sidearm') >= 0) return 'pistol';
    if (k.indexOf('knife') >= 0 || k.indexOf('melee') >= 0) return 'knife';
    if (k.indexOf('nade') >= 0 || k.indexOf('grenade') >= 0) return 'grenade';
    if (k.indexOf('explo') >= 0 || k.indexOf('blast') >= 0) return 'explosion';
    if (k.indexOf('shotgun') >= 0) return 'shotgun';
    return 'rifle';
  }

  /** procedural weapon glyph in the box (x, y-h/2) .. (x+w, y+h/2) */
  _glyph(kind, x, y, w, h, color, alpha) {
    const c = this.c;
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.strokeStyle = color;
    const t = Math.max(1, h * 0.14);
    const my = y;
    switch (kind) {
      case 'pistol':
        c.fillRect(x + w * 0.34, my - h * 0.20, w * 0.62, h * 0.24);       // slide
        c.fillRect(x + w * 0.34, my + h * 0.04, w * 0.22, h * 0.44);       // grip
        c.fillRect(x + w * 0.56, my + h * 0.04, w * 0.10, h * 0.16);       // trigger guard
        break;
      case 'knife':
        c.beginPath();
        c.moveTo(x + w * 0.30, my + h * 0.10);
        c.lineTo(x + w * 0.96, my - h * 0.24);
        c.lineTo(x + w * 0.96, my + h * 0.04);
        c.closePath(); c.fill();
        c.fillRect(x + w * 0.06, my - h * 0.06, w * 0.26, h * 0.20);
        break;
      case 'grenade':
        c.beginPath(); c.arc(x + w * 0.52, my + h * 0.10, h * 0.36, 0, Math.PI * 2); c.fill();
        c.fillRect(x + w * 0.44, my - h * 0.44, w * 0.16, h * 0.24);
        c.fillRect(x + w * 0.58, my - h * 0.40, w * 0.22, t);
        break;
      case 'explosion': {
        const cx0 = x + w * 0.5;
        c.lineWidth = t;
        c.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          c.moveTo(cx0 + Math.cos(a) * h * 0.16, my + Math.sin(a) * h * 0.16);
          c.lineTo(cx0 + Math.cos(a) * h * 0.48, my + Math.sin(a) * h * 0.48);
        }
        c.stroke();
        break;
      }
      case 'shotgun':
        c.fillRect(x + w * 0.02, my - h * 0.10, w * 0.30, h * 0.28);       // stock
        c.fillRect(x + w * 0.30, my - h * 0.16, w * 0.36, h * 0.32);       // receiver
        c.fillRect(x + w * 0.62, my - h * 0.14, w * 0.38, h * 0.14);       // barrel
        c.fillRect(x + w * 0.62, my + h * 0.02, w * 0.30, h * 0.10);       // tube
        break;
      case 'smg':
        c.fillRect(x + w * 0.04, my - h * 0.08, w * 0.24, h * 0.22);       // stock
        c.fillRect(x + w * 0.26, my - h * 0.20, w * 0.40, h * 0.36);       // receiver
        c.fillRect(x + w * 0.66, my - h * 0.14, w * 0.30, h * 0.14);       // barrel
        c.fillRect(x + w * 0.40, my + h * 0.14, w * 0.13, h * 0.46);       // mag
        c.fillRect(x + w * 0.60, my + h * 0.14, w * 0.10, h * 0.26);       // grip
        break;
      default: // rifle
        c.fillRect(x + w * 0.00, my - h * 0.02, w * 0.20, h * 0.22);       // stock
        c.fillRect(x + w * 0.18, my - h * 0.18, w * 0.44, h * 0.34);       // receiver
        c.fillRect(x + w * 0.60, my - h * 0.12, w * 0.40, h * 0.13);       // barrel
        c.fillRect(x + w * 0.40, my - h * 0.28, w * 0.14, h * 0.11);       // sight
        c.fillRect(x + w * 0.52, my + h * 0.14, w * 0.11, h * 0.42);       // grip
        c.beginPath();                                                     // curved mag
        c.moveTo(x + w * 0.30, my + h * 0.14);
        c.lineTo(x + w * 0.44, my + h * 0.14);
        c.lineTo(x + w * 0.40, my + h * 0.62);
        c.lineTo(x + w * 0.24, my + h * 0.58);
        c.closePath(); c.fill();
        break;
    }
    c.globalAlpha = 1;
  }

  _skull(x, y, w, h, color, alpha) {
    const c = this.c;
    c.globalAlpha = alpha;
    c.fillStyle = color;
    const cx = x + w * 0.5, cy = y - h * 0.06;
    c.beginPath();
    c.ellipse(cx, cy, w * 0.5, h * 0.42, 0, 0, Math.PI * 2);
    c.fill();
    c.fillRect(cx - w * 0.26, cy + h * 0.28, w * 0.52, h * 0.26);          // jaw
    c.fillStyle = this.pal.hole;
    const er = w * 0.15;
    c.beginPath(); c.ellipse(cx - w * 0.20, cy - h * 0.02, er, er * 1.15, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(cx + w * 0.20, cy - h * 0.02, er, er * 1.15, 0, 0, Math.PI * 2); c.fill();
    c.fillRect(cx - w * 0.06, cy + h * 0.30, w * 0.12, h * 0.22);
    c.globalAlpha = 1;
  }

  /* ==================================================== compass ========== */

  _drawCompass(ctx) {
    const c = this.c, L = this.L, P = this.pal, F = this.F, s = this.s;
    const T = this.tune.compass;
    const cam = ctx && ctx.camera;
    let heading = 0;
    if (cam && cam.matrixWorld) {
      const me = cam.matrixWorld.elements;
      const fx = -me[8], fz = -me[10];                 // camera forward (world)
      heading = Math.atan2(fx, -fz) * RAD2DEG;         // 0 = -Z = North
      if (heading < 0) heading += 360;
    }

    const half = T.spanDeg * 0.5;
    const pxPerDeg = (L.compW * 0.5) / half;
    const y0 = L.compY;
    const letterY = y0 + 12 * s;
    const tickTop = y0 + 18 * s;

    // caret
    c.globalAlpha = 0.9;
    c.fillStyle = P.accent;
    c.beginPath();
    c.moveTo(L.compX, y0 - 1 * s);
    c.lineTo(L.compX - 4 * s, y0 - 8 * s);
    c.lineTo(L.compX + 4 * s, y0 - 8 * s);
    c.closePath(); c.fill();

    // baseline rule
    c.globalAlpha = 0.16;
    c.fillStyle = P.rule;
    c.fillRect(this._snap(L.compX - L.compW * 0.5), this._snap(tickTop), L.compW, Math.max(1, Math.round(1 * s)));

    const step = T.tickDeg;
    const n = Math.round(360 / step);
    for (let i = 0; i < n; i++) {
      const deg = i * step;
      const d = wrapDeg(deg - heading);
      if (d < -half || d > half) continue;
      const x = this._snap(L.compX + d * pxPerDeg);
      const edge = 1 - smooth01((Math.abs(d) - half * 0.5) / (half * 0.5));
      if (edge <= 0.01) continue;
      const major = (deg % 45) === 0;
      const tl = (major ? 7 : 4) * s;
      c.globalAlpha = edge * (major ? 0.85 : 0.4);
      c.fillStyle = major ? P.steel : P.dim;
      c.fillRect(x, this._snap(tickTop + 2 * s), Math.max(1, Math.round(1 * s)), tl);
      if (major) {
        const lab = this.cardinals[(deg / 45) | 0];
        const cardinal = (deg % 90) === 0;
        this._text(lab, x, letterY, F.compass, 2.2 * s, 1,
                   cardinal ? (deg === 0 ? P.accent : P.white) : P.muted,
                   edge * (cardinal ? 0.98 : 0.6));
      }
    }

    // numeric heading, rebuilt only when the integer degree changes
    this._setNum(this.lHeading, Math.round(heading) % 360);
    this._text(this.lHeading, L.compX, L.compHeadY, F.obj, 1.6 * s, 1, P.dim, 0.5);
    c.globalAlpha = 1;
  }

  /* ==================================================== objective ======== */

  _drawObjective() {
    const a = this.objAlpha;
    if (a <= 0.01 || !this.lObj.chars.length) return;
    const c = this.c, L = this.L, P = this.pal, s = this.s;
    const y = L.objY;
    const w = this._measure(this.lObj, this.F.obj, 3.0 * s);
    const dx = L.compX - w * 0.5 - 12 * s;

    // small orange diamond marker
    c.globalAlpha = a * 0.9;
    c.fillStyle = P.accent;
    const r = 3 * s;
    c.beginPath();
    c.moveTo(dx, y - 4 * s - r); c.lineTo(dx + r, y - 4 * s);
    c.lineTo(dx, y - 4 * s + r); c.lineTo(dx - r, y - 4 * s);
    c.closePath(); c.fill();
    c.globalAlpha = 1;

    this._text(this.lObj, L.compX, y, this.F.obj, 3.0 * s, 1, P.muted, a * 0.92);
  }

  /* ==================================================== banner =========== */

  _drawBanner() {
    const B = this.banner;
    if (!B.active) return;
    const T = this.tune.banner;
    const c = this.c, L = this.L, P = this.pal, s = this.s;

    let a, wipe, rise;
    if (B.t < T.fadeIn) {
      const u = B.t / T.fadeIn;
      a = smooth01(u);
      wipe = easeOutCubic(clamp(u * 1.25, 0, 1));
      rise = (1 - easeOutCubic(u)) * 9 * s;
    } else if (B.t < T.fadeIn + T.hold) {
      a = 1; wipe = 1; rise = 0;
    } else {
      const u = clamp((B.t - T.fadeIn - T.hold) / T.fadeOut, 0, 1);
      a = 1 - smooth01(u);
      wipe = 1 - easeOutCubic(u) * 0.85;
      rise = -u * 5 * s;
    }
    if (a <= 0.004) return;

    const y = L.bnY + rise;
    this._text(this.lBanner, L.compX, y, this.F.banner, 7.0 * s, 1, P.white, a);

    // thin rule that wipes horizontally out from the centre
    const rw = L.bnRule * wipe;
    const ry = this._snap(y + 16 * s);
    const th = Math.max(1, Math.round(1 * s));
    c.globalAlpha = a * 0.5;
    c.fillStyle = P.rule;
    c.fillRect(this._snap(L.compX - rw * 0.5), ry, rw, th);
    c.globalAlpha = a * 0.95;
    c.fillStyle = P.accent;
    const aw = Math.min(rw, 44 * s);
    c.fillRect(this._snap(L.compX - aw * 0.5), ry, aw, th);
    c.globalAlpha = 1;

    if (this.lBannerSub.chars.length) {
      this._text(this.lBannerSub, L.compX, y + 38 * s, this.F.bannerSub, 5.0 * s, 1, P.muted, a * 0.85);
    }
  }
}

export default HUD;
