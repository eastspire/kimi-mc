import * as THREE from 'three';
import { buildDragonModel, setMobHurt, type MobModel } from './model';

// ============================================================
// 末影龙 BOSS：盘旋末地主岛上空，周期性俯冲攻击玩家
//  - 飞行：绕岛心盘旋，随机变换高度/半径；玩家靠近时俯冲
//  - 俯冲：锁定玩家直线冲撞，接触造成高伤害 + 击退，随后拉升
//  - 回血：末影水晶存在时缓慢回血（水晶被玩家破坏后停止）
//  - 死亡：坠地动画，爆大量经验 + 龙蛋，激活返回传送门
// ============================================================

export type DragonPhase = 'circling' | 'diving' | 'rising' | 'dying';

const CIRCLE_Y = 78; // 盘旋基准高度（主岛 ISLAND_Y=64 上方）
const DIVE_DAMAGE = 12; // 俯冲接触伤害（6 心）
const MAX_HP = 200; // MC 末影龙 200 血

export class EnderDragon {
  readonly model: MobModel;
  x = 0;
  y = CIRCLE_Y;
  z = -30;
  yaw = 0;
  hp = MAX_HP;
  readonly maxHp = MAX_HP;
  phase: DragonPhase = 'circling';
  dying = false;
  removeMe = false;

  private circleAng = Math.PI * 0.5;
  private circleRadius = 30;
  private targetY = CIRCLE_Y;
  private phaseTimer = 0;
  private diveX = 0;
  private diveY = 0;
  private diveZ = 0;
  private hurtTimer = 0;
  private hurtOn = false;
  private invuln = 0;
  private flapPhase = 0;
  private deathTimer = 0;
  private vy = 0;
  /** 水晶剩余数量（main 每帧统计写入；>0 时缓慢回血） */
  crystalsAlive = 0;
  private healAcc = 0;

  constructor(
    private scene: THREE.Scene,
  ) {
    this.model = buildDragonModel();
    this.model.group.scale.setScalar(3);
    scene.add(this.model.group);
    this.syncModel();
  }

