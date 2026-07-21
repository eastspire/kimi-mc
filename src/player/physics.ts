import type { World } from '../world/world';
import { CHUNK_X, CHUNK_Z } from '../world/chunk-const';

// ============================================================
// 玩家物理：逐轴 AABB 体素碰撞
// 玩家宽 0.6、高 1.8、眼高 1.62（潜行 1.5）
// ============================================================

export const PLAYER_HALF = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const EYE_HEIGHT_SNEAK = 1.5;

const GRAVITY = 27;
const JUMP_VEL = 8.4;
const WALK_SPEED = 4.32;
const SPRINT_SPEED = 5.6;
const SNEAK_SPEED = 1.31;
const FLY_SPEED = 10.9;
const WATER_GRAVITY = 5.5;
const WATER_SWIM_UP = 3.2;
const WATER_SINK_MAX = -2.4;
const TERMINAL_VEL = -52;

export interface MoveInput {
  forward: number; // -1..1
  strafe: number; // -1..1
  jump: boolean;
  down: boolean; // 潜行键（飞行时下降）
  sprint: boolean;
  yaw: number;
}

export class PlayerBody {
  x = 0;
  y = 0;
  z = 0; // 脚底中心
  vx = 0;
  vy = 0;
  vz = 0;
  onGround = false;
  flying = false;
  sneaking = false;
  inWater = false;
  headInWater = false;
  /** 本步进内是否发生水平碰撞（冲刺撞墙取消用） */
  collidedX = false;
  collidedZ = false;

  constructor(private world: World) {}

  /** 维度切换时换绑世界（下界/主世界各一份） */
  setWorld(w: World): void {
    this.world = w;
  }

  eyeHeight(): number {
    return this.sneaking && !this.flying ? EYE_HEIGHT_SNEAK : EYE_HEIGHT;
  }

  private solidAt(
    bx: number,
    by: number,
    bz: number,
    chunkLoaded: boolean,
  ): boolean {
    // 未加载区块视为实体（与玩家物理一致，防坠虚空）；
    // 调用方预先解析 AABB 包含的区块是否全部加载，这里仅作位置检查
    if (!chunkLoaded) return true;
    return this.world.isSolid(bx, by, bz);
  }

  /** 某 AABB 是否与实体相交；chunkLoaded 由调用方批量解析（节省 N 次 Map.get） */
  private boxCollides(
    x: number,
    y: number,
    z: number,
    chunkLoaded: boolean,
  ): boolean {
    const x0 = Math.floor(x - PLAYER_HALF),
      x1 = Math.floor(x + PLAYER_HALF - 1e-7);
    const y0 = Math.floor(y),
      y1 = Math.floor(y + PLAYER_HEIGHT - 1e-7);
    const z0 = Math.floor(z - PLAYER_HALF),
      z1 = Math.floor(z + PLAYER_HALF - 1e-7);
    for (let by = y0; by <= y1; by++)
      for (let bz = z0; bz <= z1; bz++)
        for (let bx = x0; bx <= x1; bx++)
          if (this.solidAt(bx, by, bz, chunkLoaded)) return true;
    return false;
  }

