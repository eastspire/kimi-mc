import { CHUNK_X, CHUNK_Y, CHUNK_Z } from '../world/chunk-const';
import type { Dimension } from '../world/worldgen';
import type { World } from '../world/world';
import type { BlockRegistry } from '../core/block-registry';
import type { AtlasResult } from '../core/atlas';

// ============================================================
// 全屏可探索地图：
//  - 每个已加载区块采样一份 16×16 顶面方块"代表色"（来自贴图平均色）
//  - 颜色打包为 1 字节（RGB332），随存档持久化，逐区块点亮
//  - 打开地图时把已探索区块拼成以玩家为中心的俯视画布，标注玩家位置/朝向
// ============================================================

/** 单区块地图分辨率（每格 1 世界方块） */
const RES = 16;

/** 打包 0..1 的 r,g,b 为 RGB332 单字节 */
function pack332(r: number, g: number, b: number): number {
  const R = Math.max(0, Math.min(7, Math.round(r * 7)));
  const G = Math.max(0, Math.min(7, Math.round(g * 7)));
  const B = Math.max(0, Math.min(3, Math.round(b * 3)));
  return (R << 5) | (G << 2) | B;
}

/** 解包 RGB332 → [r,g,b] 0..255 */
function unpack332(v: number): [number, number, number] {
  const R = (v >> 5) & 7;
  const G = (v >> 2) & 7;
  const B = v & 3;
  return [
    Math.round((R / 7) * 255),
    Math.round((G / 7) * 255),
    Math.round((B / 3) * 255),
  ];
}

/** 维度名（存档键 + 显示） */
export const DIM_LABEL: Record<Dimension, string> = {
  overworld: '主世界',
  nether: '下界',
  end: '末地',
  aether: '天堂',
};

export class WorldMap {
  /** 维度 → (区块键 → 16×16 颜色字节) */
  private dimMaps = new Map<Dimension, Map<string, Uint8Array>>();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLElement;
  private open = false;
  /** 当前查看的维度（跟随玩家所在维度） */
  private viewDim: Dimension = 'overworld';
  /** 缩放（每世界方块像素数） */
  private scale = 4;
  /** 平移偏移（世界方块，相对玩家），拖拽地图用 */
  private panX = 0;
  private panZ = 0;

