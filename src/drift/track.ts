import * as THREE from 'three';
import { CHECKPOINT_SPACING, ROAD_HALF, SEG_LEN } from './config';

const SEGS_PER_CHUNK = 24;
const CHUNKS_AHEAD = 4;
const CHUNKS_BEHIND = 1;

/** Sharpest corner the generator will produce, in radians per metre. */
const MAX_CURVATURE = 0.026;
/** How quickly curvature eases toward its current target. */
const CURVATURE_EASE = 0.055;

export interface Station {
  x: number;
  y: number;
  z: number;
  /** Heading in radians; the road runs along (sin h, cos h). */
  h: number;
  /** Distance from the start, in metres. */
  dist: number;
}

export interface Obstacle {
  pos: THREE.Vector3;
  radius: number;
  mesh: THREE.Object3D;
  hit: boolean;
}

export interface Pickup {
  pos: THREE.Vector3;
  mesh: THREE.Object3D;
  taken: boolean;
}

export interface Gate {
  index: number;
  pos: THREE.Vector3;
  passed: boolean;
  group: THREE.Group;
}

interface Chunk {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  obstacles: Obstacle[];
  pickups: Pickup[];
  gates: Gate[];
}

// Cross-section of the world, from far left to far right. `hill` marks
// stations whose height comes from noise so the landscape rolls.
const CROSS: readonly { x: number; y: number; hill: number; c: number }[] = [
  { x: -120, y: 0, hill: 1.25, c: 0x241a33 },
  { x: -62, y: 0, hill: 1.0, c: 0x2e2140 },
  { x: -30, y: -0.4, hill: 0.5, c: 0x44305e },
  { x: -13, y: -1.0, hill: 0.12, c: 0x4e3860 },
  { x: -ROAD_HALF - 0.8, y: -0.06, hill: 0, c: 0x3b3446 },
  { x: -ROAD_HALF, y: 0, hill: 0, c: 0xf2ead8 },
  { x: -ROAD_HALF + 0.55, y: 0, hill: 0, c: 0x343040 },
  { x: ROAD_HALF - 0.55, y: 0, hill: 0, c: 0x343040 },
  { x: ROAD_HALF, y: 0, hill: 0, c: 0xf2ead8 },
  { x: ROAD_HALF + 0.8, y: -0.06, hill: 0, c: 0x3b3446 },
  { x: 13, y: -1.0, hill: 0.12, c: 0x4e3860 },
  { x: 30, y: -0.4, hill: 0.5, c: 0x44305e },
  { x: 62, y: 0, hill: 1.0, c: 0x2e2140 },
  { x: 120, y: 0, hill: 1.25, c: 0x241a33 },
];

