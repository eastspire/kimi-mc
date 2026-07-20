import * as THREE from 'three';

// ============================================================
// 食物定义：16×16 程序生成像素图标（与方块图集同风格）
// sprite 供快捷栏 2D 绘制；texture 供掉落物/手持 3D 渲染
// ============================================================

export interface FoodDef {
  id: string;
  name: string;
  /** 进食恢复的饥饿值 */
  hunger: number;
  sprite: HTMLCanvasElement;
  texture: THREE.Texture;
}

function ellipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  inner: string,
  outer: string,
): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (v > 1) continue;
      ctx.fillStyle = v > 0.55 ? outer : inner;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function makeFood(
  id: string,
  name: string,
  hunger: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): FoodDef {
  const sprite = document.createElement('canvas');
  sprite.width = 16;
  sprite.height = 16;
  const ctx = sprite.getContext('2d')!;
  ctx.clearRect(0, 0, 16, 16);
  paint(ctx);
  const texture = new THREE.CanvasTexture(sprite);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { id, name, hunger, sprite, texture };
}

/** 生猪排：粉红外沿 + 浅色骨节 */
function paintPorkchop(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 5.6, 4.6, '#e7a1a6', '#b05f66');
  ctx.fillStyle = '#f2d8c8';
  ctx.fillRect(11, 10, 2, 2);
  ctx.fillRect(12, 11, 2, 2);
  ctx.fillStyle = '#c98488';
  ctx.fillRect(4, 5, 2, 1);
  ctx.fillRect(6, 8, 3, 1);
}

/** 腐肉：褐绿霉斑 */
function paintRottenFlesh(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7.5, 7.5, 5.2, 4.6, '#8a6a34', '#5a411d');
  ctx.fillStyle = '#6f7a2e';
  ctx.fillRect(4, 5, 2, 2);
  ctx.fillRect(9, 9, 2, 2);
  ctx.fillRect(7, 4, 1, 1);
  ctx.fillRect(10, 6, 1, 1);
  ctx.fillStyle = '#4a3517';
  ctx.fillRect(5, 10, 2, 1);
  ctx.fillRect(11, 8, 1, 2);
}

/** 熟猪排：棕褐烤肉色 + 浅色骨节 */
function paintCookedPorkchop(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 5.6, 4.6, '#c98d54', '#8a5a2b');
  ctx.fillStyle = '#e8d8c0';
  ctx.fillRect(11, 10, 2, 2);
  ctx.fillRect(12, 11, 2, 2);
  ctx.fillStyle = '#a06838';
  ctx.fillRect(4, 5, 2, 1);
  ctx.fillRect(6, 8, 3, 1);
}

/** 生羊肉：深红肉块 + 白色脂肪纹 */
function paintMutton(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 5.4, 4.4, '#c45548', '#8e3328');
  ctx.fillStyle = '#e8c8b8';
  ctx.fillRect(4, 6, 3, 1);
  ctx.fillRect(8, 9, 3, 1);
  ctx.fillStyle = '#a03a30';
  ctx.fillRect(5, 4, 2, 1);
  ctx.fillRect(9, 6, 2, 1);
}

/** 熟羊肉：棕熟肉色 + 烤痕 */
function paintCookedMutton(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 5.4, 4.4, '#9a6a3c', '#6e4423');
  ctx.fillStyle = '#5a3418';
  ctx.fillRect(4, 6, 4, 1);
  ctx.fillRect(7, 9, 4, 1);
  ctx.fillStyle = '#c89858';
  ctx.fillRect(5, 4, 2, 1);
}

/** 生牛肉：深红肉排 + 白色脂肪边 */
function paintBeef(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 5.6, 4.4, '#b04038', '#7e2a24');
  ctx.fillStyle = '#e8c8b8';
  ctx.fillRect(3, 5, 2, 4);
  ctx.fillRect(5, 3, 4, 1);
  ctx.fillStyle = '#8e2e28';
  ctx.fillRect(6, 7, 3, 1);
  ctx.fillRect(9, 9, 2, 1);
}

/** 牛排：深棕烤肉 + 烤架痕 */
function paintCookedBeef(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 5.6, 4.4, '#7a5230', '#54371c');
  ctx.fillStyle = '#3e2812';
  for (let i = 0; i < 3; i++) ctx.fillRect(4 + i * 3, 4, 1, 7);
  ctx.fillStyle = '#a07840';
  ctx.fillRect(5, 3, 3, 1);
}

/** 生鸡肉：浅粉肉块 + 鸡腿骨 */
function paintChickenFood(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 4.8, 4.2, '#e8a8a0', '#b87870');
  ctx.fillStyle = '#f0e0d0';
  ctx.fillRect(10, 10, 3, 2);
  ctx.fillStyle = '#d89088';
  ctx.fillRect(5, 5, 2, 1);
  ctx.fillRect(7, 8, 2, 1);
}

/** 熟鸡肉：金黄烤鸡 */
function paintCookedChicken(ctx: CanvasRenderingContext2D): void {
  ellipse(ctx, 7, 7, 4.8, 4.2, '#c89040', '#8a5a20');
  ctx.fillStyle = '#f0e0d0';
  ctx.fillRect(10, 10, 3, 2);
  ctx.fillStyle = '#e8b860';
  ctx.fillRect(5, 5, 2, 1);
  ctx.fillRect(7, 8, 2, 1);
}

export const FOODS = {
  porkchop: makeFood('porkchop', '生猪排', 3, paintPorkchop),
  rotten_flesh: makeFood('rotten_flesh', '腐肉', 4, paintRottenFlesh),
  cooked_porkchop: makeFood('cooked_porkchop', '熟猪排', 8, paintCookedPorkchop),
  mutton: makeFood('mutton', '生羊肉', 2, paintMutton),
  cooked_mutton: makeFood('cooked_mutton', '熟羊肉', 6, paintCookedMutton),
  beef: makeFood('beef', '生牛肉', 3, paintBeef),
  cooked_beef: makeFood('cooked_beef', '牛排', 8, paintCookedBeef),
  chicken: makeFood('chicken', '生鸡肉', 2, paintChickenFood),
  cooked_chicken: makeFood('cooked_chicken', '熟鸡肉', 6, paintCookedChicken),
} as const;

export type FoodId = keyof typeof FOODS;
