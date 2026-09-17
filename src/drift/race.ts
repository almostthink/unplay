import * as THREE from 'three';
import { World } from './scene';
import { Track } from './track';
import { CarPhysics, CarRig } from './car';
import { SkidPool, SmokePool, SparkPool } from './effects';
import { InputController } from './input';
import {
  CHECKPOINT_TIME,
  COINS_PER_SCORE,
  CRASH_PENALTY,
  MAX_REVIVES,
  DRIFT_ANGLE_MIN,
  DRIFT_MULT_MAX,
  DRIFT_MULT_RATE,
  DRIFT_SCORE_RATE,
  DRIFT_SPEED_MIN,
  NITRO_PER_COIN,
  NITRO_PER_DRIFT_SECOND,
  REVIVE_TIME,
  ROAD_HALF,
  SCORE_PER_METRE,
  SEG_LEN,
  START_TIME,
} from './config';
import { S } from './state';
import { carDef, effectiveStats, nitroMax } from './garage';
import { sfx } from './audio';

export interface HudState {
  speedKmh: number;
  time: number;
  score: number;
  pending: number;
  mult: number;
  drifting: boolean;
  nitro: number;
  offRoad: boolean;
  distance: number;
  countdown: string | null;
}

export interface RaceResult {
  score: number;
  distance: number;
  bestMult: number;
  coins: number;
  newBest: boolean;
}

type Phase = 'countdown' | 'driving' | 'over';

const CAR_RADIUS = 1.5;
const PICKUP_RADIUS = 2.1;

export class Race {
  private track = new Track();
  private physics: CarPhysics;
  private rig: CarRig;
  private smoke = new SmokePool();
  private skid = new SkidPool();
  private sparks = new SparkPool();

  private phase: Phase = 'countdown';
  private countdown = 3.2;
  private lastCountdownTick = 4;

  private time = START_TIME;
  private score = 0;
  private pending = 0;
  private mult = 1;
  private bestMult = 1;
  private distance = 0;
  private coinsPicked = 0;
  private drifting = false;
  private stationHint = 0;
  private shake = 0;
  private crashCooldown = 0;
  private revivesUsed = 0;

  private orbitAngle = 0;
  private camTarget = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private baseFov: number;

  onEnd: (result: RaceResult) => void = () => {};
  onCheckpoint: (seconds: number) => void = () => {};
  onCrash: () => void = () => {};

  constructor(
    private world: World,
    private input: InputController,
  ) {
    const id = S().currentCar;
    this.physics = new CarPhysics(effectiveStats(id));
    this.rig = new CarRig(carDef(id), S().cars[id].paint);
    this.baseFov = world.camera.fov;

    world.scene.add(this.track.group);
    world.scene.add(this.rig.group);
    world.scene.add(this.smoke.group, this.skid.group, this.sparks.group);
  }

  get running(): boolean {
    return this.phase !== 'over';
  }

  get revivesLeft(): number {
    return Math.max(0, MAX_REVIVES - this.revivesUsed);
  }

  /** Rebuilds the car for the garage selection and resets every counter. */
  start(): void {
    this.rebuildRig();
    this.track.reset();
    this.track.update(0);
    this.smoke.clear();
    this.skid.clear();
    this.sparks.clear();

    const s = this.track.station(2);
    this.physics.reset(s.x, s.z, s.y, s.h);

    this.phase = 'countdown';
    this.countdown = 3.2;
    this.lastCountdownTick = 4;
    this.time = START_TIME;
    this.score = 0;
    this.pending = 0;
    this.mult = 1;
    this.bestMult = 1;
    this.distance = 0;
    this.coinsPicked = 0;
    this.drifting = false;
    this.stationHint = 2;
    this.shake = 0;
    this.crashCooldown = 0;
    this.revivesUsed = 0;

    this.input.setEnabled(false);
    this.snapCamera();
    sfx.startEngine();
  }

