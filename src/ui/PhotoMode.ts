import * as THREE from 'three';
import type { GameWorld } from '../gameplay/GameWorld';
import type { Input } from '../input/Input';

const LOOKS: { name: string; look: number; post?: 'nvg' | 'thermal' }[] = [
  { name: 'Standard', look: 0 }, { name: 'Kino', look: 1 }, { name: 'Noir', look: 2 }, { name: 'Lebendig', look: 3 },
  { name: 'Vintage', look: 4 }, { name: 'Nachtsicht', look: 0, post: 'nvg' }, { name: 'Wärmebild', look: 0, post: 'thermal' },
];

/**
 * Photo mode (from the pause menu): the match stays frozen, a free camera flies around the
 * player (WASD / left stick, mouse / right stick, Space / Ctrl up-down, Q / E roll, mouse wheel /
 * bumpers FOV), F cycles colour looks, H hides the panel, click / A saves a PNG, Esc returns.
 */
export class PhotoMode {
  active = false;
  onExit: (() => void) | null = null;
  private el: HTMLElement | null = null;
  private pos = new THREE.Vector3();
  private yaw = 0; private pitch = 0; private roll = 0; private fov = 70;
  private savedFov = 70;
  private lookIdx = 0;
  private letterbox = false;
  private e = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private w: GameWorld, private input: Input, private ui: HTMLElement) {}

  enter() {
    const cam = this.w.engine.camera;
    this.active = true;
    this.pos.copy(cam.position);
    this.e.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = this.e.y; this.pitch = this.e.x; this.roll = 0;
    this.fov = this.savedFov = cam.fov;
    this.w.engine.overlay.visible = false;
    document.body.classList.add('photo-mode');
    this.el = document.createElement('div');
    this.el.className = 'photo-ui';
    this.el.innerHTML = `<div class="bars"><i></i><i></i></div><div class="flash"></div>
      <div class="panel"><b>FOTOMODUS</b><span class="look"></span><span class="fov"></span>
      <div class="keys">WASD/Stick · Maus: Kamera · Leertaste/Strg: hoch/runter · Q/E: Neigen · Mausrad: FOV · F: Filter · I: Kinobalken · H: Panel · Klick: Foto · Esc: zurück</div>
      <div class="btns"><button data-k="look">Filter</button><button data-k="bars">Balken</button><button data-k="shot">📷 Foto</button><button data-k="exit">Zurück</button></div></div>`;
    this.ui.appendChild(this.el);
    this.el.querySelector('[data-k="look"]')!.addEventListener('click', (ev) => { ev.stopPropagation(); this.nextLook(); });
    this.el.querySelector('[data-k="bars"]')!.addEventListener('click', (ev) => { ev.stopPropagation(); this.toggleBars(); });
    this.el.querySelector('[data-k="shot"]')!.addEventListener('click', (ev) => { ev.stopPropagation(); this.capture(); });
    this.el.querySelector('[data-k="exit"]')!.addEventListener('click', (ev) => { ev.stopPropagation(); this.exit(); });
    this.applyLook();
    this.input.lock();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    const cam = this.w.engine.camera;
    cam.fov = this.savedFov; cam.updateProjectionMatrix();
    this.w.engine.look = 0;
    this.w.engine.setPost('none');
    this.w.engine.overlay.visible = true;
    document.body.classList.remove('photo-mode');
    this.el?.remove(); this.el = null;
    this.onExit?.();
  }

  private nextLook() { this.lookIdx = (this.lookIdx + 1) % LOOKS.length; this.applyLook(); this.w.audio.ui('cursor'); }
  private toggleBars() { this.letterbox = !this.letterbox; this.el?.classList.toggle('letterbox', this.letterbox); }
  private applyLook() {
    const l = LOOKS[this.lookIdx];
    this.w.engine.look = l.look;
    this.w.engine.setPost(l.post ?? 'none');
    const s = this.el?.querySelector('.look'); if (s) s.textContent = `Filter: ${l.name}`;
  }

  capture() {
    const panel = this.el?.querySelector('.panel') as HTMLElement | null;
    try {
      const url = this.w.engine.capture();
      const a = document.createElement('a');
      a.href = url; a.download = `lumos-strike-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
    } catch (e) { console.warn('capture failed', e); }
    this.w.audio.ui('confirm');
    const f = this.el?.querySelector('.flash') as HTMLElement | null;
    if (f) { f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
    if (panel) panel.style.visibility = '';
  }

  update(dt: number) {
    if (!this.active) return;
    const inp = this.input, cam = this.w.engine.camera;
    if (inp.pressed('pause')) { this.exit(); return; }
    if (inp.pressed('interact') || inp.pressed('reload')) this.nextLook();
    if (inp.pressed('heal')) this.el?.classList.toggle('hide-panel');
    if (inp.pressed('fire') || inp.pressed('jump') && inp.device === 'gamepad') this.capture();
    if (inp.pressed('inspect')) this.toggleBars();
    if (inp.pressed('weaponNext') || inp.pressed('leanR') && inp.device === 'gamepad') this.fov = Math.max(15, this.fov - 5);
    if (inp.pressed('weaponPrev') || inp.pressed('leanL') && inp.device === 'gamepad') this.fov = Math.min(110, this.fov + 5);
    const sens = 0.0021 * (this.fov / 70);
    this.yaw -= inp.lookX * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - inp.lookY * sens, -1.5, 1.5);
    if (inp.device !== 'gamepad') {
      if (inp.held('leanL')) this.roll += dt * 0.6;
      if (inp.held('leanR')) this.roll -= dt * 0.6;
    }
    const speed = (inp.held('sprint') ? 16 : 5) * dt;
    const f = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.pos.addScaledVector(f, inp.moveY * speed).addScaledVector(right, inp.moveX * speed);
    if (inp.held('jump') && inp.device !== 'gamepad') this.pos.y += speed;
    if (inp.held('crouch')) this.pos.y -= speed;
    // tethered to the player (no scouting the map from a paused match) and kept above ground
    const anchor = this.w.player?.soldier.pos;
    if (anchor) { const d = this.pos.distanceTo(anchor); if (d > 45) this.pos.sub(anchor).multiplyScalar(45 / d).add(anchor); }
    const g = Math.max(this.w.terrain.getHeight(this.pos.x, this.pos.z), this.w.waterLevel) + 0.25;
    if (this.pos.y < g) this.pos.y = g;
    cam.position.copy(this.pos);
    cam.quaternion.setFromEuler(this.e.set(this.pitch, this.yaw, this.roll, 'YXZ'));
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov += (this.fov - cam.fov) * Math.min(1, dt * 10); cam.updateProjectionMatrix(); }
    const fs = this.el?.querySelector('.fov'); if (fs) fs.textContent = `FOV ${Math.round(this.fov)}°${Math.abs(this.roll) > 0.01 ? ` · Neigung ${Math.round(THREE.MathUtils.radToDeg(this.roll))}°` : ''}`;
  }
}
