/**
 * WebSocket client for the realtime relay (server/index.ts).
 * Default URL is same-origin `/ws` (Vite proxies it to the relay), so it works locally, on the LAN
 * and in GitHub Codespaces with a single forwarded port. Override with VITE_REALTIME_URL or ?server=.
 */
export interface RoomPlayer { id: string; name: string; idx: number }
export interface RoomInfo { code: string; host: string; running: boolean; mode: string; sub: string; players: RoomPlayer[] }
export interface StartInfo { seed: number; mode: string; sub: string; night: boolean; host: string; players: RoomPlayer[] }

type Handler = (m: any) => void;

export class NetClient {
  ws: WebSocket | null = null;
  id = '';
  room: RoomInfo | null = null;
  connected = false;
  ping = 0;
  private handlers = new Map<string, Handler[]>();
  private pingT = 0;

  static url(): string {
    const q = new URL(location.href).searchParams.get('server');
    const env = import.meta.env.VITE_REALTIME_URL as string | undefined;
    if (q || env) return (q || env)!;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  get isHost() { return !!this.room && this.room.host === this.id; }

  connect(name: string, url = NetClient.url()) {
    if (this.connected) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      try { this.ws = new WebSocket(url); } catch { resolve(false); return; }
      const timer = setTimeout(() => resolve(false), 5000);
      this.ws.onopen = () => { this.connected = true; this.send({ t: 'hello', name }); clearTimeout(timer); resolve(true); this.emit('status', true); };
      this.ws.onclose = () => { this.connected = false; this.room = null; this.emit('status', false); };
      this.ws.onerror = () => { clearTimeout(timer); resolve(false); };
      this.ws.onmessage = (e) => {
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'welcome') this.id = m.id;
        if (m.t === 'room') this.room = m;
        if (m.t === 'pong') this.ping = performance.now() - m.ts;
        this.emit(m.t, m);
      };
    });
  }

  on(t: string, fn: Handler) { const l = this.handlers.get(t) ?? []; l.push(fn); this.handlers.set(t, l); return () => this.off(t, fn); }
  off(t: string, fn: Handler) { const l = this.handlers.get(t); if (l) this.handlers.set(t, l.filter((h) => h !== fn)); }
  private emit(t: string, m: any) { this.handlers.get(t)?.forEach((h) => h(m)); }
  send(m: Record<string, unknown>) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  join(code: string) { this.send({ t: 'join', code }); }
  leave() { this.send({ t: 'leave' }); this.room = null; }
  start(mode: string, sub: string, night: boolean) { this.send({ t: 'start', mode, sub, night }); }
  event(e: Record<string, unknown>) { this.send({ t: 'ev', e }); }
  to(id: string, e: Record<string, unknown>) { this.send({ t: 'to', to: id, e }); }
  toHost(e: Record<string, unknown>) { this.send({ t: 'host', e }); }
  tick(dt: number) { this.pingT -= dt; if (this.pingT <= 0 && this.connected) { this.pingT = 2; this.send({ t: 'ping', ts: performance.now() }); } }
  close() { this.ws?.close(); this.ws = null; this.connected = false; this.room = null; }
}
