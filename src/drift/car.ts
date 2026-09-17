import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CarDef } from './config';
import { NITRO_BOOST } from './config';

export interface CarInput {
  /** -1 full left, +1 full right. */
  steer: number;
  /** Held handbrake, which breaks traction deliberately. */
  handbrake: boolean;
  nitro: boolean;
}

export interface CarStats {
  topSpeed: number;
  accel: number;
  grip: number;
  steer: number;
}

/** Visual rig: the meshes that make up the car and its moving parts. */
export class CarRig {
  readonly group = new THREE.Group();
  private wheels: THREE.Mesh[] = [];
  private frontWheels: THREE.Mesh[] = [];
  private brakeLights: THREE.MeshStandardMaterial;
  private bodyMat: THREE.MeshPhysicalMaterial;
  private flames: THREE.Mesh[] = [];
  private wheelSpin = 0;

  constructor(def: CarDef, paint: number) {
    const [length, width, height] = def.size;

    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color: paint,
      metalness: 0.35,
      roughness: 0.32,
      clearcoat: 0.85,
      clearcoatRoughness: 0.14,
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0d1020,
      metalness: 0.2,
      roughness: 0.08,
      clearcoat: 1,
      transmission: 0,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x14151c,
      roughness: 0.7,
      metalness: 0.3,
    });
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x121218, roughness: 0.95 });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xd9dde6,
      metalness: 0.95,
      roughness: 0.22,
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfff3d6,
      emissive: 0xffe4a8,
      emissiveIntensity: 3.2,
    });
    this.brakeLights = new THREE.MeshStandardMaterial({
      color: 0xff2b2b,
      emissive: 0xff0000,
      emissiveIntensity: 1.4,
    });

    // Lower body, slightly tapered by scaling the front of the shell.
    const shell = new THREE.Mesh(
      new RoundedBoxGeometry(width, height, length, 3, 0.26),
      this.bodyMat,
    );
    shell.position.y = height / 2 + 0.34;
    shell.castShadow = true;
    this.group.add(shell);

    // Cabin sits back from centre so the car reads as front-engined.
    const cabin = new THREE.Mesh(
      new RoundedBoxGeometry(width * 0.82, height * 0.62, length * 0.42, 3, 0.2),
      this.bodyMat,
    );
    cabin.position.set(0, height + 0.42, -length * 0.06);
    cabin.castShadow = true;
    this.group.add(cabin);

    const glass = new THREE.Mesh(
      new RoundedBoxGeometry(width * 0.84, height * 0.44, length * 0.44, 2, 0.16),
      glassMat,
    );
    glass.position.set(0, height + 0.52, -length * 0.06);
    this.group.add(glass);

    // Splitter and diffuser give the silhouette some definition.
    const splitter = new THREE.Mesh(
      new THREE.BoxGeometry(width * 1.02, 0.12, length * 0.16),
      trimMat,
    );
    splitter.position.set(0, 0.36, length * 0.45);
    this.group.add(splitter);

    // Rear wing.
    const wing = new THREE.Mesh(new THREE.BoxGeometry(width * 0.94, 0.1, 0.42), trimMat);
    wing.position.set(0, height + 0.62, -length * 0.46);
    wing.castShadow = true;
    this.group.add(wing);
    for (const side of [-1, 1]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.16), trimMat);
      stay.position.set(side * width * 0.34, height + 0.45, -length * 0.46);
      this.group.add(stay);
    }

    // Wheels: cylinders laid on their side, with a bright rim disc.
    const tyreGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 16);
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.32, 12);
    const axleZ = length * 0.32;
    const axleX = width * 0.5;
    for (const [sx, sz] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ] as const) {
      const wheel = new THREE.Mesh(tyreGeo, tyreMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(sx * axleX, 0.42, sz * axleZ);
      wheel.castShadow = true;
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.z = Math.PI / 2;
      rim.position.copy(wheel.position);
      this.group.add(wheel, rim);
      this.wheels.push(wheel, rim);
      if (sz > 0) this.frontWheels.push(wheel, rim);
    }

    // Lights.
    for (const side of [-1, 1]) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.1), headMat);
      head.position.set(side * width * 0.3, height * 0.75, length * 0.5);
      this.group.add(head);

      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.14, 0.08), this.brakeLights);
      tail.position.set(side * width * 0.3, height * 0.8, -length * 0.5);
      this.group.add(tail);

      // Exhaust flame, hidden until nitro fires.
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, 0.9, 8),
        new THREE.MeshBasicMaterial({
          color: 0x8ad4ff,
          transparent: true,
          opacity: 0.9,
          toneMapped: false,
        }),
      );
      flame.rotation.x = Math.PI / 2;
      flame.position.set(side * width * 0.22, 0.45, -length * 0.56);
      flame.visible = false;
      this.group.add(flame);
      this.flames.push(flame);
    }
  }

  setPaint(color: number): void {
    this.bodyMat.color.setHex(color);
  }

  /**
   * Updates the moving parts. `lean` tilts the body into the slide, which is
   * what sells the drift more than anything else on screen.
   */
  update(dt: number, speed: number, steer: number, driftAngle: number, nitro: boolean): void {
    this.wheelSpin += speed * dt * 2.4;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    for (const w of this.frontWheels) w.rotation.y = steer * 0.42;

    const lean = THREE.MathUtils.clamp(driftAngle * 0.35, -0.22, 0.22);
    this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, -lean, 1 - Math.exp(-10 * dt));
    // A touch of squat under acceleration.
    this.group.rotation.x = THREE.MathUtils.lerp(
      this.group.rotation.x,
      nitro ? -0.035 : 0,
      1 - Math.exp(-6 * dt),
    );

    const flicker = 0.7 + Math.random() * 0.5;
    for (const f of this.flames) {
      f.visible = nitro;
      f.scale.set(flicker, 0.8 + Math.random() * 0.7, flicker);
    }
    this.brakeLights.emissiveIntensity = nitro ? 0.6 : 1.4 + Math.abs(driftAngle) * 2;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}