  /**
   * Resets the world and parks the selected car at the start line without
   * beginning a run, so the menu can show it off in the live scene.
   */
  parkForMenu(): void {
    this.rebuildRig();
    this.track.reset();
    this.track.update(0);
    this.smoke.clear();
    this.skid.clear();
    this.sparks.clear();

    const s = this.track.station(4);
    this.physics.reset(s.x, s.z, s.y, s.h);
    this.physics.y = s.y;
    this.phase = 'over';
    this.input.setEnabled(false);
    this.stationHint = 4;
    this.orbitAngle = 0.6;

    this.rig.group.position.set(s.x, s.y, s.z);
    this.rig.group.rotation.set(0, s.h, 0);
    this.world.camera.fov = this.baseFov;
    this.world.camera.updateProjectionMatrix();
    sfx.stopEngine();
  }

  /** Slow orbit around the parked car, used behind the menu. */
  orbit(dt: number): void {
    this.orbitAngle += dt * 0.22;
    const car = this.rig.group.position;
    const radius = 11.5;
    this.world.camera.position.set(
      car.x + Math.sin(this.orbitAngle) * radius,
      car.y + 3.9,
      car.z + Math.cos(this.orbitAngle) * radius,
    );
    this.world.camera.lookAt(car.x, car.y + 0.95, car.z);
    this.rig.update(dt, 0, 0, 0, false);
    this.track.animate(dt);
    this.world.follow(car);
  }

  private rebuildRig(): void {
    const id = S().currentCar;
    this.world.scene.remove(this.rig.group);
    this.rig.dispose();
    this.rig = new CarRig(carDef(id), S().cars[id].paint);
    this.world.scene.add(this.rig.group);
    this.physics.setStats(effectiveStats(id));
  }

  /** Grants extra time after a rewarded video and puts the car back on track. */
  revive(): void {
    this.revivesUsed += 1;
    this.time = REVIVE_TIME;
    this.phase = 'countdown';
    this.countdown = 2.2;
    this.lastCountdownTick = 3;
    this.crashCooldown = 1.5;

    // Re-centre on the road so the player does not resume facing a wall.
    const loc = this.track.locate(this.physics.x, this.physics.z, this.stationHint);
    const st = this.track.station(loc.index);
    this.physics.reset(st.x, st.z, st.y, st.h);
    this.physics.vLong = 12;
    this.input.setEnabled(false);
    sfx.startEngine();
  }

  stop(): void {
    this.phase = 'over';
    this.input.setEnabled(false);
    sfx.stopEngine();
  }

  update(dt: number): HudState {
    if (this.phase === 'countdown') this.tickCountdown(dt);

    const input = this.input.read(dt);
    const loc = this.track.locate(this.physics.x, this.physics.z, this.stationHint);
    this.stationHint = loc.index;
    const offRoad = Math.abs(loc.lateral) > ROAD_HALF - 0.4;

    if (this.phase === 'driving') {
      this.physics.step(dt, input, offRoad);
      this.time -= dt;
      if (this.time <= 0) {
        this.time = 0;
        this.endRun();
      }
    } else if (this.phase === 'countdown') {
      // The car idles in place during the countdown.
      this.physics.step(dt, { steer: 0, handbrake: true, nitro: false }, false);
    }

    this.track.update(loc.index);
    this.track.animate(dt);

    const speed = this.physics.speed;
    const driftAngle = this.physics.driftAngle;

    if (this.phase === 'driving') {
      this.updateScoring(dt, speed, driftAngle);
      this.updateCollisions(dt, loc.index);
      this.updateEffects(speed, driftAngle, offRoad);
      this.distance += Math.max(0, this.physics.vLong) * dt;
      this.score += Math.max(0, this.physics.vLong) * dt * SCORE_PER_METRE;
    }

    // Lift the car to the road surface, with a little suspension travel.
    const targetY = loc.y + 0.02;
    this.physics.y += (targetY - this.physics.y) * (1 - Math.exp(-14 * dt));

    this.rig.group.position.set(this.physics.x, this.physics.y, this.physics.z);
    this.rig.group.rotation.y = this.physics.yaw;
    this.rig.update(dt, speed, input.steer, driftAngle, input.nitro && this.physics.nitro > 0);

    this.updateCamera(dt, speed, input.nitro && this.physics.nitro > 0, offRoad);
    this.smoke.update(dt, this.world.camera.quaternion);
    this.skid.update(dt);
    this.sparks.update(dt);

    sfx.updateEngine(
      Math.min(1, speed / Math.max(1, effectiveStats(S().currentCar).topSpeed)),
      this.drifting ? Math.min(1, Math.abs(driftAngle) * 2.2) : offRoad && speed > 6 ? 0.35 : 0,
      input.nitro && this.physics.nitro > 0,
    );

    return {
      speedKmh: speed * 3.6,
      time: this.time,
      score: this.score,
      pending: this.pending,
      mult: this.mult,
      drifting: this.drifting,
      nitro: this.physics.nitro / nitroMax(S().currentCar),
      offRoad,
      distance: this.distance,
      countdown: this.countdownLabel(),
    };
  }

