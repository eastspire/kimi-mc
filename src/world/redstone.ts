import type { World } from '../world/world';

// ============================================================
// 红石电路模拟（MC 简化版）：电源 → 红石粉衰减传播 → 用电器
//  - 能量等级 0..15 由本类 Map 维护（不占方块数据位），逐 tick 重算
//  - 电源：拉杆(常开 15)、按钮(脉冲)、红石火把(反相器，附着方块未充能时输出)
//  - 传播：红石粉四向 + 上下，逐级 -1；电源强充能相邻实体方块
//  - 用电器：红石灯(亮灭)、活塞(推出)、TNT(点燃) — 状态切换经 applyEdit 换方块 id
// ============================================================

const TICK = 0.05; // 每 50ms 一个红石刻（MC 1 tick = 0.05s）

export interface RedstoneHooks {
  /** 切换某处方块 id（重建网格 + 入存档），由 main.ts applyEdit 提供 */
  setBlock: (x: number, y: number, z: number, id: number) => void;
  /** 点燃 TNT（位置 → 生成点燃实体并移除方块） */
  igniteTnt: (x: number, y: number, z: number) => void;
}

export class RedstoneSimulator {
  private acc = 0;
  /** 待唤醒坐标（方块改动时入队，去重） */
  private pending = new Set<string>();
  /** 按钮脉冲：key → 剩余供电秒 */
  private pulses = new Map<string, number>();
  /** 已点燃的 TNT 坐标（防重复触发） */
  private litTnt = new Set<string>();

  private idDustOff = -1;
  private idDustOn = -1;
  private idTorchOff = -1;
  private idTorchOn = -1;
  private idLeverOff = -1;
  private idLeverOn = -1;
  private idLampOff = -1;
  private idLampOn = -1;
  private idPiston = -1;
  private idTnt = -1;
  private idButton = -1;

  constructor(
    private world: World,
    private hooks: RedstoneHooks,
  ) {
    const reg = world.reg;
    const get = (n: string): number => (reg.byName.has(n) ? reg.id(n) : -1);
    this.idDustOff = get('redstone_dust_off');
    this.idDustOn = get('redstone_dust_on');
    this.idTorchOff = get('redstone_torch_off');
    this.idTorchOn = get('redstone_torch_on');
    this.idLeverOff = get('lever_off');
    this.idLeverOn = get('lever_on');
    this.idLampOff = get('redstone_lamp_off');
    this.idLampOn = get('redstone_lamp_on');
    this.idPiston = get('piston');
    this.idTnt = get('tnt');
    this.idButton = get('stone_button');
  }

  /** 方块改动时唤醒（applyEdit 调用）：重算该区域 */
  wake(x: number, y: number, z: number): void {
    const k = key(x, y, z);
    this.pending.add(k);
    // 连带 6 邻居（电路跨格）
    for (const [dx, dy, dz] of DIRS) this.pending.add(key(x + dx, y + dy, z + dz));
  }

  /** 玩家右键拉杆/按钮：切换/触发（main.ts 交互调用） */
  activate(x: number, y: number, z: number): boolean {
    const id = this.world.getBlock(x, y, z);
    if (id === this.idLeverOff) {
      this.hooks.setBlock(x, y, z, this.idLeverOn);
      this.wake(x, y, z);
      return true;
    }
    if (id === this.idLeverOn) {
      this.hooks.setBlock(x, y, z, this.idLeverOff);
      this.wake(x, y, z);
      return true;
    }
    if (id === this.idButton) {
      this.pulses.set(key(x, y, z), 1.0); // 按钮脉冲 1s（MC 石按钮 10 红石刻）
      this.wake(x, y, z);
      return true;
    }
    return false;
  }

  update(dt: number): void {
    // 推进按钮脉冲
    for (const [k, t] of this.pulses) {
      const nt = t - dt;
      if (nt <= 0) {
        this.pulses.delete(k);
        this.pending.add(k); // 脉冲结束，重算
      } else {
        this.pulses.set(k, nt);
      }
    }
    this.acc += dt;
    if (this.acc < TICK) return;
    this.acc = 0;
    if (this.pending.size === 0) return;
    // 取一批待算区域（连带邻域已在 wake 时扩展）
    const region = new Set<string>(this.pending);
    this.pending.clear();
    this.recompute(region);
  }

