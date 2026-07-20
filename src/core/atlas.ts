import * as THREE from 'three';

// ============================================================
// 程序化贴图图集：全部为原创 16×16 像素画，运行时绘制
// 不使用任何 Mojang/Minecraft 素材
// ============================================================

export const TILE_SIZE = 16;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;

export const TILE_NAMES = [
  'grass_top',
  'grass_side',
  'dirt',
  'stone',
  'sand',
  'sandstone',
  'log_side',
  'log_top',
  'leaves',
  'planks',
  'coal_ore',
  'iron_ore',
  'gold_ore',
  'diamond_ore',
  'bedrock',
  'water_still',
  'tall_grass',
  'flower_red',
  'flower_yellow',
  'glass',
  'cobblestone',
  'gravel',
  'bricks',
  'stone_bricks',
  'glowstone',
  'obsidian',
  'snow',
  'clay',
  'crafting_top',
  'crafting_side',
  'furnace_top',
  'furnace_side',
  'furnace_front',
  'bed_top',
  'bed_side',
  'wool',
  'tnt_side',
  'tnt_top',
  'tnt_bottom',
  'torch',
  'lapis_ore',
  'redstone_ore',
  'emerald_ore',
  'farmland',
  'wheat_0',
  'wheat_1',
  'wheat_2',
  'wheat_3',
  'wheat_4',
  'wheat_5',
  'wheat_6',
  'wheat_7',
  'pumpkin_side',
  'pumpkin_top',
  'pumpkin_face',
  'melon_side',
  'melon_top',
  'cactus_side',
  'cactus_top',
  'sugarcane',
  'bookshelf',
  'mossy_cobble',
  'enchanting_top',
  'enchanting_side',
  'redstone_dust_on',
  'redstone_dust_off',
  'redstone_torch_on',
  'redstone_torch_off',
  'lever',
  'button',
  'redstone_lamp_on',
  'redstone_lamp_off',
  'piston_side',
  'piston_top',
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
function speckle(
  ctx: Ctx,
  rnd: () => number,
  base: string,
  spots: string[],
  density = 0.5,
): void {
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
  speckle(
    ctx,
    rnd,
    '#69a83e',
    ['#5d9433', '#74b544', '#5a8f31', '#7cbc4b'],
    0.55,
  );
};

const paintDirt: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(
    ctx,
    rnd,
    '#866043',
    ['#79553a', '#8f6849', '#6e4e35', '#96704d'],
    0.5,
  );
  for (let i = 0; i < 5; i++)
    px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#a08b70'); // 小石子
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
  speckle(
    ctx,
    rnd,
    '#7d7d7d',
    ['#737373', '#858585', '#6e6e6e', '#8c8c8c'],
    0.45,
  );
  // 几道石纹
  for (let i = 0; i < 3; i++) {
    let x = (rnd() * 14) | 0,
      y = (rnd() * 14) | 0;
    for (let s = 0; s < 5; s++) {
      px(ctx, x, y, '#666666');
      x += rnd() < 0.5 ? 1 : 0;
      y += rnd() < 0.5 ? 1 : 0;
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
    px(ctx, x, 0, '#c8bd85');
    px(ctx, x, 1, '#cfc489');
    px(ctx, x, 14, '#cfc489');
    px(ctx, x, 15, '#c8bd85');
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
  for (let i = 0; i < 4; i++)
    px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#42321f');
};

const paintLogTop: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#6b5433';
  ctx.fillRect(0, 0, 16, 16);
  // 年轮：同心方环
  const rings = [
    '#b0925e',
    '#9c7f4e',
    '#b0925e',
    '#8a6f45',
    '#b0925e',
    '#6b5433',
  ];
  for (let r = 1; r < 8; r++) {
    ctx.fillStyle = rings[r % rings.length];
    ctx.fillRect(r, r, 16 - r * 2, 16 - r * 2);
  }
  for (let i = 0; i < 10; i++)
    px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#5c472c');
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
  for (let x = 0; x < 16; x++)
    for (const y of [3, 7, 11, 15]) px(ctx, x, y, '#7d5f38');
  const joints = [12, 4, 14, 6];
  for (let b = 0; b < 4; b++) {
    const jx = joints[b];
    for (let y = b * 4; y < b * 4 + 4; y++) px(ctx, jx % 16, y, '#7d5f38');
  }
  for (const [nx, ny] of [
    [2, 1],
    [9, 5],
    [5, 9],
    [13, 13],
  ] as const)
    px(ctx, nx, ny, '#6b4f2e'); // 钉眼
};

function paintOre(spot: string, spotHi: string): Painter {
  return (ctx, ox, oy, rnd) => {
    paintStone(ctx, ox, oy, rnd);
    for (let v = 0; v < 4; v++) {
      const bx = 1 + ((rnd() * 12) | 0),
        by = 1 + ((rnd() * 12) | 0);
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [2, 0],
        [0, 2],
      ] as const) {
        if (rnd() < 0.75)
          px(
            ctx,
            Math.min(15, bx + dx),
            Math.min(15, by + dy),
            rnd() < 0.4 ? spotHi : spot,
          );
      }
    }
  };
}

