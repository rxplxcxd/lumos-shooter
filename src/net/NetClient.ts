/**
 * Realtime client for the Node `ws` relay server (server/index.ts): rooms / matchmaking,
 * 20 Hz state snapshots, shot & hit events, party invites. Async data (profiles, stats)
 * goes through Lumos Cloud / Supabase – this socket only carries the fast game state.
 *
 * Connect with VITE_REALTIME_URL=ws://localhost:8787 (or ?server=ws://host:8787).
 */
export interface NetState { id: string; name: string; t: number; p: [number, number, number]; yaw: number; pitch: number; anim: string; hp: number; team: number; weapon: string }
type Msg =
  | { type: 'welcome'; id: string }
  | { type: 'joined'; room: string; players: { id: string; name: string }[] }
  | { type: 'state'; s: NetState }
  | { type: 'leave'; id: string }
  | { type: 'shot'; id: string; o: number[]; d: number[]; w: string }
  | { type: 'hit'; from: string; to: string; dmg: number; zone: string }
  | { type: 'chat'; from: string; text: string };

export class NetClient {
  ws: WebSocket | null = null;
  id = '';
  room = '';
  peers = new Map<string, NetState>();
  handlers = new Map<string, ((m: any) => void)[]>();
  connected = false;
  private sendT = 0;

  static url(): string | null {
    const q = new URL(location.href).searchParams.get('server');
    return q || (import.meta.env.VITE_REALTIME_URL as string | undefined) || null;
  }

  connect(url: string, name: string) {
    return new Promise<boolean>((resolve) => {
      try { this.ws = new WebSocket(url); } catch { resolve(false); return; }
      const timer = setTimeout(() => resolve(false), 4000);
      this.ws.onopen = () => { this.connected = true; this.send({ type: 'hello', name }); clearTimeout(timer); resolve(true); };
      this.ws.onclose = () => { this.connected = false; };
      this.ws.onerror = () => resolve(false);
      this.ws.onmessage = (e) => {
        let m: Msg; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'welcome') this.id = m.id;
        if (m.type === 'state') this.peers.set(m.s.id, m.s);
        if (m.type === 'leave') this.peers.delete(m.id);
        this.handlers.get(m.type)?.forEach((h) => h(m));
      };
    });
  }

  on(type: Msg['type'], fn: (m: any) => void) { const l = this.handlers.get(type) ?? []; l.push(fn); this.handlers.set(type, l); }
  send(m: Record<string, unknown>) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  join(mode: string, sub: string) { this.room = `${mode}:${sub}`; this.send({ type: 'join', room: this.room }); }
  /** throttled to 20 Hz */
  pushState(dt: number, s: Omit<NetState, 'id' | 't'>) { this.sendT += dt; if (this.sendT < 0.05) return; this.sendT = 0; this.send({ type: 'state', s: { ...s, t: performance.now() } }); }
  close() { this.ws?.close(); this.ws = null; this.peers.clear(); }
}