  constructor(
    private reg: BlockRegistry,
    private atlas: AtlasResult,
    restored?: Record<string, Map<string, Uint8Array>>,
  ) {
    // 注入 DOM
    this.overlay = document.createElement('div');
    this.overlay.id = 'world-map';
    this.overlay.className = 'hidden';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.overlay.appendChild(this.canvas);
    const hint = document.createElement('div');
    hint.id = 'world-map-hint';
    this.overlay.appendChild(hint);
    document.body.appendChild(this.overlay);

    if (restored) {
      for (const [dim, m] of Object.entries(restored)) {
        this.dimMaps.set(dim as Dimension, new Map(m));
      }
    }

    // 拖拽平移 + 滚轮缩放
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener('mousedown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => (dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !this.open) return;
      this.panX -= (e.clientX - lastX) / this.scale;
      this.panZ -= (e.clientY - lastY) / this.scale;
      lastX = e.clientX;
      lastY = e.clientY;
      this.redrawPending = true;
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.scale = Math.max(
          2,
          Math.min(12, this.scale + (e.deltaY < 0 ? 1 : -1)),
        );
        this.redrawPending = true;
      },
      { passive: false },
    );
  }

  private redrawPending = true;

  get isOpen(): boolean {
    return this.open;
  }

  /** 某维度的探索表（惰性创建） */
  private table(dim: Dimension): Map<string, Uint8Array> {
    let m = this.dimMaps.get(dim);
    if (!m) {
      m = new Map();
      this.dimMaps.set(dim, m);
    }
    return m;
  }

  /**
   * 采样某区块顶面颜色并记录（区块网格化落地时调用）。
   * 逐列自上而下找第一个"有颜色"的方块（非空气、非透明流体之上的实体或水面）。
   * 直接读 chunk raw Uint8Array，跳过 World.getBlock 的 Map+字符串开销。
   */
  recordChunk(world: World, cx: number, cz: number, dim: Dimension): void {
    const chunk = world.chunkAt(cx, cz);
    if (!chunk) return; // 已被卸载则跳过（罕发，但仍需兜底）
    const key = `${cx},${cz}`;
    const colors = new Uint8Array(RES * RES);
    for (let lz = 0; lz < RES; lz++) {
      for (let lx = 0; lx < RES; lx++) {
        colors[lx + lz * RES] = this.topColor(lx, lz, chunk);
      }
    }
    this.table(dim).set(key, colors);
  }

  // ---- 加载期采样节流：区块落地只入队,主循环每帧限量消化,避免加载界面卡死 ----
  private pending: { world: World; cx: number; cz: number; dim: Dimension }[] =
    [];
  private pendingKeys = new Set<string>();

  /** 区块落地时排队采样(不立即执行)。重复的区块只排一次(生成后又编辑)。 */
  enqueueChunk(world: World, cx: number, cz: number, dim: Dimension): void {
    const k = `${dim}:${cx},${cz}`;
    if (this.pendingKeys.has(k)) return;
    this.pendingKeys.add(k);
    this.pending.push({ world, cx, cz, dim });
  }

  /**
   * 每帧限量消化待采样区块。budget 为本帧最多采样的区块数。
   * 加载阶段每帧调用,把集中在落地高峰的采样摊开,主线程不再被一次性打断。
   */
  drainQueue(budget: number): void {
    let n = 0;
    while (n < budget && this.pending.length > 0) {
      const p = this.pending.shift()!;
      this.pendingKeys.delete(`${p.dim}:${p.cx},${p.cz}`);
      this.recordChunk(p.world, p.cx, p.cz, p.dim);
      n++;
    }
  }

  /** 求某列顶面代表色（RGB332）。从世界顶向下找首个可着色方块。
   * 热路径优化：跳过 World.getBlock 的 Map 查找 + 字符串 key 分配，
   * 直接读 chunk raw Uint8Array（每列 ~10 次 typed-array 读，无分配）。 */
  private topColor(lx: number, lz: number, chunk: Uint8Array): number {
    // chunk 内部布局：lx + CHUNK_X * (lz + CHUNK_Z * y)
    const STEP = 16;
    let y = CHUNK_Y - 1;
    // 快降：跳过整段全空区域
    while (y >= STEP) {
      if (chunk[lx + CHUNK_X * (lz + CHUNK_Z * y)] !== 0) break;
      y -= STEP;
    }
    const top = Math.min(CHUNK_Y - 1, y + STEP);
    for (let yy = top; yy >= 0; yy--) {
      const id = chunk[lx + CHUNK_X * (lz + CHUNK_Z * yy)];
      if (id === 0) continue;
      const def = this.reg.def(id);
      if (!def) continue;
      // 取顶面贴图平均色；无顶面则取任意面
      const tile =
        def.faceTiles.up ??
        def.elements[0]?.faces.up?.tile ??
        def.elements[0]?.faces.south?.tile ??
        def.elements[0]?.faces.north?.tile;
      if (tile === undefined) continue;
      const r = this.atlas.tileColors[tile * 3];
      const g = this.atlas.tileColors[tile * 3 + 1];
      const b = this.atlas.tileColors[tile * 3 + 2];
      return pack332(r, g, b);
    }
    return 0; // 全空列
  }

  toggle(dim: Dimension, px: number, pz: number): void {
    if (this.open) this.close();
    else this.show(dim, px, pz);
  }

  show(dim: Dimension, px: number, pz: number): void {
    this.open = true;
    this.viewDim = dim;
    this.panX = 0;
    this.panZ = 0;
    this.overlay.classList.remove('hidden');
    this.resize();
    this.redrawPending = true;
    void px;
    void pz;
  }

  close(): void {
    this.open = false;
    this.overlay.classList.add('hidden');
  }

  resize(): void {
    const s = Math.min(window.innerWidth, window.innerHeight) * 0.86;
    this.canvas.width = Math.floor(s);
    this.canvas.height = Math.floor(s);
    this.redrawPending = true;
  }

  /** 每帧调用（仅打开时重绘） */
  update(px: number, pz: number, yaw: number, dim: Dimension): void {
    if (!this.open) return;
    this.viewDim = dim;
    if (!this.redrawPending && this.lastKey === this.key(px, pz, yaw)) return;
    this.lastKey = this.key(px, pz, yaw);
    this.redrawPending = false;
    this.draw(px, pz, yaw);
  }

  private lastKey = '';
  private key(px: number, pz: number, yaw: number): string {
    return `${Math.round(px * 2)},${Math.round(pz * 2)},${Math.round(yaw * 20)},${this.scale},${Math.round(this.panX)},${Math.round(this.panZ)}`;
  }

  /** 主绘制：以（玩家+平移）为中心铺开已探索区块 */
  private draw(px: number, pz: number, yaw: number): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ctx = this.ctx;
    // 背景（未探索：深色）
    ctx.fillStyle = '#0a0c14';
    ctx.fillRect(0, 0, W, H);

    const centerX = px + this.panX;
    const centerZ = pz + this.panZ;
    const table = this.dimMaps.get(this.viewDim);
    const s = this.scale;

    if (table) {
      // 视野内覆盖的区块范围
      const half = W / 2 / s; // 半径（世界方块）
      const cx0 = Math.floor((centerX - half) / CHUNK_X) - 1;
      const cx1 = Math.floor((centerX + half) / CHUNK_X) + 1;
      const cz0 = Math.floor((centerZ - half) / CHUNK_Z) - 1;
      const cz1 = Math.floor((centerZ + half) / CHUNK_Z) + 1;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const colors = table.get(`${cx},${cz}`);
          if (!colors) continue;
          this.drawChunk(cx, cz, colors, centerX, centerZ, s, W, H);
        }
      }
    }

    // 玩家标记：白色三角（朝向 yaw），居中
    const pxScreen = W / 2 - this.panX * s;
    const pzScreen = H / 2 - this.panZ * s;
    ctx.save();
    ctx.translate(pxScreen, pzScreen);
    // MC 地图：箭头指向玩家朝向。yaw=0 朝 -Z（北），屏幕上方为 -Z。
    ctx.rotate(-yaw);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 标题/提示
    const hint = this.overlay.querySelector('#world-map-hint') as HTMLElement;
    hint.textContent = `${DIM_LABEL[this.viewDim]} · 拖拽平移 · 滚轮缩放 · M / ESC 关闭`;
  }

  /** 绘制单个区块的 16×16 颜色到画布对应位置 */
  private drawChunk(
    cx: number,
    cz: number,
    colors: Uint8Array,
    centerX: number,
    centerZ: number,
    s: number,
    W: number,
    H: number,
  ): void {
    const ctx = this.ctx;
    const baseSX = W / 2 + (cx * CHUNK_X - centerX) * s;
    const baseSZ = H / 2 + (cz * CHUNK_Z - centerZ) * s;
    for (let lz = 0; lz < RES; lz++) {
      for (let lx = 0; lx < RES; lx++) {
        const v = colors[lx + lz * RES];
        const sx = baseSX + lx * s;
        const sz = baseSZ + lz * s;
        if (sx + s < 0 || sz + s < 0 || sx > W || sz > H) continue;
        if (v === 0) {
          // 未着色（虚空/全空）：主世界视作天空留白，其它维度留深色
          ctx.fillStyle = this.viewDim === 'overworld' ? '#7ba7e8' : '#14121e';
        } else {
          const [r, g, b] = unpack332(v);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        }
        ctx.fillRect(
          Math.floor(sx),
          Math.floor(sz),
          Math.ceil(s),
          Math.ceil(s),
        );
      }
    }
  }

  /** 序列化全部维度地图（存档用） */
  serialize(): Record<string, Map<string, Uint8Array>> {
    const out: Record<string, Map<string, Uint8Array>> = {};
    for (const [dim, m] of this.dimMaps) {
      if (m.size > 0) out[dim] = new Map(m);
    }
    return out;
  }
}
