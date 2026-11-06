import { settings } from '../core/Settings';
import { bus } from '../core/Events';

/**
 * Unified input layer: keyboard + mouse (pointer lock), Gamepad API (Xbox / PlayStation /
 * Lumos handheld / Steam Deck – standard mapping), touch (virtual sticks), gyro aiming
 * (DeviceOrientation / DeviceMotion) and haptics (Gamepad vibrationActuator / navigator.vibrate).
 * Gameplay code only reads the abstract action state below.
 */
export type Action =
  | 'fire' | 'ads' | 'jump' | 'crouch' | 'sprint' | 'reload' | 'interact' | 'weaponNext' | 'weaponPrev'
  | 'grenade' | 'heal' | 'plate' | 'map' | 'pause' | 'leanL' | 'leanR' | 'inspect' | 'melee' | 'camera'
  | 'nvg' | 'scoreboard' | 'ping' | 'slot1' | 'slot2' | 'slot3' | 'ascend' | 'descend' | 'killstreak' | 'emote';

export type Device = 'keyboard' | 'gamepad' | 'touch';

const KEYMAP: Record<string, Action> = {
  Space: 'jump', KeyC: 'crouch', ControlLeft: 'crouch', ShiftLeft: 'sprint', KeyR: 'reload', KeyF: 'interact', KeyE: 'leanR', KeyQ: 'leanL',
  KeyG: 'grenade', KeyH: 'heal', KeyX: 'plate', KeyM: 'map', Escape: 'pause', KeyP: 'pause', KeyI: 'inspect', KeyV: 'melee', KeyT: 'camera',
  KeyN: 'nvg', Tab: 'scoreboard', KeyZ: 'ping', Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', KeyB: 'killstreak', KeyJ: 'emote',
};
// Vehicle-specific keys are read through axis helpers (ascend/descend share Space/Ctrl).

// Standard gamepad mapping indices
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 };
const PADMAP: [number, Action][] = [
  [PAD.A, 'jump'], [PAD.B, 'crouch'], [PAD.X, 'reload'], [PAD.X, 'interact'], [PAD.Y, 'weaponNext'], [PAD.LB, 'grenade'], [PAD.RB, 'melee'],
  [PAD.LT, 'ads'], [PAD.RT, 'fire'], [PAD.LS, 'sprint'], [PAD.RS, 'camera'], [PAD.START, 'pause'], [PAD.BACK, 'map'],
  [PAD.UP, 'nvg'], [PAD.DOWN, 'plate'], [PAD.LEFT, 'heal'], [PAD.RIGHT, 'killstreak'],
];