  /** 重算一组坐标的能量并驱动用电器状态 */
  private recompute(region: Set<string>): void {
    // 电源种子：region + 各自邻居里的电源
    const power = new Map<string, number>();
    const queue: [string, number][] = []; // [key, power]
    const seedScope = new Set<string>();
    for (const k of region) {
      seedScope.add(k);
      const [x, y, z] = unkey(k);
      for (const [dx, dy, dz] of DIRS) seedScope.add(key(x + dx, y + dy, z + dz));
    }
    for (const k of seedScope) {
      const [x, y, z] = unkey(k);
      const src = this.sourcePower(x, y, z);
      if (src > 0) {
        power.set(k, src);
        queue.push([k, src]);
      }
    }
    // BFS：沿红石粉传播，逐级衰减（不受 scope 限制，覆盖整条 dust 链）
    while (queue.length > 0) {
      const [k, p] = queue.shift()!;
      if (p <= 1) continue;
      const [x, y, z] = unkey(k);
      for (const [dx, dy, dz] of DIRS) {
        const nk = key(x + dx, y + dy, z + dz);
        const nid = this.world.getBlock(x + dx, y + dy, z + dz);
        if (!this.isDust(nid) && !this.isPowerSource(nid)) continue;
        const np = p - 1;
        if ((power.get(nk) ?? 0) < np) {
          power.set(nk, np);
          queue.push([nk, np]);
        }
      }
    }

    // 驱动范围：能量图覆盖的 dust + 它们的所有邻居（用电器/火把/灯）+ region
    const drive = new Set<string>(region);
    for (const k of power.keys()) {
      drive.add(k);
      const [x, y, z] = unkey(k);
      for (const [dx, dy, dz] of DIRS) drive.add(key(x + dx, y + dy, z + dz));
    }

    // 逐元件更新可见状态
    for (const k of drive) {
      const [x, y, z] = unkey(k);
      const id = this.world.getBlock(x, y, z);
      const powered = this.isPowered(x, y, z, power);

      if (this.isDust(id)) {
        const want = powered ? this.idDustOn : this.idDustOff;
        if (id !== want) this.hooks.setBlock(x, y, z, want);
      } else if (id === this.idLampOff && powered) {
        this.hooks.setBlock(x, y, z, this.idLampOn);
      } else if (id === this.idLampOn && !powered) {
        this.hooks.setBlock(x, y, z, this.idLampOff);
      } else if (id === this.idTorchOff || id === this.idTorchOn) {
        // 红石火把 = 反相器：附着方块被（外部）充能则熄灭，否则点亮
        // 注意排除火把自身——火把会给下方方块供能，不能据此判 below 充能
        const belowPowered = this.belowBlockPowered(x, y, z, power);
        const want = belowPowered ? this.idTorchOff : this.idTorchOn;
        if (id !== want) this.hooks.setBlock(x, y, z, want);
      } else if (id === this.idPiston) {
        // 活塞：充能时推出前方一格（简化：仅在有空气/可替换时放置推出标记）
        // 完整活塞（推拉/粘回）量大，本版充能触发一次推出动画省略，留作扩展
      } else if (id === this.idTnt && powered && !this.litTnt.has(k)) {
        this.litTnt.add(k);
        this.hooks.igniteTnt(x, y, z);
      }
    }
    // 波前扩散：能量图覆盖的元件邻居入下一刻，让能量沿电路逐刻传到位
    for (const k of power.keys()) {
      const [x, y, z] = unkey(k);
      for (const [dx, dy, dz] of DIRS) {
        const nid = this.world.getBlock(x + dx, y + dy, z + dz);
        if (this.isComponent(nid)) this.pending.add(key(x + dx, y + dy, z + dz));
      }
    }
    // 清理已不在 TNT 的坐标
    for (const k of this.litTnt) {
      const [x, y, z] = unkey(k);
      if (this.world.getBlock(x, y, z) !== this.idTnt) this.litTnt.delete(k);
    }
  }