  /** 受击：伤害 + 红闪 + 无敌帧；返回是否真的造成了伤害 */
  damage(dmg: number): boolean {
    if (this.dying || this.invuln > 0) return false;
    this.hp -= dmg;
    this.invuln = 0.3;
    this.hurtTimer = 0.25;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dying = true;
      this.phase = 'dying';
      this.deathTimer = 0;
    }
    return true;
  }

  /** 是否与攻击点（玩家近战/箭）相交（宽松 AABB，龙体型大） */
  hitTest(px: number, py: number, pz: number, reach: number): boolean {
    const dx = px - this.x;
    const dy = py - (this.y + 1);
    const dz = pz - this.z;
    return dx * dx + dy * dy + dz * dz < (reach + 3) * (reach + 3);
  }

  /**
   * 主循环步进。onHitPlayer 在俯冲接触时回调（伤害+击退由 main 处理）。
   */
  step(
    dt: number,
    px: number,
    py: number,
    pz: number,
    onHitPlayer: (dmg: number, kbx: number, kbz: number) => void,
  ): void {
    this.invuln = Math.max(0, this.invuln - dt);
    if (this.hurtTimer > 0) this.hurtTimer -= dt;
    this.flapPhase += dt * (this.phase === 'diving' ? 9 : 4.5);

    // 水晶回血：每颗存活水晶 0.5 血/秒（MC 水晶连线回血简化）
    if (!this.dying && this.crystalsAlive > 0 && this.hp < this.maxHp) {
      this.healAcc += dt * 0.5 * this.crystalsAlive;
      if (this.healAcc >= 1) {
        const add = Math.floor(this.healAcc);
        this.healAcc -= add;
        this.hp = Math.min(this.maxHp, this.hp + add);
      }
    }

    if (this.dying) {
      // 死亡：缓缓坠向岛心，渐隐消散
      this.deathTimer += dt;
      this.y = Math.max(66, this.y - dt * 3);
      this.model.group.rotation.z += dt * 0.6;
      if (this.deathTimer > 2.5) this.removeMe = true;
      this.syncModel();
      return;
    }

    const distP = Math.hypot(px - this.x, pz - this.z);
    this.phaseTimer -= dt;

    if (this.phase === 'circling') {
      // 盘旋：绕岛心缓慢转圈，高度正弦起伏
      this.circleAng += dt * 0.35;
      const tx = Math.cos(this.circleAng) * this.circleRadius;
      const tz = Math.sin(this.circleAng) * this.circleRadius;
      this.targetY = CIRCLE_Y + Math.sin(this.flapPhase * 0.3) * 4;
      this.flyToward(tx, this.targetY, tz, dt, 10);
      // 周期性俯冲：玩家在范围内且计时到
      if (this.phaseTimer <= 0 && distP < 48) {
        this.phase = 'diving';
        this.diveX = px;
        this.diveY = py;
        this.diveZ = pz;
        this.phaseTimer = 3; // 俯冲最长持续
      }
    } else if (this.phase === 'diving') {
      // 俯冲：直线冲向玩家
      this.flyToward(this.diveX, this.diveY + 1, this.diveZ, dt, 22);
      // 接触玩家：伤害 + 击退，然后拉升
      if (distP < 4 && Math.abs(py + 1 - this.y) < 3) {
        const kx = px - this.x;
        const kz = pz - this.z;
        onHitPlayer(DIVE_DAMAGE, kx, kz);
        this.phase = 'rising';
        this.phaseTimer = 2.5;
      } else if (this.phaseTimer <= 0) {
        this.phase = 'rising';
        this.phaseTimer = 2.5;
      }
    } else if (this.phase === 'rising') {
      // 拉升回盘旋高度
      this.flyToward(this.x, CIRCLE_Y + 6, this.z, dt, 12);
      if (this.phaseTimer <= 0) {
        this.phase = 'circling';
        this.circleRadius = 24 + Math.random() * 16;
        this.phaseTimer = 4 + Math.random() * 4; // 下次俯冲间隔
      }
    }

    // 朝向 = 速度方向
    this.syncModel();
  }

  /** 朝目标点平滑飞行（位置插值 + 朝向） */
  private flyToward(
    tx: number,
    ty: number,
    tz: number,
    dt: number,
    speed: number,
  ): void {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dz = tz - this.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return;
    const step = Math.min(d, speed * dt);
    this.x += (dx / d) * step;
    this.y += (dy / d) * step;
    this.z += (dz / d) * step;
    this.vy = (dy / d) * speed;
    // 朝向：面向移动方向（模型正面 -Z，yaw 约定与 Mob 一致）
    this.yaw = Math.atan2(-dx, -dz);
  }

  /** 位置/朝向/翅膀扇动/受伤红闪同步到模型 */
  private syncModel(): void {
    const g = this.model.group;
    g.position.set(this.x, this.y, this.z);
    g.rotation.y = this.yaw;
    if (!this.dying) g.rotation.z = 0;
    // 俯冲时身体前倾
    g.rotation.x = this.phase === 'diving' ? 0.5 : this.vy < -1 ? -0.2 : 0;

    // 翅膀扇动（绕 z 轴上下扑）
    const flap = Math.sin(this.flapPhase) * 0.7;
    if (this.model.arms[0]) this.model.arms[0].rotation.z = -flap - 0.15;
    if (this.model.arms[1]) this.model.arms[1].rotation.z = flap + 0.15;
    // 尾节摆动 + 颈微摆
    const legs = this.model.legs;
    for (let i = 0; i < legs.length; i++) {
      legs[i].rotation.y = Math.sin(this.flapPhase * 0.5 + i * 0.8) * 0.18;
    }

    // 受伤红闪
    const hurt = this.dying || this.hurtTimer > 0;
    if (hurt !== this.hurtOn) {
      this.hurtOn = hurt;
      setMobHurt(this.model, hurt);
    }
    // 死亡渐隐（经材质透明实现）
    if (this.dying) {
      const t = Math.min(1, this.deathTimer / 2.5);
      for (const m of this.model.meshes) {
        (m.material as THREE.MeshBasicMaterial).transparent = true;
        (m.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      }
    }
  }

  dispose(): void {
    this.scene.remove(this.model.group);
  }
}