export class Input {
  readonly down = new Set<Action>();
  private pressedQ = new Set<Action>();
  private releasedQ = new Set<Action>();
  moveX = 0; moveY = 0; // -1..1 (x right, y forward)
  lookX = 0; lookY = 0; // accumulated per-frame look delta in "mouse pixels"
  throttle = 0; // vehicle helpers (analog triggers)
  brake = 0;
  device: Device = 'keyboard';
  padType: 'xbox' | 'playstation' | 'lumos' | 'generic' = 'generic';
  pointerLocked = false;
  enabled = true;
  private keys = new Set<string>();
  private padPrev: boolean[] = [];
  private gyro = { x: 0, y: 0, active: false, lastAlpha: 0, lastBeta: 0, lastGamma: 0, hasLast: false };
  touch = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
  readonly canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Tab') e.preventDefault();
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      this.setDevice('keyboard');
      const a = KEYMAP[e.code];
      if (a) this.press(a);
      if (e.code === 'Space') this.press('ascend');
      if (e.code === 'ControlLeft' || e.code === 'KeyC') this.press('descend');
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const a = KEYMAP[e.code];
      if (a) this.release(a);
      if (e.code === 'Space') this.release('ascend');
      if (e.code === 'ControlLeft' || e.code === 'KeyC') this.release('descend');
    });
    addEventListener('blur', () => { this.keys.clear(); [...this.down].forEach((a) => this.release(a)); });
    canvas.addEventListener('mousedown', (e) => {
      this.setDevice('keyboard');
      if (!this.pointerLocked && this.enabled && !('ontouchstart' in window && this.device === 'touch')) this.lock();
      if (e.button === 0) this.press('fire');
      if (e.button === 2) this.press('ads');
      if (e.button === 1) this.press('ping');
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.release('fire');
      if (e.button === 2) this.release('ads');
      if (e.button === 1) this.release('ping');
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.pointerLocked || !this.enabled) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    addEventListener('wheel', (e) => { if (this.pointerLocked) this.tap(e.deltaY > 0 ? 'weaponNext' : 'weaponPrev'); });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      bus.emit('input:lock', this.pointerLocked);
    });
    addEventListener('gamepadconnected', (e) => {
      const id = (e as GamepadEvent).gamepad.id.toLowerCase();
      this.padType = /lumos/.test(id) ? 'lumos' : /054c|playstation|dualsense|dualshock|wireless controller/.test(id) ? 'playstation' : /xbox|xinput|045e/.test(id) ? 'xbox' : 'generic';
      this.setDevice('gamepad');
      bus.emit('input:gamepad', this.padType);
    });
    this.initGyro();
  }

  lock() { try { (this.canvas as any).requestPointerLock?.({ unadjustedMovement: true })?.catch?.(() => (this.canvas as any).requestPointerLock()); } catch { /* ignore */ } }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  setDevice(d: Device) {
    if (this.device !== d) { this.device = d; bus.emit('input:device', d); }
  }

  press(a: Action) { if (!this.down.has(a)) { this.down.add(a); this.pressedQ.add(a); } }
  release(a: Action) { if (this.down.has(a)) { this.down.delete(a); this.releasedQ.add(a); } }
  tap(a: Action) { this.pressedQ.add(a); }
  pressed(a: Action) { return this.pressedQ.has(a); }
  released(a: Action) { return this.releasedQ.has(a); }
  held(a: Action) { return this.down.has(a); }
  key(code: string) { return this.keys.has(code); }

  /** Call once per frame after gameplay consumed the queued edges. */
  endFrame() { this.pressedQ.clear(); this.releasedQ.clear(); this.lookX = 0; this.lookY = 0; }

  /** Poll gamepads + compose analog axes. Call at the start of each frame. */
  poll(dt: number) {
    let mx = 0, my = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    this.throttle = this.keys.has('KeyW') ? 1 : 0;
    this.brake = this.keys.has('KeyS') ? 1 : 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    if (pad) {
      const dz = (v: number, d = 0.15) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
      const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0);
      const rx = dz(pad.axes[2] ?? 0, 0.1), ry = dz(pad.axes[3] ?? 0, 0.1);
      if (lx || ly || rx || ry || pad.buttons.some((b) => b.pressed)) this.setDevice('gamepad');
      mx += lx; my -= ly;
      // response curve: precise near centre, fast at the edge
      const curve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.8);
      const sens = 900 * settings.data.padSens * dt;
      this.lookX += curve(rx) * sens;
      this.lookY += curve(ry) * sens * 0.75;
      this.throttle = Math.max(this.throttle, pad.buttons[PAD.RT]?.value ?? 0);
      this.brake = Math.max(this.brake, pad.buttons[PAD.LT]?.value ?? 0);
      const now: boolean[] = pad.buttons.map((b) => b.pressed || b.value > 0.4);
      for (const [idx, action] of PADMAP) {
        if (now[idx] && !this.padPrev[idx]) this.press(action);
        if (!now[idx] && this.padPrev[idx]) this.release(action);
      }
      if (now[PAD.A] && !this.padPrev[PAD.A]) this.press('ascend');
      if (!now[PAD.A] && this.padPrev[PAD.A]) this.release('ascend');
      if (now[PAD.B] && !this.padPrev[PAD.B]) this.press('descend');
      if (!now[PAD.B] && this.padPrev[PAD.B]) this.release('descend');
      this.padPrev = now;
    }
    mx += this.touch.moveX; my += this.touch.moveY;
    this.lookX += this.touch.lookX; this.lookY += this.touch.lookY;
    this.touch.lookX = 0; this.touch.lookY = 0;
    // gyro aiming (only applied while ADS by default – like Switch / Steam Deck games)
    if (settings.data.gyroAim && this.gyro.active) {
      const g = settings.data.gyroSens * 18;
      if (this.held('ads') || this.device === 'touch') { this.lookX += this.gyro.x * g; this.lookY += this.gyro.y * g; }
    }
    this.gyro.x = 0; this.gyro.y = 0;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.moveX = mx; this.moveY = my;
    if (!this.enabled) { this.moveX = this.moveY = 0; this.lookX = this.lookY = 0; }
  }

  private initGyro() {
    const onMotion = (e: DeviceMotionEvent) => {
      const r = e.rotationRate;
      if (!r || r.alpha == null) return;
      this.gyro.active = true;
      const portrait = matchMedia('(orientation: portrait)').matches;
      // deg/s -> per-event delta (event ~60Hz)
      const yaw = (portrait ? r.alpha : r.beta!) ?? 0;
      const pitch = (portrait ? r.beta : r.alpha!) ?? 0;
      this.gyro.x += -yaw / 60;
      this.gyro.y += -pitch / 60;
    };
    addEventListener('devicemotion', onMotion);
  }

  /** iOS needs a user gesture to grant motion sensors. */
  async requestGyro() {
    const DME = (window as any).DeviceMotionEvent;
    if (DME?.requestPermission) { try { await DME.requestPermission(); } catch { /* denied */ } }
  }

  /** Haptic feedback – dual rumble on gamepads (Lumos/Xbox/DualSense) and vibration on phones. */
  rumble(strong: number, weak: number, ms: number) {
    if (!settings.data.haptics) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      const act = (p as any)?.vibrationActuator;
      if (act?.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
    }
    if (this.device === 'touch' && navigator.vibrate) navigator.vibrate(Math.min(ms, 60));
  }

  /** Returns the glyph label for an action on the current device. */
  glyph(a: Action): string {
    const set = settings.data.glyphs === 'auto' ? (this.device === 'gamepad' ? this.padType : this.device === 'touch' ? 'touch' : 'keyboard') : settings.data.glyphs;
    const xbox: Partial<Record<Action, string>> = { jump: 'A', crouch: 'B', reload: 'X', interact: 'X', weaponNext: 'Y', grenade: 'LB', melee: 'RB', ads: 'LT', fire: 'RT', sprint: 'L3', camera: 'R3', pause: '☰', map: '⧉', nvg: '↑', plate: '↓', heal: '←', killstreak: '→' };
    const ps: Partial<Record<Action, string>> = { jump: '✕', crouch: '◯', reload: '▢', interact: '▢', weaponNext: '△', grenade: 'L1', melee: 'R1', ads: 'L2', fire: 'R2', sprint: 'L3', camera: 'R3', pause: 'OPT', map: 'PAD', nvg: '↑', plate: '↓', heal: '←', killstreak: '→' };
    const lumos: Partial<Record<Action, string>> = { ...xbox, pause: 'MENU', map: 'VIEW', jump: 'Ⓐ', crouch: 'Ⓑ', reload: 'Ⓧ', interact: 'Ⓧ', weaponNext: 'Ⓨ' };
    const kb: Partial<Record<Action, string>> = { jump: 'SPACE', crouch: 'C', reload: 'R', interact: 'F', weaponNext: 'WHEEL', grenade: 'G', melee: 'V', ads: 'RMB', fire: 'LMB', sprint: 'SHIFT', camera: 'T', pause: 'ESC', map: 'M', nvg: 'N', plate: 'X', heal: 'H', killstreak: 'B', leanL: 'Q', leanR: 'E', inspect: 'I', slot1: '1', slot2: '2', slot3: '3', emote: 'J', scoreboard: 'TAB' };
    const touch: Partial<Record<Action, string>> = { interact: 'TAP', reload: '⟳' };
    const map = set === 'xbox' || set === 'generic' ? xbox : set === 'playstation' ? ps : set === 'lumos' ? lumos : set === 'touch' ? { ...kb, ...touch } : kb;
    return map[a] ?? a.toUpperCase();
  }
}