const paintBedrock: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#565656';
  ctx.fillRect(0, 0, 16, 16);
  for (let i = 0; i < 9; i++) {
    const bx = (rnd() * 13) | 0,
      by = (rnd() * 13) | 0;
    const c = rnd() < 0.5 ? '#2e2e2e' : '#767676';
    ctx.fillStyle = c;
    ctx.fillRect(bx, by, 2 + ((rnd() * 3) | 0), 2 + ((rnd() * 2) | 0));
  }
  for (let i = 0; i < 20; i++)
    px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#454545');
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
    px(ctx, 7, 12, '#4a7d2a');
    px(ctx, 9, 13, '#4a7d2a'); // 小叶
    // 花瓣十字
    for (const [dx, dy] of [
      [0, -2],
      [-1, -1],
      [0, -1],
      [1, -1],
      [-2, 0],
      [-1, 0],
      [1, 0],
      [2, 0],
      [0, 1],
    ] as const) {
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
    px(ctx, i, 0, '#dcebf0');
    px(ctx, i, 15, '#dcebf0');
    px(ctx, 0, i, '#dcebf0');
    px(ctx, 15, i, '#dcebf0');
  }
  // 斜向高光
  ctx.fillStyle = 'rgba(230,245,250,0.4)';
  for (const [x, y] of [
    [3, 12],
    [4, 11],
    [5, 10],
    [6, 9],
    [9, 6],
    [10, 5],
    [11, 4],
    [12, 3],
  ] as const) {
    ctx.fillRect(x, y, 1, 1);
  }
};

const paintCobblestone: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#7a7a7a', ['#6f6f6f', '#858585', '#676767'], 0.4);
  // 错位石块轮廓 + 高光
  for (let i = 0; i < 6; i++) {
    const bx = 1 + ((rnd() * 11) | 0),
      by = 1 + ((rnd() * 11) | 0);
    const w = 3 + ((rnd() * 3) | 0),
      h = 2 + ((rnd() * 3) | 0);
    for (let x = 0; x < w; x++) {
      px(ctx, Math.min(15, bx + x), by, '#565656');
      px(ctx, Math.min(15, bx + x), Math.min(15, by + h), '#565656');
    }
    for (let y = 0; y <= h; y++) {
      px(ctx, bx, Math.min(15, by + y), '#565656');
      px(ctx, Math.min(15, bx + w), Math.min(15, by + y), '#565656');
    }
    px(ctx, Math.min(15, bx + 1), Math.min(15, by + 1), '#8c8c8c');
  }
};

const paintGravel: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(
    ctx,
    rnd,
    '#8a8378',
    ['#7d7568', '#968e81', '#6e675c', '#a29a8d', '#5f594f'],
    0.65,
  );
};

const paintBricks: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.fillStyle = '#9c4f38';
  ctx.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (rnd() < 0.2) px(ctx, x, y, rnd() < 0.5 ? '#8f4632' : '#a85740');
    }
  }
  // 灰浆缝：每 4 行一道横缝，竖缝逐行交错
  for (let x = 0; x < 16; x++)
    for (const y of [3, 7, 11, 15]) px(ctx, x, y, '#b8a89a');
  for (let b = 0; b < 4; b++) {
    const jx = b % 2 === 0 ? 8 : 0;
    for (let y = b * 4; y < b * 4 + 4; y++)
      px(ctx, (jx + 4) % 16, y, '#b8a89a');
    for (let y = b * 4; y < b * 4 + 4; y++) px(ctx, jx, y, '#b8a89a');
  }
};

