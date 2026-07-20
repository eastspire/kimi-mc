import * as THREE from 'three';
import { RENDER_DIST } from './chunk-manager';

// ============================================================
// 天空 / 昼夜循环：天空色渐变 + 雾同步 + 太阳/月亮方块
// 无阴影贴图，明暗主要靠面烘焙 + 全局亮度系数
// ============================================================

const DAY_LENGTH = 600; // 一昼夜（秒）

const SKY_DAY = new THREE.Color(0x78a7ff);
const SKY_NIGHT = new THREE.Color(0x06060f);
const SKY_SUNSET = new THREE.Color(0xe8964a);

function makeSunTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffe98a';
  ctx.fillRect(4, 4, 24, 24);
  ctx.fillStyle = '#fff6c0';
  ctx.fillRect(8, 8, 16, 16);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

function makeMoonTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d8dce8';
  ctx.fillRect(6, 6, 20, 20);
  ctx.fillStyle = '#b8bcc8';
  ctx.fillRect(10, 10, 5, 5);
  ctx.fillRect(18, 16, 4, 4);
  ctx.fillRect(12, 20, 3, 3);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

export class Sky {
  // 从上午开始：ang = time/DAY_LENGTH*2π - π/2，需 sin(ang) > 0 才是白天
  private time = DAY_LENGTH * 0.3;
  private skyColor = new THREE.Color();
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  /** 全局亮度系数（0.2 夜 ~ 1.0 昼），由 main 应用到材质 */
  daylight = 1;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    const far = RENDER_DIST * 16;
    scene.fog = new THREE.Fog(0x78a7ff, far * 0.55, far * 0.95);

    const geo = new THREE.PlaneGeometry(28, 28);
    this.sun = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: makeSunTexture(), fog: false, transparent: true }));
    this.moon = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ map: makeMoonTexture(), fog: false, transparent: true }));
    scene.add(this.sun, this.moon);
  }

  update(dt: number, camera: THREE.PerspectiveCamera, tinted: THREE.Material[]): void {
    this.time = (this.time + dt) % DAY_LENGTH;
    const ang = (this.time / DAY_LENGTH) * Math.PI * 2 - Math.PI / 2;
    const sunY = Math.sin(ang); // >0 白天
    const sunX = Math.cos(ang);

    // 亮度：平滑过渡，夜里保底 0.22
    const t = THREE.MathUtils.smoothstep(sunY, -0.12, 0.25);
    this.daylight = 0.22 + 0.78 * t;

    // 天空色：昼/夜插值，日出日落混入橙
    this.skyColor.lerpColors(SKY_NIGHT, SKY_DAY, t);
    const sunset = Math.max(0, 1 - Math.abs(sunY) * 4) * 0.7;
    this.skyColor.lerp(SKY_SUNSET, sunset);

    (this.scene.fog as THREE.Fog).color.copy(this.skyColor);
    this.renderer.setClearColor(this.skyColor);

    for (const m of tinted) {
      const mat = m as THREE.MeshBasicMaterial;
      mat.color.setScalar(this.daylight);
    }

    // 太阳/月亮位置（跟随相机，距离略小于雾远平面）
    const dist = RENDER_DIST * 16 * 0.9;
    const dir = new THREE.Vector3(sunX, sunY, 0.25).normalize();
    this.sun.position.copy(camera.position).addScaledVector(dir, dist);
    this.sun.lookAt(camera.position);
    this.sun.visible = sunY > -0.15;
    this.moon.position.copy(camera.position).addScaledVector(dir, -dist);
    this.moon.lookAt(camera.position);
    this.moon.visible = sunY < 0.15;
  }

  get day(): number {
    return Math.floor(this.time / DAY_LENGTH) + 1;
  }

  get timeOfDay(): number {
    return this.time / DAY_LENGTH;
  }
}
