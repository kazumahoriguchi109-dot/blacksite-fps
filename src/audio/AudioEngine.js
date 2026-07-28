/**
 * BLACKSITE — procedural audio engine.
 *
 * Everything you hear is synthesised at runtime with the Web Audio API.
 * No sample files, no fetch, no base64 blobs: oscillators, noise buffers,
 * biquads, waveshapers and convolution against procedurally generated
 * impulse responses.
 *
 * Design notes
 * ------------
 * * A gunshot is not one noise burst. Every shot is five layers:
 *     1. crack       — sub-millisecond transient, highpassed, waveshaped
 *     2. body        — filtered noise under a lowpass that sweeps down fast
 *     3. thump       — 55–90 Hz triangle/sine with a pitch drop (the chest hit)
 *     4. mechanism   — bolt/spring: bandpassed noise + inharmonic metal partials
 *     5. tail        — dark noise fed almost entirely to the convolution reverb
 * * Two impulse responses are generated (tight interior, large exterior with
 *   slap-back) and crossfaded by `setEnvironment()`.
 * * Every buffer and IR is generated exactly ONCE (in `unlock()`, or lazily on
 *   the first `play()` if the host forgot). `play()` only ever builds a handful
 *   of cheap nodes.
 * * Voices are pooled and capped; the panner/air-absorption/send chain is
 *   permanent per voice slot, only the input gain is rebuilt per shot so a
 *   stolen voice can never bleed into its next owner.
 * * `update()` performs zero allocations.
 * * If `AudioContext` is missing or blocked, every method degrades to a no-op
 *   instead of throwing.
 *
 * @module audio/AudioEngine
 */

/** Canonical sound names. Anything not in here is ignored by `play()`. */
export const SOUND_NAMES = Object.freeze([
  // weapons
  'rifleFire', 'smgFire', 'pistolFire', 'dryFire',
  // manipulation
  'magOut', 'magIn', 'boltBack', 'boltForward', 'reloadRustle',
  'adsIn', 'adsOut', 'weaponSwitch',
  // locomotion
  'footstepConcrete', 'footstepGravel', 'footstepMetal',
  // ballistics
  'impactConcrete', 'impactMetal', 'impactFlesh', 'ricochet', 'bulletWhizz',
  // ordnance
  'explosion', 'grenadeBounce', 'grenadePin',
  // feedback / bodies
  'hitmarker', 'headshot', 'playerHurt', 'playerDeath', 'enemyDeath',
  // melee
  'meleeSwing', 'meleeHit',
  // misc
  'shellDrop',
]);

/** Convenience aliases so callers can pass a surface kind straight through. */
const ALIASES = Object.freeze({
  footstep: 'footstepConcrete',
  footstepDirt: 'footstepGravel',
  impact: 'impactConcrete',
  impactWood: 'impactConcrete',
  impactBlood: 'impactFlesh',
  bloodImpact: 'impactFlesh',
  shellEject: 'shellDrop',
  shellConcrete: 'shellDrop',
  shellMetal: 'shellDrop',
  hit: 'hitmarker',
  kill: 'hitmarker',
});

/**
 * Per-weapon voicing. Frequencies in Hz, times in seconds.
 * rifle  = sharp, loud, long tail
 * smg    = tighter, higher, busier mechanism
 * pistol = snappier with more mid punch
 */
const WEAPONS = Object.freeze({
  rifle: {
    gain: 1.00,
    crackLevel: 0.95, crackHP: 2400, crackDur: 0.016,
    snapLevel: 0.70, snapHP: 6200, snapDur: 0.0055,
    bodyLevel: 0.90, bodyF0: 8600, bodyF1: 360, bodyQ: 1.15, bodyDur: 0.20,
    punchF: 1450, punchQ: 1.3, punchLevel: 0.34, punchDur: 0.085,
    thumpLevel: 0.85, thumpF0: 195, thumpF1: 52, thumpDur: 0.23,
    subLevel: 0.40, subF0: 96, subF1: 34, subDur: 0.30,
    mechLevel: 0.26, mechBP: 3100, mechQ: 3.2, mechDur: 0.045, mechDelay: 0.012,
    mechPartials: [2870, 4390, 6180], mechRing: 0.11, mechRingLevel: 0.10,
    tailLevel: 0.55, tailLP: 2100, tailDur: 0.52,
    drive: 1.0, send: 0.75,
  },
  smg: {
    gain: 0.80,
    crackLevel: 0.80, crackHP: 3300, crackDur: 0.011,
    snapLevel: 0.62, snapHP: 7400, snapDur: 0.004,
    bodyLevel: 0.78, bodyF0: 9600, bodyF1: 640, bodyQ: 1.35, bodyDur: 0.115,
    punchF: 1950, punchQ: 1.6, punchLevel: 0.28, punchDur: 0.05,
    thumpLevel: 0.58, thumpF0: 168, thumpF1: 72, thumpDur: 0.125,
    subLevel: 0.20, subF0: 88, subF1: 44, subDur: 0.16,
    mechLevel: 0.42, mechBP: 3800, mechQ: 3.6, mechDur: 0.05, mechDelay: 0.008,
    mechPartials: [3320, 4980, 7150], mechRing: 0.085, mechRingLevel: 0.16,
    tailLevel: 0.36, tailLP: 2600, tailDur: 0.34,
    drive: 0.8, send: 0.55,
  },
  pistol: {
    gain: 0.82,
    crackLevel: 0.85, crackHP: 2000, crackDur: 0.014,
    snapLevel: 0.55, snapHP: 5400, snapDur: 0.005,
    bodyLevel: 0.80, bodyF0: 6800, bodyF1: 480, bodyQ: 1.0, bodyDur: 0.155,
    punchF: 940, punchQ: 1.1, punchLevel: 0.52, punchDur: 0.10,
    thumpLevel: 0.70, thumpF0: 215, thumpF1: 66, thumpDur: 0.17,
    subLevel: 0.26, subF0: 105, subF1: 40, subDur: 0.20,
    mechLevel: 0.38, mechBP: 2600, mechQ: 3.0, mechDur: 0.055, mechDelay: 0.016,
    mechPartials: [2350, 3610, 5240], mechRing: 0.10, mechRingLevel: 0.14,
    tailLevel: 0.42, tailLP: 1800, tailDur: 0.40,
    drive: 0.7, send: 0.62,
  },
});