const paintStoneBricks: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#7d7d7d', ['#737373', '#858585'], 0.3);
  // 4 块大砖 + 深色砖缝
  for (let i = 0; i < 16; i++) {
    px(ctx, i, 7, '#5e5e5e');
    px(ctx, i, 8, '#5e5e5e');
    px(ctx, 7, i, '#5e5e5e');
    px(ctx, 8, i, '#5e5e5e');
  }
  for (let i = 0; i < 16; i++) {
    px(ctx, i, 0, '#565656');
    px(ctx, i, 15, '#565656');
    px(ctx, 0, i, '#565656');
    px(ctx, 15, i, '#565656');
  }
  for (let i = 0; i < 8; i++)
    px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#6a6a6a'); // 磨损
};

const paintGlowstone: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(
    ctx,
    rnd,
    '#e8c76a',
    ['#f5dc8a', '#d4af52', '#c99f45', '#ffedaa'],
    0.6,
  );
  // 萤石斑块
  for (let i = 0; i < 5; i++) {
    const bx = (rnd() * 13) | 0,
      by = (rnd() * 13) | 0;
    ctx.fillStyle = rnd() < 0.5 ? '#fff0b8' : '#d9b455';
    ctx.fillRect(bx, by, 2 + ((rnd() * 2) | 0), 2 + ((rnd() * 2) | 0));
  }
};

const paintObsidian: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(
    ctx,
    rnd,
    '#17101f',
    ['#0f0a16', '#201530', '#241a38', '#0a0710'],
    0.5,
  );
  for (let i = 0; i < 6; i++)
    px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#2e2044'); // 紫晶闪点
};

const paintSnow: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#f2fbfb', ['#e4f2f2', '#ffffff', '#dcecec'], 0.3);
};

const paintClay: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#9fa4b1', ['#9499a6', '#aab0bc', '#8b909d'], 0.35);
};

/** 工作台顶面：木板底 + 深色边框 + 网格线 */
const paintCraftingTop: Painter = (ctx, _ox, _oy, rnd) => {
  paintPlanks(ctx, _ox, _oy, rnd);
  for (let i = 1; i < 15; i++) {
    px(ctx, i, 5, '#5a4020');
    px(ctx, i, 10, '#5a4020');
    px(ctx, 5, i, '#5a4020');
    px(ctx, 10, i, '#5a4020');
  }
  for (let i = 0; i < 16; i++) {
    px(ctx, i, 0, '#4a3018');
    px(ctx, i, 15, '#4a3018');
    px(ctx, 0, i, '#4a3018');
    px(ctx, 15, i, '#4a3018');
  }
};

/** 工作台侧面：木板底 + 顶沿压线 */
const paintCraftingSide: Painter = (ctx, _ox, _oy, rnd) => {
  paintPlanks(ctx, _ox, _oy, rnd);
  for (let i = 1; i < 15; i++) {
    px(ctx, i, 2, '#5a4020');
    px(ctx, i, 3, '#5a4020');
  }
  for (let i = 0; i < 16; i++) {
    px(ctx, i, 0, '#4a3018');
    px(ctx, i, 1, '#4a3018');
  }
};

/** 熔炉侧/顶面基底：灰色石板 + 深色描边 */
function paintFurnaceBase(
  ctx: CanvasRenderingContext2D,
  rnd: () => number,
): void {
  speckle(ctx, rnd, '#7d7d7d', ['#757575', '#858585', '#6f6f6f'], 0.3);
  for (let i = 0; i < 16; i++) {
    px(ctx, i, 0, '#5a5a5a');
    px(ctx, i, 15, '#5a5a5a');
    px(ctx, 0, i, '#5a5a5a');
    px(ctx, 15, i, '#5a5a5a');
  }
}