/**
 * Arcade drift physics in the horizontal plane.
 *
 * The body frame is rotated first, which is what naturally injects sideways
 * velocity on turn-in; tyre grip then pulls that velocity back toward zero.
 * Lower grip, or a held handbrake, lets the slide persist, so drifting falls
 * out of the model instead of being a special case.
 */
export class CarPhysics {
  x = 0;
  z = 0;
  y = 0;
  yaw = 0;
  /** Velocity along the car's nose, in metres per second. */
  vLong = 0;
  /** Velocity across the car, positive to the right. */
  vLat = 0;
  /** Nitro remaining, in seconds. */
  nitro = 0;
  offRoad = false;

  constructor(private stats: CarStats) {}

  setStats(stats: CarStats): void {
    this.stats = stats;
  }

  reset(x: number, z: number, y: number, yaw: number): void {
    this.x = x;
    this.z = z;
    this.y = y;
    this.yaw = yaw;
    this.vLong = 0;
    this.vLat = 0;
    this.nitro = 0;
    this.offRoad = false;
  }

  get speed(): number {
    return Math.hypot(this.vLong, this.vLat);
  }

  /** Angle between where the car points and where it is going. */
  get driftAngle(): number {
    return Math.atan2(this.vLat, Math.max(1, Math.abs(this.vLong)));
  }

  step(dt: number, input: CarInput, offRoad: boolean): void {
    this.offRoad = offRoad;
    const boosting = input.nitro && this.nitro > 0;

    const surfaceGrip = offRoad ? 0.42 : 1;
    const surfaceSpeed = offRoad ? 0.55 : 1;

    // --- rotate the body frame; this is where lateral velocity comes from
    const speedFactor = THREE.MathUtils.clamp(Math.abs(this.vLong) / 11, 0, 1);
    // Steering authority falls away with speed, as it does on a real car.
    // Without this the body out-rotates its own velocity and the car spins.
    const speedDamp = 1 / (1 + Math.abs(this.vLong) / 34);
    const yawRate = input.steer * this.stats.steer * speedFactor * speedDamp;
    const dTheta = yawRate * dt;
    const c = Math.cos(dTheta);
    const s = Math.sin(dTheta);
    const long = this.vLong * c + this.vLat * s;
    const lat = -this.vLong * s + this.vLat * c;
    this.vLong = long;
    this.vLat = lat;
    this.yaw += dTheta;

    // --- tyres pull the slide back in
    let grip = this.stats.grip * surfaceGrip;
    if (input.handbrake) grip *= 0.16;
    // Grip falls away at speed, so fast corners break traction on their own.
    grip *= 1 - THREE.MathUtils.clamp(Math.abs(this.vLong) / 120, 0, 0.38);
    this.vLat *= Math.exp(-grip * dt);

    // --- engine and drag
    const topSpeed = this.stats.topSpeed * surfaceSpeed * (boosting ? NITRO_BOOST * 0.72 + 0.28 : 1);
    const accel = this.stats.accel * (boosting ? NITRO_BOOST : 1);
    // A sliding car loses drive, which keeps long drifts a real trade-off.
    const traction = 1 - THREE.MathUtils.clamp(Math.abs(this.driftAngle) / 1.4, 0, 0.38);
    this.vLong += accel * traction * dt;
    this.vLong -= this.vLong * Math.abs(this.vLong) * (0.9 / (topSpeed * topSpeed)) * accel * dt;
    if (this.vLong > topSpeed) this.vLong = topSpeed;
    if (this.vLong < 0) this.vLong = 0;

    if (boosting) this.nitro = Math.max(0, this.nitro - dt);

    // --- integrate position in world space
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    this.x += (fx * this.vLong + rx * this.vLat) * dt;
    this.z += (fz * this.vLong + rz * this.vLat) * dt;
  }

  /** Scrubs speed after hitting something solid. */
  crash(): void {
    this.vLong *= 0.35;
    this.vLat *= 0.4;
  }
}