const CLAMP = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class AudioEngine {
  /**
   * @param {object} [opts]
   * @param {number} [opts.masterVolume=0.9]
   * @param {number} [opts.maxVoices=24]
   * @param {'interior'|'exterior'} [opts.environment='interior']
   * @param {number} [opts.seed] fixes the per-shot randomisation (tests/replays)
   */
  constructor(opts = {}) {
    /** True only when a usable AudioContext exists. Everything checks this. */
    this.available = false;
    this.unlocked = false;
    this.actx = null;

    /**
     * Live tuning knobs. Mutating these directly is fine; the ones that need
     * to touch the graph have setters (see `setMasterVolume` etc).
     */
    this.params = {
      masterVolume: opts.masterVolume ?? 0.9,
      sfxVolume: 1.0,
      musicVolume: 0.6,
      /**
       * Bus headroom. A rifle shot sums to ~2.0 internally; this keeps a single
       * shot just under the limiter knee so only genuinely stacked gunfire
       * saturates. Raise for a louder/dirtier mix, lower for more headroom.
       */
      headroom: 0.42,
      /** Post-compressor makeup gain. */
      makeup: 1.15,
      maxVoices: opts.maxVoices ?? 24,
      // spatialisation
      refDistance: 4.0,
      maxDistance: 220.0,
      rolloff: 1.05,
      /** Metres over which HF energy halves (air absorption). Lower = duller. */
      airAbsorption: 24.0,
      /** m/s — distant shots arrive late. 0 disables propagation delay. */
      speedOfSound: 343.0,
      /** Global multiplier on every reverb send. */
      reverbSend: 1.0,
      /** Extra reverb per metre of distance. */
      reverbDistanceBias: 0.018,
      /** Random pitch spread applied to every non-tonal one-shot. */
      pitchVariance: 0.05,
      /** Master bus dynamics. */
      compThreshold: -15,
      compRatio: 6,
      compKnee: 12,
      compAttack: 0.0035,
      compRelease: 0.18,
      /** Soft-clip knee of the brickwall-ish waveshaper (0..1). */
      limiterKnee: 0.72,
      /**
       * How far over 0 dBFS the limiter can still shape smoothly. A WaveShaper
       * only sees [-1,1], so the signal is scaled by 1/drive going in and the
       * curve is built over [-drive, +drive]; without this, anything past unity
       * would be flat-topped (hard clipped) instead of soft-limited.
       */
      limiterDrive: 6.0,
      /** Repeat-fire attenuation: same sound within this window gets ducked. */
      repeatWindow: 0.045,
      repeatDuck: 0.72,
      environment: opts.environment ?? 'interior',
    };

    /** Per-category trims — handy mixing knobs for the HUD/options menu. */
    this.categoryGain = {
      weapon: 1.0,
      mech: 0.9,
      foley: 0.85,
      impact: 0.95,
      ordnance: 1.0,
      ui: 0.8,
      voice: 0.9,
    };

    // ---- internal state (all preallocated; update() never news anything) ----
    this._voices = [];
    this._dying = [];
    this._free = [];
    this._voiceId = 0;
    this._camera = null;
    this._built = false;
    this._buildPromise = null;
    this._lastPlay = Object.create(null);
    /**
     * Two separate streams on purpose:
     *  _bufRndState is FIXED, so the generated buffers and impulse responses —
     *  the actual timbre of the game — are bit-identical every session.
     *  _rndState drives per-shot jitter and is seeded from Math.random(), so the
     *  same "unlucky" draw doesn't land on the first footstep of every session
     *  (measured: a fixed seed made step one a consistent ~5 dB quieter than the
     *  median on all three surfaces). Pass `opts.seed` to make it reproducible.
     */
    this._bufRndState = 0x1a2b3c4d;
    this._rndState = (opts.seed !== undefined ? opts.seed >>> 0
      : (Math.random() * 0xffffffff) >>> 0) || 0x9e3779b9;
    for (let i = 0; i < 16; i++) this._rnd();   // let the xorshift diffuse

    // listener + emitter scratch (no per-frame / per-play allocation)
    this._px = 0; this._py = 0; this._pz = 0;
    this._lx = 0; this._ly = 0; this._lz = 0;
    this._lfx = 0; this._lfy = 0; this._lfz = -1;
    this._lux = 0; this._luy = 1; this._luz = 0;

    this._duckUntil = 0;
    this._duckRelease = 0.35;

    // reusable options record for synth calls
    this._o = { pitch: 1, volume: 1, distance: 0, variant: 0, dest: null, send: null };

    this.buffers = {
      white: null, pink: null, brown: null,
      grit: null, crackle: null, cloth: null,
    };
    this.irs = { interior: null, exterior: null };

    try {
      const AC = (typeof window !== 'undefined') &&
        (window.AudioContext || window.webkitAudioContext);
      if (!AC) return;
      this.actx = new AC({ latencyHint: 'interactive' });
      this._initGraph();
      this.available = true;
    } catch (err) {
      // Never throw out of a constructor — the game must still run silent.
      if (typeof console !== 'undefined') {
        console.warn('[AudioEngine] disabled:', err && err.message);
      }
      this.actx = null;
      this.available = false;
    }
  }

  // =====================================================================
  // Master graph
  // =====================================================================

  _initGraph() {
    const ac = this.actx;
    const P = this.params;

    // destination <- master <- limiter <- preLimit <- (compressor <- sfx) + music
    this.master = ac.createGain();
    this.master.gain.value = P.masterVolume;
    this.master.connect(ac.destination);

    this.limiter = ac.createWaveShaper();
    this.limiter.curve = this._softClipCurve(P.limiterKnee, P.limiterDrive);
    this.limiter.oversample = '4x';
    this.limiter.connect(this.master);

    // preLimit carries the makeup gain *and* the 1/drive scaling the shaper
    // domain needs; the curve undoes the scaling, so the net transfer is
    // unity-then-soft-limit.
    this.preLimit = ac.createGain();
    this.preLimit.gain.value = P.makeup / P.limiterDrive;
    this.preLimit.connect(this.limiter);

    this.compressor = ac.createDynamicsCompressor();
    this.compressor.threshold.value = P.compThreshold;
    this.compressor.knee.value = P.compKnee;
    this.compressor.ratio.value = P.compRatio;
    this.compressor.attack.value = P.compAttack;
    this.compressor.release.value = P.compRelease;
    this.compressor.connect(this.preLimit);

    /** Everything gameplay-ish lands here (dry + reverb return). */
    this.sfxBus = ac.createGain();
    this.sfxBus.gain.value = P.sfxVolume * P.headroom;
    this.sfxBus.connect(this.compressor);

    /** Dry voices. Kept separate so the reverb return can be trimmed alone. */
    this.dryBus = ac.createGain();
    this.dryBus.gain.value = 1.0;
    this.dryBus.connect(this.sfxBus);

    /** Music/ambience bus — sits past the compressor so gunfire can't pump it. */
    this.musicBus = ac.createGain();
    this.musicBus.gain.value = 1.0;
    this.musicGain = ac.createGain();
    this.musicGain.gain.value = P.musicVolume;
    this.musicBus.connect(this.musicGain);
    this.musicGain.connect(this.preLimit);

    // --- reverb: two convolvers, crossfaded by setEnvironment() -------------
    this.reverbIn = ac.createGain();
    this.reverbIn.gain.value = 1.0;

    // A gentle pre-filter keeps the reverb out of the way of the dry transient.
    this.reverbTone = ac.createBiquadFilter();
    this.reverbTone.type = 'highpass';
    this.reverbTone.frequency.value = 180;
    this.reverbTone.Q.value = 0.6;
    this.reverbIn.connect(this.reverbTone);

    this.convInterior = ac.createConvolver();
    this.convInterior.normalize = true;
    this.retInterior = ac.createGain();
    this.retInterior.gain.value = P.environment === 'interior' ? 1 : 0;
    this.reverbTone.connect(this.convInterior);
    this.convInterior.connect(this.retInterior);
    this.retInterior.connect(this.sfxBus);

    this.convExterior = ac.createConvolver();
    this.convExterior.normalize = true;
    this.retExterior = ac.createGain();
    this.retExterior.gain.value = P.environment === 'exterior' ? 1 : 0;
    this.reverbTone.connect(this.convExterior);
    this.convExterior.connect(this.retExterior);
    this.retExterior.connect(this.sfxBus);

    // Shared, immutable waveshaper curves.
    this._curveDrive = this._tanhCurve(2.6);
    this._curveCrack = this._tanhCurve(1.5);
  }

  /**
   * Transfer curve over the raw range [-drive, +drive]: exactly linear below
   * `knee`, asymptotic to 1.0 above it. The shaper's [-1,1] domain is mapped
   * onto that range by the 1/drive gain sitting in front of it.
   */
  _softClipCurve(knee, drive) {
    const n = 8192;
    const c = new Float32Array(n);
    const t = CLAMP(knee, 0.2, 0.95);
    const d = Math.max(1, drive || 1);
    for (let i = 0; i < n; i++) {
      const raw = ((i / (n - 1)) * 2 - 1) * d;
      const a = Math.abs(raw);
      const y = a <= t ? a : t + (1 - t) * Math.tanh((a - t) / (1 - t));
      c[i] = raw < 0 ? -y : y;
    }
    return c;
  }

  _tanhCurve(k) {
    const n = 4096;
    const c = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / norm;
    }
    return c;
  }

  // =====================================================================
  // Lifecycle
  // =====================================================================

  /**
   * Resume the context on a user gesture and pre-generate every buffer and IR.
   * Safe to call repeatedly; the heavy work happens once.
   * @returns {Promise<boolean>} true if audio is live
   */
  async unlock() {
    if (!this.available) return false;
    try {
      if (this.actx.state === 'suspended') await this.actx.resume();
    } catch (_) { /* autoplay policy — try again on the next gesture */ }
    try {
      await this._buildBuffersAsync();
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[AudioEngine] buffer build failed:', err);
      this.available = false;
      return false;
    }
    // Let the bus compressor settle before any gameplay sound reaches it.
    // Measured: a DynamicsCompressor attenuates its input by ~6.7 dB for the
    // first ~50 ms of context time, so a sound fired the instant the context
    // starts comes out noticeably weak. Buffer generation above usually covers
    // this already; this makes the guarantee explicit rather than incidental.
    const settled = this.actx.currentTime + 0.08;
    // Bounded: never trust the clock to advance (a throttled background tab, or
    // a stubbed context in a test harness, would otherwise hang unlock()).
    for (let i = 0; i < 8 && this.actx.state === 'running'; i++) {
      if (this.actx.currentTime >= settled) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    this.unlocked = this.actx.state === 'running';
    return this.unlocked;
  }

  /** @returns {Promise<void>} */
  async resume() {
    if (!this.available) return;
    try { if (this.actx.state !== 'running') await this.actx.resume(); } catch (_) {}
  }

  /** @returns {Promise<void>} */
  async suspend() {
    if (!this.available) return;
    try { if (this.actx.state === 'running') await this.actx.suspend(); } catch (_) {}
  }

  dispose() {
    if (!this.available) return;
    const now = this._now();
    for (let k = 0; k < 2; k++) {
      const list = k === 0 ? this._voices : this._dying;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.input) { try { v.input.gain.cancelScheduledValues(now); v.input.gain.value = 0; v.input.disconnect(); } catch (_) {} }
      }
      list.length = 0;
    }
    this._free.length = 0;
    try { this.master.disconnect(); } catch (_) {}
    try { this.actx.close(); } catch (_) {}
    this.available = false;
    this.unlocked = false;
    this._camera = null;
    this.buffers = { white: null, pink: null, brown: null, grit: null, crackle: null, cloth: null };
    this.irs = { interior: null, exterior: null };
  }

  // =====================================================================
  // Buffer / impulse-response generation  (runs exactly once)
  // =====================================================================

  async _buildBuffersAsync() {
    if (this._built) return;
    if (this._buildPromise) return this._buildPromise;
    const yield_ = () => new Promise((r) => setTimeout(r, 0));
    this._buildPromise = (async () => {
      const b = this.buffers;
      b.white = this._noiseBuffer(2.0, 2, 'white');   await yield_();
      b.pink = this._noiseBuffer(2.0, 2, 'pink');     await yield_();
      b.brown = this._noiseBuffer(1.5, 1, 'brown');   await yield_();
      b.grit = this._gritBuffer(1.5);                 await yield_();
      b.crackle = this._crackleBuffer(2.2);           await yield_();
      b.cloth = this._clothBuffer(1.2);               await yield_();
      this.irs.interior = this._makeIR('interior');   await yield_();
      this.irs.exterior = this._makeIR('exterior');
      this.convInterior.buffer = this.irs.interior;
      this.convExterior.buffer = this.irs.exterior;
      this._built = true;
      this._buildPromise = null;
    })();
    return this._buildPromise;
  }

  /** Synchronous fallback if someone calls play() before unlock(). */
  _buildBuffersSync() {
    if (this._built) return;
    const b = this.buffers;
    b.white = this._noiseBuffer(2.0, 2, 'white');
    b.pink = this._noiseBuffer(2.0, 2, 'pink');
    b.brown = this._noiseBuffer(1.5, 1, 'brown');
    b.grit = this._gritBuffer(1.5);
    b.crackle = this._crackleBuffer(2.2);
    b.cloth = this._clothBuffer(1.2);
    this.irs.interior = this._makeIR('interior');
    this.irs.exterior = this._makeIR('exterior');
    this.convInterior.buffer = this.irs.interior;
    this.convExterior.buffer = this.irs.exterior;
    this._built = true;
  }

  /** Deterministic RNG for buffer contents (stable audio between sessions). */
  _brnd() {
    let x = this._bufRndState;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this._bufRndState = x;
    return x / 4294967296;
  }

  /** Fast RNG for per-play variation. */
  _rnd() {
    let x = this._rndState;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this._rndState = x;
    return x / 4294967296;
  }

  _rr(a, b) { return a + (b - a) * this._rnd(); }

  _noiseBuffer(seconds, channels, kind) {
    const ac = this.actx;
    const sr = ac.sampleRate;
    const len = Math.max(1, Math.floor(seconds * sr));
    const buf = ac.createBuffer(channels, len, sr);
    for (let c = 0; c < channels; c++) {
      const d = buf.getChannelData(c);
      if (kind === 'pink') {
        // Paul Kellett's economy pink filter.
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = this._brnd() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          const out = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
          d[i] = CLAMP(out, -1, 1);
        }
      } else if (kind === 'brown') {
        let last = 0;
        for (let i = 0; i < len; i++) {
          const w = this._brnd() * 2 - 1;
          last = (last + 0.02 * w) / 1.02;
          d[i] = CLAMP(last * 3.5, -1, 1);
        }
      } else {
        for (let i = 0; i < len; i++) d[i] = this._brnd() * 2 - 1;
      }
    }
    return buf;
  }

  /**
   * Sparse grains — the raw material for gravel footsteps. Reads at a random
   * offset each step so no two steps are ever identical.
   */
  _gritBuffer(seconds) {
    const ac = this.actx;
    const sr = ac.sampleRate;
    const len = Math.floor(seconds * sr);
    const buf = ac.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const grains = Math.floor(seconds * 900);
    for (let g = 0; g < grains; g++) {
      const start = Math.floor(this._brnd() * (len - 200));
      const dur = 12 + Math.floor(this._brnd() * 70);
      const amp = 0.25 + this._brnd() * 0.75;
      const w = 1 + this._brnd() * 3; // grain "pitch" via zero-crossing rate
      for (let i = 0; i < dur; i++) {
        const env = Math.exp(-i / (dur * 0.32));
        d[start + i] += amp * env * Math.sin(i * w) * (this._brnd() * 2 - 1);
      }
    }
    let peak = 0;
    for (let i = 0; i < len; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    if (peak > 0) { const k = 0.95 / peak; for (let i = 0; i < len; i++) d[i] *= k; }
    return buf;
  }

  /** Debris/fire crackle for explosions: impulse density decays over time. */
  _crackleBuffer(seconds) {
    const ac = this.actx;
    const sr = ac.sampleRate;
    const len = Math.floor(seconds * sr);
    const buf = ac.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let t = 0;
    while (t < len) {
      const prog = t / len;
      const density = 1400 * Math.exp(-prog * 2.6) + 25;
      t += Math.max(8, Math.floor((sr / density) * (0.25 + this._brnd() * 1.75)));
      if (t >= len - 64) break;
      const amp = (0.2 + this._brnd() * 0.8) * Math.exp(-prog * 1.6);
      const dur = 6 + Math.floor(this._brnd() * 40);
      for (let i = 0; i < dur && t + i < len; i++) {
        d[t + i] += amp * Math.exp(-i / (dur * 0.25)) * (this._brnd() * 2 - 1);
      }
    }
    return buf;
  }

  /** Slow, fibrous noise for nylon/cloth (reload rustle, ADS transitions). */
  _clothBuffer(seconds) {
    const ac = this.actx;
    const sr = ac.sampleRate;
    const len = Math.floor(seconds * sr);
    const buf = ac.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let lp = 0, hp = 0, prev = 0;
    for (let i = 0; i < len; i++) {
      const w = this._brnd() * 2 - 1;
      lp += 0.35 * (w - lp);
      hp = 0.92 * (hp + lp - prev);
      prev = lp;
      // amplitude "fibres": slow random modulation
      const mod = 0.45 + 0.55 * Math.abs(Math.sin(i * 0.00042) * Math.sin(i * 0.0017));
      d[i] = CLAMP(hp * mod * 1.8, -1, 1);
    }
    return buf;
  }

  /**
   * Procedural impulse response.
   *  interior — 0.9 s, dense early reflections, fast dark decay
   *  exterior — 3.1 s, sparse discrete slap-backs off distant structures
   */
  _makeIR(kind) {
    const ac = this.actx;
    const sr = ac.sampleRate;
    const exterior = kind === 'exterior';
    const seconds = exterior ? 3.1 : 0.95;
    const len = Math.floor(seconds * sr);
    const buf = ac.createBuffer(2, len, sr);

    // discrete early reflections / slap-backs: [timeSec, gain, spreadSec]
    const taps = exterior
      ? [[0.031, 0.55, 0.004], [0.072, 0.44, 0.006], [0.118, 0.38, 0.008],
         [0.187, 0.30, 0.012], [0.268, 0.24, 0.016], [0.372, 0.18, 0.020],
         [0.505, 0.13, 0.026], [0.690, 0.09, 0.032], [0.920, 0.06, 0.040]]
      : [[0.0055, 0.62, 0.001], [0.0091, 0.50, 0.0012], [0.0143, 0.44, 0.0016],
         [0.0208, 0.36, 0.002], [0.0287, 0.30, 0.0026], [0.0391, 0.24, 0.003],
         [0.0522, 0.18, 0.004], [0.0685, 0.13, 0.005]];

    const decayK = exterior ? 1.45 : 5.6;
    const preDelay = Math.floor((exterior ? 0.011 : 0.004) * sr);

    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      // Diffuse tail: exponentially decaying noise, progressively darkened by a
      // one-pole whose coefficient falls with time (HF dies first, as in air).
      let y = 0;
      const skew = c === 0 ? 1.0 : 1.06;   // decorrelate the two channels
      for (let i = preDelay; i < len; i++) {
        const t = (i - preDelay) / sr;
        const env = Math.exp(-t * decayK * skew);
        const a = CLAMP(1.0 - t * (exterior ? 0.42 : 1.15), 0.05, 1.0);
        y += a * ((this._brnd() * 2 - 1) - y);
        d[i] = y * env;
      }
      // Early reflections layered on top, each a short decaying burst.
      for (let k = 0; k < taps.length; k++) {
        const tap = taps[k];
        const jitter = (this._brnd() - 0.5) * (exterior ? 0.012 : 0.0018);
        const at = Math.floor((tap[0] * (c === 0 ? 1 : 1.03) + jitter) * sr) + preDelay;
        const spread = Math.max(4, Math.floor(tap[2] * sr));
        const g = tap[1] * (0.8 + this._brnd() * 0.4);
        for (let i = 0; i < spread && at + i < len; i++) {
          d[at + i] += g * Math.exp(-i / (spread * 0.3)) * (this._brnd() * 2 - 1);
        }
      }
      // Kill DC and normalise.
      let dc = 0;
      for (let i = 0; i < len; i++) dc += d[i];
      dc /= len;
      let peak = 0;
      for (let i = 0; i < len; i++) { d[i] -= dc; const a = Math.abs(d[i]); if (a > peak) peak = a; }
      if (peak > 0) { const s = 0.9 / peak; for (let i = 0; i < len; i++) d[i] *= s; }
    }
    return buf;
  }

  // =====================================================================
  // Node helpers
  // =====================================================================

  _now() { return this.actx.currentTime; }

  _gain(v) { const g = this.actx.createGain(); g.gain.value = v; return g; }

  _bq(type, freq, q, gainDb) {
    const f = this.actx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.max(10, Math.min(freq, this.actx.sampleRate * 0.48));
    if (q !== undefined) f.Q.value = q;
    if (gainDb !== undefined) f.gain.value = gainDb;
    return f;
  }

  _osc(type, freq) {
    const o = this.actx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  /** Percussive AD envelope. `peak` and the floor are always > 0 for exp ramps. */
  _env(p, t, peak, attack, decay, floor) {
    const f = floor || 0.0006;
    const pk = Math.max(peak, f * 1.5);
    p.setValueAtTime(f, t);
    if (attack > 0.0002) p.linearRampToValueAtTime(pk, t + attack);
    else { p.setValueAtTime(pk, t + 0.00005); attack = 0.00005; }
    p.exponentialRampToValueAtTime(f, t + attack + Math.max(0.004, decay));
    p.setValueAtTime(0, t + attack + Math.max(0.004, decay) + 0.002);
  }

  /** Swell envelope (whooshes): rise, hold, fall. */
  _envSwell(p, t, peak, rise, fall) {
    const f = 0.0006;
    p.setValueAtTime(f, t);
    p.linearRampToValueAtTime(Math.max(peak, f * 2), t + rise);
    p.exponentialRampToValueAtTime(f, t + rise + fall);
    p.setValueAtTime(0, t + rise + fall + 0.002);
  }

  _sweep(p, t, f0, f1, time) {
    p.setValueAtTime(Math.max(10, f0), t);
    p.exponentialRampToValueAtTime(Math.max(10, f1), t + Math.max(0.004, time));
  }

  /**
   * One noise burst through a filter into `dest`.
   * @param {AudioNode} dest
   * @param {number} t start time
   * @param {object} c { dur, level, type, f0, f1, q, buf, rate, attack, hp, shape }
   */
  _burst(dest, t, c) {
    const ac = this.actx;
    const buf = c.buf || this.buffers.white;
    if (!buf) return null;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const rate = c.rate || 1;
    src.playbackRate.value = rate;
    const dur = Math.max(0.004, c.dur);
    const span = Math.min(buf.duration - 0.02, dur * rate + 0.01);
    const off = this._rnd() * Math.max(0.001, buf.duration - span - 0.01);

    let node = src;
    if (c.hp) { const h = this._bq('highpass', c.hp, c.hpQ || 0.7); node.connect(h); node = h; }
    if (c.type) {
      const f = this._bq(c.type, c.f0, c.q === undefined ? 1 : c.q);
      if (c.f1 !== undefined && c.f1 !== c.f0) {
        this._sweep(f.frequency, t, c.f0, c.f1, c.sweep === undefined ? dur * 0.65 : c.sweep);
      }
      node.connect(f); node = f;
    }
    if (c.shape) {
      const ws = ac.createWaveShaper();
      ws.curve = c.shape === 'hard' ? this._curveDrive : this._curveCrack;
      ws.oversample = '2x';
      node.connect(ws); node = ws;
    }
    const g = this._gain(0);
    this._env(g.gain, t, c.level === undefined ? 1 : c.level, c.attack === undefined ? 0.0006 : c.attack, dur);
    node.connect(g);
    g.connect(dest);
    src.start(t, off);
    src.stop(t + dur + 0.03);
    return g;
  }

  /**
   * Inharmonic resonant partials — the difference between "a click" and
   * "a machined steel part". Each partial droops slightly in pitch as it dies.
   */
  _partials(dest, t, freqs, level, decay, pitch, detune, spread) {
    const n = freqs.length;
    const sp = spread === undefined ? 0.55 : spread;
    for (let i = 0; i < n; i++) {
      const base = freqs[i] * (pitch || 1) * (1 + (this._rnd() - 0.5) * (detune || 0.04));
      const o = this._osc('sine', base);
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.982, t + decay);
      const g = this._gain(0);
      const lv = level / (1 + i * sp);
      const dk = Math.max(0.01, decay * (1 - i * 0.13));
      this._env(g.gain, t + i * 0.0006, lv, 0.0008, dk);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + dk + 0.05);
    }
  }

  /** Pitched body tone with a downward glide (thumps, subs, grunts). */
  _tone(dest, t, type, f0, f1, glide, level, attack, decay, lp) {
    const o = this._osc(type, f0);
    this._sweep(o.frequency, t, f0, f1, glide);
    let node = o;
    if (lp) { const f = this._bq('lowpass', lp, 0.9); node.connect(f); node = f; }
    const g = this._gain(0);
    this._env(g.gain, t, level, attack, decay);
    node.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + attack + decay + 0.06);
    return g;
  }

  // =====================================================================
  // Voice pool
  // =====================================================================

  _createVoice() {
    const ac = this.actx;
    const v = {
      id: 0,
      name: '',
      input: null,
      air: null,
      panner: null,
      flat: null,
      send: null,
      spatial: false,
      startTime: 0,
      endTime: 0,
      level: 0,
      priority: 1,
      stolen: false,
      engine: this,
      stop: voiceStop,
    };
    v.air = ac.createBiquadFilter();
    v.air.type = 'lowpass';
    v.air.frequency.value = 20000;
    v.air.Q.value = 0.4;

    v.panner = ac.createPanner();
    v.panner.panningModel = 'HRTF';
    v.panner.distanceModel = 'inverse';
    v.panner.refDistance = this.params.refDistance;
    v.panner.maxDistance = this.params.maxDistance;
    v.panner.rolloffFactor = this.params.rolloff;
    v.panner.coneInnerAngle = 360;
    v.panner.coneOuterAngle = 360;
    v.panner.coneOuterGain = 1;

    v.flat = ac.createGain();
    v.flat.gain.value = 1;

    v.send = ac.createGain();
    v.send.gain.value = 0;

    v.air.connect(v.panner);
    v.panner.connect(this.dryBus);
    v.air.connect(v.send);
    v.flat.connect(this.dryBus);
    v.flat.connect(v.send);
    v.send.connect(this.reverbIn);
    return v;
  }

  /**
   * Steal a voice if we're at the cap. Returns true if a slot was freed.
   * Expendability favours old, quiet, low-priority voices.
   *
   * The victim leaves the active list immediately (so the cap is honoured even
   * when a hundred play() calls land between two frames) and finishes a 12 ms
   * fade on the `_dying` list before its nodes go back to the pool.
   */
  _steal(now, priority) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      const score = (3 - v.priority) * 20 + (now - v.startTime) * 6 + (1 - Math.min(1, v.level)) * 8;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return false;
    const incoming = (3 - priority) * 20;
    if (bestScore < incoming) return false;      // new sound is the least important
    const v = this._voices[best];
    if (v.input) {
      const g = v.input.gain;
      try {
        g.cancelScheduledValues(now);
        g.setValueAtTime(Math.max(0.0005, g.value), now);
        g.exponentialRampToValueAtTime(0.0005, now + 0.012);
        g.setValueAtTime(0, now + 0.014);
      } catch (_) { g.value = 0; }
    }
    v.stolen = true;
    v.endTime = now + 0.02;
    const lastIdx = this._voices.length - 1;
    this._voices[best] = this._voices[lastIdx];
    this._voices.pop();
    this._dying.push(v);
    // Hard ceiling on fading voices too — a pathological burst can't allocate
    // an unbounded number of HRTF panners.
    while (this._dying.length > this.params.maxVoices) this._release(this._dying.shift());
    return true;
  }

  /** Return faded-out (stolen) voices to the pool. Allocation free. */
  _drainDying(now) {
    for (let i = this._dying.length - 1; i >= 0; i--) {
      const v = this._dying[i];
      if (now >= v.endTime) {
        const lastIdx = this._dying.length - 1;
        this._dying[i] = this._dying[lastIdx];
        this._dying.pop();
        this._release(v);
      }
    }
  }

  _release(v) {
    if (v.input) {
      try { v.input.disconnect(); } catch (_) {}
      v.input = null;   // orphans any still-running sources → silent + collectable
    }
    try { v.send.gain.value = 0; } catch (_) {}
    v.id = 0;
    v.stolen = false;
    v.name = '';
    this._free.push(v);
  }

  // =====================================================================
  // Public API
  // =====================================================================

  /**
   * Wire the 3D listener to a camera. The camera is polled every `update()`.
   * @param {{matrixWorld:{elements:ArrayLike<number>}}} camera
   */
  setListener(camera) {
    this._camera = camera || null;
    if (!this.available || !camera) return;
    this._syncListener(true);
  }

  /** @param {'interior'|'exterior'} kind */
  setEnvironment(kind) {
    const k = kind === 'exterior' ? 'exterior' : 'interior';
    this.params.environment = k;
    if (!this.available) return;
    const t = this._now();
    const fade = 0.5;
    const inG = k === 'interior' ? 1 : 0;
    const exG = k === 'exterior' ? 1 : 0;
    try {
      this.retInterior.gain.cancelScheduledValues(t);
      this.retInterior.gain.setValueAtTime(this.retInterior.gain.value, t);
      this.retInterior.gain.linearRampToValueAtTime(inG, t + fade);
      this.retExterior.gain.cancelScheduledValues(t);
      this.retExterior.gain.setValueAtTime(this.retExterior.gain.value, t);
      this.retExterior.gain.linearRampToValueAtTime(exG, t + fade);
    } catch (_) {}
    // Outdoors: sound carries further and stays brighter.
    this.params.airAbsorption = k === 'exterior' ? 34 : 20;
    this.params.maxDistance = k === 'exterior' ? 320 : 160;
  }

  getEnvironment() { return this.params.environment; }

  /** @param {number} v 0..1 */
  setMasterVolume(v) {
    this.params.masterVolume = CLAMP(v, 0, 1.5);
    if (this.available) this.master.gain.value = this.params.masterVolume;
  }

  /** @param {number} v 0..1 */
  setSfxVolume(v) {
    this.params.sfxVolume = CLAMP(v, 0, 1.5);
    if (this.available) this.sfxBus.gain.value = this.params.sfxVolume * this.params.headroom;
  }

  /**
   * Re-apply `params.headroom` / `params.makeup` / compressor settings after
   * poking them directly. Cheap; call from a debug panel, not per frame.
   */
  applyMixSettings() {
    if (!this.available) return;
    const P = this.params;
    this.sfxBus.gain.value = P.sfxVolume * P.headroom;
    this.preLimit.gain.value = P.makeup / P.limiterDrive;
    this.master.gain.value = P.masterVolume;
    this.musicGain.gain.value = P.musicVolume;
    this.compressor.threshold.value = P.compThreshold;
    this.compressor.knee.value = P.compKnee;
    this.compressor.ratio.value = P.compRatio;
    this.compressor.attack.value = P.compAttack;
    this.compressor.release.value = P.compRelease;
    this.limiter.curve = this._softClipCurve(P.limiterKnee, P.limiterDrive);
  }

  /** @param {number} v 0..1 */
  setMusicVolume(v) {
    this.params.musicVolume = CLAMP(v, 0, 1.5);
    if (this.available) this.musicGain.gain.value = this.params.musicVolume;
  }

  /** @param {string} cat @param {number} v */
  setCategoryVolume(cat, v) {
    if (cat in this.categoryGain) this.categoryGain[cat] = CLAMP(v, 0, 2);
  }

  /**
   * Duck the music/ambience bus (explosions, cinematic beats).
   * Not a real sidechain — just a scheduled dip, which is all a shooter needs.
   * @param {number} [amount=0.35] target multiplier of the current music level
   * @param {number} [hold=0.25] seconds at the ducked level
   * @param {number} [release=0.6] recovery time
   * @param {number} [when] context time to duck at; defaults to now. Delayed
   *   sounds (a distant explosion still travelling to the listener) pass their
   *   own scheduled time so the music dips when the blast lands, not when the
   *   event fired.
   */
  duckMusic(amount = 0.35, hold = 0.25, release = 0.6, when) {
    if (!this.available) return;
    const now = this._now();
    const t = (typeof when === 'number' && when > now) ? when : now;
    const g = this.musicGain.gain;
    const target = this.params.musicVolume * CLAMP(amount, 0, 1);
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(0.0005, g.value), t);
      g.linearRampToValueAtTime(Math.max(0.0005, target), t + 0.03);
      g.setValueAtTime(Math.max(0.0005, target), t + 0.03 + hold);
      g.linearRampToValueAtTime(this.params.musicVolume, t + 0.03 + hold + release);
    } catch (_) {}
  }

  /**
   * Fire a one-shot.
   * @param {string} name  one of SOUND_NAMES (aliases accepted)
   * @param {object} [opts]
   * @param {{x:number,y:number,z:number}|number[]} [opts.position] world position → 3D
   * @param {number} [opts.volume=1]
   * @param {number} [opts.pitch=1]
   * @param {number} [opts.distance] explicit metres when no position is given
   * @param {number} [opts.delay=0] extra seconds before the sound starts
   * @param {number} [opts.send] override the reverb send for this shot
   * @returns {object|null} voice handle with `.stop(fade)`
   */
  play(name, opts) {
    if (!this.available) return null;
    const key = ALIASES[name] || name;
    const def = DEFS[key];
    if (!def) return null;
    if (!this._built) {
      try { this._buildBuffersSync(); }
      catch (_) { this.available = false; return null; }
    }
    if (this.actx.state !== 'running') {
      // Not unlocked yet — silently drop instead of stacking suspended nodes.
      if (this.actx.state === 'suspended') { this.resume(); return null; }
    }

    const o = opts || EMPTY;
    const P = this.params;
    const now = this._now();

    // ---- distance / propagation ----
    let dist = 0;
    let pos = o.position;
    let spatial = false;
    if (pos && def.spatial !== false) {
      let px, py, pz;
      if (Array.isArray(pos)) { px = pos[0]; py = pos[1]; pz = pos[2]; }
      else { px = pos.x; py = pos.y; pz = pos.z; }
      if (typeof px === 'number' && typeof py === 'number' && typeof pz === 'number') {
        const dx = px - this._lx, dy = py - this._ly, dz = pz - this._lz;
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        spatial = true;
        this._px = px; this._py = py; this._pz = pz;
      }
    }
    if (!spatial && typeof o.distance === 'number') dist = Math.max(0, o.distance);

    // ---- level ----
    let level = def.gain * (this.categoryGain[def.cat] || 1) * (o.volume === undefined ? 1 : o.volume);
    if (!spatial && dist > 0) {
      // manual inverse-distance when there's no panner doing it for us
      const rd = P.refDistance;
      level *= rd / (rd + P.rolloff * Math.max(0, dist - rd));
    }
    // Rapid repeats of the same sound sum in the bus; pull them back a touch so
    // five simultaneous rifle shots stay under the limiter instead of on it.
    const last = this._lastPlay[key];
    if (last !== undefined && now - last < P.repeatWindow) level *= P.repeatDuck;
    this._lastPlay[key] = now;
    if (level <= 0.0008) return null;

    // ---- voice allocation ----
    if (this._dying.length) this._drainDying(now);
    if (this._voices.length >= P.maxVoices && !this._steal(now, def.prio)) return null;
    let v = this._free.pop();
    if (!v) {
      try { v = this._createVoice(); }
      catch (_) { return null; }
    }
    v.id = ++this._voiceId;
    v.name = key;
    v.spatial = spatial;
    v.level = level;
    v.priority = def.prio;
    v.stolen = false;

    const input = this._gain(level);
    v.input = input;

    if (spatial) {
      const p = v.panner;
      p.refDistance = P.refDistance;
      p.maxDistance = P.maxDistance;
      p.rolloffFactor = P.rolloff;
      if (p.positionX) {
        p.positionX.value = this._px; p.positionY.value = this._py; p.positionZ.value = this._pz;
      } else if (p.setPosition) {
        p.setPosition(this._px, this._py, this._pz);
      }
      // Air absorption: HF halves every `airAbsorption` metres.
      const air = CLAMP(20000 * Math.pow(0.5, dist / P.airAbsorption), 320, 20000);
      v.air.frequency.value = air;
      input.connect(v.air);
    } else {
      if (dist > 0) {
        // 2D but far (e.g. an explosion reported by distance only)
        const air = CLAMP(20000 * Math.pow(0.5, dist / P.airAbsorption), 320, 20000);
        v.air.frequency.value = air;
      } else {
        v.air.frequency.value = 20000;
      }
      input.connect(v.flat);
    }

    const sendAmt = (o.send === undefined ? def.send : o.send) *
      P.reverbSend * (1 + dist * P.reverbDistanceBias);
    v.send.gain.value = CLAMP(sendAmt, 0, 3);

    // ---- timing ----
    let t = now + 0.004;                       // tiny lookahead: avoids glitches
    if (P.speedOfSound > 0 && dist > 1) t += Math.min(dist / P.speedOfSound, 0.5);
    if (o.delay) t += Math.max(0, o.delay);

    // ---- synthesis ----
    const so = this._o;
    so.pitch = (o.pitch === undefined ? 1 : o.pitch) *
      (def.varies === false ? 1 : 1 + (this._rnd() - 0.5) * 2 * P.pitchVariance);
    so.volume = level;
    so.distance = dist;
    so.dest = input;
    so.send = v.send;

    v.startTime = t;
    v.endTime = t + def.dur + 0.12;
    this._voices.push(v);

    try {
      def.fn.call(this, input, t, so);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[AudioEngine]', key, err);
    }
    return v;
  }

  /**
   * Per-frame housekeeping: listener transform + voice reaping. Allocation free.
   * @param {number} dt
   * @param {object} [ctx] shared context; `ctx.camera` overrides the stored one
   */
  update(dt, ctx) {
    if (!this.available) return;
    if (ctx && ctx.camera && ctx.camera !== this._camera) this._camera = ctx.camera;
    this._syncListener(false);

    const now = this.actx.currentTime;
    for (let i = this._voices.length - 1; i >= 0; i--) {
      const v = this._voices[i];
      if (now >= v.endTime) {
        // swap-remove: no splice, no garbage
        const lastIdx = this._voices.length - 1;
        this._voices[i] = this._voices[lastIdx];
        this._voices.pop();
        this._release(v);
      }
    }
    if (this._dying.length) this._drainDying(now);
  }

  /** Reads the camera's world matrix directly — no THREE import, no vectors. */
  _syncListener(force) {
    const cam = this._camera;
    if (!cam) return;
    const m = cam.matrixWorld && cam.matrixWorld.elements;
    if (!m) return;

    const px = m[12], py = m[13], pz = m[14];
    // -Z column is forward, +Y column is up (both normalised in place).
    let fx = -m[8], fy = -m[9], fz = -m[10];
    let ux = m[4], uy = m[5], uz = m[6];
    let n = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (n > 1e-6) { n = 1 / n; fx *= n; fy *= n; fz *= n; } else { fx = 0; fy = 0; fz = -1; }
    n = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (n > 1e-6) { n = 1 / n; ux *= n; uy *= n; uz *= n; } else { ux = 0; uy = 1; uz = 0; }

    if (!force) {
      const moved = Math.abs(px - this._lx) + Math.abs(py - this._ly) + Math.abs(pz - this._lz);
      const turned = Math.abs(fx - this._lfx) + Math.abs(fy - this._lfy) + Math.abs(fz - this._lfz);
      if (moved < 1e-4 && turned < 1e-4) return;
    }
    this._lx = px; this._ly = py; this._lz = pz;
    this._lfx = fx; this._lfy = fy; this._lfz = fz;
    this._lux = ux; this._luy = uy; this._luz = uz;

    const L = this.actx.listener;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      if (L.setPosition) L.setPosition(px, py, pz);
      if (L.setOrientation) L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // =====================================================================
  // Synthesis — weapons
  // =====================================================================

  /**
   * The five-layer gunshot.
   * @param {AudioNode} out voice input
   * @param {number} t
   * @param {object} o  { pitch, send, ... }
   * @param {object} C  weapon config from WEAPONS
   */
  _gunshot(out, t, o, C) {
    const p = o.pitch;
    const B = this.buffers;
    const send = o.send;

    // --- 1. crack: the supersonic snap. Two stacked transients, waveshaped. ---
    this._burst(out, t, {
      dur: C.snapDur * (1 / p), level: C.snapLevel, hp: C.snapHP * p,
      type: 'highpass', f0: C.snapHP * p, q: 0.5, attack: 0.00025,
      rate: 1.6, shape: 'hard',
    });
    this._burst(out, t + 0.0004, {
      dur: C.crackDur, level: C.crackLevel, hp: C.crackHP * p, hpQ: 0.8,
      type: 'bandpass', f0: C.crackHP * 1.9 * p, f1: C.crackHP * 0.9 * p,
      q: 0.7, sweep: C.crackDur * 0.8, attack: 0.0004, shape: 'soft',
    });

    // --- 2. body: one long noise source feeding lowpass + mid punch + tail ---
    const src = this.actx.createBufferSource();
    src.buffer = B.white;
    src.playbackRate.value = 1;
    const bufDur = B.white.duration;
    const totalDur = Math.max(C.bodyDur, C.tailDur) + 0.05;
    src.start(t, this._rnd() * Math.max(0.001, bufDur - totalDur - 0.02));
    src.stop(t + totalDur + 0.05);

    const lp = this._bq('lowpass', C.bodyF0 * p, C.bodyQ);
    this._sweep(lp.frequency, t, C.bodyF0 * p, C.bodyF1 * p, C.bodyDur * 0.55);
    const bodyG = this._gain(0);
    this._env(bodyG.gain, t, C.bodyLevel, 0.0007, C.bodyDur);
    src.connect(lp); lp.connect(bodyG); bodyG.connect(out);
    if (send) bodyG.connect(send);      // body is what the room hears

    const punch = this._bq('bandpass', C.punchF * p, C.punchQ);
    const punchG = this._gain(0);
    this._env(punchG.gain, t, C.punchLevel, 0.0009, C.punchDur);
    src.connect(punch); punch.connect(punchG); punchG.connect(out);

    // --- 3. thump: chest-punch low end with a fast pitch drop ---
    this._tone(out, t, 'triangle', C.thumpF0 * Math.sqrt(p), C.thumpF1 * Math.sqrt(p),
      C.thumpDur * 0.30, C.thumpLevel, 0.0015, C.thumpDur, 320);
    this._tone(out, t + 0.001, 'sine', C.subF0, C.subF1,
      C.subDur * 0.45, C.subLevel, 0.003, C.subDur, 180);

    // --- 4. mechanism: bolt/carrier/spring ---
    const mt = t + C.mechDelay;
    this._burst(out, mt, {
      dur: C.mechDur, level: C.mechLevel, type: 'bandpass',
      f0: C.mechBP * p, f1: C.mechBP * 0.55 * p, q: C.mechQ, attack: 0.0008,
    });
    this._partials(out, mt + 0.002, C.mechPartials, C.mechRingLevel, C.mechRing, p, 0.05, 0.5);
    // spring resonance — a thin high ring that decays slower than the click
    this._partials(out, mt + 0.004, [5240, 7360], C.mechRingLevel * 0.35, C.mechRing * 1.8, p, 0.08, 0.8);

    // --- 5. tail: dark noise, mostly into the room ---
    const tailF = this._bq('lowpass', C.tailLP * p, 0.7);
    this._sweep(tailF.frequency, t, C.tailLP * p, C.tailLP * 0.35 * p, C.tailDur * 0.7);
    const tailG = this._gain(0);
    this._env(tailG.gain, t + 0.004, C.tailLevel, 0.006, C.tailDur);
    src.connect(tailF); tailF.connect(tailG);
    const tailDry = this._gain(0.22);
    tailG.connect(tailDry); tailDry.connect(out);
    if (send) tailG.connect(send);
  }

  _synRifle(out, t, o) { this._gunshot(out, t, o, WEAPONS.rifle); }
  _synSmg(out, t, o) { this._gunshot(out, t, o, WEAPONS.smg); }
  _synPistol(out, t, o) { this._gunshot(out, t, o, WEAPONS.pistol); }

  _synDryFire(out, t, o) {
    const p = o.pitch;
    // hammer falling on an empty chamber: hard, dead, no body
    this._burst(out, t, {
      dur: 0.018, level: 0.85, type: 'bandpass', f0: 2400 * p, f1: 1500 * p,
      q: 5.5, attack: 0.0003, shape: 'soft',
    });
    this._partials(out, t + 0.0008, [3720, 5180, 7900], 0.30, 0.055, p, 0.05, 0.6);
    this._tone(out, t, 'triangle', 190 * p, 96 * p, 0.02, 0.22, 0.001, 0.045, 420);
  }

  // =====================================================================
  // Synthesis — weapon handling
  // =====================================================================

  _synMagOut(out, t, o) {
    const p = o.pitch;
    // 1. release catch clicks
    this._burst(out, t, { dur: 0.012, level: 0.5, type: 'bandpass', f0: 2900 * p, q: 6, attack: 0.0003 });
    this._partials(out, t, [3150, 4620], 0.20, 0.045, p, 0.05, 0.7);
    // 2. magazine dragging out of the well — scraping bandpass sweep
    this._burst(out, t + 0.012, {
      dur: 0.085, level: 0.34, type: 'bandpass', f0: 1900 * p, f1: 900 * p,
      q: 2.4, attack: 0.008, sweep: 0.07, buf: this.buffers.pink,
    });
    // 3. it clears the well: hollow polymer/alloy knock
    this._tone(out, t + 0.062, 'triangle', 320 * p, 165 * p, 0.03, 0.30, 0.0012, 0.075, 900);
    this._partials(out, t + 0.062, [1180, 1940, 2710], 0.16, 0.09, p, 0.06, 0.55);
  }

  _synMagIn(out, t, o) {
    const p = o.pitch;
    // approach scrape
    this._burst(out, t, {
      dur: 0.05, level: 0.22, type: 'bandpass', f0: 1400 * p, f1: 2200 * p,
      q: 2.0, attack: 0.006, sweep: 0.045, buf: this.buffers.pink,
    });
    // seat: heavy, solid, low
    const st = t + 0.048;
    this._burst(out, st, { dur: 0.03, level: 0.75, type: 'lowpass', f0: 2600 * p, f1: 700 * p, q: 1.1, attack: 0.0004, shape: 'soft' });
    this._tone(out, st, 'triangle', 240 * p, 88 * p, 0.035, 0.62, 0.0012, 0.11, 500);
    this._partials(out, st + 0.001, [1620, 2480, 3810], 0.24, 0.07, p, 0.05, 0.6);
    // catch engages a beat later
    const ct = st + 0.042;
    this._burst(out, ct, { dur: 0.014, level: 0.42, type: 'bandpass', f0: 3300 * p, q: 6.5, attack: 0.0003 });
    this._partials(out, ct, [3140, 4760, 6320], 0.22, 0.05, p, 0.05, 0.65);
  }

  _synBoltBack(out, t, o) {
    const p = o.pitch;
    // carrier riding back: rising scrape, spring compressing
    this._burst(out, t, {
      dur: 0.10, level: 0.40, type: 'bandpass', f0: 1500 * p, f1: 3100 * p,
      q: 1.9, attack: 0.010, sweep: 0.085, buf: this.buffers.pink,
    });
    // buffer stop
    const st = t + 0.095;
    this._burst(out, st, { dur: 0.022, level: 0.62, type: 'bandpass', f0: 2500 * p, f1: 1300 * p, q: 3.4, attack: 0.0004 });
    this._partials(out, st, [2260, 3480, 5120], 0.26, 0.075, p, 0.05, 0.6);
    this._tone(out, st, 'triangle', 210 * p, 105 * p, 0.02, 0.26, 0.0012, 0.06, 420);
    // spring ring
    this._partials(out, st + 0.004, [5320, 6910], 0.09, 0.20, p, 0.09, 0.9);
  }

  _synBoltForward(out, t, o) {
    const p = o.pitch;
    // spring drives it home: short whoosh then a heavy slam
    this._burst(out, t, {
      dur: 0.045, level: 0.34, type: 'bandpass', f0: 2600 * p, f1: 1200 * p,
      q: 1.7, attack: 0.004, sweep: 0.04, buf: this.buffers.pink,
    });
    const st = t + 0.044;
    this._burst(out, st, { dur: 0.028, level: 0.95, type: 'lowpass', f0: 4200 * p, f1: 800 * p, q: 1.2, attack: 0.0003, shape: 'soft' });
    this._partials(out, st, [2140, 3320, 5140, 7260], 0.34, 0.085, p, 0.05, 0.55);
    this._tone(out, st, 'triangle', 260 * p, 92 * p, 0.028, 0.55, 0.001, 0.09, 460);
    this._partials(out, st + 0.006, [4820, 6640], 0.10, 0.22, p, 0.08, 0.9);
  }

  _synReloadRustle(out, t, o) {
    const p = o.pitch;
    const B = this.buffers;
    for (let i = 0; i < 3; i++) {
      const off = i * this._rr(0.055, 0.11);
      this._burst(out, t + off, {
        dur: this._rr(0.10, 0.20), level: this._rr(0.10, 0.20),
        type: 'bandpass', f0: this._rr(1100, 2300) * p, q: 1.1,
        attack: 0.02, buf: B.cloth, rate: this._rr(0.85, 1.25),
      });
    }
  }

  _synAdsIn(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, {
      dur: 0.10, level: 0.22, type: 'bandpass', f0: 700 * p, f1: 1500 * p,
      q: 1.0, attack: 0.018, sweep: 0.08, buf: this.buffers.cloth,
    });
    this._burst(out, t + 0.075, { dur: 0.012, level: 0.16, type: 'bandpass', f0: 2900 * p, q: 5, attack: 0.0004 });
    this._partials(out, t + 0.075, [3060, 4410], 0.07, 0.03, p, 0.05, 0.7);
  }

  _synAdsOut(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, {
      dur: 0.09, level: 0.20, type: 'bandpass', f0: 1500 * p, f1: 620 * p,
      q: 1.0, attack: 0.012, sweep: 0.07, buf: this.buffers.cloth,
    });
    this._burst(out, t + 0.01, { dur: 0.010, level: 0.12, type: 'bandpass', f0: 2200 * p, q: 5, attack: 0.0004 });
  }

  _synWeaponSwitch(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, {
      dur: 0.14, level: 0.20, type: 'bandpass', f0: 900 * p, f1: 1800 * p,
      q: 0.9, attack: 0.03, sweep: 0.11, buf: this.buffers.cloth,
    });
    this._burst(out, t + 0.115, { dur: 0.02, level: 0.34, type: 'bandpass', f0: 2100 * p, f1: 1100 * p, q: 3.2, attack: 0.0004 });
    this._partials(out, t + 0.115, [1960, 3140, 4720], 0.20, 0.06, p, 0.06, 0.6);
    this._tone(out, t + 0.115, 'triangle', 180 * p, 92 * p, 0.02, 0.20, 0.0012, 0.05, 400);
  }

  // =====================================================================
  // Synthesis — locomotion
  // =====================================================================

  _synFootConcrete(out, t, o) {
    const p = o.pitch * this._rr(0.9, 1.12);
    const lv = this._rr(0.75, 1.05);
    // heel strike
    this._burst(out, t, {
      dur: this._rr(0.045, 0.075), level: 0.55 * lv, type: 'lowpass',
      f0: this._rr(1500, 2400) * p, f1: this._rr(380, 620) * p, q: 1.1, attack: 0.0008,
    });
    // grit under the boot
    this._burst(out, t + 0.004, {
      dur: this._rr(0.03, 0.06), level: 0.16 * lv, type: 'bandpass',
      f0: this._rr(3200, 5200) * p, q: 1.4, attack: 0.001, buf: this.buffers.grit,
      rate: this._rr(0.9, 1.3),
    });
    // body weight
    this._tone(out, t, 'sine', this._rr(120, 165) * p, this._rr(52, 68) * p,
      0.035, 0.42 * lv, 0.002, this._rr(0.06, 0.10), 240);
  }

  _synFootGravel(out, t, o) {
    const p = o.pitch * this._rr(0.88, 1.15);
    const lv = this._rr(0.7, 1.05);
    // the crunch is the star: dense grains, two overlapping layers
    this._burst(out, t, {
      dur: this._rr(0.075, 0.13), level: 0.50 * lv, type: 'bandpass',
      f0: this._rr(1900, 3400) * p, f1: this._rr(900, 1500) * p, q: 0.9,
      attack: 0.002, buf: this.buffers.grit, rate: this._rr(0.8, 1.35), sweep: 0.09,
    });
    this._burst(out, t + this._rr(0.008, 0.03), {
      dur: this._rr(0.05, 0.10), level: 0.30 * lv, type: 'highpass',
      f0: this._rr(2600, 4600) * p, q: 0.7, attack: 0.004,
      buf: this.buffers.grit, rate: this._rr(1.1, 1.8),
    });
    this._tone(out, t, 'sine', this._rr(105, 140) * p, this._rr(48, 62) * p,
      0.04, 0.26 * lv, 0.003, this._rr(0.05, 0.085), 200);
  }

  _synFootMetal(out, t, o) {
    const p = o.pitch * this._rr(0.9, 1.14);
    const lv = this._rr(0.75, 1.1);
    this._burst(out, t, {
      dur: this._rr(0.025, 0.045), level: 0.42 * lv, type: 'bandpass',
      f0: this._rr(2600, 4200) * p, f1: this._rr(1200, 1900) * p, q: 1.6, attack: 0.0006,
    });
    // ringing plate — the inharmonic set is jittered per step
    const f = this._rr(0.92, 1.09);
    this._partials(out, t, [418 * f, 731 * f, 1187 * f, 1893 * f, 2740 * f],
      0.26 * lv, this._rr(0.16, 0.30), p, 0.05, 0.5);
    this._tone(out, t, 'sine', this._rr(115, 150) * p, this._rr(58, 74) * p,
      0.03, 0.24 * lv, 0.002, 0.06, 260);
  }

  // =====================================================================
  // Synthesis — impacts
  // =====================================================================

  _synImpactConcrete(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, {
      dur: 0.012, level: 0.85, type: 'highpass', f0: 3200 * p, q: 0.6,
      attack: 0.0003, shape: 'soft',
    });
    this._burst(out, t, {
      dur: 0.085, level: 0.62, type: 'lowpass', f0: 5200 * p, f1: 560 * p,
      q: 1.2, attack: 0.0006, sweep: 0.05,
    });
    // dust / spall
    this._burst(out, t + 0.01, {
      dur: 0.13, level: 0.16, type: 'bandpass', f0: 2100 * p, q: 1.0,
      attack: 0.006, buf: this.buffers.grit, rate: this._rr(0.9, 1.4),
    });
    this._tone(out, t, 'triangle', 175 * p, 68 * p, 0.03, 0.34, 0.0015, 0.075, 300);
  }

  _synImpactMetal(out, t, o) {
    const p = o.pitch * this._rr(0.9, 1.12);
    this._burst(out, t, {
      dur: 0.010, level: 0.85, type: 'highpass', f0: 4200 * p, q: 0.6,
      attack: 0.00025, shape: 'soft',
    });
    this._burst(out, t, {
      dur: 0.035, level: 0.48, type: 'bandpass', f0: 4600 * p, f1: 2100 * p,
      q: 1.8, attack: 0.0005,
    });
    const f = this._rr(0.9, 1.12);
    this._partials(out, t, [2380 * f, 3570 * f, 5090 * f, 7310 * f, 9640 * f],
      0.40, this._rr(0.18, 0.34), p, 0.06, 0.5);
    this._tone(out, t, 'triangle', 210 * p, 96 * p, 0.02, 0.20, 0.0012, 0.05, 340);
  }

  _synImpactFlesh(out, t, o) {
    const p = o.pitch * this._rr(0.9, 1.1);
    // wet slap, no top end
    this._burst(out, t, {
      dur: 0.055, level: 0.70, type: 'lowpass', f0: 1400 * p, f1: 260 * p,
      q: 1.4, attack: 0.0008, sweep: 0.03,
    });
    this._burst(out, t + 0.002, {
      dur: 0.03, level: 0.26, type: 'bandpass', f0: 1150 * p, f1: 620 * p,
      q: 2.2, attack: 0.0008,
    });
    this._tone(out, t, 'sine', 132 * p, 58 * p, 0.03, 0.55, 0.0015, 0.09, 200);
    // spatter
    this._burst(out, t + 0.012, {
      dur: 0.09, level: 0.10, type: 'bandpass', f0: 2600 * p, q: 1.2,
      attack: 0.004, buf: this.buffers.grit, rate: 1.6,
    });
  }

  _synRicochet(out, t, o) {
    const p = o.pitch * this._rr(0.85, 1.2);
    // strike
    this._burst(out, t, {
      dur: 0.014, level: 0.60, type: 'highpass', f0: 3600 * p, q: 0.7,
      attack: 0.0003, shape: 'soft',
    });
    // the whine: two detuned oscillators falling ~2 octaves, band-limited
    const dur = this._rr(0.28, 0.5);
    const f0 = this._rr(2400, 3400) * p;
    const f1 = f0 * this._rr(0.16, 0.28);
    const bp = this._bq('bandpass', f0, 3.2);
    this._sweep(bp.frequency, t, f0 * 1.1, f1 * 1.2, dur * 0.85);
    const wg = this._gain(0);
    this._envSwell(wg.gain, t, 0.34, 0.012, dur);
    bp.connect(wg); wg.connect(out);
    if (o.send) wg.connect(o.send);
    for (let i = 0; i < 2; i++) {
      const det = i === 0 ? 1 : this._rr(1.004, 1.016);
      const osc = this._osc(i === 0 ? 'sawtooth' : 'triangle', f0 * det);
      this._sweep(osc.frequency, t, f0 * det, f1 * det, dur * 0.85);
      const g = this._gain(i === 0 ? 0.55 : 0.45);
      osc.connect(g); g.connect(bp);
      osc.start(t); osc.stop(t + dur + 0.05);
    }
    // debris trail
    this._burst(out, t + 0.005, {
      dur: dur * 0.5, level: 0.10, type: 'bandpass', f0: f0 * 0.8, f1: f1,
      q: 2.0, attack: 0.006, sweep: dur * 0.45,
    });
  }

  _synBulletWhizz(out, t, o) {
    const p = o.pitch * this._rr(0.9, 1.15);
    const dur = this._rr(0.08, 0.14);
    this._burst(out, t, {
      dur, level: 0.42, type: 'bandpass', f0: 2200 * p, f1: 700 * p,
      q: 3.0, attack: dur * 0.3, sweep: dur * 0.8,
    });
    this._burst(out, t, {
      dur: dur * 0.8, level: 0.14, type: 'highpass', f0: 4000 * p, q: 0.7,
      attack: dur * 0.25,
    });
  }

  // =====================================================================
  // Synthesis — ordnance
  // =====================================================================

  _synExplosion(out, t, o) {
    const p = o.pitch;
    const B = this.buffers;
    const send = o.send;
    this.duckMusic(0.25, 0.5, 1.2, t);

    // ignition crack
    this._burst(out, t, {
      dur: 0.03, level: 0.85, type: 'highpass', f0: 1800 * p, q: 0.6,
      attack: 0.0004, shape: 'hard',
    });

    // main body: broadband, waveshaped, lowpass collapsing over ~0.9 s
    const src = this.actx.createBufferSource();
    src.buffer = B.white;
    src.playbackRate.value = 0.85;
    src.start(t, this._rnd() * 0.4);
    src.stop(t + 2.2);
    const lp = this._bq('lowpass', 3400 * p, 0.9);
    this._sweep(lp.frequency, t, 3400 * p, 130, 0.95);
    const ws = this.actx.createWaveShaper();
    ws.curve = this._curveDrive; ws.oversample = '2x';
    const bodyG = this._gain(0);
    this._env(bodyG.gain, t, 1.0, 0.006, 1.15);
    src.connect(lp); lp.connect(ws); ws.connect(bodyG); bodyG.connect(out);
    if (send) bodyG.connect(send);

    // sub: the concussion
    this._tone(out, t + 0.004, 'sine', 96, 26, 0.55, 1.0, 0.008, 1.5, 140);
    this._tone(out, t + 0.002, 'triangle', 190, 44, 0.30, 0.55, 0.004, 0.6, 220);

    // debris crackle
    const cg = this._burst(out, t + 0.03, {
      dur: 1.6, level: 0.30, type: 'bandpass', f0: 2400 * p, f1: 900 * p,
      q: 0.9, attack: 0.02, buf: B.crackle, sweep: 1.2,
    });
    if (cg && send) cg.connect(send);

    // long dark tail straight into the room
    const tailF = this._bq('lowpass', 1200, 0.7);
    this._sweep(tailF.frequency, t, 1200, 320, 1.4);
    const tailG = this._gain(0);
    this._env(tailG.gain, t + 0.02, 0.55, 0.06, 1.9);
    src.connect(tailF); tailF.connect(tailG);
    const dry = this._gain(0.3);
    tailG.connect(dry); dry.connect(out);
    if (send) tailG.connect(send);
  }

  _synGrenadeBounce(out, t, o) {
    const p = o.pitch * this._rr(0.85, 1.2);
    this._burst(out, t, {
      dur: 0.018, level: 0.55, type: 'bandpass', f0: 2600 * p, f1: 1300 * p,
      q: 3.0, attack: 0.0004,
    });
    const f = this._rr(0.9, 1.14);
    this._partials(out, t, [1420 * f, 2170 * f, 3390 * f, 5010 * f], 0.32, this._rr(0.09, 0.18), p, 0.05, 0.6);
    this._tone(out, t, 'triangle', 240 * p, 130 * p, 0.02, 0.22, 0.0012, 0.05, 500);
  }

  _synGrenadePin(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, { dur: 0.012, level: 0.40, type: 'bandpass', f0: 4200 * p, q: 7, attack: 0.0003 });
    this._partials(out, t, [4180, 6240, 8710], 0.24, 0.09, p, 0.04, 0.55);
    // spring
    this._burst(out, t + 0.02, { dur: 0.05, level: 0.10, type: 'bandpass', f0: 5600 * p, f1: 3800 * p, q: 6, attack: 0.003 });
  }

  _synShellDrop(out, t, o) {
    const p = o.pitch * this._rr(0.9, 1.18);
    const bounces = 3;
    let bt = t;
    let lv = 0.5;
    for (let i = 0; i < bounces; i++) {
      this._burst(out, bt, {
        dur: 0.008, level: 0.30 * lv, type: 'bandpass',
        f0: this._rr(4200, 6400) * p, q: 5, attack: 0.0003,
      });
      this._partials(out, bt, [3260 * this._rr(0.95, 1.06), 4870, 6930], 0.30 * lv, 0.055 * (1 - i * 0.2), p, 0.05, 0.6);
      bt += this._rr(0.055, 0.10) * (1 + i * 0.35);
      lv *= 0.55;
    }
  }

  // =====================================================================
  // Synthesis — feedback / bodies / melee
  // =====================================================================

  _synHitmarker(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, { dur: 0.006, level: 0.30, type: 'bandpass', f0: 3400 * p, q: 4, attack: 0.0003 });
    this._tone(out, t, 'triangle', 1520 * p, 1480 * p, 0.02, 0.30, 0.0008, 0.028, 6000);
    this._tone(out, t + 0.018, 'triangle', 2180 * p, 2120 * p, 0.02, 0.24, 0.0008, 0.030, 8000);
  }

  _synHeadshot(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, { dur: 0.006, level: 0.34, type: 'highpass', f0: 5200 * p, q: 0.7, attack: 0.0003 });
    this._tone(out, t, 'triangle', 2620 * p, 2580 * p, 0.02, 0.32, 0.0008, 0.045, 9000);
    this._partials(out, t + 0.004, [3940, 5910], 0.20, 0.14, p, 0.02, 0.7);
    this._tone(out, t + 0.03, 'sine', 1960 * p, 1300 * p, 0.06, 0.16, 0.002, 0.08, 6000);
  }

  _synPlayerHurt(out, t, o) {
    const p = o.pitch;
    // impact on the plate carrier + a short pressure wave in the ears
    this._burst(out, t, {
      dur: 0.09, level: 0.55, type: 'lowpass', f0: 1800 * p, f1: 340 * p,
      q: 1.2, attack: 0.0008, sweep: 0.05,
    });
    this._tone(out, t, 'sine', 120, 52, 0.05, 0.60, 0.002, 0.20, 200);
    this._burst(out, t + 0.01, {
      dur: 0.35, level: 0.10, type: 'bandpass', f0: 900 * p, q: 1.4,
      attack: 0.02, buf: this.buffers.pink,
    });
  }

  _synPlayerDeath(out, t, o) {
    // sub drop, wash of noise collapsing, tinnitus ring rising then fading
    this._tone(out, t, 'sine', 92, 27, 1.1, 0.85, 0.02, 2.0, 130);
    this._burst(out, t, {
      dur: 1.6, level: 0.34, type: 'lowpass', f0: 2400, f1: 220,
      q: 0.9, attack: 0.02, sweep: 1.1, buf: this.buffers.pink,
    });
    const ring = this._osc('sine', 3100);
    const rg = this._gain(0);
    this._envSwell(rg.gain, t + 0.05, 0.13, 0.25, 2.6);
    ring.connect(rg); rg.connect(out);
    ring.start(t); ring.stop(t + 3.2);
    const ring2 = this._osc('sine', 4640);
    const rg2 = this._gain(0);
    this._envSwell(rg2.gain, t + 0.08, 0.06, 0.3, 2.4);
    ring2.connect(rg2); rg2.connect(out);
    ring2.start(t); ring2.stop(t + 3.2);
  }

  _synEnemyDeath(out, t, o) {
    const p = o.pitch * this._rr(0.9, 1.12);
    // a short vocal grunt: sawtooth through two formant bandpasses
    const gd = this._rr(0.22, 0.36);
    const f0 = this._rr(105, 135) * p;
    const src = this._osc('sawtooth', f0);
    this._sweep(src.frequency, t, f0, f0 * 0.68, gd);
    const vg = this._gain(0);
    this._envSwell(vg.gain, t, 0.22, 0.03, gd);
    const fm1 = this._bq('bandpass', this._rr(620, 780), 4.5);
    const fm2 = this._bq('bandpass', this._rr(1050, 1350), 5.5);
    const fmix = this._gain(1);
    src.connect(fm1); src.connect(fm2);
    fm1.connect(fmix); fm2.connect(fmix);
    fmix.connect(vg); vg.connect(out);
    src.start(t); src.stop(t + gd + 0.08);
    // gear rustle then the body hitting the deck (two thumps)
    this._burst(out, t + 0.10, {
      dur: 0.28, level: 0.16, type: 'bandpass', f0: 1500 * p, q: 1.0,
      attack: 0.04, buf: this.buffers.cloth,
    });
    const d1 = t + this._rr(0.24, 0.34);
    this._tone(out, d1, 'sine', 116, 48, 0.05, 0.55, 0.002, 0.16, 190);
    this._burst(out, d1, { dur: 0.10, level: 0.30, type: 'lowpass', f0: 1300 * p, f1: 300 * p, q: 1.0, attack: 0.001 });
    const d2 = d1 + this._rr(0.09, 0.16);
    this._tone(out, d2, 'sine', 98, 44, 0.05, 0.32, 0.002, 0.13, 170);
    this._burst(out, d2, { dur: 0.14, level: 0.20, type: 'bandpass', f0: 900 * p, q: 0.9, attack: 0.004, buf: this.buffers.cloth });
  }

  _synMeleeSwing(out, t, o) {
    const p = o.pitch * this._rr(0.92, 1.1);
    const dur = this._rr(0.20, 0.28);
    const src = this.actx.createBufferSource();
    src.buffer = this.buffers.pink;
    src.playbackRate.value = 1;
    src.start(t, this._rnd() * 1.0);
    src.stop(t + dur + 0.06);
    const bp = this._bq('bandpass', 320 * p, 1.3);
    bp.frequency.setValueAtTime(320 * p, t);
    bp.frequency.exponentialRampToValueAtTime(1900 * p, t + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(520 * p, t + dur);
    const g = this._gain(0);
    this._envSwell(g.gain, t, 0.42, dur * 0.5, dur * 0.5);
    src.connect(bp); bp.connect(g); g.connect(out);
  }

  _synMeleeHit(out, t, o) {
    const p = o.pitch;
    this._burst(out, t, {
      dur: 0.07, level: 0.80, type: 'lowpass', f0: 2600 * p, f1: 380 * p,
      q: 1.3, attack: 0.0006, sweep: 0.04, shape: 'soft',
    });
    this._tone(out, t, 'sine', 145, 54, 0.04, 0.75, 0.0015, 0.16, 220);
    this._burst(out, t + 0.004, {
      dur: 0.05, level: 0.24, type: 'bandpass', f0: 1250 * p, f1: 700 * p, q: 2.0, attack: 0.001,
    });
    this._partials(out, t + 0.002, [880, 1370], 0.10, 0.06, p, 0.06, 0.7);
  }
}