const paintFurnaceSide: Painter = (ctx, _ox, _oy, rnd) => {
  paintFurnaceBase(ctx, rnd);
};

const paintFurnaceTop: Painter = (ctx, _ox, _oy, rnd) => {
  paintFurnaceBase(ctx, rnd);
};

/** 熔炉正面：石板底 + 深色炉口 + 底部火槽 */
const paintFurnaceFront: Painter = (ctx, _ox, _oy, rnd) => {
  paintFurnaceBase(ctx, rnd);
  for (let y = 5; y <= 10; y++)
    for (let x = 4; x <= 11; x++) px(ctx, x, y, '#2a2a2a');
  for (let y = 6; y <= 9; y++)
    for (let x = 5; x <= 10; x++) px(ctx, x, y, '#141414');
  for (let x = 5; x <= 10; x++) px(ctx, x, 12, '#3a3a3a');
  px(ctx, 5, 13, '#2a2a2a');
  px(ctx, 10, 13, '#2a2a2a');
};

/** 床顶：北端白枕头 + 红色床身 + 深色包边 */
const paintBedTop: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#b02830', ['#a02028', '#c03840', '#982028'], 0.25);
  for (let y = 0; y < 4; y++)
    for (let x = 1; x < 15; x++)
      px(ctx, x, y, y === 0 || x === 1 || x === 14 ? '#d0d0d0' : '#f0f0f0');
  for (let i = 0; i < 16; i++) {
    px(ctx, i, 15, '#7a1a20');
    px(ctx, 0, i, '#7a1a20');
    px(ctx, 15, i, '#7a1a20');
  }
};

/** 床侧：上沿红床垫 + 下木板床架 */
const paintBedSide: Painter = (ctx, _ox, _oy, rnd) => {
  paintPlanks(ctx, _ox, _oy, rnd);
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 16; x++) px(ctx, x, y, y === 0 ? '#c03840' : '#a02028');
};

/** 羊毛：白底细斑 + 浅灰织纹 */
const paintWool: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#e8e8e8', ['#dcdcdc', '#f4f4f4', '#d0d0d0'], 0.3);
  for (let i = 2; i < 16; i += 4)
    for (let j = 0; j < 16; j++) px(ctx, j, i, '#d4d4d4');
};

/** 火把：透明底 + 竖直木柄 + 顶部火焰（亮黄→橙） */
const paintTorch: Painter = (ctx, _ox, _oy, rnd) => {
  ctx.clearRect(0, 0, 16, 16);
  // 木柄（中央 2px 宽）
  for (let y = 6; y < 16; y++) {
    px(ctx, 7, y, y % 2 ? '#6b5433' : '#7d6a42');
    px(ctx, 8, y, y % 2 ? '#7d6a42' : '#57422a');
  }
  // 火焰芯
  for (let y = 2; y < 7; y++) {
    for (let x = 6; x < 10; x++) {
      const edge = x === 6 || x === 9 || y === 2;
      px(ctx, x, y, edge ? '#e8942a' : '#ffd84a');
    }
  }
  px(ctx, 7, 1, '#e8942a');
  px(ctx, 8, 1, '#ffedaa');
  // 火光高光
  if (rnd() < 1) px(ctx, 7, 3, '#fff6c0');
};

/** 耕地：深棕土 + 横向犁沟 */
const paintFarmland: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#5a3d24', ['#4e3420', '#66452a', '#452c1a'], 0.5);
  for (const y of [3, 7, 11, 15]) {
    for (let x = 0; x < 16; x++) px(ctx, x, y, '#3a2614');
  }
  for (const y of [4, 8, 12]) {
    for (let x = 0; x < 16; x++) if (rnd() < 0.5) px(ctx, x, y, '#6e4c2e');
  }
};