  // -------------------------------------------------------------- phases

  private tickCountdown(dt: number): void {
    this.countdown -= dt;
    const whole = Math.ceil(this.countdown);
    if (whole < this.lastCountdownTick) {
      this.lastCountdownTick = whole;
      if (whole >= 1) sfx.countdown(false);
      else sfx.countdown(true);
    }
    if (this.countdown <= 0) {
      this.phase = 'driving';
      this.input.setEnabled(true);
    }
  }

  private countdownLabel(): string | null {
    if (this.phase !== 'countdown') return null;
    const whole = Math.ceil(this.countdown);
    return whole >= 1 ? String(whole) : 'GO';
  }

  private endRun(): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.input.setEnabled(false);
    sfx.stopEngine();

    // A drift in progress still banks; ending mid-slide should feel rewarding.
    this.score += this.pending;
    this.pending = 0;

    const s = S();
    const score = Math.floor(this.score);
    const newBest = score > s.stats.bestScore;
    const coins = Math.floor(score * COINS_PER_SCORE) + this.coinsPicked;

    this.onEnd({
      score,
      distance: Math.floor(this.distance),
      bestMult: this.bestMult,
      coins,
      newBest,
    });
  }

  // ------------------------------------------------------------- scoring

  private updateScoring(dt: number, speed: number, driftAngle: number): void {
    const sliding = Math.abs(driftAngle) > DRIFT_ANGLE_MIN && speed > DRIFT_SPEED_MIN;

    if (sliding) {
      if (!this.drifting) {
        this.drifting = true;
        this.mult = 1;
      }
      this.mult = Math.min(DRIFT_MULT_MAX, this.mult + DRIFT_MULT_RATE * dt);
      this.bestMult = Math.max(this.bestMult, this.mult);
      this.pending += DRIFT_SCORE_RATE * this.mult * dt;
      this.physics.nitro = Math.min(
        nitroMax(S().currentCar),
        this.physics.nitro + NITRO_PER_DRIFT_SECOND * dt,
      );
    } else if (this.drifting) {
      // Give a short grace window so a brief straighten does not break a combo.
      this.drifting = false;
      this.score += this.pending;
      this.pending = 0;
      this.mult = 1;
    }
  }

  private updateCollisions(dt: number, index: number): void {
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    const cx = this.physics.x;
    const cz = this.physics.z;

    for (const o of this.track.activeObstacles()) {
      const dx = o.pos.x - cx;
      const dz = o.pos.z - cz;
      const r = o.radius + CAR_RADIUS;
      if (dx * dx + dz * dz > r * r) continue;

      o.hit = true;
      o.mesh.visible = false;
      if (this.crashCooldown > 0) continue;

      this.crashCooldown = 0.6;
      this.physics.crash();
      this.time = Math.max(0, this.time - CRASH_PENALTY);
      this.pending = 0;
      this.mult = 1;
      this.drifting = false;
      this.shake = 1;
      this.sparks.burst(o.pos, 14);
      sfx.crash();
      this.onCrash();
      if (this.time <= 0) this.endRun();
    }

    for (const p of this.track.activePickups()) {
      const dx = p.pos.x - cx;
      const dz = p.pos.z - cz;
      if (dx * dx + dz * dz > PICKUP_RADIUS * PICKUP_RADIUS) continue;
      p.taken = true;
      p.mesh.visible = false;
      this.coinsPicked += 25;
      this.physics.nitro = Math.min(
        nitroMax(S().currentCar),
        this.physics.nitro + NITRO_PER_COIN,
      );
      sfx.coin();
    }

    for (const g of this.track.activeGates()) {
      if (index < g.index) continue;
      g.passed = true;
      g.group.visible = false;
      this.time += CHECKPOINT_TIME;
      sfx.checkpoint();
      this.onCheckpoint(CHECKPOINT_TIME);
    }
  }

  // ------------------------------------------------------------- visuals

  private updateEffects(speed: number, driftAngle: number, offRoad: boolean): void {
    const slipping = Math.abs(driftAngle) > 0.14 && speed > 8;
    if (!slipping && !offRoad) return;

    const strength = Math.min(1, Math.abs(driftAngle) * 2);
    const def = carDef(S().currentCar);
    const back = -def.size[0] * 0.32;
    const half = def.size[1] * 0.5;
    const fx = Math.sin(this.physics.yaw);
    const fz = Math.cos(this.physics.yaw);
    const rx = Math.cos(this.physics.yaw);
    const rz = -Math.sin(this.physics.yaw);

    for (const side of [-1, 1]) {
      const wx = this.physics.x + fx * back + rx * side * half;
      const wz = this.physics.z + fz * back + rz * side * half;
      if (Math.random() < (slipping ? 0.85 : 0.3)) {
        this.smoke.spawn(wx, this.physics.y + 0.35, wz, strength);
      }
      if (slipping && !offRoad) {
        this.skid.spawn(wx, this.physics.y, wz, this.physics.yaw, strength);
      }
    }
  }

  private snapCamera(): void {
    const dir = this.travelDirection();
    this.camTarget
      .set(this.physics.x, this.physics.y, this.physics.z)
      .addScaledVector(dir, -11)
      .add(this.tmp.set(0, 4.4, 0));
    this.world.camera.position.copy(this.camTarget);
    this.world.camera.lookAt(this.physics.x, this.physics.y + 1.2, this.physics.z);
  }

  /** Behind the direction of travel, so a drifting car reads sideways. */
  private travelDirection(): THREE.Vector3 {
    const fx = Math.sin(this.physics.yaw);
    const fz = Math.cos(this.physics.yaw);
    const rx = Math.cos(this.physics.yaw);
    const rz = -Math.sin(this.physics.yaw);
    const vx = fx * this.physics.vLong + rx * this.physics.vLat;
    const vz = fz * this.physics.vLong + rz * this.physics.vLat;
    const speed = Math.hypot(vx, vz);
    if (speed < 5) return this.tmp.set(fx, 0, fz);
    // Blend toward the nose a little so the view does not swing wildly.
    const bx = vx / speed + fx * 0.45;
    const bz = vz / speed + fz * 0.45;
    const bl = Math.hypot(bx, bz) || 1;
    return this.tmp.set(bx / bl, 0, bz / bl);
  }

  private updateCamera(dt: number, speed: number, nitro: boolean, offRoad: boolean): void {
    const top = Math.max(1, effectiveStats(S().currentCar).topSpeed);
    const ratio = Math.min(1, speed / top);
    const dir = this.travelDirection().clone();

    const back = 10.2 + ratio * 3.4;
    const height = 4.2 + ratio * 1.1;
    this.camTarget
      .set(this.physics.x, this.physics.y, this.physics.z)
      .addScaledVector(dir, -back);
    this.camTarget.y += height;

    const follow = 1 - Math.exp(-5.5 * dt);
    this.world.camera.position.lerp(this.camTarget, follow);

    // Look a little ahead of the car so corners open up early.
    this.camLook.set(
      this.physics.x + dir.x * 9,
      this.physics.y + 1.4,
      this.physics.z + dir.z * 9,
    );

    this.shake = Math.max(0, this.shake - dt * 2.2);
    const jolt = this.shake * 0.55 + (offRoad && speed > 10 ? 0.09 : 0);
    if (jolt > 0) {
      this.world.camera.position.x += (Math.random() - 0.5) * jolt;
      this.world.camera.position.y += (Math.random() - 0.5) * jolt;
    }

    this.world.camera.lookAt(this.camLook);

    const targetFov = this.baseFov + ratio * 10 + (nitro ? 7 : 0);
    this.world.camera.fov += (targetFov - this.world.camera.fov) * (1 - Math.exp(-6 * dt));
    this.world.camera.updateProjectionMatrix();

    this.world.follow(this.rig.group.position);
  }

  /** Station index the car is nearest, exposed for the minimap-free HUD. */
  get progressMetres(): number {
    return this.stationHint * SEG_LEN;
  }

  dispose(): void {
    sfx.stopEngine();
    this.rig.dispose();
  }
}
