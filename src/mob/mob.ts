import type { World } from '../world/world';
import {
  buildPigModel,
  buildZombieModel,
  buildSheepModel,
  buildCowModel,
  buildChickenModel,
  buildSkeletonModel,
  buildCreeperModel,
  buildSpiderModel,
  buildEndermanModel,
  setMobHurt,
  type MobModel,
} from './model';

// ============================================================
// 生物实体：逐轴 AABB 体素碰撞（与玩家同套物理参数）+ 行为
//  - 游荡：站立 ↔ 随机方向行走（猪/僵尸通用）
//  - 僵尸：24 格内追击玩家，近身挥臂攻击（创造模式无伤害）
//  - 猪：受击后恐慌逃窜 2s
//  - 受伤：击退 + 红闪 0.25s + 0.5s 无敌帧（MC 一致）
//  - 死亡：倒地侧翻 0.45s 后由 manager 移除
// ============================================================

export type MobKind =
  | 'pig'
  | 'zombie'
  | 'sheep'
  | 'cow'
  | 'chicken'
  | 'skeleton'
  | 'creeper'
  | 'spider'
  | 'enderman';

const GRAVITY = 27;
const TERMINAL_VEL = -52;
const JUMP_VEL = 8.4;
const WATER_GRAVITY = 5.5;
const WATER_SWIM_UP = 2.4;
const CHASE_RANGE = 24;
const ATTACK_RANGE = 1.4;
const KNOCKBACK = 6.5;
const DEATH_TIME = 0.45;

interface MobDims {
  half: number;
  height: number;
  speed: number;
  hp: number;
}

const DIMS: Record<MobKind, MobDims> = {
  pig: { half: 0.45, height: 0.9, speed: 1.15, hp: 10 },
  zombie: { half: 0.3, height: 1.95, speed: 1.4, hp: 20 },
  sheep: { half: 0.45, height: 1.3, speed: 1.1, hp: 8 },
  cow: { half: 0.45, height: 1.0, speed: 1.1, hp: 10 },
  chicken: { half: 0.3, height: 0.7, speed: 1.3, hp: 4 },
  skeleton: { half: 0.3, height: 1.95, speed: 1.4, hp: 20 },
  creeper: { half: 0.3, height: 1.7, speed: 1.3, hp: 20 },
  spider: { half: 0.7, height: 0.9, speed: 1.6, hp: 16 },
  enderman: { half: 0.3, height: 2.9, speed: 1.5, hp: 40 },
};

/** 腿摆动相位偏移：四足对角同相，双足左右交替 */
const LEG_PHASE: Record<MobKind, number[]> = {
  pig: [0, Math.PI, Math.PI, 0],
  zombie: [0, Math.PI],
  sheep: [0, Math.PI, Math.PI, 0],
  cow: [0, Math.PI, Math.PI, 0],
  chicken: [0, Math.PI],
  skeleton: [0, Math.PI],
  creeper: [0, Math.PI, Math.PI, 0],
  spider: [0, Math.PI, Math.PI, 0, Math.PI, 0, 0, Math.PI],
  enderman: [0, Math.PI],
};

const MODEL_BUILDER: Record<MobKind, () => MobModel> = {
  pig: buildPigModel,
  zombie: buildZombieModel,
  sheep: buildSheepModel,
  cow: buildCowModel,
  chicken: buildChickenModel,
  skeleton: buildSkeletonModel,
  creeper: buildCreeperModel,
  spider: buildSpiderModel,
  enderman: buildEndermanModel,
};

/** 敌对生物（追击玩家）；骷髅/僵尸怕日晒，苦力怕/蜘蛛不怕 */
export const HOSTILE: ReadonlySet<MobKind> = new Set([
  'zombie',
  'skeleton',
  'creeper',
  'spider',
]);
/** 条件敌对：白天中立、夜晚敌对（MC 蜘蛛特性） */
export const CONDITIONAL_HOSTILE: ReadonlySet<MobKind> = new Set(['spider']);
export const SUN_BURNS: ReadonlySet<MobKind> = new Set(['zombie', 'skeleton']);

export class Mob {
  readonly model: MobModel;
  readonly half: number;
  readonly height: number;

  x: number;
  y: number;
  z: number;
  vx = 0;
  vy = 0;
  vz = 0;
  /** 身体朝向（移动方向，rad） */
  yaw = 0;
  onGround = false;
  /** 暴露在日光下的累计秒数（僵尸燃烧用，manager 维护） */
  sunTimer = 0;
  /** 鸡下蛋倒计时（秒，manager 维护），MC：5~10 分钟一枚 */
  eggTimer = 300 + Math.random() * 300;
  /** 本帧攻击命中玩家（manager 消费后置位回调） */
  attackLanded = false;
  /** 骷髅本帧放箭（manager 消费） */
  shootArrow = false;
  /** 苦力怕引信秒数（<0 未点燃；MC 走远熄灭） */
  fuseTimer = -1;
  /** 苦力怕本帧爆炸（manager 消费） */
  explodeNow = false;
  /** 引信刚点燃（manager 消费一次：嘶嘶音效） */
  fuseJustLit = false;

