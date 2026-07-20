import * as THREE from 'three';

// ============================================================
// 程序化贴图图集：全部为原创 16×16 像素画，运行时绘制
// 不使用任何 Mojang/Minecraft 素材
// ============================================================

export const TILE_SIZE = 16;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;

export const TILE_NAMES = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'sand', 'sandstone',
  'log_side', 'log_top', 'leaves', 'planks', 'coal_ore', 'iron_ore',
  'gold_ore', 'diamond_ore', 'bedrock', 'water_still', 'tall_grass',
  'flower_red', 'flower_yellow', 'glass',
] as const;

export type TileName = (typeof TILE_NAMES)[number];

export const TILE_INDEX: ReadonlyMap<string, number> = new Map(
  TILE_NAMES.map((n, i) => [n, i]),
);

export interface AtlasResult {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  crackCanvas: HTMLCanvasElement;
  crackTexture: THREE.CanvasTexture;
  /** 每格平均色 (r,g,b) 0..1，供破坏粒子使用 */
  tileColors: Float32Array;
}

// 确定性伪随机
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;
type Painter = (ctx: Ctx, ox: number, oy: number, rnd: () => number) => void;

function px(ctx: Ctx, x: number, y: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, 1, 1);
}

/** 底色 + 噪点杂色 */
function speckle(ctx: Ctx, rnd: () => number, base: string, spots: string[], density = 0.5): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      if (rnd() < density) px(ctx, x, y, spots[(rnd() * spots.length) | 0]);
    }
  }
}

// ---------- 各贴格绘制（原创像素画） ----------

const paintGrassTop: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#69a83e', ['#5d9433', '#74b544', '#5a8f31', '#7cbc4b'], 0.55);
};

const paintDirt: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#866043', ['#79553a', '#8f6849', '#6e4e35', '#96704d'], 0.5);
  for (let i = 0; i < 5; i++) px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#a08b70'); // 小石子
};

const paintGrassSide: Painter = (ctx, ox, oy, rnd) => {
  paintDirt(ctx, ox, oy, rnd);
  // 顶部草皮，下缘呈锯齿
  for (let x = 0; x < 16; x++) {
    const depth = 2 + ((rnd() * 3) | 0);
    for (let y = 0; y <= depth; y++) {
      px(ctx, x, y, rnd() < 0.3 ? '#5d9433' : '#69a83e');
    }
  }
};

const paintStone: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#7d7d7d', ['#737373', '#858585', '#6e6e6e', '#8c8c8c'], 0.45);
  // 几道石纹
  for (let i = 0; i < 3; i++) {
    let x = (rnd() * 14) | 0, y = (rnd() * 14) | 0;
    for (let s = 0; s < 5; s++) {
      px(ctx, x, y, '#666666');
      x += rnd() < 0.5 ? 1 : 0; y += rnd() < 0.5 ? 1 : 0;
      if (x > 15 || y > 15) break;
    }
  }
};

const paintSand: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#dbd3a0', ['#d0c68f', '#e4ddae', '#c8bd85'], 0.45);
};

const paintSandstone: Painter = (ctx, ox, oy, rnd) => {
  paintSand(ctx, ox, oy, rnd);
  for (let x = 0; x < 16; x++) {
    px(ctx, x, 0, '#c8bd85'); px(ctx, x, 1, '#cfc489');
    px(ctx, x, 14, '#cfc489'); px(ctx, x, 15, '#c8bd85');
  }
  for (let x = 3; x < 13; x++) px(ctx, x, 7 + ((rnd() * 2) | 0), '#d0c68f'); // 中部层理
};

const paintLogSide: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#6b5433';
  ctx.fillRect(0, 0, 16, 16);
  for (let x = 0; x < 16; x++) {
    const c = x % 4 === 0 ? '#57422a' : x % 4 === 2 ? '#77603c' : '#6b5433';
    for (let y = 0; y < 16; y++) {
      px(ctx, x, y, rnd() < 0.12 ? '#4d3a24' : c);
    }
  }
  // 树皮疙瘩
  for (let i = 0; i < 4; i++) px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#42321f');
};

const paintLogTop: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#6b5433';
  ctx.fillRect(0, 0, 16, 16);
  // 年轮：同心方环
  const rings = ['#b0925e', '#9c7f4e', '#b0925e', '#8a6f45', '#b0925e', '#6b5433'];
  for (let r = 1; r < 8; r++) {
    ctx.fillStyle = rings[r % rings.length];
    ctx.fillRect(r, r, 16 - r * 2, 16 - r * 2);
  }
  for (let i = 0; i < 10; i++) px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#5c472c');
};

