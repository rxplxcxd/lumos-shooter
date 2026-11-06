/**
 * Lumos Strike realtime relay (WebSocket) – host-relay multiplayer.
 *
 *  - party rooms by code (`join {code}`), first member is the host, host migration on leave
 *  - host `start` -> everybody receives the same seed / mode / player list and builds the
 *    identical world; the host simulates bots, zombies and mode logic and streams snapshots
 *  - players stream their own state (~20 Hz); events are broadcast, targeted or sent to the host
 *  - basic protection: message rate limit, size limit, damage clamp
 *
 * Run: npm run server (PORT env, default 8787). `npm run dev` starts it automatically and Vite
 * proxies ws://<dev-host>/ws to it, so a single forwarded port is enough (LAN / Codespaces).
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

interface Client { id: string; ws: WebSocket; name: string; room: Room | null; last: number; msgs: number }
interface Room { code: string; host: string; clients: Client[]; running: boolean; mode: string; sub: string; seed: number }

const PORT = Number(process.env.PORT || 8787);
const MAX_PER_ROOM = 16;
const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
const wss = new WebSocketServer({ port: PORT, maxPayload: 256 * 1024 });
console.log(`[lumos-strike] realtime server on ws://0.0.0.0:${PORT}`);

const send = (c: Client, m: unknown) => { if (c.ws.readyState === 1) c.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
const broadcast = (r: Room, m: unknown, except?: Client) => { const s = JSON.stringify(m); for (const c of r.clients) if (c !== except) send(c, s); };
const roomInfo = (r: Room) => ({ t: 'room', code: r.code, host: r.host, running: r.running, mode: r.mode, sub: r.sub, players: r.clients.map((c, i) => ({ id: c.id, name: c.name, idx: i })) });

function join(c: Client, code: string) {
  leave(c);
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'LUMOS';
  let r = rooms.get(code);
  if (!r) { r = { code, host: c.id, clients: [], running: false, mode: 'mp', sub: 'tdm', seed: 0 }; rooms.set(code, r); }
  if (r.clients.length >= MAX_PER_ROOM) { send(c, { t: 'error', msg: 'Raum ist voll' }); return; }
  r.clients.push(c);
  c.room = r;
  broadcast(r, roomInfo(r));
}

function leave(c: Client) {
  const r = c.room;
  if (!r) return;
  c.room = null;
  r.clients = r.clients.filter((x) => x !== c);
  if (!r.clients.length) { rooms.delete(r.code); return; }
  if (r.host === c.id) { r.host = r.clients[0].id; broadcast(r, { t: 'hostLeft', newHost: r.host }); }
  broadcast(r, { t: 'left', id: c.id });
  broadcast(r, roomInfo(r));
}

wss.on('connection', (ws) => {
  const c: Client = { id: randomUUID().slice(0, 8), ws, name: 'Operator', room: null, last: Date.now(), msgs: 0 };
  clients.set(c.id, c);
  send(c, { t: 'welcome', id: c.id });
  ws.on('message', (raw) => {
    if (++c.msgs > 200) return; // per-second rate limit
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    c.last = Date.now();
    const r = c.room;
    switch (m.t) {
      case 'hello': c.name = String(m.name ?? 'Operator').slice(0, 16); if (r) broadcast(r, roomInfo(r)); break;
      case 'join': join(c, String(m.code ?? '')); break;
      case 'leave': leave(c); break;
      case 'start':
        if (!r || r.host !== c.id) break;
        r.running = true; r.mode = String(m.mode); r.sub = String(m.sub); r.seed = (Math.random() * 1e9) | 0;
        broadcast(r, { t: 'start', seed: r.seed, mode: r.mode, sub: r.sub, night: !!m.night, host: r.host, players: r.clients.map((x, i) => ({ id: x.id, name: x.name, idx: i })) });
        break;
      case 'end': if (r && r.host === c.id) { r.running = false; broadcast(r, roomInfo(r)); } break;
      case 'st': if (r) { m.id = c.id; broadcast(r, m, c); } break;
      case 'snap': if (r && r.host === c.id) broadcast(r, m, c); break;
      case 'ev': if (r) broadcast(r, { t: 'ev', from: c.id, e: m.e }, c); break;
      case 'to': {
        if (!r) break;
        const tgt = r.clients.find((x) => x.id === m.to);
        if (m.e?.k === 'hit') m.e.dmg = Math.max(0, Math.min(300, Number(m.e.dmg) || 0));
        if (tgt) send(tgt, { t: 'ev', from: c.id, e: m.e });
        break;
      }
      case 'host': { if (!r) break; const h = r.clients.find((x) => x.id === r.host); if (h && h !== c) send(h, { t: 'ev', from: c.id, e: m.e }); break; }
      case 'ping': send(c, { t: 'pong', ts: m.ts }); break;
    }
  });
  ws.on('close', () => { leave(c); clients.delete(c.id); });
});

setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) { c.msgs = 0; if (now - c.last > 45000) c.ws.terminate(); }
}, 1000);
