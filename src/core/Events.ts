type Handler<T = any> = (payload: T) => void;
/** Minimal typed-ish event bus used to decouple gameplay, HUD, audio and network. */
export class Events {
  private map = new Map<string, Set<Handler>>();
  on<T = any>(ev: string, fn: Handler<T>) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev)!.add(fn);
    return () => this.off(ev, fn);
  }
  off(ev: string, fn: Handler) { this.map.get(ev)?.delete(fn); }
  emit<T = any>(ev: string, payload?: T) { this.map.get(ev)?.forEach((fn) => fn(payload)); }
  clear() { this.map.clear(); }
}
export const bus = new Events();