const paintLeaves: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#3f7726';
  ctx.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rnd();
      if (r < 0.28) px(ctx, x, y, '#356820');
      else if (r < 0.42) px(ctx, x, y, '#4a8a2c');
      else if (r < 0.5) px(ctx, x, y, '#2d5a1b'); // 深孔（不透明）
    }
  }
};

const paintPlanks: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#a98250';
  ctx.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (rnd() < 0.18) px(ctx, x, y, rnd() < 0.5 ? '#9a7547' : '#b28c58');
    }
  }
  // 板缝：每 4 行一道横缝 + 交错竖缝
  for (let x = 0; x < 16; x++) for (const y of [3, 7, 11, 15]) px(ctx, x, y, '#7d5f38');
  const joints = [12, 4, 14, 6];
  for (let b = 0; b < 4; b++) {
    const jx = joints[b];
    for (let y = b * 4; y < b * 4 + 4; y++) px(ctx, jx % 16, y, '#7d5f38');
  }
  for (const [nx, ny] of [[2, 1], [9, 5], [5, 9], [13, 13]] as const) px(ctx, nx, ny, '#6b4f2e'); // 钉眼
};

function paintOre(spot: string, spotHi: string): Painter {
  return (ctx, ox, oy, rnd) => {
    paintStone(ctx, ox, oy, rnd);
    for (let v = 0; v < 4; v++) {
      const bx = 1 + ((rnd() * 12) | 0), by = 1 + ((rnd() * 12) | 0);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2]] as const) {
        if (rnd() < 0.75) px(ctx, Math.min(15, bx + dx), Math.min(15, by + dy), rnd() < 0.4 ? spotHi : spot);
      }
    }
  };
}

const paintBedrock: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#565656';
  ctx.fillRect(0, 0, 16, 16);
  for (let i = 0; i < 9; i++) {
    const bx = (rnd() * 13) | 0, by = (rnd() * 13) | 0;
    const c = rnd() < 0.5 ? '#2e2e2e' : '#767676';
    ctx.fillStyle = c;
    ctx.fillRect(bx, by, 2 + ((rnd() * 3) | 0), 2 + ((rnd() * 2) | 0));
  }
  for (let i = 0; i < 20; i++) px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#454545');
};

const paintWater: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#3f76e4';
  ctx.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const r = rnd();
      if (r < 0.16) px(ctx, x, y, '#4a86ec');
      else if (r < 0.26) px(ctx, x, y, '#3568d4');
    }
  }
  // 横向水纹
  for (let i = 0; i < 3; i++) {
    const y = (rnd() * 16) | 0;
    for (let x = 0; x < 16; x++) if (rnd() < 0.6) px(ctx, x, y, '#5c95f0');
  }
};

const paintTallGrass: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.clearRect(0, 0, 16, 16);
  for (let b = 0; b < 9; b++) {
    const x = 1 + ((rnd() * 14) | 0);
    const h = 5 + ((rnd() * 10) | 0);
    const lean = rnd() < 0.5 ? -1 : 1;
    for (let s = 0; s < h; s++) {
      const xx = Math.max(0, Math.min(15, x + (s > h * 0.6 ? lean : 0)));
      px(ctx, xx, 15 - s, s > h * 0.7 ? '#7cbc4b' : '#5d9433');
    }
  }
};

