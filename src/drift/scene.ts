import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';

export type Quality = 'high' | 'medium' | 'low';

/** Dusk palette; every material and light is tuned against these. */
export const PALETTE = {
  skyTop: new THREE.Color(0x1a1040),
  skyMid: new THREE.Color(0x56265c),
  skyLow: new THREE.Color(0xd8663a),
  sun: new THREE.Color(0xffc489),
  fog: new THREE.Color(0x5b3466),
  ground: new THREE.Color(0x3e2d52),
  road: new THREE.Color(0x3a3446),
};

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Three-stop vertical gradient plus a soft glow around the sun direction.
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 top;
  uniform vec3 mid;
  uniform vec3 low;
  uniform vec3 sunColor;
  uniform vec3 sunDir;

  void main() {
    float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(low, mid, smoothstep(0.34, 0.62, h));
    col = mix(col, top, smoothstep(0.58, 0.96, h));

    float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
    col += sunColor * pow(d, 90.0) * 0.85;
    col += sunColor * pow(d, 8.0) * 0.10;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly sun: THREE.DirectionalLight;

  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private sky: THREE.Mesh;
  private quality: Quality = 'high';
  private width = 1;
  private height = 1;

  /** Direction the sun sits in, used by both the light and the sky shader. */
  private readonly sunDir = new THREE.Vector3(0.78, 0.30, 0.5).normalize();

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 1400);
    this.camera.position.set(0, 6, -12);

    this.scene.fog = new THREE.Fog(PALETTE.fog, 90, 420);

    // Sky dome. Rendered from the inside and never written to the depth
    // buffer, so it can be tiny relative to the far plane.
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: PALETTE.skyTop },
        mid: { value: PALETTE.skyMid },
        low: { value: PALETTE.skyLow },
        sunColor: { value: PALETTE.sun },
        sunDir: { value: this.sunDir },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);

    const hemi = new THREE.HemisphereLight(0xffb27a, 0x3a2b52, 0.8);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xffc99a, 2.6);
    this.sun.position.copy(this.sunDir).multiplyScalar(120);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // A cool fill from behind the camera keeps the car's shaded side readable
    // while the sun backlights the scene.
    const fill = new THREE.DirectionalLight(0x8f9bff, 0.55);
    fill.position.set(-70, 55, -80);
    this.scene.add(fill);

    // A floor of ambient light so nothing in shadow reads as pure black.
    this.scene.add(new THREE.AmbientLight(0x4a3a6e, 0.45));

    this.setQuality(quality);
  }

  setQuality(quality: Quality): void {
    this.quality = quality;

    const maxPr = quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPr));

    const shadows = quality !== 'low';
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.sun.castShadow = shadows;
    if (shadows) {
      const size = quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      const cam = this.sun.shadow.camera;
      cam.near = 1;
      cam.far = 400;
      cam.left = -70;
      cam.right = 70;
      cam.top = 70;
      cam.bottom = -70;
      this.sun.shadow.bias = -0.0012;
      this.sun.shadow.normalBias = 0.6;
      cam.updateProjectionMatrix();
    }

    this.buildComposer();
    this.resize(this.width, this.height);
  }

  private buildComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    if (this.quality === 'low') return;

    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    // Threshold sits at 1.0 so only genuine highlights (lights, the sun disc,
    // emissive trim) bloom; below that the sky itself washes the frame out.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      this.quality === 'high' ? 0.38 : 0.28,
      0.6,
      1.0,
    );
    composer.addPass(this.bloom);

    const vignette = new ShaderPass(VignetteShader);
    vignette.uniforms.offset.value = 1.3;
    vignette.uniforms.darkness.value = 0.8;
    composer.addPass(vignette);

    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.composer?.setSize(this.width, this.height);
    this.bloom?.setSize(this.width, this.height);
  }

  /** Keeps the sky centred on the camera and the shadow box over the car. */
  follow(target: THREE.Vector3): void {
    this.sky.position.copy(this.camera.position);
    this.sun.position.copy(this.sunDir).multiplyScalar(120).add(target);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.composer?.dispose();
    this.renderer.dispose();
  }
}

/** Picks a starting quality from what the device reports. */
export function detectQuality(): Quality {
  const mem = (navigator as any).deviceMemory as number | undefined;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mem !== undefined && mem <= 2) return 'low';
  if (cores <= 4 && mobile) return 'medium';
  if (mobile) return 'medium';
  return 'high';
}
