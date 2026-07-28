import { EventEmitter } from './EventEmitter.js';

/**
 * Pointer-lock input. Exposes edge-triggered (`pressed`) and level (`down`)
 * queries plus accumulated mouse delta that the camera consumes once per frame.
 */
export class Input extends EventEmitter {
  constructor(domElement) {
    super();
    this.dom = domElement;
    this.down = new Set();
    this._pressedThisFrame = new Set();
    this._releasedThisFrame = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.locked = false;
    this.sensitivity = 0.0021;
    this.invertY = false;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const c = e.code;
      if (!this.down.has(c)) this._pressedThisFrame.add(c);
      this.down.add(c);
      // Stop browser scroll / quick-find stealing gameplay keys.
      if (['Space', 'Tab', 'KeyF', 'Slash', 'Quote'].includes(c)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.down.delete(e.code);
      this._releasedThisFrame.add(e.code);
    };
    this._onMouseDown = (e) => {
      const c = `Mouse${e.button}`;
      if (!this.down.has(c)) this._pressedThisFrame.add(c);
      this.down.add(c);
    };
    this._onMouseUp = (e) => {
      const c = `Mouse${e.button}`;
      this.down.delete(c);
      this._releasedThisFrame.add(c);
    };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onWheel = (e) => { this.mouse.wheel += Math.sign(e.deltaY); };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.dom;
      this.emit('lockchange', this.locked);
      if (!this.locked) this.down.clear();
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.dom.addEventListener('contextmenu', this._onContext);
  }

  requestLock() {
    if (!this.locked) this.dom.requestPointerLock?.();
  }

  isDown(code) { return this.down.has(code); }
  anyDown(...codes) { return codes.some((c) => this.down.has(c)); }
  pressed(code) { return this._pressedThisFrame.has(code); }
  released(code) { return this._releasedThisFrame.has(code); }

  /** Consume this frame's look delta (radians). */
  takeLook() {
    const yaw = -this.mouse.dx * this.sensitivity;
    const pitch = (this.invertY ? 1 : -1) * this.mouse.dy * this.sensitivity;
    this.mouse.dx = 0; this.mouse.dy = 0;
    return { yaw, pitch };
  }

  /** Call at the very end of each frame. */
  endFrame() {
    this._pressedThisFrame.clear();
    this._releasedThisFrame.clear();
    this.mouse.wheel = 0;
  }
}