/** Voice handle: `engine.play(...).stop(0.05)`. Guarded against pool reuse. */
function voiceStop(fade) {
  const e = this.engine;
  if (!e || !e.available || !this.id || !this.input) return;
  const now = e.actx.currentTime;
  const f = fade === undefined ? 0.03 : Math.max(0.005, fade);
  const g = this.input.gain;
  try {
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0005, g.value), now);
    g.exponentialRampToValueAtTime(0.0005, now + f);
    g.setValueAtTime(0, now + f + 0.002);
  } catch (_) { g.value = 0; }
  this.endTime = Math.min(this.endTime, now + f + 0.01);
}

const EMPTY = Object.freeze({});

/**
 * Sound table.
 *  fn      — synth method
 *  cat     — mixer category
 *  gain    — base level
 *  dur     — nominal lifetime (voice reaping)
 *  send    — reverb send amount
 *  prio    — 0 = expendable … 3 = never steal
 *  spatial — false forces 2D (UI / first-person)
 *  varies  — false disables random pitch jitter
 *
 * The gains are not guesses: every sound was rendered through an
 * OfflineAudioContext and its peak measured, then solved so that each one
 * lands on an intended level relative to a rifle shot (rifle at -4.4 dBFS,
 * footsteps -19 dB, foley -22 dB, impacts -12 dB, and so on). That's why some
 * are above 1.0 — a whoosh made of filtered noise simply needs more gain than
 * a transient to reach the same peak.
 */