/** Cheap deterministic value noise; good enough for rolling hills. */
function noise(a: number, b: number): number {
  const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

function smoothNoise(a: number, b: number): number {
  const i = Math.floor(a);
  const f = a - i;
  const s = f * f * (3 - 2 * f);
  return noise(i, b) * (1 - s) + noise(i + 1, b) * s;
}

export class Track {
  readonly group = new THREE.Group();

  private stations: Station[] = [];
  private curvature = 0;
  private targetCurvature = 0;
  private sinceTarget = 0;
  private chunks = new Map<number, Chunk>();
  private nextGateDist = CHECKPOINT_SPACING;

  private readonly roadMat: THREE.MeshStandardMaterial;
  private readonly postMat: THREE.MeshStandardMaterial;
  private readonly coneMat: THREE.MeshStandardMaterial;
  private readonly coinMat: THREE.MeshStandardMaterial;
  private readonly gateMat: THREE.MeshStandardMaterial;
  private readonly trunkMat: THREE.MeshStandardMaterial;
  private readonly leafMat: THREE.MeshStandardMaterial;
  private readonly rockMat: THREE.MeshStandardMaterial;

  private readonly coneGeo = new THREE.ConeGeometry(0.55, 1.1, 10);
  private readonly coinGeo = new THREE.TorusGeometry(0.75, 0.2, 8, 20);
  private readonly postGeo = new THREE.BoxGeometry(0.16, 1.1, 0.16);
  private readonly trunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 3.2, 6);
  private readonly leafGeo = new THREE.ConeGeometry(2.1, 5.2, 7);
  private readonly rockGeo = new THREE.DodecahedronGeometry(1.5, 0);
  private readonly pillarGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
  private readonly dashMat = new THREE.MeshBasicMaterial({
    color: 0xe6dcc0,
    toneMapped: false,
  });

  constructor() {
    this.roadMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
    });
    this.postMat = new THREE.MeshStandardMaterial({
      color: 0xd8d2c4,
      emissive: 0xff7a3c,
      emissiveIntensity: 0.55,
      roughness: 0.6,
    });
    this.coneMat = new THREE.MeshStandardMaterial({
      color: 0xff6a2b,
      emissive: 0xff3b00,
      emissiveIntensity: 0.35,
      roughness: 0.55,
    });
    this.coinMat = new THREE.MeshStandardMaterial({
      color: 0xffc233,
      emissive: 0xffa300,
      emissiveIntensity: 1.5,
      metalness: 0.7,
      roughness: 0.25,
    });
    this.gateMat = new THREE.MeshStandardMaterial({
      color: 0x38f5c0,
      emissive: 0x25ffc4,
      emissiveIntensity: 2.2,
      transparent: true,
      opacity: 0.75,
    });
    this.trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3644, roughness: 1 });
    this.leafMat = new THREE.MeshStandardMaterial({ color: 0x5d4a86, roughness: 0.95 });
    this.rockMat = new THREE.MeshStandardMaterial({ color: 0x4c3f5c, roughness: 1 });

    this.ensureStations(SEGS_PER_CHUNK * (CHUNKS_AHEAD + 2));
  }

  // ------------------------------------------------------------ centreline

  /** Extends the centreline until at least `count` stations exist. */
  private ensureStations(count: number): void {
    if (this.stations.length === 0) {
      this.stations.push({ x: 0, y: 0, z: 0, h: 0, dist: 0 });
    }
    while (this.stations.length < count) {
      const prev = this.stations[this.stations.length - 1];
      const i = this.stations.length;

      // Hold a target curvature for a while, then pick a new one. Straights
      // are picked often so corners read as events rather than noise.
      this.sinceTarget -= 1;
      if (this.sinceTarget <= 0) {
        const straight = Math.random() < 0.32;
        this.targetCurvature = straight
          ? 0
          : (Math.random() < 0.5 ? -1 : 1) * (0.008 + Math.random() * (MAX_CURVATURE - 0.008));
        this.sinceTarget = 12 + Math.floor(Math.random() * 26);
      }
      this.curvature += (this.targetCurvature - this.curvature) * CURVATURE_EASE;

      const h = prev.h + this.curvature * SEG_LEN;
      const x = prev.x + Math.sin(h) * SEG_LEN;
      const z = prev.z + Math.cos(h) * SEG_LEN;
      const y = 5.5 * Math.sin(i * 0.011) + 2.4 * Math.sin(i * 0.031 + 1.7);
      this.stations.push({ x, y, z, h, dist: prev.dist + SEG_LEN });
    }
  }

  station(i: number): Station {
    this.ensureStations(i + 2);
    return this.stations[Math.max(0, Math.min(i, this.stations.length - 1))];
  }

  /** Interpolated point at a fractional station index. */
  sample(fi: number, out = new THREE.Vector3()): THREE.Vector3 {
    const i = Math.floor(fi);
    const f = fi - i;
    const a = this.station(i);
    const b = this.station(i + 1);
    return out.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
  }

  /**
   * Finds where a world position sits relative to the road, searching outward
   * from `hint` so the cost stays constant regardless of distance travelled.
   */
  locate(x: number, z: number, hint: number): { index: number; lateral: number; y: number; h: number } {
    const from = Math.max(0, hint - 12);
    const to = hint + 24;
    this.ensureStations(to + 2);

    let bestIndex = from;
    let bestDist = Infinity;
    for (let i = from; i <= to; i++) {
      const s = this.stations[i];
      if (!s) break;
      const dx = x - s.x;
      const dz = z - s.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }

    const s = this.stations[bestIndex];
    // Signed distance along the station's right vector.
    const rx = Math.cos(s.h);
    const rz = -Math.sin(s.h);
    const lateral = (x - s.x) * rx + (z - s.z) * rz;
    return { index: bestIndex, lateral, y: s.y, h: s.h };
  }

  // ---------------------------------------------------------------- chunks

  /** Builds chunks around the car and disposes the ones left behind. */
  update(carIndex: number): void {
    const centre = Math.floor(carIndex / SEGS_PER_CHUNK);
    const first = centre - CHUNKS_BEHIND;
    const last = centre + CHUNKS_AHEAD;

    for (let c = first; c <= last; c++) {
      if (c < 0 || this.chunks.has(c)) continue;
      this.chunks.set(c, this.buildChunk(c));
    }
    for (const [index, chunk] of this.chunks) {
      if (index >= first && index <= last) continue;
      this.disposeChunk(chunk);
      this.chunks.delete(index);
    }
  }

  /**
   * Drops a chunk. Only the geometries built for this chunk are disposed;
   * the shared prop geometries and every material outlive it.
   */
  private disposeChunk(chunk: Chunk): void {
    this.group.remove(chunk.group);
    for (const g of chunk.geometries) g.dispose();
    chunk.group.clear();
  }

  private buildChunk(chunkIndex: number): Chunk {
    const start = chunkIndex * SEGS_PER_CHUNK;
    const end = start + SEGS_PER_CHUNK;
    this.ensureStations(end + 2);

    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const obstacles: Obstacle[] = [];
    const pickups: Pickup[] = [];
    const gates: Gate[] = [];

    // --- ground + road ribbon, one draw call for the whole chunk
    const rows = SEGS_PER_CHUNK + 1;
    const cols = CROSS.length;
    const positions = new Float32Array(rows * cols * 3);
    const colors = new Float32Array(rows * cols * 3);
    const indices: number[] = [];
    const colour = new THREE.Color();

    for (let r = 0; r < rows; r++) {
      const s = this.station(start + r);
      const rx = Math.cos(s.h);
      const rz = -Math.sin(s.h);
      for (let c = 0; c < cols; c++) {
        const def = CROSS[c];
        const hill =
          def.hill > 0
            ? smoothNoise((start + r) * 0.09, def.x * 0.13) * 5 * def.hill +
              smoothNoise((start + r) * 0.035, def.x * 0.05) * 11 * def.hill +
              smoothNoise((start + r) * 0.011, def.x * 0.019) * 20 * def.hill
            : 0;
        const o = (r * cols + c) * 3;
        positions[o] = s.x + rx * def.x;
        positions[o + 1] = s.y + def.y + hill;
        positions[o + 2] = s.z + rz * def.x;
        colour.setHex(def.c);
        colors[o] = colour.r;
        colors[o + 1] = colour.g;
        colors[o + 2] = colour.b;
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        indices.push(a, d, b, b, d, e);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geometries.push(geo);

    const ground = new THREE.Mesh(geo, this.roadMat);
    ground.receiveShadow = true;
    group.add(ground);

    // --- centre dashes
    const dashGeo = this.buildDashes(start);
    if (dashGeo) {
      geometries.push(dashGeo);
      const dashes = new THREE.Mesh(dashGeo, this.dashMat);
      group.add(dashes);
    }

    // --- scenery and road furniture
    for (let r = 0; r < SEGS_PER_CHUNK; r++) {
      const i = start + r;
      const s = this.station(i);
      const rx = Math.cos(s.h);
      const rz = -Math.sin(s.h);

      // Reflective marker posts pace the road and sell the speed.
      if (i % 3 === 0) {
        for (const side of [-1, 1]) {
          const post = new THREE.Mesh(this.postGeo, this.postMat);
          post.position.set(
            s.x + rx * side * (ROAD_HALF + 1.3),
            s.y + 0.45,
            s.z + rz * side * (ROAD_HALF + 1.3),
          );
          post.rotation.y = -s.h;
          group.add(post);
        }
      }

      // Trees and rocks on the verge.
      if (i > 12 && Math.random() < 0.55) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const off = (16 + Math.random() * 40) * side;
        // Matches the ribbon's height function so trees do not float.
        const w = Math.abs(off) < 30 ? 0.5 : 1;
        const hill =
          smoothNoise(i * 0.09, off * 0.13) * 5 * w +
          smoothNoise(i * 0.035, off * 0.05) * 11 * w +
          smoothNoise(i * 0.011, off * 0.019) * 20 * w;
        const px = s.x + rx * off;
        const pz = s.z + rz * off;
        const py = s.y - 0.4 + hill;

        if (Math.random() < 0.72) {
          const tree = new THREE.Group();
          const trunk = new THREE.Mesh(this.trunkGeo, this.trunkMat);
          trunk.position.y = 1.6;
          const leaves = new THREE.Mesh(this.leafGeo, this.leafMat);
          leaves.position.y = 5.2;
          tree.add(trunk, leaves);
          tree.position.set(px, py, pz);
          const scale = 0.75 + Math.random() * 0.9;
          tree.scale.setScalar(scale);
          tree.rotation.y = Math.random() * Math.PI;
          tree.castShadow = true;
          trunk.castShadow = true;
          leaves.castShadow = true;
          group.add(tree);
        } else {
          const rock = new THREE.Mesh(this.rockGeo, this.rockMat);
          rock.position.set(px, py, pz);
          rock.scale.set(
            0.6 + Math.random(),
            0.4 + Math.random() * 0.7,
            0.6 + Math.random(),
          );
          rock.rotation.set(Math.random(), Math.random(), Math.random());
          rock.castShadow = true;
          group.add(rock);
        }
      }

      // Obstacles, kept off the first stretch so the run starts cleanly.
      if (i > 40 && Math.random() < 0.15) {
        const lane = (Math.random() * 2 - 1) * (ROAD_HALF - 1.6);
        const cone = new THREE.Mesh(this.coneGeo, this.coneMat);
        const pos = new THREE.Vector3(s.x + rx * lane, s.y + 0.55, s.z + rz * lane);
        cone.position.copy(pos);
        cone.castShadow = true;
        group.add(cone);
        obstacles.push({ pos, radius: 1.15, mesh: cone, hit: false });
      }

      // Coin pickups, biased toward the outside of corners where drifts go.
      if (i > 8 && i % 4 === 0 && Math.random() < 0.5) {
        const lane = (Math.random() * 2 - 1) * (ROAD_HALF - 2.2);
        const coin = new THREE.Mesh(this.coinGeo, this.coinMat);
        const pos = new THREE.Vector3(s.x + rx * lane, s.y + 1.25, s.z + rz * lane);
        coin.position.copy(pos);
        coin.rotation.y = -s.h;
        group.add(coin);
        pickups.push({ pos, mesh: coin, taken: false });
      }

      // Checkpoint gate whenever the next spacing threshold is crossed.
      if (s.dist >= this.nextGateDist) {
        this.nextGateDist += CHECKPOINT_SPACING;
        gates.push(this.buildGate(i, group, geometries));
      }
    }

    this.group.add(group);
    return { group, geometries, obstacles, pickups, gates };
  }

  private buildDashes(start: number): THREE.BufferGeometry | null {
    const positions: number[] = [];
    const indices: number[] = [];
    let v = 0;
    for (let r = 0; r < SEGS_PER_CHUNK; r += 2) {
      const a = this.station(start + r);
      const b = this.station(start + r + 1);
      const arx = Math.cos(a.h);
      const arz = -Math.sin(a.h);
      const brx = Math.cos(b.h);
      const brz = -Math.sin(b.h);
      const w = 0.16;
      positions.push(
        a.x + arx * -w, a.y + 0.02, a.z + arz * -w,
        a.x + arx * w, a.y + 0.02, a.z + arz * w,
        b.x + brx * -w, b.y + 0.02, b.z + brz * -w,
        b.x + brx * w, b.y + 0.02, b.z + brz * w,
      );
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      v += 4;
    }
    if (!positions.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    return geo;
  }

  private buildGate(
    index: number,
    parent: THREE.Group,
    geometries: THREE.BufferGeometry[],
  ): Gate {
    const s = this.station(index);
    const rx = Math.cos(s.h);
    const rz = -Math.sin(s.h);
    const group = new THREE.Group();

    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(this.pillarGeo, this.gateMat);
      pillar.position.set(
        s.x + rx * side * (ROAD_HALF + 1),
        s.y + 3.5,
        s.z + rz * side * (ROAD_HALF + 1),
      );
      group.add(pillar);
    }
    const beamGeo = new THREE.BoxGeometry((ROAD_HALF + 1) * 2, 0.55, 0.4);
    geometries.push(beamGeo);
    const beam = new THREE.Mesh(beamGeo, this.gateMat);
    beam.position.set(s.x, s.y + 6.6, s.z);
    beam.rotation.y = -s.h;
    group.add(beam);

    parent.add(group);
    return { index, pos: new THREE.Vector3(s.x, s.y, s.z), passed: false, group };
  }

  // ----------------------------------------------------------- queries

  /** Live obstacles near the car, for collision tests. */
  *activeObstacles(): Generator<Obstacle> {
    for (const chunk of this.chunks.values()) {
      for (const o of chunk.obstacles) if (!o.hit) yield o;
    }
  }

  *activePickups(): Generator<Pickup> {
    for (const chunk of this.chunks.values()) {
      for (const p of chunk.pickups) if (!p.taken) yield p;
    }
  }

  *activeGates(): Generator<Gate> {
    for (const chunk of this.chunks.values()) {
      for (const g of chunk.gates) if (!g.passed) yield g;
    }
  }

  /** Spins the coins so they catch the light. */
  animate(dt: number): void {
    for (const chunk of this.chunks.values()) {
      for (const p of chunk.pickups) {
        if (!p.taken) p.mesh.rotation.z += dt * 2.6;
      }
    }
  }

  reset(): void {
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    this.stations = [];
    this.curvature = 0;
    this.targetCurvature = 0;
    this.sinceTarget = 0;
    this.nextGateDist = CHECKPOINT_SPACING;
    this.ensureStations(SEGS_PER_CHUNK * (CHUNKS_AHEAD + 2));
  }
}
