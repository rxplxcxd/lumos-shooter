import { defaultProfile, type Profile } from './Profile';

/**
 * Backend abstraction (cross-save, friends, progression):
 *   1. Lumos Cloud  – when running inside Lumos OS / with a LUMOS_SESSION_TOKEN
 *   2. Supabase     – standalone web deployment (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
 *   3. Local        – offline / development (localStorage), always works
 */
export interface Backend {
  readonly kind: 'lumos' | 'supabase' | 'local';
  readonly label: string;
  init(): Promise<boolean>;
  loadProfile(): Promise<Profile>;
  saveProfile(p: Profile): Promise<void>;
  pushMatch(result: Record<string, unknown>): Promise<void>;
  friends(): Promise<Profile['friends']>;
  invite(friendId: string): Promise<boolean>;
}

const LOCAL_KEY = 'lumos-strike-profile-v1';

export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  readonly label = 'Offline (lokal)';
  async init() { return true; }
  async loadProfile(): Promise<Profile> {
    try { const raw = localStorage.getItem(LOCAL_KEY); if (raw) return { ...defaultProfile(), ...JSON.parse(raw) }; } catch { /* ignore */ }
    return defaultProfile('local-' + Math.random().toString(36).slice(2, 8));
  }
  async saveProfile(p: Profile) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(p)); } catch { /* ignore */ } }
  async pushMatch() { /* stored in profile stats */ }
  async friends() { return []; }
  async invite() { return false; }
}

/** Lumos Cloud – the handheld OS ecosystem backend (profile, cloud save, friends, CDN). */
export class LumosCloudBackend implements Backend {
  readonly kind = 'lumos' as const;
  readonly label = 'Lumos Cloud';
  private token = '';
  private base = '';
  private local = new LocalBackend();
  async init() {
    const sdk = (window as any).LumosCloudSDK;
    const url = new URL(location.href);
    this.token = sdk?.sessionToken || url.searchParams.get('lumos_token') || (import.meta.env.VITE_LUMOS_SESSION_TOKEN as string) || '';
    this.base = (sdk?.apiBase || (import.meta.env.VITE_LUMOS_API as string) || '').replace(/\/$/, '');
    if (!this.token || !this.base) return false;
    try {
      const r = await fetch(`${this.base}/api/v1/lumos/user/profile`, { headers: this.headers() });
      return r.ok;
    } catch { return false; }
  }
  private headers() { return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }; }
  async loadProfile(): Promise<Profile> {
    const r = await fetch(`${this.base}/api/v1/lumos/user/profile`, { headers: this.headers() });
    const remote = await r.json();
    const base = await this.local.loadProfile();
    const merged: Profile = { ...base, ...(remote.gameData?.['lumos-strike'] ?? {}), id: remote.id ?? base.id, name: remote.displayName ?? remote.username ?? base.name };
    return merged;
  }
  async saveProfile(p: Profile) {
    await this.local.saveProfile(p);
    await fetch(`${this.base}/api/v1/lumos/user/sync`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ game: 'lumos-strike', save: p }) }).catch(() => {});
  }
  async pushMatch(result: Record<string, unknown>) {
    await fetch(`${this.base}/api/v1/lumos/user/sync`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ game: 'lumos-strike', match: result }) }).catch(() => {});
  }
  async friends() {
    try {
      const r = await fetch(`${this.base}/api/v1/lumos/user/friends`, { headers: this.headers() });
      const list = await r.json();
      return (list ?? []).map((f: any) => ({ id: f.id, name: f.displayName ?? f.username, online: !!f.online, source: 'lumos' as const }));
    } catch { return []; }
  }
  async invite(friendId: string) {
    const r = await fetch(`${this.base}/api/v1/lumos/party/invite`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ game: 'lumos-strike', friendId }) }).catch(() => null);
    return !!r?.ok;
  }
}

/** Supabase – anonymous (or OAuth) auth + `profiles` / `matches` / `friends` tables (see supabase/schema.sql). */
export class SupabaseBackend implements Backend {
  readonly kind = 'supabase' as const;
  readonly label = 'Supabase';
  private sb: any = null;
  private uid = '';
  private local = new LocalBackend();
  async init() {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !key) return false;
    try {
      const { createClient } = await import('@supabase/supabase-js');
      this.sb = createClient(url, key, { auth: { persistSession: true } });
      let { data } = await this.sb.auth.getSession();
      if (!data.session) { const res = await this.sb.auth.signInAnonymously(); data = { session: res.data.session }; }
      this.uid = data.session?.user?.id ?? '';
      return !!this.uid;
    } catch (e) { console.warn('[supabase] init failed', e); return false; }
  }
  async loadProfile(): Promise<Profile> {
    const base = await this.local.loadProfile();
    const { data } = await this.sb.from('profiles').select('data').eq('id', this.uid).maybeSingle();
    return data?.data ? { ...base, ...data.data, id: this.uid } : { ...base, id: this.uid };
  }
  async saveProfile(p: Profile) {
    await this.local.saveProfile(p);
    await this.sb.from('profiles').upsert({ id: this.uid, name: p.name, level: p.level, data: p, updated_at: new Date().toISOString() });
  }
  async pushMatch(result: Record<string, unknown>) { await this.sb.from('matches').insert({ user_id: this.uid, result }); }
  async friends() {
    const { data } = await this.sb.from('friends').select('friend_id, profiles:friend_id(name, last_seen)').eq('user_id', this.uid);
    return (data ?? []).map((f: any) => ({ id: f.friend_id, name: f.profiles?.name ?? 'Freund', online: f.profiles?.last_seen ? Date.now() - Date.parse(f.profiles.last_seen) < 120000 : false, source: 'supabase' as const }));
  }
  async invite(friendId: string) {
    const { error } = await this.sb.from('party_invites').insert({ from_id: this.uid, to_id: friendId, game: 'lumos-strike' });
    return !error;
  }
}

export async function createBackend(): Promise<Backend> {
  for (const b of [new LumosCloudBackend(), new SupabaseBackend()]) {
    try { if (await b.init()) return b; } catch { /* next */ }
  }
  const l = new LocalBackend();
  await l.init();
  return l;
}