  hp: number;
  dying = false;
  /** 死亡白烟已喷过（manager 置位，防重复） */
  puffed = false;

  /** 追击目标（僵尸）：manager 每帧写入玩家位置 */
  targetX = 0;
  targetY = 0;
  targetZ = 0;
  hasTarget = false;

  private readonly speed: number;
  private aiTimer = 0;
  private walking = false;
  private walkPhase = 0;
  private colX = false;
  private colZ = false;
  private readonly legPhase: number[];

  private hurtTimer = 0;
  private hurtOn = false;
  private invuln = 0;
  private knockTimer = 0;
  private kbX = 0;
  private kbZ = 0;
  private panicTimer = 0;
  private panicYaw = 0;
  private attackTimer = 0;
  private attackAnim = 0;
  private deathTimer = 0;
  /** 末影人瞬移冷却（追击/受击逃逸共用） */
  private teleportTimer = 0;

  constructor(
    private world: World,
    readonly kind: MobKind,
    x: number,
    y: number,
    z: number,
  ) {
    const d = DIMS[kind];
    this.half = d.half;
    this.height = d.height;
    this.speed = d.speed;
    this.hp = d.hp;
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = Math.random() * Math.PI * 2;
    this.aiTimer = 1 + Math.random() * 3;
    this.legPhase = LEG_PHASE[kind];
    this.model = MODEL_BUILDER[kind]();
    this.syncModel(0);
  }

  /** 死亡动画播完，manager 据此移除 */
  get removeMe(): boolean {
    return this.dying && this.deathTimer >= DEATH_TIME + 0.15;
  }

  /** 末影人被激怒（注视/受击触发，manager 维护） */
  provoked = false;

  /** 受击：伤害 + 击退 + 红闪 + 无敌帧；返回是否真的造成了伤害 */
  damage(dirX: number, dirZ: number, dmg: number): boolean {
    if (this.dying || this.invuln > 0) return false;
    this.hp -= dmg;
    this.invuln = 0.5;
    this.hurtTimer = 0.25;
    const len = Math.hypot(dirX, dirZ) || 1;
    this.kbX = (dirX / len) * KNOCKBACK;
    this.kbZ = (dirZ / len) * KNOCKBACK;
    this.knockTimer = 0.28;
    if (this.onGround) this.vy = 3.8;
    if (this.hp <= 0) {
      this.dying = true;
      this.deathTimer = 0;
    } else if (this.kind === 'enderman') {
      // 末影人受击：激怒并概率瞬移逃逸（MC：被打后常瞬走再绕回）
      this.provoked = true;
      if (Math.random() < 0.5) this.teleportNear(this.x, this.y, this.z, 8);
    } else if (!HOSTILE.has(this.kind)) {
      // 被动生物恐慌逃窜：朝击退反方向狂奔 2s（敌对生物不恐慌，MC 一致）
      this.panicTimer = 2;
      this.panicYaw = Math.atan2(-dirX, -dirZ);
    }
    return true;
  }

  private solidAt(bx: number, by: number, bz: number): boolean {
    // 未加载区块视为实体（与玩家物理一致，防坠虚空）
    if (!this.world.hasChunk(Math.floor(bx / 16), Math.floor(bz / 16)))
      return true;
    return this.world.isSolid(bx, by, bz);
  }

  private boxCollides(x: number, y: number, z: number): boolean {
    const x0 = Math.floor(x - this.half);
    const x1 = Math.floor(x + this.half - 1e-7);
    const y0 = Math.floor(y);
    const y1 = Math.floor(y + this.height - 1e-7);
    const z0 = Math.floor(z - this.half);
    const z1 = Math.floor(z + this.half - 1e-7);
    for (let by = y0; by <= y1; by++)
      for (let bz = z0; bz <= z1; bz++)
        for (let bx = x0; bx <= x1; bx++)
          if (this.solidAt(bx, by, bz)) return true;
    return false;
  }