function paintFlower(petal: string, center: string): Painter {
  return (ctx, _ox, _oy, rnd) => {
    ctx.clearRect(0, 0, 16, 16);
    // 茎
    for (let y = 7; y < 16; y++) px(ctx, 8, y, '#4a7d2a');
    px(ctx, 7, 12, '#4a7d2a'); px(ctx, 9, 13, '#4a7d2a'); // 小叶
    // 花瓣十字
    for (const [dx, dy] of [[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [1, 0], [2, 0], [0, 1]] as const) {
      px(ctx, 8 + dx, 6 + dy, rnd() < 0.25 ? '#ffffff22' : petal);
    }
    px(ctx, 8, 6, center);
    // 几棵草
    for (let i = 0; i < 3; i++) px(ctx, (rnd() * 16) | 0, 15, '#5d9433');
  };
}

const paintGlass: Painter = (ctx, _ox, _oy, _rnd) => {
  ctx.clearRect(0, 0, 16, 16);
  ctx.fillStyle = 'rgba(220,235,240,0.85)';
  for (let i = 0; i < 16; i++) {
    px(ctx, i, 0, '#dcebf0'); px(ctx, i, 15, '#dcebf0');
    px(ctx, 0, i, '#dcebf0'); px(ctx, 15, i, '#dcebf0');
  }
  // 斜向高光
  ctx.fillStyle = 'rgba(230,245,250,0.4)';
  for (const [x, y] of [[3, 12], [4, 11], [5, 10], [6, 9], [9, 6], [10, 5], [11, 4], [12, 3]] as const) {
    ctx.fillRect(x, y, 1, 1);
  }
};

const PAINTERS: Record<TileName, Painter> = {
  grass_top: paintGrassTop,
  grass_side: paintGrassSide,
  dirt: paintDirt,
  stone: paintStone,
  sand: paintSand,
  sandstone: paintSandstone,
  log_side: paintLogSide,
  log_top: paintLogTop,
  leaves: paintLeaves,
  planks: paintPlanks,
  coal_ore: paintOre('#262626', '#3d3d3d'),
  iron_ore: paintOre('#d8af93', '#b98a6e'),
  gold_ore: paintOre('#f9e14e', '#f5c93c'),
  diamond_ore: paintOre('#4ee8d8', '#7ff5e8'),
  bedrock: paintBedrock,
  water_still: paintWater,
  tall_grass: paintTallGrass,
  flower_red: paintFlower('#d8362c', '#f0d040'),
  flower_yellow: paintFlower('#f2d13c', '#e8a820'),
  glass: paintGlass,
};

// ---------- 裂纹贴图（10 阶段，程序化绘制） ----------
function createCrackCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TILE_SIZE * 10;
  c.height = TILE_SIZE;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  for (let stage = 0; stage < 10; stage++) {
    const rnd = mulberry32(9000 + stage * 137);
    const ox = stage * TILE_SIZE;
    const lines = 2 + stage;
    for (let l = 0; l < lines; l++) {
      let x = ox + 4 + ((rnd() * 8) | 0);
      let y = 4 + ((rnd() * 8) | 0);
      const steps = 3 + ((stage * 1.5) | 0);
      for (let s = 0; s < steps; s++) {
        ctx.fillStyle = 'rgba(24,20,18,0.85)';
        ctx.fillRect(x, y, 1, 1);
        if (rnd() < 0.4) ctx.fillRect(x + 1, y, 1, 1);
        x += rnd() < 0.5 ? 1 : -1;
        y += rnd() < 0.5 ? 1 : -1;
        x = Math.max(ox, Math.min(ox + 15, x));
        y = Math.max(0, Math.min(15, y));
      }
    }
  }
  return c;
}

// ---------- 图集构建 ----------
export function createAtlas(): AtlasResult {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * TILE_SIZE;
  canvas.height = ATLAS_ROWS * TILE_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  TILE_NAMES.forEach((name, i) => {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    const ox = col * TILE_SIZE;
    const oy = row * TILE_SIZE;
    ctx.save();
    ctx.translate(ox, oy);
    PAINTERS[name](ctx, ox, oy, mulberry32(1337 + i * 77));
    ctx.restore();
  });

  // 每格平均色（破坏粒子用），跳过透明像素
  const tileColors = new Float32Array(TILE_NAMES.length * 3);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  TILE_NAMES.forEach((_name, i) => {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const p = ((row * TILE_SIZE + y) * canvas.width + col * TILE_SIZE + x) * 4;
        if (img[p + 3] > 128) {
          r += img[p]; g += img[p + 1]; b += img[p + 2]; n++;
        }
      }
    }
    tileColors[i * 3] = n ? r / n / 255 : 1;
    tileColors[i * 3 + 1] = n ? g / n / 255 : 1;
    tileColors[i * 3 + 2] = n ? b / n / 255 : 1;
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // UV 在自定义 shader 中自行处理

  const crackCanvas = createCrackCanvas();
  const crackTexture = new THREE.CanvasTexture(crackCanvas);
  crackTexture.magFilter = THREE.NearestFilter;
  crackTexture.minFilter = THREE.NearestFilter;
  crackTexture.generateMipmaps = false;
  crackTexture.colorSpace = THREE.SRGBColorSpace;
  crackTexture.repeat.set(0.1, 1);

  return { canvas, texture, crackCanvas, crackTexture, tileColors };
}
