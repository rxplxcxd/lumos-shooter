import type { Input, Action } from '../input/Input';
import { settings } from '../core/Settings';

/** Virtual twin-stick touch layout for phones / tablets / handhelds without a pad. */
export class TouchControls {
  root = document.createElement('div');
  private input: Input;
  private stickId: number | null = null;
  private lookId: number | null = null;
  private stickCenter = { x: 0, y: 0 };
  private lastLook = { x: 0, y: 0 };
  private knob: HTMLElement;

  static wanted() {
    const s = settings.data.touchControls;
    if (s === 'on') return true;
    if (s === 'off') return false;
    return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  }

  constructor(input: Input, parent: HTMLElement) {
    this.input = input;
    this.root.className = 'touch';
    this.root.innerHTML = `<div class="look"></div><div class="stick"><i></i></div><div class="btns"></div>`;
    parent.appendChild(this.root);
    const stick = this.root.querySelector('.stick') as HTMLElement;
    this.knob = stick.querySelector('i') as HTMLElement;
    const look = this.root.querySelector('.look') as HTMLElement;
    const btns = this.root.querySelector('.btns') as HTMLElement;
    const layout: [Action, string, number, number, string?][] = [
      ['fire', 'FEUER', 196, 176, 'fire'], ['ads', 'ZIEL', 112, 206], ['jump', 'SPRUNG', 212, 92], ['crouch', 'DUCK', 132, 122], ['reload', 'R', 46, 176],
      ['interact', 'NUTZEN', 52, 96], ['grenade', 'GRAN', 212, 12], ['weaponNext', 'WAFFE', 132, 40], ['heal', '✚', -34, 206], ['plate', '🛡', -34, 130], ['sprint', 'SPRINT', -34, 54],
    ];
    const pause = document.createElement('div');
    pause.className = 'tb pause-btn'; pause.textContent = '❚❚';
    pause.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.press('pause'); }, { passive: false });
    pause.addEventListener('touchend', (e) => { e.preventDefault(); this.input.release('pause'); }, { passive: false });
    this.root.appendChild(pause);
    document.getElementById('ui')?.classList.add('touch-mode');
    for (const [a, label, x, y, cls] of layout) {
      const b = document.createElement('div');
      b.className = 'tb' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.style.left = `${x}px`; b.style.top = `${y}px`;
      const toggle = a === 'ads' || a === 'crouch' || a === 'sprint';
      b.addEventListener('touchstart', (e) => {
        e.preventDefault(); this.input.setDevice('touch');
        if (toggle) { if (this.input.held(a)) { this.input.release(a); b.classList.remove('on'); } else { this.input.press(a); b.classList.add('on'); } }
        else this.input.press(a);
        if (a === 'fire') this.beginLook(e.changedTouches[0]);
      }, { passive: false });
      b.addEventListener('touchmove', (e) => { if (a === 'fire') this.moveLook(e); }, { passive: false });
      b.addEventListener('touchend', (e) => { e.preventDefault(); if (!toggle) this.input.release(a); if (a === 'fire') this.lookId = null; }, { passive: false });
      btns.appendChild(b);
    }
    stick.addEventListener('touchstart', (e) => {
      e.preventDefault(); this.input.setDevice('touch');
      const t = e.changedTouches[0]; this.stickId = t.identifier;
      const r = stick.getBoundingClientRect(); this.stickCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.moveStick(t.clientX, t.clientY);
    }, { passive: false });
    stick.addEventListener('touchmove', (e) => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === this.stickId) this.moveStick(t.clientX, t.clientY); }, { passive: false });
    stick.addEventListener('touchend', (e) => { e.preventDefault(); this.stickId = null; this.input.touch.moveX = 0; this.input.touch.moveY = 0; this.knob.style.transform = ''; }, { passive: false });
    look.addEventListener('touchstart', (e) => { e.preventDefault(); this.input.setDevice('touch'); this.beginLook(e.changedTouches[0]); }, { passive: false });
    look.addEventListener('touchmove', (e) => this.moveLook(e), { passive: false });
    look.addEventListener('touchend', () => { this.lookId = null; });
    // first touch also unlocks gyro on iOS
    addEventListener('touchstart', () => this.input.requestGyro(), { once: true });
  }

  private beginLook(t: Touch) { this.lookId = t.identifier; this.lastLook = { x: t.clientX, y: t.clientY }; }
  private moveLook(e: TouchEvent) {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === this.lookId) {
      const k = 2.2 * settings.data.mouseSens;
      this.input.touch.lookX += (t.clientX - this.lastLook.x) * k;
      this.input.touch.lookY += (t.clientY - this.lastLook.y) * k;
      this.lastLook = { x: t.clientX, y: t.clientY };
    }
  }
  private moveStick(x: number, y: number) {
    const dx = x - this.stickCenter.x, dy = y - this.stickCenter.y;
    const max = 60, l = Math.min(Math.hypot(dx, dy), max);
    const a = Math.atan2(dy, dx);
    const nx = Math.cos(a) * l, ny = Math.sin(a) * l;
    this.knob.style.transform = `translate(${nx}px, ${ny}px)`;
    this.input.touch.moveX = nx / max;
    this.input.touch.moveY = -ny / max;
  }
  setVisible(v: boolean) { this.root.classList.toggle('hidden', !v); }
  dispose() { this.root.remove(); document.getElementById('ui')?.classList.remove('touch-mode'); }
}
