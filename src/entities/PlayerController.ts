import * as THREE from 'three';
import { Soldier, type Intent } from './Soldier';
import type { GameWorld, Interactable } from '../gameplay/GameWorld';
import { settings } from '../core/Settings';
import type { Vehicle, VehicleControls } from '../vehicles/Vehicle';
import { Grenade } from '../weapons/Grenade';
import type { Actor } from '../gameplay/types';
import type { Weapon } from '../weapons/Weapon';
import { calibrateSights, type SightCalib } from '../weapons/SightCalib';

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

/**
 * Local player: input -> Soldier, FPS/TPS cameras, view-model with procedural sway/bob/recoil/
 * reload/inspect, ADS + scopes, leaning, grenades with arc preview, vehicles, freefall/parachute,
 * aim assist (gamepad), haptics, interaction prompts.
 */
export class PlayerController {
  w: GameWorld;
  soldier: Soldier;
  yaw = 0;
  pitch = 0;
  thirdPerson = settings.data.thirdPerson;
  recoilP = 0; recoilY = 0;
  private shakeAmt = 0;
  private bobT = 0;
  private vm = new THREE.Group(); // view-model root
  private vmGun: THREE.Object3D | null = null;
  private vmKey = '';
  private vmKick = 0;
  private vmItem: THREE.Object3D | null = null;
  private inspectT = 0;
  private swayX = 0; private swayY = 0;
  private arc: THREE.Line;
  private grenadeHeld = false;
  private grenadeCook = 0;
  private grenadeMesh: THREE.Object3D | null = null;
  focus: Interactable | null = null;
  focusVehicle: Vehicle | null = null;
  vehCamYaw = 0; vehCamPitch = -0.15;
  nvg = false;
  spectateTarget: Actor | null = null;
  private burstQueue = 0;
  private burstT = 0;
  private holdT = 0;
  inPlane = false;
  private flashlight: THREE.SpotLight;
  private flashT = 0; private flashNear = 1; private flashK = 1;
  private parachuteMesh: THREE.Object3D | null = null;
  lockedControls = false;