const DEFS = Object.freeze({
  rifleFire:        { fn: AudioEngine.prototype._synRifle,        cat: 'weapon',   gain: 1.46, dur: 0.75, send: 0.75, prio: 3 },
  smgFire:          { fn: AudioEngine.prototype._synSmg,          cat: 'weapon',   gain: 0.80, dur: 0.55, send: 0.55, prio: 3 },
  pistolFire:       { fn: AudioEngine.prototype._synPistol,       cat: 'weapon',   gain: 0.82, dur: 0.62, send: 0.62, prio: 3 },
  dryFire:          { fn: AudioEngine.prototype._synDryFire,      cat: 'mech',     gain: 0.44, dur: 0.12, send: 0.25, prio: 2 },

  magOut:           { fn: AudioEngine.prototype._synMagOut,       cat: 'mech',     gain: 0.33, dur: 0.20, send: 0.30, prio: 2 },
  magIn:            { fn: AudioEngine.prototype._synMagIn,        cat: 'mech',     gain: 0.22, dur: 0.20, send: 0.30, prio: 2 },
  boltBack:         { fn: AudioEngine.prototype._synBoltBack,     cat: 'mech',     gain: 0.35, dur: 0.35, send: 0.30, prio: 2 },
  boltForward:      { fn: AudioEngine.prototype._synBoltForward,  cat: 'mech',     gain: 0.25, dur: 0.35, send: 0.32, prio: 2 },
  reloadRustle:     { fn: AudioEngine.prototype._synReloadRustle, cat: 'foley',    gain: 1.53, dur: 0.40, send: 0.18, prio: 0 },
  adsIn:            { fn: AudioEngine.prototype._synAdsIn,        cat: 'foley',    gain: 0.78, dur: 0.15, send: 0.12, prio: 1, spatial: false },
  adsOut:           { fn: AudioEngine.prototype._synAdsOut,       cat: 'foley',    gain: 0.89, dur: 0.14, send: 0.12, prio: 1, spatial: false },
  weaponSwitch:     { fn: AudioEngine.prototype._synWeaponSwitch, cat: 'foley',    gain: 0.36, dur: 0.25, send: 0.20, prio: 1, spatial: false },

  footstepConcrete: { fn: AudioEngine.prototype._synFootConcrete, cat: 'foley',    gain: 0.19, dur: 0.18, send: 0.30, prio: 0 },
  footstepGravel:   { fn: AudioEngine.prototype._synFootGravel,   cat: 'foley',    gain: 0.34, dur: 0.22, send: 0.26, prio: 0 },
  footstepMetal:    { fn: AudioEngine.prototype._synFootMetal,    cat: 'foley',    gain: 0.19, dur: 0.36, send: 0.34, prio: 0 },

  impactConcrete:   { fn: AudioEngine.prototype._synImpactConcrete, cat: 'impact', gain: 0.34, dur: 0.22, send: 0.55, prio: 1 },
  impactMetal:      { fn: AudioEngine.prototype._synImpactMetal,  cat: 'impact',   gain: 0.39, dur: 0.40, send: 0.55, prio: 1 },
  impactFlesh:      { fn: AudioEngine.prototype._synImpactFlesh,  cat: 'impact',   gain: 0.29, dur: 0.18, send: 0.30, prio: 1 },
  ricochet:         { fn: AudioEngine.prototype._synRicochet,     cat: 'impact',   gain: 1.60, dur: 0.60, send: 0.95, prio: 1 },
  bulletWhizz:      { fn: AudioEngine.prototype._synBulletWhizz,  cat: 'impact',   gain: 1.97, dur: 0.20, send: 0.35, prio: 1 },

  explosion:        { fn: AudioEngine.prototype._synExplosion,    cat: 'ordnance', gain: 1.03, dur: 2.40, send: 1.25, prio: 3, varies: false },
  grenadeBounce:    { fn: AudioEngine.prototype._synGrenadeBounce,cat: 'ordnance', gain: 0.32, dur: 0.25, send: 0.45, prio: 1 },
  grenadePin:       { fn: AudioEngine.prototype._synGrenadePin,   cat: 'mech',     gain: 0.23, dur: 0.14, send: 0.20, prio: 1, spatial: false },
  shellDrop:        { fn: AudioEngine.prototype._synShellDrop,    cat: 'foley',    gain: 1.01, dur: 0.40, send: 0.40, prio: 0 },

  hitmarker:        { fn: AudioEngine.prototype._synHitmarker,    cat: 'ui',       gain: 0.80, dur: 0.10, send: 0.0, prio: 2, spatial: false, varies: false },
  headshot:         { fn: AudioEngine.prototype._synHeadshot,     cat: 'ui',       gain: 0.60, dur: 0.22, send: 0.0, prio: 2, spatial: false, varies: false },
  playerHurt:       { fn: AudioEngine.prototype._synPlayerHurt,   cat: 'voice',    gain: 0.48, dur: 0.45, send: 0.10, prio: 3, spatial: false },
  playerDeath:      { fn: AudioEngine.prototype._synPlayerDeath,  cat: 'voice',    gain: 0.69, dur: 3.30, send: 0.25, prio: 3, spatial: false, varies: false },
  enemyDeath:       { fn: AudioEngine.prototype._synEnemyDeath,   cat: 'voice',    gain: 0.44, dur: 0.75, send: 0.45, prio: 2 },

  meleeSwing:       { fn: AudioEngine.prototype._synMeleeSwing,   cat: 'foley',    gain: 2.45, dur: 0.35, send: 0.20, prio: 1 },
  meleeHit:         { fn: AudioEngine.prototype._synMeleeHit,     cat: 'impact',   gain: 0.42, dur: 0.28, send: 0.40, prio: 2 },
});

export default AudioEngine;