  private moveAxis(axis: 'x' | 'y' | 'z', delta: number): boolean {
    if (delta === 0) return false;
    this[axis] += delta;
    if (!this.boxCollides(this.x, this.y, this.z)) return false;

    const x0 = Math.floor(this.x - this.half);
    const x1 = Math.floor(this.x + this.half - 1e-7);
    const y0 = Math.floor(this.y);
    const y1 = Math.floor(this.y + this.height - 1e-7);
    const z0 = Math.floor(this.z - this.half);
    const z1 = Math.floor(this.z + this.half - 1e-7);
    let hit = false;
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          if (!this.solidAt(bx, by, bz)) continue;
          hit = true;
          if (axis === 'x') {
            this.x =
              delta > 0 ? bx - this.half - 1e-4 : bx + 1 + this.half + 1e-4;
            this.vx = 0;
            this.colX = true;
          } else if (axis === 'y') {
            this.y = delta > 0 ? by - this.height - 1e-4 : by + 1 + 1e-4;
            this.vy = 0;
          } else {
            this.z =
              delta > 0 ? bz - this.half - 1e-4 : bz + 1 + this.half + 1e-4;
            this.vz = 0;
            this.colZ = true;
          }
        }
      }
    }
    return hit;
  }

  /** 末影人瞬移：在 (cx,cy,cz) 附近随机找一处可站立位置，瞬移过去（MC） */
  private teleportNear(cx: number, cy: number, cz: number, radius: number): void {
    for (let attempt = 0; attempt < 12; attempt++) {
      const nx = cx + (Math.random() - 0.5) * 2 * radius;
      const nz = cz + (Math.random() - 0.5) * 2 * radius;
      const bx = Math.floor(nx);
      const bz = Math.floor(nz);
      // 自上而下找可站立面（脚下方块实体、头顶净空）
      for (let by = Math.min(120, Math.floor(cy) + 4); by > Math.floor(cy) - 6; by--) {
        if (!this.solidAt(bx, by, bz)) continue;
        if (this.boxCollides(nx, by + 1.01, nz)) break;
        this.x = nx;
        this.y = by + 1.01;
        this.z = nz;
        this.vy = 0;
        return;
      }
    }
  }

  /** 物理 + AI 步进 */
  step(dt: number): void {
    if (this.dying) {
      this.deathTimer += dt;
      return; // 倒地动画由 syncModel 表现，不再移动
    }
    this.invuln = Math.max(0, this.invuln - dt);
    if (this.hurtTimer > 0) this.hurtTimer -= dt;
    this.attackTimer = Math.max(0, this.attackTimer - dt);

    // ---- 敌对追击：僵尸近身挥击 / 骷髅 10 格外停步放箭 / 苦力怕近身引爆 ----
    let chasing = false;
    if (HOSTILE.has(this.kind) && this.hasTarget) {
      const dx = this.targetX - this.x;
      const dz = this.targetZ - this.z;
      const d = Math.hypot(dx, dz);
      const dy = Math.abs(this.targetY - this.y);
      if (d < CHASE_RANGE && dy < 10) {
        if (this.kind === 'zombie' || this.kind === 'spider' || this.kind === 'enderman') {
          chasing = true;
          this.yaw = Math.atan2(-dx, -dz);
          if (d < ATTACK_RANGE + this.half && dy < 2.2 && this.attackTimer <= 0) {
            this.attackTimer = 1;
            this.attackAnim = 0.45;
            this.attackLanded = true;
          }
          // 蜘蛛跃击：追击接近时概率前扑跳起（MC 蜘蛛特性）
          if (this.kind === 'spider' && this.onGround && d < 6 && d > 2 && Math.random() < 0.02)
            this.vy = JUMP_VEL * 1.1;
          // 末影人瞬移：追击时周期性瞬移到玩家附近（MC 特性）
          if (this.kind === 'enderman') {
            this.teleportTimer -= dt;
            if (this.teleportTimer <= 0) {
              this.teleportTimer = 2 + Math.random() * 3;
              this.teleportNear(this.targetX, this.targetY, this.targetZ, 4);
            }
          }
        } else if (this.kind === 'skeleton') {
          this.yaw = Math.atan2(-dx, -dz);
          if (d > 10) chasing = true; // 接近到射程停住（MC 站桩输出）
          if (d < 16 && dy < 4 && this.attackTimer <= 0) {
            this.attackTimer = 2;
            this.attackAnim = 0.45;
            this.shootArrow = true;
          }
        } else if (this.kind === 'creeper') {
          this.yaw = Math.atan2(-dx, -dz);
          if (this.fuseTimer >= 0) {
            if (d > 7) {
              this.fuseTimer = -1; // 走远熄灭（MC）
            } else {
              this.fuseTimer += dt;
              if (this.fuseTimer >= 1.5) {
                this.explodeNow = true;
                this.fuseTimer = -1;
              }
            }
          } else if (d < 3 && dy < 2.5) {
            this.fuseTimer = 0;
            this.fuseJustLit = true; // 点燃瞬间（嘶嘶声）
          }
          if (this.fuseTimer < 0) chasing = true; // 引爆中定住不动
        }
      }
    }

    // ---- 水平速度：击退 > 恐慌 > 追击 > 游荡 ----
    if (this.knockTimer > 0) {
      this.knockTimer -= dt;
      this.vx = this.kbX;
      this.vz = this.kbZ;
    } else if (this.panicTimer > 0) {
      this.panicTimer -= dt;
      this.yaw = this.panicYaw;
      const sp = this.speed * 2.1;
      this.vx = -Math.sin(this.yaw) * sp;
      this.vz = -Math.cos(this.yaw) * sp;
    } else if (chasing) {
      const sp = this.speed * 1.65;
      this.vx = -Math.sin(this.yaw) * sp;
      this.vz = -Math.cos(this.yaw) * sp;
    } else {
      // 游荡 AI：站立 1.5~4.5s ↔ 行走 2~6s（随机新方向）
      this.aiTimer -= dt;
      if (this.aiTimer <= 0) {
        if (this.walking && Math.random() < 0.45) {
          this.walking = false;
          this.aiTimer = 1.5 + Math.random() * 3;
        } else {
          this.walking = true;
          this.yaw = Math.random() * Math.PI * 2;
          this.aiTimer = 2 + Math.random() * 4;
        }
      }
      if (this.walking) {
        this.vx = -Math.sin(this.yaw) * this.speed;
        this.vz = -Math.cos(this.yaw) * this.speed;
      } else {
        this.vx = 0;
        this.vz = 0;
      }
    }

    // ---- 垂直：水中上浮，陆上重力 ----
    const feetId = this.world.getBlock(
      Math.floor(this.x),
      Math.floor(this.y + 0.3),
      Math.floor(this.z),
    );
    if (this.world.reg.isWater(feetId)) {
      this.vy -= WATER_GRAVITY * dt;
      this.vy = Math.min(this.vy + 26 * dt, WATER_SWIM_UP);
    } else {
      this.vy -= GRAVITY * dt;
      if (this.vy < TERMINAL_VEL) this.vy = TERMINAL_VEL;
    }

    this.colX = false;
    this.colZ = false;
    this.moveAxis('x', this.vx * dt);
    this.moveAxis('z', this.vz * dt);
    const hitY = this.moveAxis('y', this.vy * dt);
    this.onGround = hitY && this.vy <= 0;

    // 有移动意图且撞墙时自动跳 1 格（MC 生物基础行为）
    if ((this.colX || this.colZ) && this.onGround && this.knockTimer <= 0)
      this.vy = JUMP_VEL;

    // 掉出世界兜底
    if (this.y < -16) {
      this.y = 100;
      this.vy = 0;
    }
  }

  /** 位置/朝向/动画同步到模型 */
  syncModel(dt: number): void {
    const g = this.model.group;
    if (this.dying) {
      // 侧翻倒地（MC 死亡姿态）
      const t = Math.min(1, this.deathTimer / DEATH_TIME);
      g.rotation.z = (-Math.PI / 2) * t;
    }
    // 受伤红闪（死亡期间保持）
    const hurt = this.dying || this.hurtTimer > 0;
    if (hurt !== this.hurtOn) {
      this.hurtOn = hurt;
      setMobHurt(this.model, hurt);
    }

    const sp = Math.hypot(this.vx, this.vz);
    this.walkPhase += sp * dt * 1.7;
    const amp = Math.min(0.72, sp * 0.45);
    const legs = this.model.legs;
    for (let i = 0; i < legs.length; i++) {
      legs[i].rotation.x =
        Math.sin(this.walkPhase + (this.legPhase[i] ?? 0)) * amp;
    }

    // 手臂：僵尸恒前举（攻击下压）；骷髅平时垂臂、射箭时抬起
    if (this.model.arms.length > 0) {
      const base = this.model.armBase ?? Math.PI / 2;
      let armRot = base;
      if (this.attackAnim > 0) {
        this.attackAnim -= dt;
        if (this.kind === 'zombie')
          armRot = base - Math.abs(Math.sin(this.attackAnim * 14)) * 0.6;
        else armRot = base + (Math.PI / 2) * Math.min(1, this.attackAnim / 0.45);
      }
      for (const a of this.model.arms) a.rotation.x = armRot;
    }

    // 苦力怕引信：膨胀 + 白闪（MC 引爆前奏）
    if (this.kind === 'creeper') {
      if (this.fuseTimer >= 0) {
        g.scale.setScalar(1 + (this.fuseTimer / 1.5) * 0.25);
        const flash = Math.floor(this.fuseTimer * 10) % 2 === 1;
        if (flash !== this.hurtOn) {
          this.hurtOn = flash;
          setMobHurt(this.model, flash);
        }
      } else {
        if (g.scale.x !== 1) g.scale.setScalar(1);
        const want = this.dying || this.hurtTimer > 0;
        if (want !== this.hurtOn) {
          this.hurtOn = want;
          setMobHurt(this.model, want);
        }
      }
    }

    g.position.set(this.x, this.y, this.z);
    g.rotation.y = this.yaw;
  }
}