  constructor(w: GameWorld, soldier: Soldier) {
    this.w = w;
    this.soldier = soldier;
    soldier.isPlayer = true;
    const ov = w.engine.overlay;
    ov.clear();
    ov.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(1, 2, 1); ov.add(dl);
    ov.add(this.vm);
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.arc = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xffe08a, dashSize: 0.3, gapSize: 0.18, transparent: true, opacity: 0.9 }));
    this.arc.frustumCulled = false; this.arc.visible = false;
    w.scene.add(this.arc);
    this.flashlight = new THREE.SpotLight(0xfff2d0, 0, 40, 0.42, 0.72, 2);
    w.scene.add(this.flashlight, this.flashlight.target);
    w.assets.instance('w_grenade').then((m) => { this.grenadeMesh = m; });
    w.assets.instance('item_parachute').then((m) => { this.parachuteMesh = m; m.visible = false; w.scene.add(m); });
  }

  forward(out = new THREE.Vector3()) {
    return out.set(0, 0, -1).applyEuler(new THREE.Euler(this.pitch + this.recoilP, this.yaw + this.recoilY, 0, 'YXZ'));
  }

  shake(a: number) { this.shakeAmt = Math.min(2, this.shakeAmt + a); }

  get adsFovTarget() {
    const s = this.soldier.weapon.stats;
    return THREE.MathUtils.lerp(settings.data.fov, s.adsFov * (settings.data.fov / 80), this.soldier.ads);
  }

  update(dt: number) {
    const s = this.soldier, inp = this.w.input, w = this.w;
    // ------------------------------------------------------------- look
    const adsMul = s.ads > 0.5 ? settings.data.adsSensMul * (s.weapon.stats.adsFov / 55) : 1;
    let sens = 0.0022 * (inp.device === 'gamepad' ? settings.data.padSens : settings.data.mouseSens) * adsMul;
    if (inp.device === 'gamepad' && settings.data.aimAssist && this.aimAssistTarget()) sens *= 0.55;
    const lx = inp.lookX * sens, ly = inp.lookY * sens * (settings.data.invertY ? -1 : 1);
    if (s.inVehicle) {
      this.vehCamYaw -= lx; this.vehCamPitch = THREE.MathUtils.clamp(this.vehCamPitch - ly, -1.2, 0.6);
      this.yaw = this.vehCamYaw; this.pitch = this.vehCamPitch;
    } else if (s.alive) {
      this.yaw -= lx;
      this.pitch = THREE.MathUtils.clamp(this.pitch - ly, -1.45, 1.45);
    }
    // recoil recovery
    this.recoilP *= Math.max(0, 1 - dt * 7); this.recoilY *= Math.max(0, 1 - dt * 7);

    if (!s.alive) { this.updateDeathCam(dt); return; }
    if (this.inPlane || this.lockedControls) { this.updateCamera(dt); return; }

    // ------------------------------------------------------------- vehicles
    if (s.inVehicle) { this.vehicleInput(dt, s.inVehicle); this.updateCamera(dt); this.updateViewModel(dt); return; }

    // ------------------------------------------------------------- movement intent
    const fwd = tmp.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = tmp2.set(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3().addScaledVector(fwd, inp.moveY).addScaledVector(right, inp.moveX);
    if (move.lengthSq() > 1) move.normalize();
    const intent: Intent = {
      move, sprint: inp.held('sprint') || (inp.device === 'touch' && inp.moveY > 0.92), crouch: inp.held('crouch'), jump: inp.pressed('jump'),
      yaw: this.yaw + Math.PI, pitch: this.pitch,
    };
    if (inp.device === 'gamepad' && inp.pressed('sprint')) this.toggleSprint = !this.toggleSprint;
    if (inp.device === 'gamepad') intent.sprint = this.toggleSprint && inp.moveY > 0.3;
    if (inp.moveY < 0.2) this.toggleSprint = false;
    // freefall / parachute (Warzone style: deploy and cut the canopy as often as you like)
    if (s.freefall) {
      intent.crouch = false; intent.jump = false; intent.sprint = false;
      const agl = s.pos.y - Math.max(w.terrain.getHeight(s.pos.x, s.pos.z), w.waterLevel);
      this.freefallT += dt;
      this.chuteCd -= dt;
      if (inp.pressed('jump') && this.freefallT > 0.35 && this.chuteCd <= 0 && (agl > 18 || !s.parachute)) {
        s.parachute = !s.parachute;
        this.chuteCd = 0.4;
        w.audio.play(s.parachute ? 'wind_loop' : 'rocket_whoosh', { volume: s.parachute ? 0.35 : 0.25, rate: s.parachute ? 1 : 1.6 });
        w.bus.emit(s.parachute ? 'parachute' : 'chuteCut', s);
        w.input.rumble(0.3, 0.6, 140);
      }
      if (!s.parachute && agl < 55 && s.vel.y < -12) { s.parachute = true; this.chuteCd = 0.6; w.bus.emit('parachute', s); w.bus.emit('toast', 'Fallschirm automatisch geöffnet'); }
      // wind roar follows the airspeed
      if (!this.windLoop) this.windLoop = w.audio.loop('wind_loop', 0);
      this.windLoop?.set(Math.min(0.9, s.glideSpeed / 70) * (s.parachute ? 0.4 : 1), 0.7 + s.glideSpeed / 90);
    } else if (this.windLoop) { this.windLoop.stop(); this.windLoop = null; }
    if (!s.freefall) this.freefallT = 0;
    s.move(dt, intent);
    // third-person: the character looks where the camera aims
    s.lookTarget = this.thirdPerson ? s.eyePos(new THREE.Vector3()).addScaledVector(this.forward(), 30) : null;
    // camera landing dip
    if (s.grounded && !this.wasGrounded && s.airTime === 0) this.camDipV -= 2.2;
    this.wasGrounded = s.grounded;
    this.camDipV += (-90 * this.camDip - 12 * this.camDipV) * dt; this.camDip += this.camDipV * dt;
    // leaning
    const leanT = s.grounded && !s.sprinting ? (inp.held('leanR') ? 1 : 0) - (inp.held('leanL') ? 1 : 0) : 0;
    s.leaning = THREE.MathUtils.lerp(s.leaning, leanT, Math.min(1, dt * 10));

    // ------------------------------------------------------------- interaction
    this.updateInteraction(dt);

    // ------------------------------------------------------------- weapons
    if (inp.pressed('slot1')) s.switchWeapon(0);
    if (inp.pressed('slot2')) s.switchWeapon(1);
    if (inp.pressed('slot3') || inp.pressed('melee')) { if (inp.pressed('melee')) this.melee(); else s.switchWeapon(2); }
    if (inp.pressed('weaponNext') || inp.pressed('weaponPrev')) {
      const order = [0, 1, 2].filter((i) => i === 2 || s.weapons[i]);
      const idx = order.indexOf(s.current);
      s.switchWeapon(order[(idx + (inp.pressed('weaponPrev') ? order.length - 1 : 1)) % order.length]);
    }
    const busy = s.busyT > 0 || s.climbing > 0 || s.swimming || s.freefall;
    const canAds = !busy && !s.sprinting && s.weapon.def.cls !== 'melee' && !s.downed;
    s.adsHeld = inp.held('ads') && canAds;
    const adsSpeed = 1 / Math.max(0.08, s.weapon.stats.adsTime);
    s.ads = THREE.MathUtils.clamp(s.ads + (s.adsHeld ? 1 : -1) * dt * adsSpeed, 0, 1);
    if (inp.pressed('reload') && !(this.focus && inp.device === 'gamepad')) s.startReload();
    if (inp.pressed('inspect')) this.inspectT = 2.2;
    if (inp.pressed('heal')) s.tryHeal();
    if (inp.pressed('plate')) s.tryPlate();
    if (inp.pressed('nvg')) { this.nvg = !this.nvg; w.audio.ui(this.nvg ? 'popup_open' : 'popup_close'); }
    if (inp.pressed('ping') && s.alive) this.ping();
    if (inp.pressed('camera')) { this.thirdPerson = !this.thirdPerson; settings.set('thirdPerson', this.thirdPerson); }
    if (inp.pressed('emote')) s.model.setLoco('dance', 0.3);
    s.updateWeapon(dt);
    if (!busy) this.handleFire(dt);
    this.handleGrenade(dt);
    // auto reload when empty
    if (s.weapon.ammo === 0 && s.weapon.reloading <= 0 && s.weapon.def.cls !== 'melee' && !inp.held('fire')) s.startReload();
    // thermal optic / NVG post FX
    const thermal = s.weapon.stats.thermal && s.ads > 0.85;
    w.engine.setPost(s.underwater ? 'underwater' : thermal ? 'thermal' : this.nvg ? 'nvg' : 'none');
    w.setThermal(thermal, dt);
    // weapon light at night
    const light = s.weapon.attachments.includes('flashlight') || w.sky.isNight;
    // a real torch: inverse-square falloff, eased off on surfaces right in front of the lens
    if (light && !this.thirdPerson) {
      this.flashT -= dt;
      if (this.flashT <= 0) {
        this.flashT = 0.1;
        const hit = w.physics.raycast(w.engine.camera.position, this.forward(), 6, s.collider);
        this.flashNear = hit ? THREE.MathUtils.clamp(hit.dist / 2.5, 0.12, 1) : 1;
      }
      this.flashK += (this.flashNear - this.flashK) * Math.min(1, dt * 8);
      this.flashlight.intensity = 26 * this.flashK * this.flashK;
    } else this.flashlight.intensity = 0;
    this.updateCamera(dt);
    this.updateViewModel(dt);
    // parachute visual
    if (this.parachuteMesh) {
      this.chuteOpen = THREE.MathUtils.lerp(this.chuteOpen, s.parachute && s.freefall ? 1 : 0, Math.min(1, dt * (s.parachute ? 5 : 9)));
      this.parachuteMesh.visible = this.chuteOpen > 0.03;
      if (this.parachuteMesh.visible) {
        this.parachuteMesh.position.copy(s.pos).add(new THREE.Vector3(0, 2.6 * this.chuteOpen, 0));
        this.parachuteMesh.rotation.set(-s.vel.dot(new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw))) * 0.01, s.yaw, 0);
        this.parachuteMesh.scale.set(0.75 * this.chuteOpen, 0.75 * Math.max(0.2, this.chuteOpen), 0.75 * this.chuteOpen);
      }
    }
  }
  private toggleSprint = false;
  private freefallT = 0;
  private chuteOpen = 0;
  private chuteCd = 0;
  private windLoop: ReturnType<GameWorld['audio']['loop']> = null;
  private wasGrounded = true;
  private camDip = 0; private camDipV = 0;

  // ----------------------------------------------------------------- firing
  private handleFire(dt: number) {
    const s = this.soldier, inp = this.w.input;
    const wp = s.weapon;
    if (wp.def.cls === 'melee') { if (inp.pressed('fire')) this.melee(); return; }
    if (s.downed && wp.def.cls !== 'pistol') return;
    if (s.sprinting && inp.held('fire')) { s.sprinting = false; }
    const trigger = wp.stats.auto ? inp.held('fire') : inp.pressed('fire');
    if (this.burstQueue > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0 && wp.canFire()) { this.fireOnce(); this.burstQueue--; this.burstT = wp.interval; }
      return;
    }
    if (trigger && wp.canFire()) {
      if (wp.def.burst) { this.burstQueue = wp.def.burst - 1; this.burstT = wp.interval; }
      this.fireOnce();
    } else if (inp.pressed('fire') && wp.ammo <= 0 && wp.reloading <= 0) {
      this.w.audio.play('ui_cursor', { volume: 0.4 });
      s.startReload();
    }
  }

  private fireOnce() {
    const s = this.soldier, w = this.w, wp = s.weapon, st = wp.stats;
    wp.cooldown = wp.interval * (s.perks.has('doubletap') ? 0.75 : 1);
    if (!w.mode?.infiniteAmmo || true) wp.ammo--;
    s.lastShotTime = w.time;
    if (st.silenced) s.silencedUntil = w.time + 0.1; else s.silencedUntil = 0;
    const cam = w.engine.camera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const moving = Math.min(1, Math.hypot(s.vel.x, s.vel.z) / 4);
    const spreadDeg = wp.spread(s.ads, moving, !s.grounded && !s.swimming, s.crouching);
    const pellets = st.pellets ?? 1;
    const aimDir = this.forward();
    // aim assist "bullet magnetism" for controller hip/ADS fire (small)
    const assist = w.input.device !== 'keyboard' && settings.data.aimAssist ? this.aimAssistTarget() : null;
    if (assist && s.ads > 0.5) {
      const to = assist.eyePos(new THREE.Vector3()).add(new THREE.Vector3(0, -0.35, 0)).sub(origin).normalize();
      aimDir.lerp(to, 0.35).normalize();
    }
    const muzzleWorld = this.muzzleWorld();
    for (let i = 0; i < pellets; i++) {
      const d = aimDir.clone();
      const ang = THREE.MathUtils.degToRad(spreadDeg) * Math.sqrt(Math.random());
      const rot = Math.random() * Math.PI * 2;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      d.addScaledVector(rt, Math.cos(rot) * Math.tan(ang)).addScaledVector(up, Math.sin(rot) * Math.tan(ang)).normalize();
      w.ballistics.fire(s, origin, d, st, { tracer: i === 0, pellet: pellets > 1 });
      if (i === 0) w.effects.tracer(muzzleWorld, origin.clone().addScaledVector(d, 40), 0xfff0b0);
    }
    w.effects.muzzle(muzzleWorld, aimDir, st.cls === 'shotgun' || st.cls === 'launcher', st.silenced);
    const snd = st.silenced ? 'suppressed' : st.sound;
    w.audio.play(snd, { volume: st.silenced ? 0.5 : 0.85 });
    if (st.cls === 'shotgun' || st.cls === 'sniper') setTimeout(() => w.audio.play(st.cls === 'shotgun' ? 'shotgun_pump' : 'sniper_bolt', { volume: 0.5 }), 350);
    // recoil
    const crouchK = s.crouching ? 0.75 : 1;
    const adsK = 1 - s.ads * 0.35;
    this.recoilP += THREE.MathUtils.degToRad(st.recoilV) * crouchK * adsK * 0.45;
    this.pitch += THREE.MathUtils.degToRad(st.recoilV) * crouchK * adsK * 0.55;
    this.recoilY += THREE.MathUtils.degToRad((Math.random() - 0.5) * 2 * st.recoilH) * crouchK;
    wp.bloom = Math.min(wp.bloom + (st.cls === 'smg' ? 0.25 : 0.4) * (1 - s.ads * 0.7), 6);
    this.vmKick = Math.min(1, this.vmKick + (st.cls === 'shotgun' || st.cls === 'sniper' || st.cls === 'launcher' ? 1 : 0.45));
    const heavy = st.cls === 'shotgun' || st.cls === 'sniper' || st.cls === 'launcher';
    this.vmImpulse(new THREE.Vector3((Math.random() - 0.5) * 0.2, 0.15, heavy ? 1.6 : 0.7), new THREE.Vector3(heavy ? 3 : 1.4, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * (heavy ? 2 : 1)));
    if (st.cls !== 'launcher' && st.cls !== 'shotgun') {
      const cam = w.engine.camera;
      const rightV = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), upV = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      w.effects.casing(muzzleWorld.clone().addScaledVector(this.forward(), -0.25).addScaledVector(rightV, 0.05), rightV.multiplyScalar(2.5 + Math.random()).addScaledVector(upV, 1.8).add(s.vel));
    }
    if (st.cls !== 'pistol') this.shake(st.cls === 'launcher' || st.cls === 'shotgun' ? 0.25 : 0.05);
    w.input.rumble(st.cls === 'shotgun' || st.cls === 'sniper' ? 0.8 : 0.25, 0.4, st.cls === 'smg' ? 40 : 80);
    s.model.setUpper('shoot', 0.02, 0.15);
    s.model.recoilKick(st.cls === 'shotgun' || st.cls === 'sniper' || st.cls === 'launcher' ? 1.8 : 0.6);
    w.bus.emit('playerFired', s);
  }

  private melee() {
    const s = this.soldier, w = this.w;
    if (s.knife.cooldown > 0) return;
    s.knife.cooldown = 0.6;
    s.model.setUpper('melee', 0.05, 0.45);
    this.vmKick = 1;
    w.audio.play('knife', { volume: 0.7 });
    const eye = s.eyePos(new THREE.Vector3());
    const dir = this.forward();
    let best: Actor | null = null, bd = 2.6;
    for (const a of w.actorsNear(eye, 3)) {
      if (a === s) continue;
      const h = a.hitTest(eye, dir, 2.6);
      if (h && h.dist < bd) { bd = h.dist; best = a; }
      else if (!h && a.pos.distanceTo(s.pos) < 1.6) { best = best ?? a; }
    }
    if (best && (best.team !== s.team || best.kind === 'zombie')) {
      const behind = new THREE.Vector3(Math.sin(best.yaw), 0, Math.cos(best.yaw)).dot(dir.clone().setY(0).normalize()) > 0.5;
      const dmg = (behind ? 200 : s.knife.stats.damage) * (s.perks.has('muscle') ? 2 : 1);
      const dealt = best.damage(dmg, { attacker: s, weapon: 'knife', melee: true, dir, zone: 'body' });
      w.onPlayerHit(best, dealt, 'body', !best.alive);
      w.effects.impact(best.pos.clone().setY(best.pos.y + 1.2), dir.clone().negate(), 'flesh');
    }
  }

  private handleGrenade(dt: number) {
    const s = this.soldier, inp = this.w.input, w = this.w;
    if (inp.pressed('grenade') && s.grenades > 0 && s.busyT <= 0 && !s.downed) { this.grenadeHeld = true; this.grenadeCook = 0; w.audio.play('grenade_pin', { volume: 0.6 }); }
    if (this.grenadeHeld) {
      this.grenadeCook += dt;
      const { pos, vel } = this.throwParams();
      const pts = Grenade.predict(w, pos, vel);
      this.arc.geometry.setFromPoints(pts);
      this.arc.computeLineDistances();
      this.arc.visible = true;
      if (inp.released('grenade') || this.grenadeCook > 3) {
        this.grenadeHeld = false; this.arc.visible = false;
        s.grenades--;
        s.beginBusy('throw', 0.5);
        const mesh = this.grenadeMesh ? this.grenadeMesh.clone() : new THREE.Mesh(new THREE.SphereGeometry(0.06), new THREE.MeshStandardMaterial({ color: 0x334422 }));
        const g = new Grenade(w, mesh, pos, vel, s, 'frag', Math.max(0.2, 3 - this.grenadeCook));
        w.updaters.push((d) => g.update(d));
        w.bus.emit('grenadeThrown', s);
      }
    }
  }

  private throwParams() {
    const s = this.soldier;
    const pos = s.eyePos(new THREE.Vector3()).add(new THREE.Vector3(Math.cos(this.yaw) * 0.25, -0.1, -Math.sin(this.yaw) * 0.25));
    const dir = this.forward();
    dir.y += 0.15;
    const vel = dir.normalize().multiplyScalar(19).add(s.vel.clone().multiplyScalar(0.5));
    return { pos, vel };
  }

  // ----------------------------------------------------------------- interaction & vehicles
  private updateInteraction(dt: number) {
    const s = this.soldier, w = this.w, inp = w.input;
    const eye = s.eyePos(new THREE.Vector3());
    const fwd = this.forward();
    this.focus = w.nearestInteractable(eye, fwd);
    this.focusVehicle = null;
    // nearest enterable vehicle; it wins over loot unless the loot is clearly closer
    let bd = 4.5;
    for (const v of w.vehicles) {
      if (v.destroyed) continue;
      const d = v.model.position.distanceTo(s.pos) - Math.max(v.size.x, v.size.z) * 0.35;
      if (d < bd && v.occupants.some((o) => !o)) { bd = d; this.focusVehicle = v; }
    }
    if (this.focusVehicle && this.focus) {
      const fd = this.focus.pos.distanceTo(s.pos);
      if (fd < bd - 0.5 || this.focus.hold) this.focusVehicle = null; else this.focus = null;
    }
    if (this.focus?.hold) {
      if (inp.held('interact')) { this.holdT += dt; if (this.holdT >= this.focus.hold) { this.focus.use(s); this.holdT = 0; } }
      else this.holdT = 0;
    } else if (inp.pressed('interact')) {
      if (this.focus) this.focus.use(s);
      else if (this.focusVehicle) {
        const v = this.focusVehicle;
        const seat = v.driver ? -1 : 0;
        if (v.enter(s, seat)) { this.vehCamYaw = this.yaw; this.vehCamPitch = -0.2; }
      }
    }
  }
  get holdProgress() { return this.focus?.hold ? this.holdT / this.focus.hold : 0; }

  private vehicleInput(dt: number, v: Vehicle) {
    const s = this.soldier, inp = this.w.input;
    if (inp.pressed('interact')) { v.exit(s); this.yaw = this.vehCamYaw; this.pitch = 0; return; }
    if (inp.pressed('weaponNext') && v.def.seats > 1) {
      // seat switch
      const next = v.occupants.findIndex((o, i) => !o && i !== s.seat);
      if (next >= 0) { v.occupants[s.seat] = null; v.occupants[next] = s; s.seat = next; }
    }
    s.move(dt, { move: new THREE.Vector3(), sprint: false, crouch: false, jump: false, yaw: s.yaw, pitch: 0 });
    if (s.seat !== 0) {
      // passengers in open vehicles can shoot
      s.updateWeapon(dt);
      if (v.exposedSeats) this.handleFire(dt);
      return;
    }
    const air = v.isAir;
    const plane = v.kind === 'plane' || v.kind === 'jet';
    const throttle = inp.device === 'gamepad' ? inp.throttle - inp.brake : inp.moveY;
    const c: VehicleControls = {
      throttle: plane ? (inp.device === 'gamepad' ? inp.throttle - inp.brake : (inp.key('KeyW') ? 1 : 0) - (inp.key('KeyS') ? 1 : 0)) : air ? inp.moveY : throttle,
      steer: plane ? (inp.key('KeyA') ? -1 : 0) + (inp.key('KeyD') ? 1 : 0) : inp.moveX,
      up: (inp.held('ascend') ? 1 : 0) - (inp.held('descend') ? 1 : 0) + (air && inp.device === 'gamepad' ? inp.throttle - inp.brake : 0),
      pitch: plane ? (inp.device === 'gamepad' ? -inp.moveY : (inp.key('ArrowDown') ? 1 : 0) - (inp.key('ArrowUp') ? 1 : 0) - inp.lookY * 0.02 * (settings.data.invertY ? -1 : 1)) : 0,
      roll: plane ? (inp.device === 'gamepad' ? inp.moveX : (inp.key('ArrowRight') ? 1 : 0) - (inp.key('ArrowLeft') ? 1 : 0) + inp.lookX * 0.02) : 0,
      aimYaw: this.vehCamYaw + Math.PI, aimPitch: -this.vehCamPitch,
      fire: inp.held('fire'), handbrake: inp.held('jump') && !air, boost: inp.held('sprint'),
    };
    if (air && !plane && inp.device === 'gamepad') c.throttle = -inp.moveY * -1;
    this.w.vehicleControls.set(v, c);
    if (inp.pressed('crouch') && !air && v.kind !== 'sub') this.w.audio.play('horn', { pos: v.model.position, volume: 0.7 });
  }

  // ----------------------------------------------------------------- camera
  private updateCamera(dt: number) {
    const s = this.soldier, w = this.w, cam = w.engine.camera;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.5);
    const sh = this.shakeAmt * this.shakeAmt;
    const shake = new THREE.Vector3((Math.random() - 0.5) * sh * 0.12, (Math.random() - 0.5) * sh * 0.12, 0);
    const v = s.inVehicle;
    if (v) {
      const center = v.model.position.clone().add(new THREE.Vector3(0, v.size.y * 0.8, 0));
      const dist = v.def.camDist ?? 7;
      const dir = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(this.vehCamPitch, this.vehCamYaw, 0, 'YXZ'));
      const desired = center.clone().addScaledVector(dir, dist);
      const hit = w.physics.raycast(center, dir, dist, v.collider);
      cam.position.copy(hit ? center.clone().addScaledVector(dir, Math.max(1, hit.dist - 0.4)) : desired);
      const gh = w.terrain.getHeight(cam.position.x, cam.position.z) + 0.5;
      if (cam.position.y < gh) cam.position.y = gh;
      cam.lookAt(center);
      cam.position.add(shake);
      s.model.setVisible(v.exposedSeats);
      this.vm.visible = false;
      cam.fov = THREE.MathUtils.lerp(cam.fov, settings.data.fov + Math.min(v.speed, 60) * 0.25, dt * 3);
      cam.updateProjectionMatrix();
      return;
    }
    if (this.inPlane) return; // mode drives the camera
    const eye = s.eyePos(new THREE.Vector3());
    const fov = this.adsFovTarget;
    const airK = s.freefall ? Math.min(1, s.glideSpeed / 75) * (s.parachute ? 0.3 : 1) : 0;
    cam.fov = THREE.MathUtils.lerp(cam.fov, (s.sprinting ? fov + 8 : fov) + airK * 18, Math.min(1, dt * 6));
    cam.updateProjectionMatrix();
    const rollLean = -s.leaning * 0.12;
    const slideTilt = s.slideT > 0 ? 0.06 : 0;
    const rot = new THREE.Euler(this.pitch + this.recoilP + shake.y, this.yaw + this.recoilY + shake.x, rollLean + slideTilt, 'YXZ');
    const tps = this.thirdPerson || s.freefall || s.swimming;
    if (tps) {
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(rot);
      const right = new THREE.Vector3(1, 0, 0).applyEuler(rot);
      const back = THREE.MathUtils.lerp(s.freefall ? 6 : 3.2, 1.6, s.ads);
      const pivot = eye.clone().addScaledVector(right, 0.55).add(new THREE.Vector3(0, 0.15, 0));
      const dir = fwd.clone().negate();
      const hit = w.physics.raycast(pivot, dir, back, s.collider);
      cam.position.copy(pivot).addScaledVector(dir, hit ? Math.max(0.3, hit.dist - 0.25) : back);
      cam.quaternion.setFromEuler(rot);
      s.model.setVisible(true);
      this.vm.visible = false;
    } else {
      cam.position.copy(eye);
      cam.position.y += this.camDip * 0.06;
      cam.quaternion.setFromEuler(rot);
      s.model.setVisible(false);
      this.vm.visible = !s.downed && !s.freefall;
    }
    // flashlight follows the view
    this.flashlight.position.copy(cam.position);
    this.flashlight.target.position.copy(cam.position).add(this.forward().multiplyScalar(10));
  }

  private kcFired = 0;
  /** killcam: the killer's weapon as first-person view-model (camera itself is driven by the replay) */
  private killcamView(dt: number) {
    const kc = this.w.killcam, wp = kc.view.weapon;
    this.arc.visible = false;
    if (!wp) { this.vm.visible = false; return; }
    this.vm.visible = true;
    this.ensureViewModel(wp);
    if (!this.vmGun) return;
    const calib = this.vmGun.userData.calib as SightCalib;
    const len = wp.def.length;
    const ads = Math.min(kc.view.ads, calib.kind === 'iron' || calib.kind === 'reflex' ? 1 : 0.82);
    const target = new THREE.Vector3(0.15 + len * 0.05, -0.15 - len * 0.03, -0.3 - len * 0.42).lerp(calib.pos, ads);
    const oc = this.w.engine.overlayCam;
    oc.fov = THREE.MathUtils.lerp(58, 42, ads); oc.updateProjectionMatrix();
    // recoil kick + muzzle flash on every replayed shot of the killer
    if (kc.view.fired > 0.95 && this.kcFired <= 0.95) {
      this.vmImpulse(new THREE.Vector3((Math.random() - 0.5) * 0.04, 0.05, 0.22), new THREE.Vector3(0.9 + wp.stats.recoilV * 0.3, (Math.random() - 0.5) * 0.3, 0));
      const mw = this.muzzleWorld();
      const dir = this.w.engine.camera.getWorldDirection(new THREE.Vector3());
      this.w.replay.orig.muzzle?.(mw, dir, wp.def.cls === 'sniper' || wp.def.cls === 'shotgun', !!wp.stats.silenced);
    }
    this.kcFired = kc.view.fired;
    const k = 260, c = 26;
    this.vmPosV.addScaledVector(this.vmPos, -k * dt).multiplyScalar(Math.max(0, 1 - c * dt));
    this.vmPos.addScaledVector(this.vmPosV, dt);
    this.vmRotV.addScaledVector(this.vmRot, -k * 0.8 * dt).multiplyScalar(Math.max(0, 1 - c * 0.9 * dt));
    this.vmRot.addScaledVector(this.vmRotV, dt);
    const g = this.vmGun;
    g.visible = true;
    g.position.lerp(target, Math.min(1, dt * 14)).add(this.vmPos.clone().multiplyScalar(0.12));
    g.rotation.set(calib.tilt * ads + this.vmRot.x * 0.12, this.vmRot.y * 0.12, this.vmRot.z * 0.12);
    const optic = g.getObjectByName('att_optic'); if (optic) optic.visible = ads < 0.8;
  }

  private updateDeathCam(dt: number) {
    const s = this.soldier, w = this.w, cam = w.engine.camera;
    if (w.killcam?.active) { w.engine.setPost('none'); this.killcamView(dt); return; }
    this.vm.visible = false;
    this.arc.visible = false;
    s.model.setVisible(true);
    w.engine.setPost('none');
    const target = this.spectateTarget && this.spectateTarget.alive ? this.spectateTarget : null;
    if (target) {
      // killcam / spectate: over the killer's shoulder looking at the victim
      const eye = target.eyePos(new THREE.Vector3());
      const look = s.pos.clone().add(new THREE.Vector3(0, 1, 0));
      const dir = look.clone().sub(eye).normalize();
      const pos = eye.clone().addScaledVector(dir, -2.2).add(new THREE.Vector3(0, 0.6, 0));
      cam.position.lerp(pos, Math.min(1, dt * 4));
      cam.lookAt(target === s.killedBy ? look : eye.clone().addScaledVector(new THREE.Vector3(Math.sin(target.yaw), 0, Math.cos(target.yaw)), 10));
    } else {
      const p = s.pos.clone().add(new THREE.Vector3(0, 4, 0));
      cam.position.lerp(p.add(new THREE.Vector3(Math.sin(w.time * 0.3) * 6, 0, Math.cos(w.time * 0.3) * 6)), Math.min(1, dt * 2));
      cam.lookAt(s.pos);
    }
  }

  // ----------------------------------------------------------------- view-model
  private async ensureViewModel(wp: Weapon) {
    const key = wp.def.id + '|' + wp.attachments.join(',') + (wp.packed ? '*' : '');
    if (key === this.vmKey) return;
    this.vmKey = key;
    const obj = await this.w.weaponModel(wp);
    if (this.vmKey !== key) return;
    if (this.vmGun) this.vm.remove(this.vmGun);
    obj.traverse((o) => { o.castShadow = false; });
    if (wp.packed) obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { const mat = (m.material as THREE.MeshStandardMaterial).clone(); mat.emissive = new THREE.Color(0x8a2be2); mat.emissiveIntensity = 0.6; m.material = mat; } });
    // view-models face -Z (camera forward)
    const holder = new THREE.Group();
    obj.rotation.y = Math.PI;
    holder.add(obj);
    holder.userData.muzzle = (obj.userData.muzzle as THREE.Vector3)?.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI) ?? new THREE.Vector3(0, 0, -0.5);
    holder.userData.sightY = (obj.userData.box as THREE.Box3)?.max.y ?? 0.08;
    const opticId = wp.attachments.find((a) => a === 'reddot' || a === 'acog' || a === 'thermal' || a === 'sniperscope') ?? null;
    holder.userData.calib = calibrateSights(holder, wp.def, opticId);
    this.vmGun = holder;
    this.vm.add(holder);
  }

  muzzleWorld(): THREE.Vector3 {
    const cam = this.w.engine.camera;
    if (this.thirdPerson || !this.vmGun) {
      const h = this.soldier.model.handR;
      if (h) return h.getWorldPosition(new THREE.Vector3()).add(this.forward().multiplyScalar(this.soldier.weapon.def.length * 0.8));
      return this.soldier.eyePos(new THREE.Vector3());
    }
    // map overlay-space muzzle into world space using the main camera
    const local = (this.vmGun.userData.muzzle as THREE.Vector3).clone().applyMatrix4(this.vmGun.matrix).applyMatrix4(this.vm.matrix);
    return local.applyQuaternion(cam.quaternion).add(cam.position);
  }

  // spring state for the view-model (position + rotation offsets)
  private vmPos = new THREE.Vector3(); private vmPosV = new THREE.Vector3();
  private vmRot = new THREE.Vector3(); private vmRotV = new THREE.Vector3();
  private drawT = 0;
  private breathT = 0;
  holdBreath = 0;
  private lastGrounded = true;
  private landImpulse = 0;
  private wallPull = 0;
  private reloadPhase = -1;

  /** impulse into the view-model springs (recoil, landing, melee) */
  vmImpulse(pos: THREE.Vector3, rot: THREE.Vector3) { this.vmPosV.add(pos); this.vmRotV.add(rot); }

  private updateViewModel(dt: number) {
    const s = this.soldier, inp = this.w.input;
    const oc = this.w.engine.overlayCam;
    oc.fov = THREE.MathUtils.lerp(58, 42, s.ads);
    oc.updateProjectionMatrix();
    const wp = s.weapon;
    const before = this.vmKey;
    this.ensureViewModel(wp);
    if (this.vmKey !== before) this.drawT = 0.38; // raise animation when a new weapon is drawn
    if (!this.vmGun) return;
    const sp = Math.hypot(s.vel.x, s.vel.z);
    const len = wp.def.length;
    // ---- base poses
    const hip = new THREE.Vector3(0.15 + len * 0.05, -0.15 - len * 0.03, -0.3 - len * 0.42);
    const calib = this.vmGun.userData.calib as SightCalib;
    const adsP = calib.pos.clone();
    const target = hip.lerp(adsP, s.ads);
    const tr = new THREE.Vector3();
    // ---- walk / sprint bob (figure-8), idle breathing
    this.bobT += dt * (s.sprinting ? 12.5 : 8.5) * Math.min(1, sp / 3);
    this.breathT += dt;
    const bobA = (s.grounded ? Math.min(1, sp / 4) : 0) * (1 - s.ads * 0.9) * (s.sprinting ? 1.6 : 1);
    target.x += Math.sin(this.bobT) * 0.011 * bobA;
    target.y += Math.abs(Math.cos(this.bobT)) * 0.012 * bobA - 0.004 * bobA;
    tr.z += Math.sin(this.bobT) * 0.025 * bobA;
    const br = (1 - s.ads * 0.8) * (0.0025 + s.model.proc.breath * 0.006);
    target.y += Math.sin(this.breathT * 1.7) * br; tr.x += Math.sin(this.breathT * 1.7 + 0.6) * br * 2;
    // ---- scoped sway (hold breath with sprint while aiming)
    if (s.ads > 0.6 && (wp.stats.scope || wp.def.cls === 'marksman')) {
      const hold = inp.held('sprint') && this.holdBreath < 4;
      this.holdBreath = hold ? this.holdBreath + dt : Math.max(0, this.holdBreath - dt * 0.5);
      const k = (hold ? 0.15 : 1) * 0.6;
      this.pitch += Math.sin(this.breathT * 1.1) * 0.00035 * k; this.yaw += Math.cos(this.breathT * 0.8) * 0.0003 * k;
    }
    // ---- strafe tilt + look sway (inertia)
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const strafe = s.vel.dot(right);
    tr.z += -strafe * 0.012 * (1 - s.ads * 0.7);
    tr.y += THREE.MathUtils.clamp(-inp.lookX * 0.0009, -0.08, 0.08) * (1 - s.ads * 0.6);
    tr.x += THREE.MathUtils.clamp(inp.lookY * 0.0007, -0.06, 0.06) * (1 - s.ads * 0.6);
    target.x += THREE.MathUtils.clamp(-inp.lookX * 0.00025, -0.02, 0.02);
    target.y += THREE.MathUtils.clamp(inp.lookY * 0.0002, -0.015, 0.015);
    // ---- sprint pose
    if (s.sprinting) { target.x += 0.05; target.y -= 0.06; tr.y += 0.6; tr.x -= 0.25; tr.z += 0.15; }
    // ---- jump / land
    if (!s.grounded && this.lastGrounded && !s.swimming) this.vmImpulse(new THREE.Vector3(0, -0.15, 0), new THREE.Vector3(-0.6, 0, 0));
    if (s.grounded && !this.lastGrounded) this.vmImpulse(new THREE.Vector3(0, -0.35, 0), new THREE.Vector3(0.9, 0, 0));
    this.lastGrounded = s.grounded;
    // ---- reload choreography: tilt -> mag out -> mag in (bump) -> rack
    if (wp.reloading > 0) {
      const k = 1 - wp.reloading / wp.stats.reload;
      const ease = (a: number, b: number) => THREE.MathUtils.smoothstep(k, a, b);
      const out = ease(0, 0.18) * (1 - ease(0.82, 1));
      target.y -= out * 0.07; target.x -= out * 0.03; tr.z += out * 0.55; tr.x -= out * 0.25;
      const ph = k < 0.35 ? 0 : k < 0.6 ? 1 : k < 0.85 ? 2 : 3;
      if (ph !== this.reloadPhase) {
        if (ph === 1) this.vmImpulse(new THREE.Vector3(0, -0.12, 0), new THREE.Vector3(0.4, 0, 0));
        if (ph === 2) { this.vmImpulse(new THREE.Vector3(0, 0.25, 0), new THREE.Vector3(-0.8, 0, 0.3)); }
        if (ph === 3 && wp.def.cls !== 'pistol') this.vmImpulse(new THREE.Vector3(-0.1, 0, 0.1), new THREE.Vector3(0, 0.6, -0.5));
        this.reloadPhase = ph;
      }
    } else this.reloadPhase = -1;
    // ---- draw (raise) animation
    if (this.drawT > 0) { this.drawT = Math.max(0, this.drawT - dt); const k = this.drawT / 0.38; target.y -= k * k * 0.25; tr.x -= k * 0.9; tr.z += k * 0.3; }
    // ---- inspect
    if (this.inspectT > 0) { this.inspectT -= dt; const k = Math.sin((1 - this.inspectT / 2.2) * Math.PI); tr.y += k * 1.2; tr.z += k * 0.5; target.x -= k * 0.08; }
    if (s.busyT > 0) target.y -= 0.25;
    // ---- wall proximity: pull the weapon back instead of clipping into geometry
    const eye = s.eyePos(new THREE.Vector3());
    const hit = this.w.physics.raycast(eye, this.forward(), 1.1, s.collider);
    this.wallPull = THREE.MathUtils.lerp(this.wallPull, hit && hit.dist < 0.95 ? 1 - hit.dist / 0.95 : 0, Math.min(1, dt * 10));
    target.z += this.wallPull * 0.2; target.y -= this.wallPull * 0.05; tr.x += this.wallPull * 0.5; tr.y -= this.wallPull * 0.35;
    // ---- melee
    if (wp.def.cls === 'melee') { tr.x += -0.4 + this.vmKick * 1.4; tr.y += this.vmKick * 0.8; target.z -= this.vmKick * 0.18; }
    this.vmKick = Math.max(0, this.vmKick - dt * 7);
    // ---- springs (pos + rot), critically damped toward the target pose
    const k = 260, c = 26;
    const pe = this.vmGun.position.clone().sub(this.vmPos).sub(target);
    void pe;
    this.vmPosV.addScaledVector(this.vmPos, -k * dt).multiplyScalar(Math.max(0, 1 - c * dt));
    this.vmPos.addScaledVector(this.vmPosV, dt);
    this.vmRotV.addScaledVector(this.vmRot, -k * 0.8 * dt).multiplyScalar(Math.max(0, 1 - c * 0.9 * dt));
    this.vmRot.addScaledVector(this.vmRotV, dt);
    const g = this.vmGun;
    g.position.lerp(target, Math.min(1, dt * 16)).add(this.vmPos.clone().multiplyScalar(0.12));
    g.rotation.set(tr.x + calib.tilt * s.ads + this.vmRot.x * 0.12, tr.y + this.vmRot.y * 0.12, tr.z + this.vmRot.z * 0.12);
    // look *through* optics: the opaque optic model fades out (HUD draws the reticle / lens);
    // magnified optics and sniper scopes hide the whole view-model so the sight picture is clean
    const optic = g.getObjectByName('att_optic');
    if (optic) optic.visible = s.ads < 0.8;
    g.visible = !(calib.kind !== 'iron' && calib.kind !== 'reflex' && s.ads > 0.9 && !this.thirdPerson);
    // consumable item while healing / plating
    if (s.busyT > 0 && (s.busyKind === 'heal' || s.busyKind === 'plate' || s.busyKind === 'syringe')) {
      const want = s.busyKind === 'plate' ? 'item_vest' : s.busyKind === 'syringe' ? 'item_syringe' : 'item_medkit';
      if (!this.vmItem || this.vmItem.name !== want) {
        if (this.vmItem) this.vm.remove(this.vmItem);
        this.vmItem = null;
        this.w.assets.instance(want).then((m) => {
          m.name = want; const holder = new THREE.Group(); holder.name = want; holder.add(m);
          m.scale.multiplyScalar(want === 'item_vest' ? 0.5 : 0.8);
          this.vmItem = holder; this.vm.add(holder);
        });
      }
      if (this.vmItem) { const kk = 1 - s.busyT / (s.busyKind === 'heal' ? 3.5 : 1.1); this.vmItem.visible = true; this.vmItem.position.set(-0.05, -0.22 + Math.sin(kk * Math.PI) * 0.08, -0.42); this.vmItem.rotation.set(0.4, 0.6 + kk, 0); }
    } else if (this.vmItem) this.vmItem.visible = false;
  }

  // ----------------------------------------------------------------- ping
  private lastPingT = -10;
  /** Warzone-style contextual ping: enemy under the crosshair > vehicle > loot > location; double tap = danger */
  private ping() {
    const w = this.w, s = this.soldier;
    const eye = w.engine.camera.position.clone();
    const f = this.forward();
    const danger = w.time - this.lastPingT < 0.45;
    this.lastPingT = w.time;
    const base = { owner: s.name, team: s.team };
    let best: Actor | null = null, bestA = THREE.MathUtils.degToRad(3.5);
    const to = new THREE.Vector3();
    for (const a of w.actors) {
      if (!a.alive || a === s || (a.kind === 'soldier' && a.team === s.team)) continue;
      to.copy(a.eyePos(new THREE.Vector3())).sub(eye);
      const d = to.length();
      if (d > 400) continue;
      const ang = to.normalize().angleTo(f);
      if (ang < bestA && !w.physics.raycast(eye, to, d - 1.2, s.collider)) { bestA = ang; best = a; }
    }
    if (best) { w.addPing({ ...base, pos: best.pos.clone().setY(best.pos.y + 2.1), kind: 'enemy', label: best.kind === 'zombie' ? 'Zombie' : 'Feind', actor: best }); return; }
    const hit = w.physics.raycast(eye, f, 700, s.collider);
    const pos = hit ? hit.point.clone() : eye.clone().addScaledVector(f, 350);
    const veh = hit ? w.vehicleOfCollider(hit.collider) : null;
    if (veh && !veh.destroyed) { w.addPing({ ...base, pos: veh.model.position.clone().setY(veh.model.position.y + 2.5), kind: 'vehicle', label: veh.def.name }); return; }
    const loot = (w as unknown as { loot?: { items: { pos: THREE.Vector3 }[]; label(it: unknown): string } }).loot;
    if (loot) {
      let li: { pos: THREE.Vector3 } | null = null, ld = 3;
      for (const it of loot.items) { const d = it.pos.distanceTo(pos); if (d < ld) { ld = d; li = it; } }
      if (li) { w.addPing({ ...base, pos: li.pos.clone().setY(li.pos.y + 0.6), kind: 'loot', label: loot.label(li) }); return; }
    }
    w.addPing({ ...base, pos, kind: danger ? 'danger' : 'go', label: danger ? 'Gefahr!' : 'Hierhin' });
  }

  // ----------------------------------------------------------------- aim assist
  aimAssistTarget(): Actor | null {
    const s = this.soldier, w = this.w;
    const eye = s.eyePos(new THREE.Vector3());
    const f = this.forward();
    let best: Actor | null = null, bestA = THREE.MathUtils.degToRad(s.ads > 0.5 ? 5 : 3.5);
    for (const a of w.actors) {
      if (!a.alive || a === s || (a.team === s.team && a.kind === 'soldier')) continue;
      const to = a.eyePos(new THREE.Vector3()).add(new THREE.Vector3(0, -0.3, 0)).sub(eye);
      const d = to.length();
      if (d > 70) continue;
      const ang = to.normalize().angleTo(f);
      if (ang < bestA) { bestA = ang; best = a; }
    }
    return best;
  }
}
