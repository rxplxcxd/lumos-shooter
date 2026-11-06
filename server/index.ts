/**
 * Lumos Strike realtime relay (WebSocket).
 *
 *  - rooms keyed by mode:sub (matchmaking = join the first room with a free slot, max 100)
 *  - 20 Hz state relay with per-room snapshot fan-out (clients send ~20 Hz)
 *  - shot / hit / chat / party-invite events
 *  - server-side sanity checks: rate limiting + max damage per hit
 *
 * Async data (profiles, progression, friends) lives in Lumos Cloud / Supabase.
 * Run: npm run server   (PORT env, default 8787)
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

interface Client { id: string; ws: WebSocket; name: string; room: string | null; last: number; msgs: number }
interface Room { id: string; key: string; clients: Set<Client>; created: number }

const PORT = Number(process.env.PORT || 8787);
const MAX_PER_ROOM = 100;
const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();

const wss = new WebSocketServer({ port: PORT });
console.log(`[lumos-strike] realtime server on ws://0.0.0.0:${PORT}`);

function send(c: Client, m: unknown) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); }
function broadcast(r: Room, m: unknown, except?: Client) { const s = JSON.stringify(m); for (const c of r.clients) if (c !== except && c.ws.readyState === 1) c.ws.send(s); }

function join(c: Client, key: string) {
  leave(c);
  let room = [...rooms.values()].find((r) => r.key === key && r.clients.size < MAX_PER_ROOM);
  if (!room) { room = { id: randomUUID().slice(0, 8), key, clients: new Set(), created: Date.now() }; rooms.set(room.id, room); }
  room.clients.add(c);
  c.room = room.id;
  send(c, { type: 'joined', room: room.id, players: [...room.clients].map((x) => ({ id: x.id, name: x.name })) });
  broadcast(room, { type: 'peer', id: c.id, name: c.name }, c);
}

function leave(c: Client) {
  if (!c.room) return;
  const r = rooms.get(c.room);
  c.room = null;
  if (!r) return;
  r.clients.delete(c);
  broadcast(r, { type: 'leave', id: c.id });
  if (!r.clients.size) rooms.delete(r.id);
}

wss.on('connection', (ws) => {
  const c: Client = { id: randomUUID().slice(0, 12), ws, name: 'Operator', room: null, last: Date.now(), msgs: 0 };
  clients.set(c.id, c);
  send(c, { type: 'welcome', id: c.id });
  ws.on('message', (raw) => {
    c.msgs++;
    if (c.msgs > 120) return; // >120 msgs/s => drop (anti-spam)
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    c.last = Date.now();
    const room = c.room ? rooms.get(c.room) : undefined;
    switch (m.type) {
      case 'hello': c.name = String(m.name ?? 'Operator').slice(0, 16); break;
      case 'join': join(c, String(m.room ?? 'br:solos').slice(0, 40)); break;
      case 'leave': leave(c); break;
      case 'state': if (room) broadcast(room, { type: 'state', s: { ...m.s, id: c.id, name: c.name } }, c); break;
      case 'shot': if (room) broadcast(room, { type: 'shot', id: c.id, o: m.o, d: m.d, w: m.w }, c); break;
      case 'hit': {
        if (!room) break;
        const dmg = Math.max(0, Math.min(250, Number(m.dmg) || 0)); // clamp – basic cheat protection
        const target = [...room.clients].find((x) => x.id === m.to);
        if (target) send(target, { type: 'hit', from: c.id, to: target.id, dmg, zone: m.zone });
        break;
      }
      case 'chat': if (room) broadcast(room, { type: 'chat', from: c.name, text: String(m.text ?? '').slice(0, 200) }); break;
      case 'invite': { const t = clients.get(m.to); if (t) send(t, { type: 'invite', from: c.id, name: c.name, room: c.room }); break; }
    }
  });
  ws.on('close', () => { leave(c); clients.delete(c.id); });
});

// per-second housekeeping: reset rate limits, drop idle sockets
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    c.msgs = 0;
    if (now - c.last > 60000) c.ws.terminate();
  }
}, 1000);
