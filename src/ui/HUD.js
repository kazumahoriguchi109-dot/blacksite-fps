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
 * ---------------------------------------------------------------------------
 * DESIGN RULE — read this before changing any number below.
 *
 * A combat HUD has one job: three things must be readable in a glance, over an
 * arbitrary background, without competing with one another.
 *
 *   TIER 1  am I being hit, and from where   — directional damage wedges,
 *                                              screen-edge hurt vignette
 *   TIER 1  do I have ammo                   — the magazine count
 *   TIER 1  am I about to die                — health number + segmented bar
 *   TIER 2  what state am I in               — one state word per cluster
 *                                              (RELOADING / RELOAD / WOUNDED /
 *                                              CRITICAL) in the slot that
 *                                              otherwise holds a quiet label
 *   TIER 3  everything else                  — killfeed, compass, objective,
 *                                              banners. These must RECEDE.
 *
 * Legibility is bought three ways, in this order:
 *   1. every glyph is stroked with a dark outline before it is filled, so it
 *      survives a blown-out sky without needing a panel behind it;
 *   2. the two bottom clusters and the banner sit on a soft elliptical scrim
 *      (one cached unit-space radial gradient, scaled per use) — support, not
 *      a box;
 *   3. bars get an explicit dark plate, because a bar is geometry and a plate
 *      reads as part of the widget.
 *
 * State is derived, never asserted twice. Health and the alive/dead flag are
 * pulled off `ctx.player` every frame, exactly like ammo already was, so the
 * HUD cannot show a death banner over a full health bar.
 *
 * Performance notes
 *   - Every pool is preallocated; the draw loop performs no allocation.
 *   - Text is stored as pre-split char arrays with cached per-char widths;
 *     numeric labels are rebuilt from a static digit table only when the
 *     integer value actually changes (no string concatenation per frame).
 *   - Gradients are built once per layout, in unit space, and placed with a
 *     transform — no `createGradient` in the draw loop.
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
const DEG2RAD = 0.017453292519943295;

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
  white:    '#f2f6fa',
  bright:   '#ffffff',
  steel:    '#cfdae6',
  muted:    '#93a3b4',
  dim:      '#6d7c8b',
  accent:   '#ff8a3d',
  accentHi: '#ffcda6',
  amber:    '#ffc14d',
  red:      '#ff4433',
  redHi:    '#ff7a63',
  kill:     '#ff5f3c',
  cyan:     '#5fd7e8',
  outline:  'rgba(0,0,0,0.90)',
  shadow:   'rgba(0,0,0,0.72)',
  hole:     'rgba(0,0,0,0.85)',
  plate:    'rgba(0,0,0,0.52)',
  track:    'rgba(232,238,245,0.16)',
  trackHi:  'rgba(232,238,245,0.30)',
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
        life: 0.40, settleIn: 0.09, fade: 0.31,
        inner: 5.0, outer: 13.5, weight: 2.6, popScale: 1.5,
        headshot: { settleIn: 0.065, weight: 3.6, scale: 1.30, popScale: 1.62 },
        killScale: 1.20,
      },

      health: {
        segments: 8, barW: 250, barH: 13, gap: 3,
        lowThreshold: 0.45, criticalThreshold: 0.22,
        pulseHz: 1.15, flashTime: 0.42, ease: 9.0,
      },

      ammo: {
        lowRatio: 0.30, emptyPulseHz: 1.6,
        reloadTime: 2.1,   // used only if the weapon exposes no progress
        barW: 190, barH: 4,
      },

      damage: {
        // Tier 1. Large, filled, outlined — a thin additive arc vanished over a
        // bright frame, which is exactly what the review reported.
        life: 1.45, radius: 128, spanDeg: 40, thickness: 14.0, fadeIn: 0.05,
        minDist: 0.75,     // closer than this == "unknown source", draw omni
      },

      killfeed: {
        life: 5.0, fadeIn: 0.18, fadeOut: 0.55, row: 22, slideEase: 15.0,
        alpha: 0.72,
      },

      banner: { fadeIn: 0.45, hold: 1.9, fadeOut: 0.7, ruleW: 300 },

      compass: { width: 0.30, minW: 250, maxW: 460, spanDeg: 120, tickDeg: 15,
                 alpha: 0.80 },

      hurt: { lowAt: 0.42, lowMax: 0.75, pulseDecay: 2.6, ease: 6.5,
              vignette: 0.85 },
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
    this.G = {};                  // cached gradients (rebuilt on layout only)
    this.visible = true;
    this.time = 0;

    /* ------------------------------------------------------------- state */
    this.hp = 1; this.hpDisp = 1;
    this.dead = false; this.deadT = 0; this.deadFade = 0;
    this.mag = 30; this.reserve = 120; this.magCap = 30;
    this._ammoExternal = false; this._nameExternal = false;
    this._healthExternal = false;

    this.chGap = this.tune.crosshair.baseGap;
    this.chAlpha = 1;
    this.ads = 0; this.moveT = 0; this.fireKick = 0;

    this.reloadP = -1;            // <0 == not reloading
    this._reloadOwn = -1;         // internal fallback timer
    this._extReload = -1;         // setReloadProgress() override
    this.reloadShow = 0;          // eased visibility of the reload widgets

    this.hurt = 0; this.dmgPulse = 0; this.dmgFlash = 0;

    /* labels ---------------------------------------------------------- */
    this.lWeapon = mkLabel();
    this.lMag = mkLabel();
    this.lReserve = mkLabel();
    this.lSlash = mkLabel();
    this.lVitals = mkLabel();
    this.lWounded = mkLabel();
    this.lCritical = mkLabel();
    this.lDown = mkLabel();
    this.lHp = mkLabel();
    this.lObj = mkLabel();
    this.lBanner = mkLabel();
    this.lBannerSub = mkLabel();
    this.lHeading = mkLabel();
    this.lReloading = mkLabel();
    this.lReloadCue = mkLabel();
    this._setText(this.lSlash, '/');
    this._setText(this.lVitals, 'vitals', true);
    this._setText(this.lWounded, 'wounded', true);
    this._setText(this.lCritical, 'critical', true);
    this._setText(this.lDown, 'down', true);
    this._setText(this.lWeapon, 'unarmed', true);
    this._setText(this.lReloading, 'reloading', true);
    this._setText(this.lReloadCue, 'reload', true);
    this._setNum(this.lMag, 30);
    this._setNum(this.lReserve, 120);
    this._setNum(this.lHp, 100);

    this.cardinals = [];
    const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let i = 0; i < 8; i++) { const l = mkLabel(); this._setText(l, CARD[i]); this.cardinals.push(l); }

    /* objective / banner timing --------------------------------------- */
    this.objAlpha = 0; this.objTarget = 0;
    this.banner = { active: false, t: 0, hold: this.tune.banner.hold, critical: false };

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

    // Optional: adopt an initial weapon name / ammo / health straight from ctx.
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
    this._healthExternal = true;
    this._applyHealth(hp01);
  }

  /** Shared by setHealth() and the per-frame pull off ctx.player. */
  _applyHealth(hp01) {
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
      this.dmgFlash = 1;
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
        e.color = this.pal.kill; e.scale = T.killScale; e.weight = T.weight + 0.8; break;
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
    this.dmgFlash = 1;
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
    // Criticality is latched in _tick from the live alive/dead flag, never
    // from string-matching a title — and it starts clear so that the banner
    // raised *on* respawn is not inked with the death that preceded it.
    this.banner.critical = false;
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

    const c = this.c;
    c.clearRect(0, 0, this.w, this.h);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.lineJoin = 'round';
    c.lineCap = 'butt';
    c.miterLimit = 2;

    /* Tier 3 first so Tier 1 always paints on top of it. */
    this._drawCompass(ctx);
    this._drawObjective();
    this._drawKillfeed();

    /* Tier 1 */
    this._drawHurtVignette();
    this._drawHealth();
    this._drawAmmo();
    this._drawCrosshair();
    this._drawReloadArc();
    this._drawDamage(ctx);
    this._drawHitmarkers();

    /* Tier 3, but centred — so it goes last and carries its own value support */
    this._drawBanner();

    c.globalAlpha = 1;

    // Screen state goes through the grade pass, never a red rectangle here.
    const pp = ctx && ctx.postfx && ctx.postfx.params;
    if (pp) pp.hurt = this.hurt;
  }

  /* ==================================================== ctx sampling ===== */

  _pullFromCtx(ctx) {
    const p = ctx && ctx.player;
    if (!p) return;

    /* --- health / alive ---------------------------------------------------
     * Nothing in the game calls setHealth(); it drives `player.health`
     * directly. Pulling it here is what stops the HUD contradicting itself
     * (a "YOU WERE KILLED" banner over a full bar was shipped for exactly
     * this reason). An explicit setHealth() still wins if anyone starts
     * calling it. */
    if (!this._healthExternal) {
      const maxH = typeof p.maxHealth === 'number' && p.maxHealth > 0 ? p.maxHealth : 100;
      if (typeof p.health === 'number' && isFinite(p.health)) {
        this._applyHealth(clamp(p.health / maxH, 0, 1));
      }
    }
    if (typeof p.dead === 'boolean') this.dead = p.dead;
    else this.dead = this.hp <= 0;

    const w = this._weaponSrc(ctx);
    if (!w) return;
    const cur = w.current || null;

    if (!this._nameExternal) {
      const n = (cur && ((cur.def && cur.def.name) || cur.name)) ||
                w.displayName || w.name || w.kind;
      if (n) this._setText(this.lWeapon, n, true);
    }

    /* Magazine CAPACITY is not ammunition — it must be adopted even when a
     * caller owns the round count, or the low-ammo threshold is computed
     * against whatever the largest magazine ever seen happened to be. */
    const cap = (cur && cur.def && cur.def.magSize) ||
                w.magSize || w.magCapacity || w.clipSize;
    if (cap > 0) this.magCap = cap | 0;

    if (!this._ammoExternal) {
      let m = typeof w.ammoMag === 'number' ? w.ammoMag
            : (cur && typeof cur.mag === 'number') ? cur.mag
            : typeof w.mag === 'number' ? w.mag
            : typeof w.ammo === 'number' ? w.ammo : null;
      if (m !== null) { this.mag = Math.max(0, m | 0); this._setNum(this.lMag, this.mag); }
      let r = typeof w.ammoReserve === 'number' ? w.ammoReserve
            : (cur && typeof cur.reserve === 'number') ? cur.reserve
            : typeof w.reserve === 'number' ? w.reserve : w.reserveAmmo;
      if (typeof r === 'number') { this.reserve = Math.max(0, r | 0); this._setNum(this.lReserve, this.reserve); }
    }
  }

  /**
   * Where weapon state actually lives.
   *
   * ARCHITECTURE.md describes `ctx.player.weapon`, but the shipped Player has
   * no such field — the WeaponSystem on `ctx.weapons` owns it. Every read that
   * went through `player.weapon` was therefore dead: no reload arc ever drew,
   * the crosshair never saw real spread, and ADS never registered. Prefer the
   * system that exists, keep honouring the documented shape if it appears.
   */
  _weaponSrc(ctx) {
    const ws = ctx && ctx.weapons;
    if (ws && (ws.current || typeof ws.state === 'string')) return ws;
    const p = ctx && ctx.player;
    return (p && p.weapon) || null;
  }

  _num01(v) {
    if (typeof v === 'number') return clamp(v > 1 ? 1 : v, 0, 1);
    if (v === true) return 1;
    return 0;
  }

  _readSpread(w) {
    let s = null;
    if (w && typeof w.computeSpread === 'function') {
      const v = w.computeSpread();
      if (typeof v === 'number' && isFinite(v)) s = v;
    }
    if (s === null) {
      s = w && typeof w.spread === 'number' ? w.spread
        : (w && typeof w.currentSpread === 'number' ? w.currentSpread : null);
    }
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
    // WeaponSystem shape: a state machine with an elapsed timer.
    if (typeof w.stateT === 'number' && w.reloadDuration > 0) {
      return clamp(w.stateT / w.reloadDuration, 0, 1);
    }
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
    const w = this._weaponSrc(ctx);

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
      else if (w.aiming !== undefined) adsRaw = this._num01(w.aiming);
    }
    this.ads = damp(this.ads, adsRaw, 11, dt);

    /* --- movement ------------------------------------------------------- */
    let sp = 0;
    const v = p && (p.velocity || p.vel || p.linearVelocity);
    if (v && typeof v.x === 'number') sp = Math.hypot(v.x, v.z || 0);
    else if (p && typeof p.speed === 'number') sp = p.speed;
    this.moveT = damp(this.moveT, clamp(sp / Math.max(0.01, C.moveRefSpeed), 0, 1), 9, dt);

    /* --- firing --------------------------------------------------------- */
    if (w && (w.firing || w.isFiring || w.state === 'firing')) {
      this.fireKick = Math.min(1, this.fireKick + dt * 6);
    }
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

    /* --- death ---------------------------------------------------------- */
    if (this.dead) this.deadT += dt; else this.deadT = 0;
    this.deadFade = damp(this.deadFade, this.dead ? 1 : 0, 7, dt);

    this.chAlpha = damp(this.chAlpha, lerp(1, C.adsFade, this.ads) * (1 - this.deadFade), 9, dt);

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

    /* --- hurt (drives the grade pass + the screen-edge vignette) --------- */
    this.dmgPulse = damp(this.dmgPulse, 0, T.hurt.pulseDecay, dt);
    this.dmgFlash = damp(this.dmgFlash, 0, 5.0, dt);
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
      e.fresh = damp(e.fresh, 0, 6, dt);
    }

    /* --- objective / banner --------------------------------------------- */
    this.objAlpha = damp(this.objAlpha, this.objTarget, 5.5, dt);
    if (this.banner.active) {
      this.banner.t += dt;
      const B = T.banner;
      /* A banner raised while the player is down IS the death banner, whatever
       * its title says — that is how the styling stays honest without parsing
       * strings. It holds for exactly as long as the death lasts, and it can
       * never survive into a frame where health has been restored. */
      if (this.dead) {
        this.banner.critical = true;
        this.banner.t = Math.min(this.banner.t, B.fadeIn + B.hold * 0.999);
      } else if (this.banner.critical) {
        this.banner.active = false;
      }
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

    /* Both bottom clusters share one baseline and one label line. A shared
     * grid is what lets the eye jump left<->right without re-acquiring. */
    L.labY = L.baseY - Math.round(96 * s);
    L.ruleY = L.labY + Math.round(7 * s);
    L.numY = L.baseY - Math.round(30 * s);

    // bottom-left : health
    L.hpX = L.margin;
    L.hpBarW = T.health.barW * s;
    L.hpBarH = Math.max(4, Math.round(T.health.barH * s));
    L.hpBarY = L.baseY - Math.round(15 * s);

    // bottom-right : ammo
    L.amX = w - L.margin;
    L.amBarW = T.ammo.barW * s;
    L.amBarH = Math.max(3, Math.round(T.ammo.barH * s));
    L.amBarY = L.hpBarY + L.hpBarH - L.amBarH;      // bottoms align

    // scrim footprints (elliptical, drawn from one cached unit gradient)
    L.scrimRx = 305 * s;
    L.scrimRy = 122 * s;
    L.scrimCy = L.baseY - Math.round(16 * s);

    // top-right : killfeed
    L.kfX = w - Math.round(34 * s);
    L.kfY = Math.round(60 * s);
    L.kfRow = Math.round(T.killfeed.row * s);
    L.kfIconW = 21 * s;
    L.kfIconH = 9 * s;
    L.kfPad = 7 * s;

    // top-centre : compass + objective
    L.compW = clamp(w * T.compass.width, T.compass.minW * s, T.compass.maxW * s);
    L.compX = Math.round(w * 0.5);
    L.compY = Math.round(26 * s);
    L.compHeadY = L.compY + Math.round(40 * s);
    L.objY = L.compY + Math.round(64 * s);

    // centre
    L.dmgR = T.damage.radius * s;
    L.dmgThick = T.damage.thickness * s;
    L.reloadR = 40 * s;

    // banner
    L.bnY = Math.round(h * 0.30);
    L.bnRule = T.banner.ruleW * s;
    L.bnPlateRx = Math.min(w * 0.34, 400 * s);
    L.bnPlateRy = 64 * s;

    const F = this.F;
    F.ammo = '800 ' + Math.round(62 * s) + 'px ' + FONT;
    F.ammoSm = '700 ' + Math.round(22 * s) + 'px ' + FONT;
    F.hp = '800 ' + Math.round(46 * s) + 'px ' + FONT;
    F.micro = '700 ' + Math.round(11 * s) + 'px ' + FONT;
    F.kf = '600 ' + Math.round(12 * s) + 'px ' + FONT;
    F.banner = '800 ' + Math.round(46 * s) + 'px ' + FONT;
    F.bannerSub = '700 ' + Math.round(13 * s) + 'px ' + FONT;
    F.compass = '700 ' + Math.round(11 * s) + 'px ' + FONT;
    F.obj = '600 ' + Math.round(11 * s) + 'px ' + FONT;

    /* Gradients, built once here in UNIT space (-1..1) and placed with a
     * transform at draw time. Canvas resolves a gradient against the CTM in
     * force when it is painted, so one object serves every scrim. */
    const c = this.c;
    const G = this.G;
    const soft = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    soft.addColorStop(0.00, 'rgba(0,0,0,1)');
    soft.addColorStop(0.42, 'rgba(0,0,0,0.80)');
    soft.addColorStop(0.72, 'rgba(0,0,0,0.34)');
    soft.addColorStop(1.00, 'rgba(0,0,0,0)');
    G.soft = soft;

    const hurt = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    hurt.addColorStop(0.00, 'rgba(180,18,10,0)');
    hurt.addColorStop(0.62, 'rgba(180,18,10,0)');
    hurt.addColorStop(0.85, 'rgba(198,24,12,0.26)');
    hurt.addColorStop(1.00, 'rgba(220,30,16,0.78)');
    G.hurt = hurt;

    /* Horizontal feathers, unit space on x (-1..1). The compass rule dissolves
     * at both ends instead of terminating in two hard stubs — a Tier 3 element
     * must not draw a hard line across the sky. */
    const feather = (rgb) => {
      const g = c.createLinearGradient(-1, 0, 1, 0);
      g.addColorStop(0.00, 'rgba(' + rgb + ',0)');
      g.addColorStop(0.24, 'rgba(' + rgb + ',1)');
      g.addColorStop(0.76, 'rgba(' + rgb + ',1)');
      g.addColorStop(1.00, 'rgba(' + rgb + ',0)');
      return g;
    };
    G.ruleFade = feather('150,175,200');
    G.ruleDark = feather('0,0,0');

    this._lv++;   // invalidate every cached text measurement
  }

  /** snap a CSS-px coordinate onto the device pixel grid */
  _snap(v) { const d = this.dpr; return Math.round(v * d) / d; }

  /**
   * Soft elliptical value support. Not a panel — at these alphas it reads as a
   * lens vignette, which is what keeps a white number alive over white concrete
   * without drawing a box around it.
   */
  _softPlate(cx, cy, rx, ry, alpha) {
    if (alpha <= 0.004) return;
    const c = this.c;
    c.save();
    c.globalAlpha = alpha;
    c.translate(cx, cy);
    c.scale(rx, ry);
    c.fillStyle = this.G.soft;
    c.fillRect(-1, -1, 2, 2);
    c.restore();
    c.globalAlpha = 1;
  }

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

  _strokeChars(lab, x, y) {
    const c = this.c, ch = lab.chars, cw = lab.cw, sp = lab.sp;
    let px = x;
    for (let i = 0; i < ch.length; i++) { c.strokeText(ch[i], px, y); px += cw[i] + sp; }
  }

  /**
   * align: 0 left | 1 centre | 2 right. Returns drawn width.
   * `outlineW` is the dark stroke laid under the fill, in px. Every piece of
   * HUD text gets one — that single change is what makes the HUD survive a
   * blown sky, an interior white floor, and a black shadow with one palette.
   */
  _text(lab, x, y, font, sp, align, color, alpha, outlineW) {
    if (!lab.chars.length || alpha <= 0.004) return 0;
    const c = this.c;
    c.font = font;
    const w = this._measure(lab, font, sp);
    const px = align === 1 ? x - w * 0.5 : align === 2 ? x - w : x;
    c.globalAlpha = alpha;
    const ow = outlineW === undefined ? 3 * this.s : outlineW;
    if (ow > 0.1) {
      c.lineJoin = 'round';
      c.lineCap = 'round';
      c.strokeStyle = this.pal.outline;
      c.lineWidth = ow;
      this._strokeChars(lab, px, y);
      c.lineCap = 'butt';
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
    const grow = Math.max(1, Math.round(1.4 * this.s));

    c.globalAlpha = a * 0.95;
    c.fillStyle = P.outline;
    this._chRects(cx, cy, gap, len, th, grow);
    c.globalAlpha = a;
    c.fillStyle = P.bright;
    this._chRects(cx, cy, gap, len, th, 0);

    // centre dot
    const d = Math.max(1, Math.round(this.tune.crosshair.dotSize * this.s));
    c.globalAlpha = a * 0.95;
    c.fillStyle = P.outline;
    c.fillRect(this._snap(cx - d * 0.5 - grow), this._snap(cy - d * 0.5 - grow), d + grow * 2, d + grow * 2);
    c.globalAlpha = a;
    c.fillStyle = P.bright;
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
      c.globalAlpha = alpha * 0.92;
      c.strokeStyle = this.pal.outline;
      c.lineWidth = lw + 3 * s;
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

  /* ==================================================== hurt vignette ==== */

  /**
   * The instantaneous "I am being hit" signal. `postfx.hurt` already grades the
   * whole frame, but it is eased at lambda 6.5 — it arrives too late and too
   * softly to be the thing that turns your head. This is the fast edge punch
   * that precedes it, so it is deliberately weak and short: any stronger and
   * the two together wash the frame pink, which is a worse read, not a better
   * one. It rides the same damage pulse as the wedges, so it cannot disagree
   * with them.
   */
  _drawHurtVignette() {
    const T = this.tune.hurt;
    const low = clamp((0.30 - this.hp) / 0.30, 0, 1);
    const breathe = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this.time * 2.4));
    const a = Math.max(this.dmgFlash * 0.52, low * low * 0.26 * breathe) * T.vignette;
    if (a <= 0.006) return;
    const c = this.c, w = this.w, h = this.h;
    c.save();
    c.globalAlpha = clamp(a, 0, 1);
    c.translate(w * 0.5, h * 0.5);
    c.scale(w * 0.62, h * 0.62);
    c.fillStyle = this.G.hurt;
    c.fillRect(-1, -1, 2, 2);
    c.restore();
    c.globalAlpha = 1;
  }

  /* ==================================================== damage arcs ====== */

  _drawDamage(ctx) {
    const c = this.c, L = this.L, P = this.pal, T = this.tune.damage;
    const cam = ctx && ctx.camera;
    let me = null;
    if (cam && cam.matrixWorld) me = cam.matrixWorld.elements;

    for (let i = 0; i < this.dmg.length; i++) {
      const e = this.dmg[i];
      if (!e.active) continue;
      const u = clamp(e.t / e.life, 0, 1);
      let a = (1 - easeOutCubic(u));
      a *= smooth01(e.t / T.fadeIn);
      if (a <= 0.006) continue;

      // Project the attacker through the camera basis -> screen-space bearing.
      let ang = 0, omni = e.omni;
      if (!omni && me) {
        const dx = e.x - me[12], dy = e.y - me[13], dz = e.z - me[14];
        // Damage with no usable source (fall damage passes the player's own
        // position) must not claim a direction it does not have.
        if (dx * dx + dy * dy + dz * dz < T.minDist * T.minDist) {
          omni = true;
        } else {
          const rx = dx * me[0] + dy * me[1] + dz * me[2];    // camera right
          const bz = dx * me[8] + dy * me[9] + dz * me[10];   // camera "back"
          ang = Math.atan2(rx, -bz);                          // 0 = dead ahead
          e.ang = ang;
        }
      } else if (!omni) {
        ang = e.ang;
      }

      const r = L.dmgR * (1 + 0.13 * u);
      const base = ang - HALFPI;

      if (omni) {
        // Unknown source: a full soft ring, so it can never be mistaken for a
        // bearing.
        c.globalAlpha = a * 0.42;
        c.lineCap = 'butt';
        c.strokeStyle = P.outline;
        c.lineWidth = L.dmgThick * 0.42 + 3 * this.s;
        c.beginPath(); c.arc(L.cx, L.cy, r, 0, Math.PI * 2); c.stroke();
        c.globalAlpha = a * 0.55;
        c.strokeStyle = P.red;
        c.lineWidth = L.dmgThick * 0.42;
        c.beginPath(); c.arc(L.cx, L.cy, r, 0, Math.PI * 2); c.stroke();
        continue;
      }

      const half = T.spanDeg * DEG2RAD * 0.5;
      const thick = L.dmgThick * lerp(1, 0.72, u);

      // Filled, tapered, outlined. A stroked arc in 'lighter' — which is what
      // this used to be — is invisible against a blown sky; a filled wedge with
      // a dark contour survives both ends of the value range.
      this._wedgePath(L.cx, L.cy, r, base, half, thick);
      c.globalAlpha = a * 0.9;
      c.lineJoin = 'round';
      c.strokeStyle = P.outline;
      c.lineWidth = 3.2 * this.s;
      c.stroke();
      c.globalAlpha = a;
      c.fillStyle = P.red;
      c.fill();

      // hot core, so the wedge still reads as "damage" and not as a UI chrome
      this._wedgePath(L.cx, L.cy, r, base, half * 0.52, thick * 0.42);
      c.globalAlpha = a * 0.85;
      c.fillStyle = P.redHi;
      c.fill();
    }
    c.globalAlpha = 1;
  }

  /** Tapered annular wedge: wide and thick in the middle, pinched at the ends. */
  _wedgePath(cx, cy, r, base, half, thick) {
    const c = this.c;
    const N = 14;
    c.beginPath();
    for (let i = 0; i <= N; i++) {                       // outer edge, left->right
      const u = (i / N) * 2 - 1;
      const th = thick * (1 - u * u * 0.70);
      const a = base + u * half;
      const rr = r + th * 0.5;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    for (let i = N; i >= 0; i--) {                       // inner edge, right->left
      const u = (i / N) * 2 - 1;
      const th = thick * (1 - u * u * 0.70);
      const a = base + u * half;
      const rr = r - th * 0.5;
      c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    c.closePath();
  }

  /* ==================================================== health =========== */

  _drawHealth() {
    const c = this.c, L = this.L, P = this.pal, T = this.tune.health, s = this.s;
    const hp = this.hpDisp;
    const segs = T.segments;
    const gap = T.gap * s;
    const segW = (L.hpBarW - gap * (segs - 1)) / segs;
    const y = L.hpBarY, hgt = L.hpBarH;

    // value support under the whole cluster
    this._softPlate(L.hpX + L.hpBarW * 0.22, L.scrimCy, L.scrimRx, L.scrimRy, 0.40);

    const critical = this.hp <= T.criticalThreshold;
    const lowHp = this.hp <= T.lowThreshold;
    let col = P.steel, alpha = 1;
    if (critical) col = P.red;
    else if (lowHp) col = P.amber;
    if (lowHp) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 * T.pulseHz * (critical ? 1.7 : 1));
      alpha *= lerp(critical ? 0.74 : 0.82, 1.0, pulse);
    }

    // dark plate behind the whole bar — the empty track has to read against
    // white concrete as clearly as it does against asphalt
    const pad = Math.max(2, Math.round(2 * s));
    c.globalAlpha = 1;
    c.fillStyle = P.plate;
    c.fillRect(this._snap(L.hpX - pad), this._snap(y - pad),
               Math.round(L.hpBarW + pad * 2), hgt + pad * 2);

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
        c.globalAlpha = easeOutCubic(fl) * 0.95;
        c.fillStyle = P.bright;
        const gy = this._snap(y - 1 * s);
        c.fillRect(x, gy, wSeg, hgt + 2 * s);
      }
    }
    c.globalAlpha = 1;

    // number
    const numCol = critical ? P.red : lowHp ? P.amber : P.white;
    const numAlpha = critical ? lerp(0.82, 1, 0.5 + 0.5 * Math.sin(this.time * 7.4)) : 1;
    this._text(this.lHp, L.hpX, L.numY, this.F.hp, 1 * s, 0, numCol, numAlpha, 4.4 * s);

    /* One slot, three states — the label line IS the state readout, so a
     * behaviour-changing state cannot hide in a colour alone. */
    let lab = this.lVitals, labCol = P.muted, labA = 0.92;
    if (this.dead) { lab = this.lDown; labCol = P.red; labA = 1; }
    else if (critical) {
      lab = this.lCritical; labCol = P.red;
      labA = lerp(0.78, 1, 0.5 + 0.5 * Math.sin(this.time * 8.2));
    } else if (lowHp) { lab = this.lWounded; labCol = P.amber; labA = 0.98; }
    this._text(lab, L.hpX, L.labY, this.F.micro, 3.6 * s, 0, labCol, labA, 3 * s);

    // accent tick under the label, tinted by state
    c.globalAlpha = critical || this.dead ? 0.95 : lowHp ? 0.85 : 0.6;
    c.fillStyle = this.dead || critical ? P.red : lowHp ? P.amber : P.accent;
    c.fillRect(this._snap(L.hpX), this._snap(L.ruleY), Math.round(16 * s), Math.max(1, Math.round(2 * s)));
    c.globalAlpha = 1;
  }

  /* ==================================================== ammo ============= */

  _drawAmmo() {
    const c = this.c, L = this.L, P = this.pal, T = this.tune.ammo, s = this.s;
    const F = this.F;
    const ratio = this.magCap > 0 ? this.mag / this.magCap : 1;
    const reloading = this.reloadShow > 0.02;
    const empty = this.mag === 0;
    const low = !empty && ratio < T.lowRatio;

    // value support under the whole cluster
    this._softPlate(L.amX - L.amBarW * 0.28, L.scrimCy, L.scrimRx, L.scrimRy, 0.40);

    const dim = 1 - this.deadFade * 0.72;

    /* A pulse must modulate attention, never legibility: the trough stays high
     * enough that the count is readable at every instant. An empty magazine
     * that flickers to 50% is a state you can miss at the exact moment you
     * needed it. While a reload is already under way the count goes steady
     * amber instead — "empty and being fixed" is not "empty, act now". */
    let magCol = P.white, magAlpha = 1;
    if (reloading) {
      magCol = P.amber;
    } else if (empty) {
      magCol = P.red;
      magAlpha = 0.8 + 0.2 * (0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 * T.emptyPulseHz));
    } else if (low) {
      magCol = P.amber;
    }

    // right-aligned run:  MAG / RESERVE
    const spSm = 0.6 * s;
    const wRes = this._measure(this.lReserve, F.ammoSm, spSm);
    const wSl = this._measure(this.lSlash, F.ammoSm, spSm);
    const padX = 7 * s;
    const xRes = L.amX;
    const xSl = xRes - wRes - padX;
    const xMag = xSl - wSl - padX;

    this._text(this.lReserve, xRes, L.numY, F.ammoSm, spSm, 2, P.muted, 0.92 * dim, 3.2 * s);
    this._text(this.lSlash, xSl, L.numY, F.ammoSm, spSm, 2, P.dim, 0.75 * dim, 3.2 * s);
    this._text(this.lMag, xMag, L.numY, F.ammo, 1 * s, 2, magCol, magAlpha * dim, 5.2 * s);

    /* Label line doubles as the ammo state readout, mirroring health. */
    let lab = this.lWeapon, labCol = P.muted, labA = 0.92, tick = P.accent, tickA = 0.6;
    if (reloading) {
      lab = this.lReloading; labCol = P.accentHi; labA = 1; tick = P.accent; tickA = 0.95;
    } else if (empty) {
      lab = this.lReloadCue; labCol = P.red; tick = P.red; tickA = 1;
      labA = lerp(0.78, 1, 0.5 + 0.5 * Math.sin(this.time * 9.0));
    } else if (low) {
      labCol = P.amber; labA = 1; tick = P.amber; tickA = 0.9;
    }
    this._text(lab, L.amX, L.labY, F.micro, 3.6 * s, 2, labCol, labA * dim, 3 * s);
    c.globalAlpha = tickA * dim;
    c.fillStyle = tick;
    c.fillRect(this._snap(L.amX - 16 * s), this._snap(L.ruleY),
               Math.round(16 * s), Math.max(1, Math.round(2 * s)));
    c.globalAlpha = 1;

    /* One bar, two jobs: magazine fill normally, reload progress while
     * reloading. Two bars in one corner would be two things to read. */
    const bw = L.amBarW, bh = L.amBarH;
    const bx = this._snap(L.amX - bw), by = this._snap(L.amBarY);
    const pad = Math.max(2, Math.round(2 * s));
    c.globalAlpha = dim * 0.85;
    c.fillStyle = P.plate;
    c.fillRect(bx - pad, by - pad, bw + pad * 2, bh + pad * 2);
    c.fillStyle = P.track;
    c.fillRect(bx, by, bw, bh);

    /* Quiet at full, loud only when the state has changed — otherwise this bar
     * is a second bright rule shouting the same thing as the number. */
    let p, barCol;
    if (reloading) {
      p = easeOutCubic(clamp(this.reloadP < 0 ? 1 : this.reloadP, 0, 1));
      barCol = P.accent;
      c.globalAlpha = dim * lerp(0.72, 1, 0.5 + 0.5 * Math.sin(this.time * 11));
    } else {
      p = clamp(ratio, 0, 1);
      barCol = empty ? P.red : low ? P.amber : P.steel;
      c.globalAlpha = dim * (empty ? magAlpha : low ? 0.95 : 0.42);
    }
    if (p > 0.001) { c.fillStyle = barCol; c.fillRect(bx, by, Math.max(1, bw * p), bh); }
    c.globalAlpha = 1;
  }

  _drawReloadArc() {
    const show = this.reloadShow;
    if (show <= 0.01) return;
    const c = this.c, L = this.L, P = this.pal, s = this.s;
    const p = clamp(this.reloadP < 0 ? 1 : this.reloadP, 0, 1);
    const r = L.reloadR;
    const span = 1.05;                       // radians of total sweep
    const a0 = HALFPI - span * 0.5;          // centred on "down"
    c.lineCap = 'round';
    c.globalAlpha = show * 0.85;
    c.strokeStyle = P.outline;
    c.lineWidth = 5.2 * s;
    c.beginPath(); c.arc(L.cx, L.cy, r, a0, a0 + span); c.stroke();
    c.globalAlpha = show * 0.40;
    c.strokeStyle = P.trackHi;
    c.lineWidth = 2.6 * s;
    c.beginPath(); c.arc(L.cx, L.cy, r, a0, a0 + span); c.stroke();
    c.globalAlpha = show;
    c.strokeStyle = P.accent;
    c.lineWidth = 3.0 * s;
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
      /* Tier 3: the feed recedes, and it recedes further as it stacks, so six
       * rows never read as six equal shouts. Only the newest row is allowed a
       * moment of accent. */
      a *= K.alpha * lerp(1, 0.52, clamp(i / 3, 0, 1));
      if (a <= 0.005) continue;

      const wA = this._measure(e.atk, F.kf, sp);
      const wV = this._measure(e.vic, F.kf, sp);
      const iconW = L.kfIconW;
      const skullW = e.headshot ? 10 * s + L.kfPad * 0.6 : 0;
      const total = wA + L.kfPad + iconW + L.kfPad + skullW + wV;

      const slide = e.fresh * 14 * s;
      const left = L.kfX - total + slide;
      const y = e.y;
      const hot = e.fresh;

      this._text(e.atk, left, y, F.kf, sp, 0, hot > 0.35 ? P.accentHi : P.steel, a, 2.6 * s);
      const gx = left + wA + L.kfPad;
      this._glyph(e.weapon, gx, y - 4 * s, iconW, L.kfIconH,
                  hot > 0.35 ? P.accent : P.dim, a * 0.95);
      let vx = gx + iconW + L.kfPad;
      if (e.headshot) {
        this._skull(vx, y - 4 * s, 8 * s, 10 * s, hot > 0.35 ? P.accentHi : P.muted, a);
        vx += skullW;
      }
      this._text(e.vic, vx, y, F.kf, sp, 0, P.muted, a * 0.9, 2.6 * s);
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
    // a dark under-pass so the glyph survives a bright frame like the text does
    c.globalAlpha = alpha * 0.7;
    c.fillStyle = this.pal.outline;
    c.strokeStyle = this.pal.outline;
    c.lineWidth = Math.max(1, h * 0.14);
    this._glyphPaint(kind, x, y, w, h, true);
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.strokeStyle = color;
    this._glyphPaint(kind, x, y, w, h, false);
    c.globalAlpha = 1;
  }

  _glyphPaint(kind, x, y, w, h, grow) {
    const c = this.c;
    const g = grow ? Math.max(1, h * 0.16) : 0;
    const t = Math.max(1, h * 0.14);
    const my = y;
    const R = (rx, ry, rw, rh) => c.fillRect(rx - g, ry - g, rw + g * 2, rh + g * 2);
    switch (kind) {
      case 'pistol':
        R(x + w * 0.34, my - h * 0.20, w * 0.62, h * 0.24);       // slide
        R(x + w * 0.34, my + h * 0.04, w * 0.22, h * 0.44);       // grip
        R(x + w * 0.56, my + h * 0.04, w * 0.10, h * 0.16);       // trigger guard
        break;
      case 'knife':
        c.beginPath();
        c.moveTo(x + w * 0.30, my + h * 0.10 + g);
        c.lineTo(x + w * 0.96 + g, my - h * 0.24 - g);
        c.lineTo(x + w * 0.96 + g, my + h * 0.04 + g);
        c.closePath(); c.fill();
        R(x + w * 0.06, my - h * 0.06, w * 0.26, h * 0.20);
        break;
      case 'grenade':
        c.beginPath(); c.arc(x + w * 0.52, my + h * 0.10, h * 0.36 + g, 0, Math.PI * 2); c.fill();
        R(x + w * 0.44, my - h * 0.44, w * 0.16, h * 0.24);
        R(x + w * 0.58, my - h * 0.40, w * 0.22, t);
        break;
      case 'explosion': {
        const cx0 = x + w * 0.5;
        c.lineWidth = t + g * 2;
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
        R(x + w * 0.02, my - h * 0.10, w * 0.30, h * 0.28);       // stock
        R(x + w * 0.30, my - h * 0.16, w * 0.36, h * 0.32);       // receiver
        R(x + w * 0.62, my - h * 0.14, w * 0.38, h * 0.14);       // barrel
        R(x + w * 0.62, my + h * 0.02, w * 0.30, h * 0.10);       // tube
        break;
      case 'smg':
        R(x + w * 0.04, my - h * 0.08, w * 0.24, h * 0.22);       // stock
        R(x + w * 0.26, my - h * 0.20, w * 0.40, h * 0.36);       // receiver
        R(x + w * 0.66, my - h * 0.14, w * 0.30, h * 0.14);       // barrel
        R(x + w * 0.40, my + h * 0.14, w * 0.13, h * 0.46);       // mag
        R(x + w * 0.60, my + h * 0.14, w * 0.10, h * 0.26);       // grip
        break;
      default: // rifle
        R(x + w * 0.00, my - h * 0.02, w * 0.20, h * 0.22);       // stock
        R(x + w * 0.18, my - h * 0.18, w * 0.44, h * 0.34);       // receiver
        R(x + w * 0.60, my - h * 0.12, w * 0.40, h * 0.13);       // barrel
        R(x + w * 0.40, my - h * 0.28, w * 0.14, h * 0.11);       // sight
        R(x + w * 0.52, my + h * 0.14, w * 0.11, h * 0.42);       // grip
        c.beginPath();                                            // curved mag
        c.moveTo(x + w * 0.30 - g, my + h * 0.14);
        c.lineTo(x + w * 0.44 + g, my + h * 0.14);
        c.lineTo(x + w * 0.40 + g, my + h * 0.62 + g);
        c.lineTo(x + w * 0.24 - g, my + h * 0.58 + g);
        c.closePath(); c.fill();
        break;
    }
  }

  _skull(x, y, w, h, color, alpha) {
    const c = this.c;
    const cx = x + w * 0.5, cy = y - h * 0.06;
    c.globalAlpha = alpha * 0.7;
    c.fillStyle = this.pal.outline;
    c.beginPath();
    c.ellipse(cx, cy, w * 0.5 + 1.4, h * 0.42 + 1.4, 0, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = alpha;
    c.fillStyle = color;
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
    const A = T.alpha;
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
    c.globalAlpha = 0.95 * A;
    c.fillStyle = P.outline;
    c.beginPath();
    c.moveTo(L.compX, y0 + 1.5 * s);
    c.lineTo(L.compX - 6 * s, y0 - 9.5 * s);
    c.lineTo(L.compX + 6 * s, y0 - 9.5 * s);
    c.closePath(); c.fill();
    c.globalAlpha = A;
    c.fillStyle = P.accent;
    c.beginPath();
    c.moveTo(L.compX, y0 - 1 * s);
    c.lineTo(L.compX - 4 * s, y0 - 8 * s);
    c.lineTo(L.compX + 4 * s, y0 - 8 * s);
    c.closePath(); c.fill();

    /* Baseline rule: a dark hairline directly under a light hairline, both
     * feathered to nothing at the ends. Two 1 px lines read at any background
     * value without ever becoming a bar across the frame. */
    const ry = this._snap(tickTop);
    const rh = Math.max(1, Math.round(1 * s));
    c.save();
    c.translate(L.compX, ry);
    c.scale(L.compW * 0.5, 1);
    c.globalAlpha = 0.42 * A;
    c.fillStyle = this.G.ruleDark;
    c.fillRect(-1, rh, 2, rh);
    c.globalAlpha = 0.30 * A;
    c.fillStyle = this.G.ruleFade;
    c.fillRect(-1, 0, 2, rh);
    c.restore();
    c.globalAlpha = 1;

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
      const tw = Math.max(1, Math.round(1 * s));
      const ty = this._snap(tickTop + 2 * s);
      c.globalAlpha = edge * 0.5 * A;
      c.fillStyle = P.outline;
      c.fillRect(x - tw, ty, tw * 3, tl);
      c.globalAlpha = edge * (major ? 0.9 : 0.45) * A;
      c.fillStyle = major ? P.steel : P.dim;
      c.fillRect(x, ty, tw, tl);
      if (major) {
        const lab = this.cardinals[(deg / 45) | 0];
        const cardinal = (deg % 90) === 0;
        this._text(lab, x, letterY, F.compass, 2.2 * s, 1,
                   cardinal ? (deg === 0 ? P.accent : P.steel) : P.muted,
                   edge * (cardinal ? 1 : 0.68) * A, 2.8 * s);
      }
    }

    // numeric heading, rebuilt only when the integer degree changes
    this._setNum(this.lHeading, Math.round(heading) % 360);
    this._text(this.lHeading, L.compX, L.compHeadY, F.obj, 1.6 * s, 1, P.dim, 0.5 * A, 2.2 * s);
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

    // small orange diamond marker (with a dark contour, like everything else)
    const r = 3 * s;
    c.globalAlpha = a * 0.85;
    c.fillStyle = P.outline;
    c.beginPath();
    c.moveTo(dx, y - 4 * s - r - 1.4); c.lineTo(dx + r + 1.4, y - 4 * s);
    c.lineTo(dx, y - 4 * s + r + 1.4); c.lineTo(dx - r - 1.4, y - 4 * s);
    c.closePath(); c.fill();
    c.globalAlpha = a * 0.9;
    c.fillStyle = P.accent;
    c.beginPath();
    c.moveTo(dx, y - 4 * s - r); c.lineTo(dx + r, y - 4 * s);
    c.lineTo(dx, y - 4 * s + r); c.lineTo(dx - r, y - 4 * s);
    c.closePath(); c.fill();
    c.globalAlpha = 1;

    this._text(this.lObj, L.compX, y, this.F.obj, 3.0 * s, 1, P.steel, a * 0.9, 2.8 * s);
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
    const crit = B.critical;

    /* The old banner was tracked-out thin type straight onto the frame; over a
     * blown sky that is nothing at all. It gets its own value support now. */
    this._softPlate(L.compX, y - 10 * s, L.bnPlateRx, L.bnPlateRy, a * (crit ? 0.58 : 0.46));

    this._text(this.lBanner, L.compX, y, this.F.banner, 7.0 * s, 1,
               crit ? P.redHi : P.bright, a, 6 * s);

    // thin rule that wipes horizontally out from the centre
    const rw = L.bnRule * wipe;
    const ry = this._snap(y + 16 * s);
    const th = Math.max(2, Math.round(2 * s));
    c.globalAlpha = a * 0.55;
    c.fillStyle = P.outline;
    c.fillRect(this._snap(L.compX - rw * 0.5), ry - 1, rw, th + 2);
    c.globalAlpha = a * 0.5;
    c.fillStyle = P.rule;
    c.fillRect(this._snap(L.compX - rw * 0.5), ry, rw, th);
    c.globalAlpha = a * 0.98;
    c.fillStyle = crit ? P.red : P.accent;
    const aw = Math.min(rw, 54 * s);
    c.fillRect(this._snap(L.compX - aw * 0.5), ry, aw, th);
    c.globalAlpha = 1;

    if (this.lBannerSub.chars.length) {
      this._text(this.lBannerSub, L.compX, y + 38 * s, this.F.bannerSub, 5.0 * s, 1,
                 crit ? P.red : P.steel, a * 0.95, 3.4 * s);
    }
  }
}

export default HUD;
