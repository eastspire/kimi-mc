import * as THREE from 'three';

// ============================================================
// 生物模型：MC 经典 64×32 皮肤布局 + 盒体拼装
// 贴图为程序生成（与方块图集同风格，零外部资源依赖），
// 几何体/材质按生物类型全局缓存共享，每只生物仅新建 Mesh 节点。
// 16 像素 = 1 格；模型正面朝 -Z（与玩家 yaw 约定一致）。
// 每种类型另备一份“受伤红闪”材质，命中时整只切换 0.25s。
// ============================================================

const PX = 1 / 16;
const TEX_W = 64;
const TEX_H = 32;

type Vec3 = [number, number, number];

/** 添加一个矩形面：c 中心，uAxis/vAxis 为贴图 u/v 增长方向（单位向量），
 *  hu/hv 为沿两轴的半长，rect 为贴图像素区域 (px,py,pw,ph)。
 *  法线 = vAxis × uAxis（外向），顶点顺序已按外向缠绕。 */
function quad(
  pos: number[],
  nor: number[],
  uv: number[],
  idx: number[],
  c: Vec3,
  uAxis: Vec3,
  vAxis: Vec3,
  hu: number,
  hv: number,
  rect: [number, number, number, number],
): void {
  const base = pos.length / 3;
  const [px, py, pw, ph] = rect;
  const n: Vec3 = [
    vAxis[1] * uAxis[2] - vAxis[2] * uAxis[1],
    vAxis[2] * uAxis[0] - vAxis[0] * uAxis[2],
    vAxis[0] * uAxis[1] - vAxis[1] * uAxis[0],
  ];
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const [s, t] of corners) {
    pos.push(
      c[0] + s * hu * uAxis[0] + t * hv * vAxis[0],
      c[1] + s * hu * uAxis[1] + t * hv * vAxis[1],
      c[2] + s * hu * uAxis[2] + t * hv * vAxis[2],
    );
    nor.push(n[0], n[1], n[2]);
    uv.push(
      (px + ((s + 1) / 2) * pw) / TEX_W,
      1 - (py + ((t + 1) / 2) * ph) / TEX_H,
    );
  }
  idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/** MC 标准盒体 UV 布局（与 ModelRenderer.addBox 一致）：
 *      [top w×d][bottom w×d]
 *  [west d×h][north w×h][east d×h][south w×h] */