  /** AABB 所跨的几个 chunk 是否都已加载；任一未加载即视为碰撞（兜底防虚空） */
  private aabbChunksLoaded(x: number, _y: number, z: number): boolean {
    const x0 = Math.floor(x - PLAYER_HALF),
      x1 = Math.floor(x + PLAYER_HALF - 1e-7);
    const z0 = Math.floor(z - PLAYER_HALF),
      z1 = Math.floor(z + PLAYER_HALF - 1e-7);
    // 单区块 AABB 即可（玩家宽 0.6 < 1 格 → 仍最多跨 2x2 = 4 区块）
    const cx0 = (x0 / CHUNK_X) | 0,
      cx1 = (x1 / CHUNK_X) | 0;
    const cz0 = (z0 / CHUNK_Z) | 0,
      cz1 = (z1 / CHUNK_Z) | 0;
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++)
        if (!this.world.hasChunk(cx, cz)) return false;
    return true;
  }

  /** 潜行防坠落：目标位置下方一格内是否有支撑 */
  private hasGroundBelow(x: number, y: number, z: number): boolean {
    const x0 = Math.floor(x - PLAYER_HALF),
      x1 = Math.floor(x + PLAYER_HALF - 1e-7);
    const z0 = Math.floor(z - PLAYER_HALF),
      z1 = Math.floor(z + PLAYER_HALF - 1e-7);
    const by = Math.floor(y - 0.5);
    if (!this.aabbChunksLoaded(x, y, z)) return true;
    for (let bz = z0; bz <= z1; bz++)
      for (let bx = x0; bx <= x1; bx++)
        if (this.world.isSolid(bx, by, bz)) return true;
    return false;
  }

  private moveAxis(axis: 'x' | 'y' | 'z', delta: number): boolean {
    if (delta === 0) return false;
    const p = this;
    p[axis] += delta;
    const loaded = this.aabbChunksLoaded(p.x, p.y, p.z);
    if (loaded && !this.boxCollides(p.x, p.y, p.z, true)) return false;

    // 水中上岸 step-up：仅当玩家脚下有水（inWater 沿墙游到 sand 旁），
    // 撞到的 solid 全在 AABB 顶部 1 格内（AABB 顶穿 sand 底），则把 feet
    // 抬到 sand 顶（feetY = sandTop - 1.8，AABB 顶刚好跟 sand 底相切）。
    // 这是 MC 玩家"游上 1 格高岸边"应有的行为——上不去会卡在岸边水里。
    if (axis === 'x' || axis === 'z') {
      const feetBlock = this.world.getBlock(
        Math.floor(p.x),
        Math.floor(p.y + 0.01),
        Math.floor(p.z),
      );
      const inWaterNow =
        this.world.reg.isWater(feetBlock) ||
        this.world.reg.isWater(
          this.world.getBlock(
            Math.floor(p.x),
            Math.floor(p.y + 0.4),
            Math.floor(p.z),
          ),
        );
      if (inWaterNow && this.tryWaterShoreStepUp(loaded)) {
        // step-up 成功：把 y 抬高后重新走该 axis（已通过 boxCollides）
        if (!this.boxCollides(p.x, p.y, p.z, true)) return false;
      }
    }

    // 逐格回退钳制
    const x0 = Math.floor(p.x - PLAYER_HALF),
      x1 = Math.floor(p.x + PLAYER_HALF - 1e-7);
    const y0 = Math.floor(p.y),
      y1 = Math.floor(p.y + PLAYER_HEIGHT - 1e-7);
    const z0 = Math.floor(p.z - PLAYER_HALF),
      z1 = Math.floor(p.z + PLAYER_HALF - 1e-7);
    let hit = false;
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          if (!this.solidAt(bx, by, bz, loaded)) continue;
          hit = true;
          if (axis === 'x') {
            p.x =
              delta > 0 ? bx - PLAYER_HALF - 1e-4 : bx + 1 + PLAYER_HALF + 1e-4;
            p.vx = 0;
            p.collidedX = true;
          } else if (axis === 'y') {
            p.y = delta > 0 ? by - PLAYER_HEIGHT - 1e-4 : by + 1 + 1e-4;
            p.vy = 0;
          } else {
            p.z =
              delta > 0 ? bz - PLAYER_HALF - 1e-4 : bz + 1 + PLAYER_HALF + 1e-4;
            p.vz = 0;
            p.collidedZ = true;
          }
        }
      }
    }
    return hit;
  }

  /**
   * 水中岸 step-up：撞到的 solid 全在 AABB 顶 1 格内（AABB 顶穿 sand 底），
   * 把 feet 抬到 sand 顶。返回 true 表示已修改 p.y。
   * 仅在脚下 0.4 格内有水时被调用（避免 dry 陆地误触发）。
   */
  private tryWaterShoreStepUp(loaded: boolean): boolean {
    const p = this;
    const x0 = Math.floor(p.x - PLAYER_HALF),
      x1 = Math.floor(p.x + PLAYER_HALF - 1e-7);
    const y0 = Math.floor(p.y),
      y1 = Math.floor(p.y + PLAYER_HEIGHT - 1e-7);
    const z0 = Math.floor(p.z - PLAYER_HALF),
      z1 = Math.floor(p.z + PLAYER_HALF - 1e-7);
    // 收集所有撞到的 solid：必须是 AABB 顶部 1 格（即 y1 == AABB 顶 1 格），
    // 且 AABB 底部以下没撞（避免把玩家从 1 格高洞里推上去）。
    let stepUpTop = -Infinity;
    let onlyTopHit = true;
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          if (!this.solidAt(bx, by, bz, loaded)) continue;
          const top = by + 1;
          if (top > stepUpTop) stepUpTop = top;
          // 撞到的 solid 必须在 AABB 顶部 1 格内（即 top == y1 + 1 = AABB 顶）
          if (top < y1 + 1 - 1e-6) onlyTopHit = false;
        }
      }
    }
    if (!onlyTopHit || stepUpTop === -Infinity) return false;
    // 把 feet 抬到 stepUpTop - 1.8（顶刚好跟 sand 底相切）
    const newY = stepUpTop - 1.8;
    // 限制不能"跳高超过 1 格"，避免从 1 格高洞被弹飞
    if (newY - p.y > 1.0) return false;
    if (newY <= p.y - 0.05) return false; // 不能往下
    p.y = newY;
    return true;
  }
  step(input: MoveInput, dt: number): void {
    this.collidedX = false;
    this.collidedZ = false;
    // 水检测（脚部与头部）：任意水位的水方块都算（含流动水）
    const feetBlock = this.world.getBlock(
      Math.floor(this.x),
      Math.floor(this.y + 0.4),
      Math.floor(this.z),
    );
    const headBlock = this.world.getBlock(
      Math.floor(this.x),
      Math.floor(this.y + this.eyeHeight()),
      Math.floor(this.z),
    );
    this.inWater =
      this.world.reg.isWater(feetBlock) || this.world.reg.isWater(headBlock);
    this.headInWater = this.world.reg.isWater(headBlock);

    // 期望水平速度
    const speed = this.flying
      ? FLY_SPEED
      : this.sneaking
        ? SNEAK_SPEED
        : input.sprint
          ? SPRINT_SPEED
          : WALK_SPEED;
    const sin = Math.sin(input.yaw),
      cos = Math.cos(input.yaw);
    let wx = -sin * input.forward + cos * input.strafe;
    let wz = -cos * input.forward - sin * input.strafe;
    const len = Math.hypot(wx, wz);
    if (len > 1e-5) {
      wx /= Math.max(1, len);
      wz /= Math.max(1, len);
    }
    const sp = this.inWater && !this.flying ? speed * 0.55 : speed;
    this.vx = wx * sp;
    this.vz = wz * sp;

    // 垂直
    if (this.flying) {
      this.vy =
        (input.jump ? FLY_SPEED * 0.9 : 0) +
        (input.down ? -FLY_SPEED * 0.9 : 0);
    } else if (this.inWater) {
      this.vy -= WATER_GRAVITY * dt;
      if (input.jump) {
        // 浅水（feet 浸水但 head 已出水）可 jump 出 sand；深水（head 仍浸）只能 swim up。
        // MC 行为：哪怕 onGround=false 也能跳（双脚已踩水底）。
        if (!this.headInWater) this.vy = JUMP_VEL;
        else this.vy = Math.min(this.vy + 28 * dt, WATER_SWIM_UP);
      }
      if (this.vy < WATER_SINK_MAX) this.vy = WATER_SINK_MAX;
    } else {
      this.vy -= GRAVITY * dt;
      if (this.vy < TERMINAL_VEL) this.vy = TERMINAL_VEL;
      if (input.jump && this.onGround) this.vy = JUMP_VEL;
    }

    // 逐轴移动（潜行且非飞行时防坠落）
    const sneakGuard = this.sneaking && this.onGround && !this.flying;
    if (
      sneakGuard &&
      this.vx !== 0 &&
      !this.hasGroundBelow(this.x + this.vx * dt, this.y, this.z)
    ) {
      this.vx = 0;
    }
    this.moveAxis('x', this.vx * dt);
    if (
      sneakGuard &&
      this.vz !== 0 &&
      !this.hasGroundBelow(this.x, this.y, this.z + this.vz * dt)
    ) {
      this.vz = 0;
    }
    this.moveAxis('z', this.vz * dt);
    const hitY = this.moveAxis('y', this.vy * dt);
    this.onGround = hitY && this.vy <= 0 && !this.flying;
    if (this.flying) this.onGround = false;

    // 掉出世界兜底
    if (this.y < -16) {
      this.y = 100;
      this.vy = 0;
    }
  }

  /** 玩家 AABB 是否与某方块格相交（放置方块时避免卡进自己） */
  intersectsBlock(bx: number, by: number, bz: number): boolean {
    return (
      bx + 1 > this.x - PLAYER_HALF &&
      bx < this.x + PLAYER_HALF &&
      by + 1 > this.y &&
      by < this.y + PLAYER_HEIGHT &&
      bz + 1 > this.z - PLAYER_HALF &&
      bz < this.z + PLAYER_HALF
    );
  }
}