/** 小麦阶段 0..7：幼苗由小到大，末阶段金黄穗 */
function paintWheat(stage: number): Painter {
  return (ctx, _ox, _oy, rnd) => {
    ctx.clearRect(0, 0, 16, 16);
    const mature = stage >= 7;
    const stalk = mature ? '#c8a83a' : '#5d9433';
    const head = mature ? '#e8c84a' : '#7cbc4b';
    const h = 2 + stage * 2; // 株高随阶段
    for (let p = 0; p < 4; p++) {
      const x = 2 + p * 4;
      for (let s = 0; s < h; s++) px(ctx, x, 15 - s, stalk);
      // 顶部穗/叶
      if (stage >= 3) {
        for (let e = 0; e < 2 + (stage >> 1); e++) {
          px(ctx, x, 15 - h - e, head);
          if (stage >= 5 && rnd() < 0.6) px(ctx, x + 1, 15 - h - e, head);
        }
      } else {
        px(ctx, x, 15 - h, head);
      }
    }
  };
}

/** 南瓜侧：橙底竖棱 + 深橙沟 */
const paintPumpkinSide: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#c87818', ['#b86e12', '#d4821f', '#a86410'], 0.4);
  for (const x of [3, 7, 11, 15]) {
    for (let y = 0; y < 16; y++) px(ctx, x, y, '#9a5c0e');
  }
};
/** 南瓜顶：橙底 + 中央茎 */
const paintPumpkinTop: Painter = (ctx, _ox, _oy, rnd) => {
  paintPumpkinSide(ctx, _ox, _oy, rnd);
  ctx.fillStyle = '#5a6a20';
  ctx.fillRect(7, 7, 2, 3);
  px(ctx, 7, 6, '#4a5a18');
};
/** 南瓜脸（雕刻）：南瓜侧 + 黑色三角眼 + 锯齿嘴 */
const paintPumpkinFace: Painter = (ctx, _ox, _oy, rnd) => {
  paintPumpkinSide(ctx, _ox, _oy, rnd);
  const dark = '#2a1808';
  // 左眼
  px(ctx, 4, 6, dark);
  px(ctx, 5, 6, dark);
  px(ctx, 4, 7, dark);
  // 右眼
  px(ctx, 10, 6, dark);
  px(ctx, 11, 6, dark);
  px(ctx, 11, 7, dark);
  // 鼻
  px(ctx, 7, 9, dark);
  px(ctx, 8, 9, dark);
  // 锯齿嘴
  for (const [x, y] of [
    [4, 12],
    [5, 12],
    [6, 13],
    [7, 12],
    [8, 12],
    [9, 13],
    [10, 12],
    [11, 12],
  ] as const)
    px(ctx, x, y, dark);
};
/** 西瓜侧：深绿底 + 浅绿竖纹 */
const paintMelonSide: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#5a8a24', ['#527d20', '#649428', '#4a731c'], 0.4);
  for (const x of [2, 6, 10, 14]) {
    for (let y = 0; y < 16; y++) if (rnd() < 0.8) px(ctx, x, y, '#7aa83a');
  }
};
const paintMelonTop: Painter = (ctx, _ox, _oy, rnd) => {
  paintMelonSide(ctx, _ox, _oy, rnd);
  ctx.fillStyle = '#4a5a18';
  ctx.fillRect(7, 7, 2, 2);
};
/** 仙人掌侧：绿底 + 竖棱 + 刺点 */
const paintCactusSide: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#3f7a2a', ['#37701f', '#488a30', '#2f6519'], 0.4);
  for (const x of [4, 8, 12]) {
    for (let y = 0; y < 16; y++) px(ctx, x, y, '#2c5c16');
  }
  for (let i = 0; i < 12; i++)
    px(ctx, (rnd() * 16) | 0, (rnd() * 16) | 0, '#b8d88a'); // 刺
};
const paintCactusTop: Painter = (ctx, _ox, _oy, rnd) => {
  speckle(ctx, rnd, '#488a30', ['#3f7a2a', '#529a38'], 0.4);
  for (let i = 1; i < 15; i++) {
    px(ctx, i, 1, '#2c5c16');
    px(ctx, i, 14, '#2c5c16');
    px(ctx, 1, i, '#2c5c16');
    px(ctx, 14, i, '#2c5c16');
  }
};
/** 甘蔗：浅绿竹节竖条 */
const paintSugarcane: Painter = (ctx, _ox, _oy, _rnd) => {
  ctx.clearRect(0, 0, 16, 16);
  for (const x of [3, 8, 13]) {
    for (let y = 0; y < 16; y++) {
      const joint = y % 5 === 0;
      px(ctx, x, y, joint ? '#5a8a3a' : '#7ab84a');
      px(ctx, x + 1, y, joint ? '#4a7a2a' : '#6aa838');
    }
  }
};
/** 书架：木板框 + 三色书脊 */
const paintBookshelf: Painter = (ctx, _ox, _oy, rnd) => {
  paintPlanks(ctx, _ox, _oy, rnd);
  const spines = [
    '#a83a2a',
    '#2a5aa8',
    '#3a8a3a',
    '#c8a83a',
    '#7a3a8a',
    '#a86a2a',
  ];
  for (let shelf = 0; shelf < 2; shelf++) {
    const y0 = 2 + shelf * 7;
    let x = 1;
    let si = shelf * 3;
    while (x < 14) {
      const w = 1 + ((rnd() * 2) | 0);
      ctx.fillStyle = spines[si % spines.length];
      ctx.fillRect(x, y0, w, 5);
      x += w + (rnd() < 0.2 ? 1 : 0);
      si++;
    }
    ctx.fillStyle = '#7d5f38';
    ctx.fillRect(0, y0 + 5, 16, 1); // 隔板
  }
};
/** 苔石：圆石底 + 绿色苔藓斑 */
const paintMossyCobble: Painter = (ctx, _ox, _oy, rnd) => {
  paintCobblestone(ctx, _ox, _oy, rnd);
  for (let i = 0; i < 10; i++) {
    const bx = (rnd() * 14) | 0,
      by = (rnd() * 14) | 0;
    ctx.fillStyle = rnd() < 0.5 ? '#5a7d2a' : '#4a6a20';
    ctx.fillRect(bx, by, 2, 2);
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
  cobblestone: paintCobblestone,
  gravel: paintGravel,
  bricks: paintBricks,
  stone_bricks: paintStoneBricks,
  glowstone: paintGlowstone,
  obsidian: paintObsidian,
  snow: paintSnow,
  clay: paintClay,
  crafting_top: paintCraftingTop,
  crafting_side: paintCraftingSide,
  furnace_top: paintFurnaceTop,
  furnace_side: paintFurnaceSide,
  furnace_front: paintFurnaceFront,
  bed_top: paintBedTop,
  bed_side: paintBedSide,
  wool: paintWool,
  // ---- TNT：侧面红体米白腰带 + "TNT" 深色字样；顶/底同心框 ----
  tnt_side: (ctx, _ox, _oy, rnd) => {
    speckle(ctx, rnd, '#c02818', ['#a82010', '#d03820', '#901808'], 0.25);
    ctx.fillStyle = '#701008';
    ctx.fillRect(0, 0, 16, 1);
    ctx.fillRect(0, 15, 16, 1);
    ctx.fillStyle = '#f0e0c0';
    ctx.fillRect(0, 6, 16, 4);
    ctx.fillStyle = '#d8c8a8';
    ctx.fillRect(0, 5, 16, 1);
    ctx.fillRect(0, 10, 16, 1);
    ctx.fillStyle = '#402810';
    ctx.fillRect(2, 6, 3, 1);
    ctx.fillRect(3, 7, 1, 3);
    ctx.fillRect(7, 6, 1, 4);
    ctx.fillRect(9, 6, 1, 4);
    ctx.fillRect(8, 7, 1, 2);
    ctx.fillRect(12, 6, 3, 1);
    ctx.fillRect(13, 7, 1, 3);
  },
  tnt_top: (ctx, _ox, _oy, rnd) => {
    speckle(ctx, rnd, '#c02818', ['#a82010', '#d03820'], 0.2);
    ctx.fillStyle = '#701008';
    ctx.fillRect(0, 0, 16, 1);
    ctx.fillRect(0, 15, 16, 1);
    ctx.fillRect(0, 0, 1, 16);
    ctx.fillRect(15, 0, 1, 16);
    ctx.fillStyle = '#d03820';
    ctx.fillRect(2, 2, 12, 1);
    ctx.fillRect(2, 13, 12, 1);
    ctx.fillRect(2, 2, 1, 12);
    ctx.fillRect(13, 2, 1, 12);
  },
  tnt_bottom: (ctx, _ox, _oy, rnd) => {
    speckle(ctx, rnd, '#a82010', ['#901808', '#b82818'], 0.2);
    ctx.fillStyle = '#581008';
    ctx.fillRect(0, 0, 16, 1);
    ctx.fillRect(0, 15, 16, 1);
    ctx.fillRect(0, 0, 1, 16);
    ctx.fillRect(15, 0, 1, 16);
  },
  // ---- 新方块贴图 ----
  torch: paintTorch,
  lapis_ore: paintOre('#2a4ac8', '#4a6ae8'),
  redstone_ore: paintOre('#c82828', '#f04838'),
  emerald_ore: paintOre('#2ac84a', '#4ae86a'),
  farmland: paintFarmland,
  wheat_0: paintWheat(0),
  wheat_1: paintWheat(1),
  wheat_2: paintWheat(2),
  wheat_3: paintWheat(3),
  wheat_4: paintWheat(4),
  wheat_5: paintWheat(5),
  wheat_6: paintWheat(6),
  wheat_7: paintWheat(7),
  pumpkin_side: paintPumpkinSide,
  pumpkin_top: paintPumpkinTop,
  pumpkin_face: paintPumpkinFace,
  melon_side: paintMelonSide,
  melon_top: paintMelonTop,
  cactus_side: paintCactusSide,
  cactus_top: paintCactusTop,
  sugarcane: paintSugarcane,
  bookshelf: paintBookshelf,
  mossy_cobble: paintMossyCobble,
  // ---- 附魔台：黑曜石底座 + 顶部红色书面 + 中央钻石四角点缀 ----
  enchanting_top: (ctx, _ox, _oy, rnd) => {
    paintObsidian(ctx, _ox, _oy, rnd);
    ctx.fillStyle = '#b03040';
    ctx.fillRect(3, 3, 10, 10);
    ctx.fillStyle = '#d8d8d0';
    ctx.fillRect(4, 4, 8, 8);
    ctx.fillStyle = '#c02828';
    ctx.fillRect(7, 4, 2, 8);
    ctx.fillStyle = '#4ee8d8';
    ctx.fillRect(1, 1, 2, 2);
    ctx.fillRect(13, 1, 2, 2);
    ctx.fillRect(1, 13, 2, 2);
    ctx.fillRect(13, 13, 2, 2);
  },
  enchanting_side: (ctx, _ox, _oy, rnd) => {
    paintObsidian(ctx, _ox, _oy, rnd);
    ctx.fillStyle = '#2a2a3a';
    ctx.fillRect(0, 0, 16, 3);
    ctx.fillStyle = '#4ee8d8';
    ctx.fillRect(3, 5, 2, 2);
    ctx.fillRect(11, 5, 2, 2);
    ctx.fillStyle = '#581008';
    ctx.fillRect(0, 12, 16, 1);
  },
  // ---- 红石粉：透明底 + 中心点 + 四向线（on 亮红发光 / off 暗红） ----
  redstone_dust_on: (ctx) => {
    ctx.clearRect(0, 0, 16, 16);
    const c = '#f03020';
    const bright = '#ff7a60';
    // 中心 4×4
    ctx.fillStyle = c;
    ctx.fillRect(6, 6, 4, 4);
    ctx.fillStyle = bright;
    ctx.fillRect(7, 7, 2, 2);
    // 四向线（宽 2）
    ctx.fillStyle = c;
    ctx.fillRect(7, 0, 2, 6);
    ctx.fillRect(7, 10, 2, 6);
    ctx.fillRect(0, 7, 6, 2);
    ctx.fillRect(10, 7, 6, 2);
  },
  redstone_dust_off: (ctx) => {
    ctx.clearRect(0, 0, 16, 16);
    const c = '#5a1408';
    ctx.fillStyle = c;
    ctx.fillRect(6, 6, 4, 4);
    ctx.fillRect(7, 0, 2, 6);
    ctx.fillRect(7, 10, 2, 6);
    ctx.fillRect(0, 7, 6, 2);
    ctx.fillRect(10, 7, 6, 2);
  },
  // ---- 红石火把：木柄 + 顶部红石（on 红亮发光 / off 暗） ----
  redstone_torch_on: (ctx) => {
    ctx.clearRect(0, 0, 16, 16);
    for (let y = 8; y < 16; y++) {
      px(ctx, 7, y, y % 2 ? '#6b5433' : '#7d6a42');
      px(ctx, 8, y, y % 2 ? '#7d6a42' : '#57422a');
    }
    ctx.fillStyle = '#f03020';
    ctx.fillRect(6, 3, 4, 5);
    ctx.fillStyle = '#ff8a70';
    ctx.fillRect(7, 4, 2, 2);
    ctx.fillStyle = '#ffb0a0';
    ctx.fillRect(7, 2, 2, 1);
  },
  redstone_torch_off: (ctx) => {
    ctx.clearRect(0, 0, 16, 16);
    for (let y = 8; y < 16; y++) {
      px(ctx, 7, y, y % 2 ? '#6b5433' : '#7d6a42');
      px(ctx, 8, y, y % 2 ? '#7d6a42' : '#57422a');
    }
    ctx.fillStyle = '#4a1408';
    ctx.fillRect(6, 3, 4, 5);
  },
  // ---- 拉杆：石座 + 斜木柄 ----
  lever: (ctx) => {
    ctx.clearRect(0, 0, 16, 16);
    ctx.fillStyle = '#7a7a7a';
    ctx.fillRect(5, 10, 6, 4);
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(5, 10, 6, 1);
    for (let i = 0; i < 7; i++) px(ctx, 7 + i, 9 - i, i % 2 ? '#8a6a34' : '#a0723d');
  },
  // ---- 按钮：石质小方块 ----
  button: (ctx) => {
    ctx.clearRect(0, 0, 16, 16);
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(5, 6, 6, 5);
    ctx.fillStyle = '#aaaaaa';
    ctx.fillRect(5, 6, 6, 2);
    ctx.fillStyle = '#5a5a5a';
    ctx.fillRect(5, 10, 6, 1);
  },
  // ---- 红石灯：on 暖黄发光 / off 暗棕 ----
  redstone_lamp_on: (ctx, _ox, _oy, rnd) => {
    speckle(ctx, rnd, '#f8c828', ['#f8e888', '#e8a818', '#fff8c8'], 0.5);
    ctx.fillStyle = '#c88818';
    ctx.fillRect(0, 0, 16, 1); ctx.fillRect(0, 15, 16, 1);
    ctx.fillRect(0, 0, 1, 16); ctx.fillRect(15, 0, 1, 16);
  },
  redstone_lamp_off: (ctx, _ox, _oy, rnd) => {
    speckle(ctx, rnd, '#6a4a20', ['#7a5a28', '#5a3a18', '#4a3414'], 0.5);
    ctx.fillStyle = '#3a2810';
    ctx.fillRect(0, 0, 16, 1); ctx.fillRect(0, 15, 16, 1);
    ctx.fillRect(0, 0, 1, 16); ctx.fillRect(15, 0, 1, 16);
  },
  // ---- 活塞：侧面木框 + 顶部推板 ----
  piston_side: (ctx, _ox, _oy, rnd) => {
    paintPlanks(ctx, _ox, _oy, rnd);
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(0, 0, 16, 4);
    ctx.fillStyle = '#aaaaaa';
    ctx.fillRect(0, 0, 16, 1);
    ctx.fillStyle = '#5a5a5a';
    ctx.fillRect(0, 3, 16, 1);
  },
  piston_top: (ctx, _ox, _oy, rnd) => {
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#aaaaaa';
    ctx.fillRect(1, 1, 14, 14);
    ctx.fillStyle = '#7a7a7a';
    ctx.fillRect(3, 3, 10, 10);
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(6, 6, 4, 4);
    if (rnd() < 1) px(ctx, 2, 2, '#bababa');
  },
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
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const p =
          ((row * TILE_SIZE + y) * canvas.width + col * TILE_SIZE + x) * 4;
        if (img[p + 3] > 128) {
          r += img[p];
          g += img[p + 1];
          b += img[p + 2];
          n++;
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
