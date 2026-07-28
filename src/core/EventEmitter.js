export class EventEmitter {
  constructor() { this._handlers = new Map(); }
  on(evt, fn) {
    if (!this._handlers.has(evt)) this._handlers.set(evt, new Set());
    this._handlers.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._handlers.get(evt)?.delete(fn); }
  emit(evt, ...args) {
    const hs = this._handlers.get(evt);
    if (!hs) return;
    for (const fn of hs) fn(...args);
  }
}