  /** 是否红石元件（参与能量评估/驱动） */
  private isComponent(id: number): boolean {
    return (
      this.isDust(id) ||
      this.isPowerSource(id) ||
      id === this.idLeverOff ||
      id === this.idTorchOff ||
      id === this.idLampOff ||
      id === this.idLampOn ||
      id === this.idPiston ||
      id === this.idTnt
    );
  }

  private isDust(id: number): boolean {
    return id === this.idDustOff || id === this.idDustOn;
  }
  private isPowerSource(id: number): boolean {
    return (
      id === this.idLeverOn ||
      id === this.idTorchOn ||
      id === this.idButton
    );
  }

  /** 该坐标作为电源的输出强度（0 = 非电源） */
  private sourcePower(x: number, y: number, z: number): number {
    const id = this.world.getBlock(x, y, z);
    if (id === this.idLeverOn) return 15;
    if (id === this.idTorchOn) return 15;
    if (id === this.idButton && this.pulses.has(key(x, y, z))) return 15;
    return 0;
  }

  /** 红石粉能量图中某坐标的能量（无则 0） */
  private dustPower(x: number, y: number, z: number, power: Map<string, number>): number {
    return power.get(key(x, y, z)) ?? 0;
  }

  /** 实体方块是否被强充能（相邻电源直接供能，或相邻红石粉有能量） */
  private solidPowered(
    x: number,
    y: number,
    z: number,
    id: number,
    power: Map<string, number>,
  ): boolean {
    if (!this.world.reg.isSolid(id)) return false;
    // 相邻有电源（拉杆/亮火把/触发按钮）→ 强充能
    for (const [dx, dy, dz] of DIRS) {
      if (this.sourcePower(x + dx, y + dy, z + dz) > 0) return true;
      if (this.dustPower(x + dx, y + dy, z + dz, power) > 0) return true;
    }
    return false;
  }

  /** 火把下方方块是否被外部充能（排除火把自身贡献，防自我反馈） */
  private belowBlockPowered(
    tx: number,
    ty: number,
    tz: number,
    power: Map<string, number>,
  ): boolean {
    const bx = tx;
    const by = ty - 1;
    const bz = tz;
    const belowId = this.world.getBlock(bx, by, bz);
    if (!this.world.reg.isSolid(belowId)) return false;
    for (const [dx, dy, dz] of DIRS) {
      const nx = bx + dx;
      const ny = by + dy;
      const nz = bz + dz;
      if (nx === tx && ny === ty && nz === tz) continue; // 跳过火把自身
      if (this.sourcePower(nx, ny, nz) > 0) return true;
      if (this.dustPower(nx, ny, nz, power) > 0) return true;
    }
    return false;
  }

  /** 该坐标的元件是否处于"被供电"状态 */
  private isPowered(x: number, y: number, z: number, power: Map<string, number>): boolean {    // 自身在能量图（红石粉）
    if (this.dustPower(x, y, z, power) > 0) return true;
    for (const [dx, dy, dz] of DIRS) {
      // 相邻电源直接供能
      if (this.sourcePower(x + dx, y + dy, z + dz) > 0) return true;
      // 相邻红石粉有能量（红石粉给所贴/相邻方块供能，MC 弱充能）
      if (this.dustPower(x + dx, y + dy, z + dz, power) > 0) return true;
    }
    // 相邻实体方块被强充能（弱充能经由方块传导）
    for (const [dx, dy, dz] of DIRS) {
      const nid = this.world.getBlock(x + dx, y + dy, z + dz);
      if (this.solidPowered(x + dx, y + dy, z + dz, nid, power)) return true;
    }
    return false;
  }
}

const DIRS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// 坐标打包为字符串 key（清晰可靠；红石区域小，分配可接受）
function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}
function unkey(k: string): [number, number, number] {
  const [x, y, z] = k.split(',').map(Number);
  return [x, y, z];
}
