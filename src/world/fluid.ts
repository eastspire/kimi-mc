import { AIR } from '../core/block-registry';
import type { World } from './world';
import { CHUNK_Y } from './worldgen';

// ============================================================
// 水流动模拟（MC 风格，按 tick 调度的增量扩散 + 消退）
//  - 水位 0=水源（满格），1..7=水平扩散逐级下沉，8=竖直下落水柱
//  - 水源向下流入空气/可替换方块；水面水源向水平四方向扩散
//  - 流动水(level>0)失去源头支撑时消退为空气（MC 一致性）
//  - 每次方块编辑唤醒其轴向邻域，队列节流处理，避免单帧卡顿
//  - 水位以独立方块 id 存于区块数据 → 网格化/存档/光照零额外数据结构
// ============================================================

interface FluidCell {
  x: number;
  y: number;
  z: number;
}

/** 每 tick 最多处理的水格数（节流，防大面积流体改动卡帧） */
const MAX_PER_TICK = 480;
/** 处理节律（秒）：MC 水约每 5 tick(0.25s) 流动一次 */
const TICK_INTERVAL = 0.18;

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class FluidSimulator {
  private queue: FluidCell[] = [];
  /** 队列去重键集合，防止同一格被反复唤醒堆积 */
  private queued = new Set<number>();
  private acc = 0;

  constructor(
    private world: World,
    /** 方块写入回调：与 applyEdit 同职责（重建网格 + 记入存档修改集） */
    private applyEdit: (x: number, y: number, z: number, id: number) => void,
  ) {}

  private key(x: number, y: number, z: number): number {
    return ((x & 0x3ff) << 17) | ((z & 0x3ff) << 7) | (y & 0x7f);
  }

  /** 唤醒某格及其轴向邻居（方块编辑/初始灌水时调用） */
  wake(x: number, y: number, z: number): void {
    this.enqueue(x, y, z);
    this.enqueue(x + 1, y, z);
    this.enqueue(x - 1, y, z);
    this.enqueue(x, y + 1, z);
    this.enqueue(x, y - 1, z);
    this.enqueue(x, y, z + 1);
    this.enqueue(x, y, z - 1);
  }

  private enqueue(x: number, y: number, z: number): void {
    if (y < 0 || y >= CHUNK_Y) return;
    const k = this.key(x, y, z);
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push({ x, y, z });
  }

  /** 目标格是否可被水占据（空气或可替换植物） */
  private canOccupy(id: number): boolean {
    if (id === AIR) return true;
    const def = this.world.reg.def(id);
    return !!def && def.replaceable;
  }

  /**
   * 流动水(level>0)是否有合法来源支撑：
   *  - 上方是水（任意等级，含下落柱）→ 由上方供水
   *  - 水平相邻有等级更低的水（level-1）→ 由它扩散而来
   */
  private hasSource(x: number, y: number, z: number, level: number): boolean {
    const reg = this.world.reg;
    const above = reg.def(this.world.getBlock(x, y + 1, z));
    if (above && above.fluid) return true;
    for (const [dx, dz] of DIRS) {
      const n = reg.def(this.world.getBlock(x + dx, y, z + dz));
      if (n && n.fluid && n.waterLevel === level - 1) return true;
    }
    return false;
  }

  /** 主循环推进：按 TICK_INTERVAL 节流处理队列 */
  update(dt: number): void {
    if (this.queue.length === 0) {
      this.acc = 0;
      return;
    }
    this.acc += dt;
    if (this.acc < TICK_INTERVAL) return;
    this.acc = 0;
    let processed = 0;
    while (this.queue.length > 0 && processed < MAX_PER_TICK) {
      const cell = this.queue.shift()!;
      this.queued.delete(this.key(cell.x, cell.y, cell.z));
      this.step(cell.x, cell.y, cell.z);
      processed++;
    }
  }

  private step(x: number, y: number, z: number): void {
    const reg = this.world.reg;
    const id = this.world.getBlock(x, y, z);
    const def = reg.def(id);
    if (!def || !def.fluid) return; // 本格不是水，无需作为源头处理

    const level = def.waterLevel;

    // ---- 消退：非水源失去支撑则蒸发 ----
    if (level > 0 && !this.hasSource(x, y, z, level)) {
      this.applyEdit(x, y, z, AIR);
      // 唤醒邻居：原本由我供水的下游格也要重判
      this.wake(x, y, z);
      return;
    }

    const below = this.world.getBlock(x, y - 1, z);
    const belowDef = reg.def(below);

    // ---- 竖直下落：下方可占据 → 生成/维持下落水柱 ----
    if (this.canOccupy(below)) {
      this.applyEdit(x, y - 1, z, reg.waterId(8));
      this.enqueue(x, y - 1, z);
      this.enqueue(x, y - 2, z);
      return; // 能下落则不水平扩散
    }

    // ---- 下落柱落地：下方是实体 → 转为水平扩散源 ----
    if (level === 8) {
      if (belowDef && !belowDef.fluid) {
        this.applyEdit(x, y, z, reg.waterId(1));
        this.enqueue(x, y, z);
      }
      return;
    }

    // ---- 水平扩散：水源/扩散水向四周铺下一级，最多到 7 ----
    if (level >= 7) return;
    const spreadId = reg.waterId(level + 1);
    for (const [dx, dz] of DIRS) {
      const nx = x + dx;
      const nz = z + dz;
      const nid = this.world.getBlock(nx, y, nz);
      if (!this.canOccupy(nid)) continue;
      this.applyEdit(nx, y, nz, spreadId);
      this.enqueue(nx, y, nz);
      this.enqueue(nx, y - 1, nz);
    }
  }

  /** 清空待处理队列（切世界/重置用） */
  clear(): void {
    this.queue.length = 0;
    this.queued.clear();
  }
}
