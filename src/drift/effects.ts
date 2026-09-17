import * as THREE from 'three';

/** Builds a soft radial puff texture once, on the fly. */
function puffTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.32)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Puff {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  vel: THREE.Vector3;
  spin: number;
}

/** Billboarded tyre smoke, drawn from a fixed pool so nothing allocates mid-race. */
export class SmokePool {
  readonly group = new THREE.Group();
  private puffs: Puff[] = [];
  private cursor = 0;
  private texture = puffTexture();

  constructor(count = 46) {
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        color: 0xd8cfe4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.puffs.push({ mesh, life: 0, maxLife: 1, vel: new THREE.Vector3(), spin: 0 });
    }
  }

  spawn(x: number, y: number, z: number, strength: number): void {
    const p = this.puffs[this.cursor];
    this.cursor = (this.cursor + 1) % this.puffs.length;
    p.mesh.position.set(x, y, z);
    p.mesh.visible = true;
    p.mesh.scale.setScalar(1.1 + Math.random() * 0.8);
    p.mesh.rotation.z = Math.random() * Math.PI;
    p.maxLife = 0.75 + Math.random() * 0.55;
    p.life = p.maxLife;
    p.spin = (Math.random() - 0.5) * 2.4;
    p.vel.set(
      (Math.random() - 0.5) * 2.4,
      1.1 + Math.random() * 1.4,
      (Math.random() - 0.5) * 2.4,
    );
    const mat = p.mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.35 + strength * 0.4;
  }

  update(dt: number, cameraQuat: THREE.Quaternion): void {
    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      if (p.life <= 0) {
        p.mesh.visible = false;
        mat.opacity = 0;
        continue;
      }
      const k = p.life / p.maxLife;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - 1.6 * dt);
      p.mesh.scale.addScalar(dt * 3.2);
      mat.opacity = k * 0.55;
      // Billboard, then keep the per-puff roll so they do not look identical.
      const roll = p.mesh.rotation.z + p.spin * dt;
      p.mesh.quaternion.copy(cameraQuat);
      p.mesh.rotateZ(roll);
      p.mesh.rotation.z = roll;
    }
  }

  clear(): void {
    for (const p of this.puffs) {
      p.life = 0;
      p.mesh.visible = false;
    }
  }
}

interface Mark {
  mesh: THREE.Mesh;
  life: number;
}

/** Dark quads laid flat on the road where the rear tyres scrub. */
export class SkidPool {
  readonly group = new THREE.Group();
  private marks: Mark[] = [];
  private cursor = 0;
  private static readonly LIFE = 5.5;

  constructor(count = 130) {
    const geo = new THREE.PlaneGeometry(0.34, 1.3);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x140f1c,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.marks.push({ mesh, life: 0 });
    }
  }

  spawn(x: number, y: number, z: number, yaw: number, strength: number): void {
    const m = this.marks[this.cursor];
    this.cursor = (this.cursor + 1) % this.marks.length;
    m.mesh.position.set(x, y + 0.03, z);
    m.mesh.rotation.set(-Math.PI / 2, 0, -yaw);
    m.mesh.visible = true;
    m.life = SkidPool.LIFE;
    (m.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 + strength * 0.35;
  }

  update(dt: number): void {
    for (const m of this.marks) {
      if (m.life <= 0) continue;
      m.life -= dt;
      const mat = m.mesh.material as THREE.MeshBasicMaterial;
      if (m.life <= 0) {
        m.mesh.visible = false;
        mat.opacity = 0;
        continue;
      }
      // Hold full strength, then fade over the last second.
      mat.opacity = Math.min(mat.opacity, 0.7) * (m.life < 1 ? m.life : 1);
    }
  }

  clear(): void {
    for (const m of this.marks) {
      m.life = 0;
      m.mesh.visible = false;
    }
  }
}

/** Short-lived sparks thrown out by a collision. */
export class SparkPool {
  readonly group = new THREE.Group();
  private sparks: { mesh: THREE.Mesh; life: number; vel: THREE.Vector3 }[] = [];
  private cursor = 0;

  constructor(count = 30) {
    const geo = new THREE.SphereGeometry(0.09, 5, 4);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffc46b, toneMapped: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.sparks.push({ mesh, life: 0, vel: new THREE.Vector3() });
    }
  }

  burst(pos: THREE.Vector3, count = 12): void {
    for (let i = 0; i < count; i++) {
      const s = this.sparks[this.cursor];
      this.cursor = (this.cursor + 1) % this.sparks.length;
      s.mesh.position.copy(pos);
      s.mesh.visible = true;
      s.life = 0.35 + Math.random() * 0.3;
      s.vel.set(
        (Math.random() - 0.5) * 12,
        2 + Math.random() * 7,
        (Math.random() - 0.5) * 12,
      );
    }
  }

  update(dt: number): void {
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        continue;
      }
      s.vel.y -= 24 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
    }
  }

  clear(): void {
    for (const s of this.sparks) {
      s.life = 0;
      s.mesh.visible = false;
    }
  }
}
