import type { BlockDef } from '../core/model-loader';
import { TILE_SIZE, ATLAS_COLS } from '../core/atlas';

// ============================================================
// 快捷栏：9 格 DOM + 从图集绘制的伪 3D 方块图标
// ============================================================

export class Hotbar {
  selected = 0;
  private slots: HTMLDivElement[] = [];

  constructor(
    private items: BlockDef[],
    private atlasCanvas: HTMLCanvasElement,
    private onSelect: (def: BlockDef, index: number) => void,
  ) {
    const bar = document.getElementById('hotbar')!;
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      slot.appendChild(num);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 44;
      slot.appendChild(canvas);
      const item = items[i];
      if (item) this.drawIcon(canvas, item);
      bar.appendChild(slot);
      this.slots.push(slot);
    }
    this.refresh();
  }

  select(i: number): void {
    if (i < 0 || i >= 9 || !this.items[i]) return;
    if (this.selected === i) return;
    this.selected = i;
    this.refresh();
    this.onSelect(this.items[i], i);
  }

  scroll(dir: number): void {
    this.select((this.selected + dir + 9) % 9);
  }

  get current(): BlockDef {
    return this.items[this.selected];
  }

  private refresh(): void {
    this.slots.forEach((s, i) => s.classList.toggle('selected', i === this.selected));
  }

  private tileRegion(tile: number): [number, number] {
    const col = tile % ATLAS_COLS;
    const row = (tile / ATLAS_COLS) | 0;
    return [col * TILE_SIZE, row * TILE_SIZE];
  }

  /** 等轴测三面图标（顶/左/右），植物画平面 */
  private drawIcon(canvas: HTMLCanvasElement, def: BlockDef): void {
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const src = this.atlasCanvas;

    if (!def.fullCube) {
      // 十字植物：平铺正面
      const tile = def.elements[0]?.faces.south?.tile ?? def.elements[0]?.faces.north?.tile ?? 0;
      const [sx, sy] = this.tileRegion(tile);
      ctx.drawImage(src, sx, sy, TILE_SIZE, TILE_SIZE, 6, 2, 32, 32);
      return;
    }

    const top = def.faceTiles.up ?? 0;
    const left = def.faceTiles.west ?? 0;
    const right = def.faceTiles.east ?? 0;

    const drawFace = (tile: number, m: [number, number, number, number, number, number], shade: number) => {
      const [sx, sy] = this.tileRegion(tile);
      ctx.setTransform(...m);
      ctx.drawImage(src, sx, sy, TILE_SIZE, TILE_SIZE, 0, 0, TILE_SIZE, TILE_SIZE);
      if (shade < 1) {
        ctx.fillStyle = `rgba(0,0,0,${1 - shade})`;
        ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      }
    };

    // 顶面菱形 (0,0)=上顶点
    drawFace(top, [1.25, 0.625, -1.25, 0.625, 22, 2], 1);
    // 左面
    drawFace(left, [1.25, 0.625, 0, 1.25, 2, 12], 0.62);
    // 右面
    drawFace(right, [1.25, -0.625, 0, 1.25, 22, 22], 0.8);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
