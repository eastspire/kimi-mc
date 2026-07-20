import * as THREE from 'three';
import { RENDER_DIST } from './chunk-manager';

// ============================================================
// 天空 / 昼夜循环：天空色渐变 + 雾同步 + 太阳/月亮方块 + 星空
// 无阴影贴图，明暗主要靠面烘焙 + 全局亮度系数
// time 为累计秒数（不取模），day = floor(time/DAY_LENGTH)+1
// ============================================================

export const DAY_LENGTH = 600; // 一昼夜（秒）

const SKY_DAY = new THREE.Color(0x78a7ff);
const SKY_NIGHT = new THREE.Color(0x06060f);
const SKY_SUNSET = new THREE.Color(0xe8964a);
const STAR_COUNT = 600;
const STAR_RADIUS = 480; // < camera.far

/** 确定性伪随机（星星固定图案） */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function makeStars(): { points: THREE.Points; mat: THREE.PointsMaterial } {
  const rand = mulberry32(42);
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // 均匀球面散布
    const u = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u) * STAR_RADIUS;
    positions[i * 3] = r * Math.cos(phi);
    positions[i * 3 + 1] = u * STAR_RADIUS;
    positions[i * 3 + 2] = r * Math.sin(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, mat };
}

export class Sky {
  // 从上午开始：ang = time/DAY_LENGTH*2π - π/2，需 sin(ang) > 0 才是白天
  private time = DAY_LENGTH * 0.3;
  private skyColor = new THREE.Color();
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private underwater = false;
  private readonly dirV = new THREE.Vector3(); // 复用，避免每帧分配
  /** 渲染距离（区块），运行时可调，雾与天体距离随之更新 */
  private dist = RENDER_DIST;
  /** 全局亮度系数（0.2 夜 ~ 1.0 昼），由 main 应用到材质 */
  daylight = 1;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    const far = this.dist * 16;
    scene.fog = new THREE.Fog(0x78a7ff, far * 0.55, far * 0.95);

    const geo = new THREE.PlaneGeometry(28, 28);
    this.sun = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: makeSunTexture(), fog: false, transparent: true }));
    this.moon = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ map: makeMoonTexture(), fog: false, transparent: true }));
    const s = makeStars();
    this.stars = s.points;
    this.starMat = s.mat;
    scene.add(this.sun, this.moon, this.stars);
  }

  /** 正常（非水下）雾距，供主循环出水恢复 */
  normalFog(): { near: number; far: number } {
    const far = this.dist * 16;
    return { near: far * 0.55, far: far * 0.95 };
  }

  /** 渲染距离变化：雾立即同步（水下时不覆盖水下近雾），天体距离随下一帧更新 */
  setRenderDist(r: number): void {
    this.dist = r;
    const nf = this.normalFog();
    const fog = this.scene.fog as THREE.Fog;
    fog.far = nf.far;
    if (!this.underwater) fog.near = nf.near;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, tinted: THREE.Material[]): void {
    this.time += dt; // 累计不取模，天数由此推出
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

    // 太阳/月亮位置（跟随相机，距离略小于雾远平面，180° 相对）
    const vis = !this.underwater;
    const dist = this.dist * 16 * 0.9;
    const dir = this.dirV.set(sunX, sunY, 0.25).normalize(); // 复用向量，热循环零分配
    this.sun.position.copy(camera.position).addScaledVector(dir, dist);
    this.sun.lookAt(camera.position);
    this.sun.visible = vis && sunY > -0.15;
    this.moon.position.copy(camera.position).addScaledVector(dir, -dist);
    this.moon.lookAt(camera.position);
    this.moon.visible = vis && sunY < 0.15;

    // 星星：仅夜间渐显，随时间缓慢旋转，跟随相机
    this.stars.position.copy(camera.position);
    this.stars.rotation.y = ang * 0.5;
    const starOp = THREE.MathUtils.clamp(-sunY * 5, 0, 1) * 0.9;
    this.starMat.opacity = vis ? starOp : 0;
    this.stars.visible = this.starMat.opacity > 0.01;
  }

  get day(): number {
    return Math.floor(this.time / DAY_LENGTH) + 1;
  }

  get timeOfDay(): number {
    return (this.time % DAY_LENGTH) / DAY_LENGTH;
  }

  /** 累计秒数（含天数信息），存档用 */
  get timeValue(): number {
    return this.time;
  }

  /** 恢复存档 / 调试：直接设定累计秒数 */
  setTime(t: number): void {
    this.time = Number.isFinite(t) && t >= 0 ? t : DAY_LENGTH * 0.3;
  }

  /** 水下时隐藏天体（雾由 main 切换） */
  setUnderwater(u: boolean): void {
    this.underwater = u;
  }
}