export function mcBox(
  w: number,
  h: number,
  d: number,
  u: number,
  v: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const hx = (w / 2) * PX;
  const hy = (h / 2) * PX;
  const hz = (d / 2) * PX;
  // top (+y)
  quad(pos, nor, uv, idx, [0, hy, 0], [1, 0, 0], [0, 0, 1], hx, hz, [u + d, v, w, d]);
  // bottom (-y)
  quad(pos, nor, uv, idx, [0, -hy, 0], [1, 0, 0], [0, 0, -1], hx, hz, [u + d + w, v, w, d]);
  // north (-z, 正面)
  quad(pos, nor, uv, idx, [0, 0, -hz], [-1, 0, 0], [0, -1, 0], hx, hy, [u + d, v + d, w, h]);
  // south (+z)
  quad(pos, nor, uv, idx, [0, 0, hz], [1, 0, 0], [0, -1, 0], hx, hy, [u + 2 * d + w, v + d, w, h]);
  // east (+x)
  quad(pos, nor, uv, idx, [hx, 0, 0], [0, 0, -1], [0, -1, 0], hz, hy, [u + d + w, v + d, d, h]);
  // west (-x)
  quad(pos, nor, uv, idx, [-hx, 0, 0], [0, 0, 1], [0, -1, 0], hz, hy, [u, v + d, d, h]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

// ------------------------------------------------------------
// 程序皮肤
// ------------------------------------------------------------

function makeTexture(paint: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  paint(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function paintPig(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const skin = '#f0a5a2';
  const dark = '#d98f8d';
  // 头部（含各面）
  f(0, 0, 32, 16, skin);
  // 鼻部区域
  f(16, 16, 10, 4, skin);
  f(17, 17, 4, 3, '#e09391'); // 鼻正面
  f(18, 18, 1, 1, '#9e5f5e'); // 鼻孔
  f(20, 18, 1, 1, '#9e5f5e');
  // 眼睛（头正面区域 (8,8) 起）
  f(9, 12, 1, 1, '#402626');
  f(14, 12, 1, 1, '#402626');
  // 身体
  f(28, 8, 36, 24, skin);
  // 腿（底两排深色作蹄）
  f(0, 16, 16, 12, skin);
  f(0, 24, 16, 2, dark);
}

function paintSheep(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const wool = '#e8e8e8';
  const woolDark = '#d4d4d4';
  const face = '#c8b8a8';
  // 头部整体羊毛色
  f(0, 0, 32, 16, wool);
  // 头正面（6×6 盒 north 面区域 (6,6)-(12,12)）：灰色脸 + 眼睛
  f(6, 6, 6, 6, face);
  f(7, 9, 1, 1, '#202020');
  f(10, 9, 1, 1, '#202020');
  // 身体：羊毛底 + 不规则深斑（卷毛感）
  f(28, 8, 36, 24, wool);
  for (let i = 0; i < 26; i++) {
    const x = 28 + ((i * 7) % 36);
    const y = 8 + ((i * 11) % 24);
    f(x, y, 2, 1, woolDark);
  }
  // 腿：灰毛 + 深色蹄
  f(0, 16, 16, 12, face);
  f(0, 26, 16, 2, '#8a7a68');
}

function paintCow(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const hide = '#6e4a2f';
  const hideDark = '#5a3a24';
  const cream = '#e8dcc8';
  // 头部
  f(0, 0, 32, 16, hide);
  // 头正面（8×8 盒 north 面区域 (8,8)-(16,16)）：口鼻浅色 + 眼睛
  f(9, 11, 6, 4, '#d8b8a0');
  f(10, 12, 1, 1, '#8a5a48'); // 鼻孔
  f(13, 12, 1, 1, '#8a5a48');
  f(9, 9, 1, 1, '#1a1010');
  f(14, 9, 1, 1, '#1a1010');
  // 角区域 (40,0)：灰白
  f(40, 0, 8, 8, '#d8d0c0');
  // 身体：棕底 + 奶油色大块斑
  f(28, 8, 36, 24, hide);
  f(34, 10, 8, 6, cream);
  f(46, 14, 7, 5, cream);
  f(38, 20, 5, 4, cream);
  f(52, 22, 6, 4, cream);
  // 腿：棕 + 深蹄
  f(0, 16, 16, 12, hide);
  f(0, 26, 16, 2, hideDark);
}

function paintChicken(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const feather = '#f0f0f0';
  const featherDark = '#d8d8d8';
  // 头部（4×4×4 盒 north 面区域 (2,2)-(6,6)）：眼 + 红冠
  f(0, 0, 32, 16, feather);
  f(2, 3, 1, 1, '#202020');
  f(5, 3, 1, 1, '#202020');
  f(3, 1, 2, 1, '#d83028'); // 冠
  f(3, 5, 2, 2, '#d83028'); // 肉垂
  // 喙区域 (20,0)：黄
  f(20, 0, 8, 6, '#e8a820');
  // 身体：白 + 浅灰羽斑
  f(28, 8, 36, 24, feather);
  for (let i = 0; i < 18; i++) {
    f(28 + ((i * 9) % 36), 8 + ((i * 7) % 24), 2, 1, featherDark);
  }
  // 腿：黄
  f(0, 16, 16, 12, '#e8a820');
}

function paintSkeleton(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const bone = '#d0d0d0';
  const boneDark = '#a8a8a8';
  // 头部
  f(0, 0, 32, 16, bone);
  // 头正面 (8,8)-(16,16)：深眼窝 + 鼻洞 + 颌线
  f(10, 11, 2, 2, '#3a3a3a');
  f(13, 11, 2, 2, '#3a3a3a');
  f(11, 13, 1, 1, '#4a4a4a');
  f(12, 13, 1, 1, '#4a4a4a');
  f(9, 14, 7, 1, boneDark);
  // 躯干：肋骨纹
  f(16, 16, 24, 16, bone);
  f(16, 20, 24, 1, boneDark);
  f(16, 24, 24, 1, boneDark);
  // 手臂：骨节
  f(40, 16, 16, 16, bone);
  f(40, 22, 16, 1, boneDark);
  // 腿
  f(0, 16, 16, 16, bone);
  f(0, 30, 16, 2, boneDark);
}

function paintCreeper(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const skin = '#4a8a2a';
  const dark = '#3a6a20';
  const light = '#5a9a34';
  // 头部：绿底斑驳
  f(0, 0, 32, 16, skin);
  for (let i = 0; i < 12; i++) f((i * 7) % 32, (i * 5) % 16, 2, 2, i % 2 ? dark : light);
  // 头正面 (8,8)-(16,16)：黑色苦脸（双眼 + 下垂嘴）
  f(10, 10, 2, 3, '#101010');
  f(13, 10, 2, 3, '#101010');
  f(11, 13, 3, 1, '#101010');
  f(10, 14, 1, 2, '#101010');
  f(14, 14, 1, 2, '#101010');
  f(11, 15, 3, 1, '#101010');
  // 身体：绿底斑驳
  f(16, 16, 24, 16, skin);
  for (let i = 0; i < 14; i++)
    f(16 + ((i * 9) % 24), 16 + ((i * 7) % 16), 2, 2, i % 2 ? dark : light);
  // 腿：深绿
  f(0, 16, 16, 16, dark);
  f(0, 28, 16, 4, '#2c5018');
}

function paintSpider(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const body = '#3a3230';
  const dark = '#2a2422';
  const light = '#4a423e';
  // 头部 (0,0)-(32,16)：棕黑底
  f(0, 0, 32, 16, body);
  // 头正面 (8,8)-(16,16)：红色复眼（MC 蜘蛛红眼）
  f(9, 10, 2, 2, '#c02818');
  f(13, 10, 2, 2, '#c02818');
  f(10, 13, 1, 1, '#701008');
  f(13, 13, 1, 1, '#701008');
  // 身体 (16,16)：深棕 + 浅色背纹
  f(16, 16, 40, 16, body);
  for (let i = 0; i < 10; i++) f(18 + ((i * 7) % 36), 18 + ((i * 5) % 12), 2, 1, light);
  f(16, 16, 40, 2, dark);
  // 腿 (0,16)：深棕
  f(0, 16, 16, 16, dark);
}

/** 末影人：通体近黑 + 紫色眼睛（MC 标志性） */
function paintEnderman(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const body = '#161616';
  const dark = '#0e0e0e';
  const light = '#1f1f1f';
  // 头部 (0,0)-(32,16)
  f(0, 0, 32, 16, body);
  // 紫色发光眼（头正面 (8,8)-(16,16)）
  f(9, 11, 2, 1, '#c04ee8');
  f(13, 11, 2, 1, '#c04ee8');
  f(9, 12, 2, 1, '#7a1fa8');
  f(13, 12, 2, 1, '#7a1fa8');
  // 躯干/四肢：近黑带轻微色差
  f(16, 16, 24, 16, body);
  f(40, 16, 16, 16, dark);
  f(0, 16, 16, 16, dark);
  for (let i = 0; i < 8; i++) f(16 + ((i * 7) % 24), 16 + ((i * 5) % 16), 1, 1, light);
}

function paintZombie(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const skin = '#527a40';
  const shirt = '#3fa8a4';
  const pants = '#3b4a9a';
  // 头部
  f(0, 0, 32, 16, skin);
  // 眼睛
  f(10, 12, 1, 1, '#1c2b16');
  f(13, 12, 1, 1, '#1c2b16');
  // 躯干（衬衫）
  f(16, 16, 24, 16, shirt);
  // 手臂（衬衫袖 + 底三排绿手）
  f(40, 16, 16, 16, shirt);
  f(40, 29, 16, 3, skin);
  // 腿（长裤 + 底两排深色鞋）
  f(0, 16, 16, 16, pants);
  f(0, 30, 16, 2, '#2c2c3c');
}

/** 僵尸猪灵：腐肉粉躯体 + 猪鼻 + 金剑（人形同僵尸盒布局） */
function paintZombiePiglin(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const flesh = '#e08a8a';
  const rot = '#b8656a';
  const cloth = '#7a4a2a';
  // 头部（粉腐肉 + 局部腐烂斑）
  f(0, 0, 32, 16, flesh);
  for (let i = 0; i < 8; i++) f((i * 5) % 30, (i * 3) % 14, 2, 2, rot);
  // 猪鼻（头正面中部）
  f(10, 10, 4, 3, '#d97a7a');
  f(11, 11, 1, 1, '#7a3a3a');
  f(13, 11, 1, 1, '#7a3a3a');
  // 眼（一好一腐）
  f(9, 8, 1, 1, '#2a1a1a');
  f(14, 8, 1, 1, '#e8e8e8');
  // 躯干：裸露腐肉 + 腰布
  f(16, 16, 24, 10, flesh);
  f(16, 26, 24, 6, cloth);
  for (let i = 0; i < 6; i++) f(16 + ((i * 7) % 22), 16 + ((i * 3) % 8), 2, 2, rot);
  // 手臂：腐肉（右手持金剑，由几何另加）
  f(40, 16, 16, 16, flesh);
  f(40, 29, 16, 3, rot);
  // 腿：腐肉 + 深色蹄
  f(0, 16, 16, 16, flesh);
  f(0, 30, 16, 2, '#5a2a2a');
}

/** 恶魂：惨白大头（哭脸）+ 同色触手区（64×32 布局，头 16px 盒 UV） */
function paintGhast(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const pale = '#f0f0f0';
  const shade = '#d8d8d8';
  // 整张贴图铺惨白底（头 16px 盒覆盖 (0,0)-(64,32) 各面区）
  f(0, 0, 64, 32, pale);
  // 轻微色差斑
  for (let i = 0; i < 20; i++) f((i * 11) % 62, (i * 7) % 30, 2, 1, shade);
  // 哭脸：north 面（正面）区域 (16,16)-(32,32)
  f(20, 21, 2, 4, '#4a4a4a'); // 左眼（垂泪）
  f(26, 21, 2, 4, '#4a4a4a'); // 右眼
  f(21, 27, 6, 1, '#5a5a5a'); // 嘴
  f(20, 28, 1, 2, '#5a5a5a');
  f(27, 28, 1, 2, '#5a5a5a');
}

/** 村民：棕长袍 + 光头大鼻子（人形盒 + 独立鼻盒） */
function paintVillager(ctx: CanvasRenderingContext2D): void {
  const f = (x: number, y: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const skin = '#c89a6a';
  const robe = '#8a6a4a';
  const robeDark = '#6e5238';
  // 头部：皮肤色（光头）
  f(0, 0, 32, 16, skin);
  // 浓眉 + 绿眼（头正面 (8,8)-(16,16)）
  f(9, 10, 3, 1, '#4a3a28');
  f(13, 10, 3, 1, '#4a3a28');
  f(10, 12, 1, 1, '#3a6a3a');
  f(14, 12, 1, 1, '#3a6a3a');
  // 鼻子（鼻盒 UV 区 (24,0) 起，统一肤色略深）
  f(24, 0, 8, 8, '#b8885a');
  // 躯干/四肢：长袍
  f(16, 16, 24, 16, robe);
  f(40, 16, 16, 16, robe); // 臂（交叠藏袍内，简化同色）
  f(0, 16, 16, 16, robe);  // 腿
  // 袍边 + 腰带
  for (let i = 0; i < 16; i++) {
    f(16 + i, 20, 1, 1, robeDark); // 胸带
    f(i, 28, 1, 1, robeDark);      // 袍摆
  }
}

// ------------------------------------------------------------
// 模型装配（几何/材质缓存，跨个体共享）
// ------------------------------------------------------------

export interface MobModel {
  group: THREE.Group;
  /** 头部枢轴（预留注视摆动） */
  head: THREE.Group;
  /** 腿枢轴（行走摆动）；猪 4 条 [左前,右前,左后,右后]，僵尸 2 条 [左,右] */
  legs: THREE.Group[];
  /** 手臂枢轴（僵尸前举，攻击时下压） */
  arms: THREE.Group[];
  /** 手臂基准仰角：僵尸恒前举 π/2，骷髅平时垂臂 0（射箭时抬起） */
  armBase?: number;
  /** 所有网格（受伤材质整只切换用） */
  meshes: THREE.Mesh[];
  material: THREE.MeshBasicMaterial;
  /** 受伤红闪材质 */
  hurtMaterial: THREE.MeshBasicMaterial;
}

interface MobAssets {
  material: THREE.MeshBasicMaterial;
  hurt: THREE.MeshBasicMaterial;
  geo: Record<string, THREE.BufferGeometry>;
}

let pigAssets: MobAssets | null = null;
let zombieAssets: MobAssets | null = null;
let sheepAssets: MobAssets | null = null;
let cowAssets: MobAssets | null = null;
let chickenAssets: MobAssets | null = null;
let skeletonAssets: MobAssets | null = null;
let creeperAssets: MobAssets | null = null;
let spiderAssets: MobAssets | null = null;
let endermanAssets: MobAssets | null = null;
let zombiePiglinAssets: MobAssets | null = null;
let ghastAssets: MobAssets | null = null;
let villagerAssets: MobAssets | null = null;

function makeAssets(paint: (ctx: CanvasRenderingContext2D) => void, geo: MobAssets['geo']): MobAssets {
  const tex = makeTexture(paint);
  return {
    material: new THREE.MeshBasicMaterial({ map: tex }),
    hurt: new THREE.MeshBasicMaterial({ map: tex, color: 0xff5544 }),
    geo,
  };
}

function getPigAssets(): MobAssets {
  if (!pigAssets) {
    pigAssets = makeAssets(paintPig, {
      body: mcBox(10, 8, 16, 28, 8),
      head: mcBox(8, 8, 8, 0, 0),
      snout: mcBox(4, 3, 1, 16, 16),
      leg: mcBox(4, 6, 4, 0, 16),
    });
  }
  return pigAssets;
}

function getZombieAssets(): MobAssets {
  if (!zombieAssets) {
    zombieAssets = makeAssets(paintZombie, {
      body: mcBox(8, 12, 4, 16, 16),
      head: mcBox(8, 8, 8, 0, 0),
      arm: mcBox(4, 12, 4, 40, 16),
      leg: mcBox(4, 12, 4, 0, 16),
    });
  }
  return zombieAssets;
}

function getSheepAssets(): MobAssets {
  if (!sheepAssets) {
    sheepAssets = makeAssets(paintSheep, {
      body: mcBox(8, 6, 14, 28, 8),
      head: mcBox(6, 6, 6, 0, 0),
      leg: mcBox(4, 6, 4, 0, 16),
    });
  }
  return sheepAssets;
}

function getCowAssets(): MobAssets {
  if (!cowAssets) {
    cowAssets = makeAssets(paintCow, {
      body: mcBox(10, 8, 16, 28, 8),
      head: mcBox(8, 8, 8, 0, 0),
      horn: mcBox(1, 2, 1, 40, 0),
      leg: mcBox(4, 6, 4, 0, 16),
    });
  }
  return cowAssets;
}

function getChickenAssets(): MobAssets {
  if (!chickenAssets) {
    chickenAssets = makeAssets(paintChicken, {
      body: mcBox(6, 6, 8, 28, 8),
      head: mcBox(4, 4, 4, 0, 0),
      beak: mcBox(2, 2, 2, 20, 0),
      leg: mcBox(2, 6, 2, 0, 16),
    });
  }
  return chickenAssets;
}

function getSkeletonAssets(): MobAssets {
  if (!skeletonAssets) {
    skeletonAssets = makeAssets(paintSkeleton, {
      body: mcBox(8, 12, 4, 16, 16),
      head: mcBox(8, 8, 8, 0, 0),
      arm: mcBox(4, 12, 4, 40, 16),
      leg: mcBox(4, 12, 4, 0, 16),
    });
  }
  return skeletonAssets;
}

function getCreeperAssets(): MobAssets {
  if (!creeperAssets) {
    creeperAssets = makeAssets(paintCreeper, {
      body: mcBox(8, 12, 4, 16, 16),
      head: mcBox(8, 8, 8, 0, 0),
      leg: mcBox(4, 6, 4, 0, 16),
    });
  }
  return creeperAssets;
}

function getSpiderAssets(): MobAssets {
  if (!spiderAssets) {
    spiderAssets = makeAssets(paintSpider, {
      body: mcBox(12, 6, 10, 16, 16),
      head: mcBox(8, 6, 8, 0, 0),
      leg: mcBox(6, 1, 1, 0, 16),
    });
  }
  return spiderAssets;
}

function getEndermanAssets(): MobAssets {
  if (!endermanAssets) {
    // 3 格高（48px）：躯干 12px，腿 30px，臂 30px（细长）
    endermanAssets = makeAssets(paintEnderman, {
      body: mcBox(8, 12, 4, 16, 16),
      head: mcBox(8, 8, 8, 0, 0),
      arm: mcBox(3, 30, 3, 40, 16),
      leg: mcBox(3, 30, 3, 0, 16),
    });
  }
  return endermanAssets;
}

function getZombiePiglinAssets(): MobAssets {
  if (!zombiePiglinAssets) {
    // 与僵尸同盒布局（人形 2 格高），皮肤为猪灵
    zombiePiglinAssets = makeAssets(paintZombiePiglin, {
      body: mcBox(8, 12, 4, 16, 16),
      head: mcBox(8, 8, 8, 0, 0),
      arm: mcBox(4, 12, 4, 40, 16),
      leg: mcBox(4, 12, 4, 0, 16),
    });
  }
  return zombiePiglinAssets;
}

function getGhastAssets(): MobAssets {
  if (!ghastAssets) {
    // 头 16px（1 格）+ 9 触手；mcBox UV 布局要求头≤16px 才不越 64×32 贴图
    // （模型经整体放大到恶魂尺寸，见 buildGhastModel）
    ghastAssets = makeAssets(paintGhast, {
      head: mcBox(16, 16, 16, 0, 0),
      tentacle: mcBox(2, 8, 2, 48, 0),
    });
  }
  return ghastAssets;
}

function getVillagerAssets(): MobAssets {
  if (!villagerAssets) {
    // 人形 + 独立大鼻盒（鼻 UV 区 (24,0)）
    villagerAssets = makeAssets(paintVillager, {
      body: mcBox(8, 12, 4, 16, 16),
      head: mcBox(8, 8, 8, 0, 0),
      nose: mcBox(2, 4, 2, 24, 0),
      arm: mcBox(4, 12, 4, 40, 16),
      leg: mcBox(4, 12, 4, 0, 16),
    });
  }
  return villagerAssets;
}

export function buildPigModel(): MobModel {
  const a = getPigAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 10 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 12 * PX, -6 * PX);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.z = -4 * PX;
  const snout = add(new THREE.Mesh(a.geo.snout, a.material));
  snout.position.set(0, 1.5 * PX, -8.5 * PX);
  head.add(headMesh, snout);
  group.add(head);

  const legs: THREE.Group[] = [];
  // [左前, 右前, 左后, 右后]
  const spots: [number, number][] = [
    [-3, -5],
    [3, -5],
    [-3, 5],
    [3, 5],
  ];
  for (const [lx, lz] of spots) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 6 * PX, lz * PX);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -3 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms: [], meshes, material: a.material, hurtMaterial: a.hurt };
}

export function buildZombieModel(): MobModel {
  const a = getZombieAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 18 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 24 * PX, 0);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.y = 4 * PX;
  head.add(headMesh);
  group.add(head);

  const arms: THREE.Group[] = [];
  for (const ax of [-6, 6]) {
    const pivot = new THREE.Group();
    pivot.position.set(ax * PX, 22 * PX, 0);
    pivot.rotation.x = Math.PI / 2; // 僵尸经典前举臂
    const mesh = add(new THREE.Mesh(a.geo.arm, a.material));
    mesh.position.y = -4 * PX;
    pivot.add(mesh);
    group.add(pivot);
    arms.push(pivot);
  }

  const legs: THREE.Group[] = [];
  for (const lx of [-2, 2]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 12 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -6 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms, meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 受伤红闪开关（整只切换材质，正常/红闪各一份共享材质，零分配） */
export function setMobHurt(model: MobModel, on: boolean): void {
  const mat = on ? model.hurtMaterial : model.material;
  for (const m of model.meshes) m.material = mat;
}

/** 羊模型：白毛身体 + 灰脸四足（结构与猪类似，无鼻） */
export function buildSheepModel(): MobModel {
  const a = getSheepAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 10 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 12 * PX, -5 * PX);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.z = -3 * PX;
  head.add(headMesh);
  group.add(head);

  const legs: THREE.Group[] = [];
  const spots: [number, number][] = [
    [-2, -4],
    [2, -4],
    [-2, 4],
    [2, 4],
  ];
  for (const [lx, lz] of spots) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 6 * PX, lz * PX);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -3 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms: [], meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 牛模型：棕花身体 + 双角四足（结构同猪放大） */
export function buildCowModel(): MobModel {
  const a = getCowAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 10 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 12 * PX, -6 * PX);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.z = -4 * PX;
  head.add(headMesh);
  for (const hx of [-3, 3]) {
    const horn = add(new THREE.Mesh(a.geo.horn, a.material));
    horn.position.set(hx * PX, 4.5 * PX, -4 * PX);
    head.add(horn);
  }
  group.add(head);

  const legs: THREE.Group[] = [];
  const spots: [number, number][] = [
    [-3, -5],
    [3, -5],
    [-3, 5],
    [3, 5],
  ];
  for (const [lx, lz] of spots) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 6 * PX, lz * PX);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -3 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms: [], meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 鸡模型：白身小头 + 黄喙双腿（MC 小巧比例） */
export function buildChickenModel(): MobModel {
  const a = getChickenAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 9 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 11 * PX, -4 * PX);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.z = -2 * PX;
  const beak = add(new THREE.Mesh(a.geo.beak, a.material));
  beak.position.set(0, -0.5 * PX, -4.5 * PX);
  head.add(headMesh, beak);
  group.add(head);

  const legs: THREE.Group[] = [];
  for (const lx of [-1.5, 1.5]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 6 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -3 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms: [], meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 骷髅模型：结构同僵尸，手臂下垂（射箭时抬起，armBase=0） */
export function buildSkeletonModel(): MobModel {
  const a = getSkeletonAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 18 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 24 * PX, 0);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.y = 4 * PX;
  head.add(headMesh);
  group.add(head);

  const arms: THREE.Group[] = [];
  for (const ax of [-6, 6]) {
    const pivot = new THREE.Group();
    pivot.position.set(ax * PX, 22 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.arm, a.material));
    mesh.position.y = -4 * PX;
    pivot.add(mesh);
    group.add(pivot);
    arms.push(pivot);
  }

  const legs: THREE.Group[] = [];
  for (const lx of [-2, 2]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 12 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -6 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms, armBase: 0, meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 苦力怕模型：无臂、四短腿、高个绿身（MC 经典剪影） */
export function buildCreeperModel(): MobModel {
  const a = getCreeperAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 12 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 18 * PX, 0);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.y = 4 * PX;
  head.add(headMesh);
  group.add(head);

  const legs: THREE.Group[] = [];
  const spots: [number, number][] = [
    [-2, -2],
    [2, -2],
    [-2, 2],
    [2, 2],
  ];
  for (const [lx, lz] of spots) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 6 * PX, lz * PX);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -3 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms: [], meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 蜘蛛模型：低矮宽身 + 红眼头 + 每侧 4 条横伸细腿（MC 剪影） */
export function buildSpiderModel(): MobModel {
  const a = getSpiderAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 7 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 8 * PX, -6 * PX);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.z = -3 * PX;
  head.add(headMesh);
  group.add(head);

  // 每侧 4 条腿：腿根在身体两侧，向外横伸（绕 z 轴外张）
  const legs: THREE.Group[] = [];
  const zSlots = [-3, -1, 1, 3];
  for (const side of [-1, 1]) {
    for (const lz of zSlots) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 6 * PX, 7 * PX, lz * PX);
      pivot.rotation.z = side * -0.5; // 外张下压
      const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
      mesh.position.x = side * 3 * PX; // 腿从根部向外延伸
      pivot.add(mesh);
      group.add(pivot);
      legs.push(pivot);
    }
  }
  return { group, head, legs, arms: [], meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 末影人模型：3 格高细长腿臂，激怒时手臂前伸（armBase 0，攻击抬起） */
export function buildEndermanModel(): MobModel {
  const a = getEndermanAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  // 腿占 30px（1.875 格），躯干在其上
  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 36 * PX; // 躯干中心：腿 30 + 半身高 6
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 44 * PX, 0);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.y = 4 * PX;
  head.add(headMesh);
  group.add(head);

  const arms: THREE.Group[] = [];
  for (const ax of [-5.5, 5.5]) {
    const pivot = new THREE.Group();
    pivot.position.set(ax * PX, 40 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.arm, a.material));
    mesh.position.y = -13 * PX; // 长臂下垂
    pivot.add(mesh);
    group.add(pivot);
    arms.push(pivot);
  }

  const legs: THREE.Group[] = [];
  for (const lx of [-2, 2]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 30 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -15 * PX; // 长腿到地
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms, armBase: 0, meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 僵尸猪灵模型：人形同僵尸，但手臂垂放持剑（armBase 0，攻击抬起） */
export function buildZombiePiglinModel(): MobModel {
  const a = getZombiePiglinAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 18 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 24 * PX, 0);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.y = 4 * PX;
  head.add(headMesh);
  group.add(head);

  // 手臂垂放（持金剑姿态简化为下垂，攻击时抬起）
  const arms: THREE.Group[] = [];
  for (const ax of [-6, 6]) {
    const pivot = new THREE.Group();
    pivot.position.set(ax * PX, 22 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.arm, a.material));
    mesh.position.y = -4 * PX;
    pivot.add(mesh);
    group.add(pivot);
    arms.push(pivot);
  }

  const legs: THREE.Group[] = [];
  for (const lx of [-2, 2]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 12 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -6 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms, armBase: 0, meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 恶魂模型：1 格头（哭脸）+ 9 触手，整体放大到恶魂体量（约 4×4×4 格） */
export function buildGhastModel(): MobModel {
  const a = getGhastAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };
  const SCALE = 4; // 1 格头放大到 4 格恶魂头

  const head = new THREE.Group();
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  head.add(headMesh);
  group.add(head);

  // 9 条触手：3×3 排布于头底，下垂
  const legs: THREE.Group[] = [];
  for (let tx = -1; tx <= 1; tx++) {
    for (let tz = -1; tz <= 1; tz++) {
      const pivot = new THREE.Group();
      pivot.position.set(tx * 4 * PX, -8 * PX, tz * 4 * PX);
      const mesh = add(new THREE.Mesh(a.geo.tentacle, a.material));
      mesh.position.y = -4 * PX; // 触手下垂
      pivot.add(mesh);
      group.add(pivot);
      legs.push(pivot); // 触手挂 legs，由 syncModel 摆动
    }
  }
  group.scale.setScalar(SCALE);
  return { group, head, legs, arms: [], meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 村民模型：人形 + 大鼻子，手臂交叠藏袍内（armBase 0，简化下垂） */
export function buildVillagerModel(): MobModel {
  const a = getVillagerAssets();
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  const add = (m: THREE.Mesh): THREE.Mesh => {
    meshes.push(m);
    return m;
  };

  const body = add(new THREE.Mesh(a.geo.body, a.material));
  body.position.y = 18 * PX;
  group.add(body);

  const head = new THREE.Group();
  head.position.set(0, 24 * PX, 0);
  const headMesh = add(new THREE.Mesh(a.geo.head, a.material));
  headMesh.position.y = 4 * PX;
  // 大鼻子：头正面（-z）下方凸出
  const nose = add(new THREE.Mesh(a.geo.nose, a.material));
  nose.position.set(0, 1 * PX, -5 * PX);
  head.add(headMesh, nose);
  group.add(head);

  // 手臂交叠身前（MC 村民经典姿态：两臂合并前垂）
  const arms: THREE.Group[] = [];
  for (const ax of [-2, 2]) {
    const pivot = new THREE.Group();
    pivot.position.set(ax * PX, 20 * PX, -3 * PX);
    pivot.rotation.x = 0.4; // 略前倾
    const mesh = add(new THREE.Mesh(a.geo.arm, a.material));
    mesh.position.y = -4 * PX;
    pivot.add(mesh);
    group.add(pivot);
    arms.push(pivot);
  }

  const legs: THREE.Group[] = [];
  for (const lx of [-2, 2]) {
    const pivot = new THREE.Group();
    pivot.position.set(lx * PX, 12 * PX, 0);
    const mesh = add(new THREE.Mesh(a.geo.leg, a.material));
    mesh.position.y = -6 * PX;
    pivot.add(mesh);
    group.add(pivot);
    legs.push(pivot);
  }
  return { group, head, legs, arms, armBase: 0.4, meshes, material: a.material, hurtMaterial: a.hurt };
}

/** 昼夜亮度同步到生物材质（与天空 daylight 一致，主循环每帧调用） */
export function setMobBrightness(d: number): void {
  if (pigAssets) pigAssets.material.color.setScalar(d);
  if (zombieAssets) zombieAssets.material.color.setScalar(d);
  if (sheepAssets) sheepAssets.material.color.setScalar(d);
  if (cowAssets) cowAssets.material.color.setScalar(d);
  if (chickenAssets) chickenAssets.material.color.setScalar(d);
  if (skeletonAssets) skeletonAssets.material.color.setScalar(d);
  if (creeperAssets) creeperAssets.material.color.setScalar(d);
  if (spiderAssets) spiderAssets.material.color.setScalar(d);
  if (endermanAssets) endermanAssets.material.color.setScalar(d);
  if (zombiePiglinAssets) zombiePiglinAssets.material.color.setScalar(d);
  if (ghastAssets) ghastAssets.material.color.setScalar(d);
  if (villagerAssets) villagerAssets.material.color.setScalar(d);
}
