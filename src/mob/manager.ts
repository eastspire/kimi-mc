import * as THREE from 'three';
import type { World } from '../world/world';
import type { Particles } from '../fx/particles';
import { Mob, HOSTILE, SUN_BURNS, CONDITIONAL_HOSTILE, type MobKind } from './mob';
import { setMobBrightness } from './model';

// ============================================================
// 生物管理：生成 / 消失 / 日晒燃烧 / 追击目标 / 攻击拾取
//  - 白天刷猪（仅草方块），夜晚刷僵尸（任意非水非树叶地表）
//  - 距玩家 24~44 格生成（MC 下限 24），>90 格消失
//  - 僵尸日出后暴露天空 2s 自燃消失（冒烟粒子）
//  - raycastMob：视线射线 vs 生物 AABB（slab 法），攻击判定用
// ============================================================

const MAX_PASSIVE = 8;
const MAX_ZOMBIES = 6;
const SPAWN_MIN = 24;
const SPAWN_MAX = 44;
const DESPAWN_DIST = 90;
const BURN_TIME = 2;
const CHASE_RANGE = 24;

export interface MobHit {
  mob: Mob;
  dist: number;
}

export class MobManager {
  private mobs: Mob[] = [];
  private spawnTimer = 4;
  private burnTick = 0;

  constructor(
    private scene: THREE.Scene,
    private world: World,
    private particles: Particles,
    /** 生物死亡（击杀/烧死）时掉落回调 */
    private onMobDead?: (kind: MobKind, x: number, y: number, z: number) => void,
    /** 鸡下蛋回调（在鸡脚下生成鸡蛋物品） */
    private onLayEgg?: (x: number, y: number, z: number) => void,
  ) {}

  get count(): number {
    return this.mobs.length;
  }

  /** 手动生成一只生物（调试/后续刷怪蛋用） */
  spawn(kind: MobKind, x: number, y: number, z: number): Mob {
    const mob = new Mob(this.world, kind, x, y, z);
    this.mobs.push(mob);
    this.scene.add(mob.model.group);
    return mob;
  }

  private removeAt(i: number): void {
    const m = this.mobs[i];
    this.scene.remove(m.model.group);
    this.mobs.splice(i, 1);
  }

  /** 视线射线 vs 全部生物 AABB，返回最近命中（slab 法，跳过死亡动画中的） */
  raycastMob(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): MobHit | null {
    let best: MobHit | null = null;
    for (const m of this.mobs) {
      if (m.dying) continue;
      const t = rayAabb(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        m.x - m.half,
        m.y,
        m.z - m.half,
        m.x + m.half,
        m.y + m.height,
        m.z + m.half,
      );
      if (t !== null && t <= maxDist && (best === null || t < best.dist)) {
        best = { mob: m, dist: t };
      }
    }
    return best;
  }

  /**
   * 玩家箭命中检测：点 (x,y,z) 是否进入某生物 AABB（加 0.15 余量）；
   * 命中则造成伤害与水平击退，返回 true（箭消失）
   */
  arrowHit(
    x: number,
    y: number,
    z: number,
    dmg: number,
    kbx: number,
    kbz: number,
  ): boolean {
    for (const m of this.mobs) {
      if (m.dying) continue;
      if (
        Math.abs(x - m.x) < m.half + 0.15 &&
        Math.abs(z - m.z) < m.half + 0.15 &&
        y > m.y - 0.1 &&
        y < m.y + m.height + 0.1
      ) {
        m.damage(kbx, kbz, dmg);
        return true;
      }
    }
    return false;
  }

  /** 头顶到世界顶端无任何实体遮挡 */
  private exposedToSky(m: Mob): boolean {
    const bx = Math.floor(m.x);
    const bz = Math.floor(m.z);
    for (let y = Math.floor(m.y + m.height) + 1; y < 128; y++) {
      if (this.world.isSolid(bx, y, bz)) return false;
    }
    return true;
  }

  private trySpawn(px: number, pz: number, kind: MobKind): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const bx = Math.floor(px + Math.cos(ang) * dist);
    const bz = Math.floor(pz + Math.sin(ang) * dist);
    if (!this.world.hasChunk(Math.floor(bx / 16), Math.floor(bz / 16))) return;

    const grassId = this.world.reg.id('grass_block');
    const leavesId = this.world.reg.id('oak_leaves');

    // 自上而下找第一个实体面：要求上方足够净空（按生物高度）
    const needClear = kind === 'enderman' ? 3 : 2;
    for (let y = 110; y > 40; y--) {
      if (!this.world.isSolid(bx, y, bz)) continue;
      let blocked = false;
      for (let c = 1; c <= needClear; c++) {
        if (this.world.isSolid(bx, y + c, bz)) {
          blocked = true;
          break;
        }
      }
      if (blocked) return; // 顶面被堵（树上/悬空物下），本轮放弃
      const ground = this.world.getBlock(bx, y, bz);
      if (this.world.reg.isWater(ground) || ground === leavesId) return;
      if (!HOSTILE.has(kind) && kind !== 'enderman' && ground !== grassId) return;
      this.spawn(kind, bx + 0.5, y + 1.01, bz + 0.5);
      return;
    }
  }

  update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    daylight: number,
    onZombieHit?: (m: Mob) => void,
    /** 骷髅放箭（在骷髅位置朝玩家方向生成箭矢） */
    onShoot?: (m: Mob) => void,
    /** 苦力怕爆炸（执行地形破坏与伤害后移除苦力怕） */
    onExplode?: (m: Mob) => void,
    /** 苦力怕引信点燃（嘶嘶音效） */
    onFuse?: (m: Mob) => void,
  ): void {
    setMobBrightness(daylight);

    // 追击目标分配（敌对生物）：玩家 24 格内；蜘蛛白天中立；末影人仅激怒时追击
    const nightHostile = daylight < 0.55;
    for (const m of this.mobs) {
      if (m.kind === 'enderman') {
        // 末影人：未被激怒不追击；激怒后 24 格内锁玩家
        if (m.dying || !m.provoked) {
          m.hasTarget = false;
          continue;
        }
        const dx = px - m.x;
        const dz = pz - m.z;
        m.hasTarget = dx * dx + dz * dz < CHASE_RANGE * CHASE_RANGE;
        if (m.hasTarget) {
          m.targetX = px;
          m.targetY = py;
          m.targetZ = pz;
        }
        continue;
      }
      if (!HOSTILE.has(m.kind) || m.dying) {
        m.hasTarget = false;
        continue;
      }
      if (CONDITIONAL_HOSTILE.has(m.kind) && !nightHostile) {
        m.hasTarget = false; // 蜘蛛白天中立
        continue;
      }
      const dx = px - m.x;
      const dz = pz - m.z;
      m.hasTarget = dx * dx + dz * dz < CHASE_RANGE * CHASE_RANGE;
      if (m.hasTarget) {
        m.targetX = px;
        m.targetY = py;
        m.targetZ = pz;
      }
    }

    // 步进 + 死亡处理 + 远距离消失
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      m.step(dt);
      m.syncModel(dt);
      if (m.attackLanded) {
        m.attackLanded = false;
        onZombieHit?.(m);
      }
      if (m.shootArrow) {
        m.shootArrow = false;
        onShoot?.(m);
      }
      if (m.fuseJustLit) {
        m.fuseJustLit = false;
        onFuse?.(m);
      }
      if (m.explodeNow) {
        m.explodeNow = false;
        onExplode?.(m);
        this.removeAt(i);
        continue;
      }
      if (m.dying) {
        if (!m.puffed) {
          m.puffed = true;
          this.particles.spawn(m.x, m.y + m.height * 0.5, m.z, 0.9, 0.9, 0.9);
          this.onMobDead?.(m.kind, m.x, m.y + m.height * 0.5, m.z);
        }
        if (m.removeMe) this.removeAt(i);
        continue;
      }
      const dx = m.x - px;
      const dz = m.z - pz;
      if (dx * dx + dz * dz > DESPAWN_DIST * DESPAWN_DIST) this.removeAt(i);
      // 鸡下蛋：MC 每 5~10 分钟一枚，掉在鸡脚下
      if (m.kind === 'chicken' && !m.dying) {
        m.eggTimer -= dt;
        if (m.eggTimer <= 0) {
          m.eggTimer = 300 + Math.random() * 300;
          this.onLayEgg?.(m.x, m.y + 0.3, m.z);
        }
      }
    }

    // 僵尸/骷髅日晒自燃（每 0.5s 才做一次天空遮挡扫描，平时只累计计时）
    this.burnTick -= dt;
    const scan = this.burnTick <= 0;
    if (scan) this.burnTick = 0.5;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      if (!SUN_BURNS.has(m.kind) || m.dying) continue;
      const burning =
        daylight > 0.7 && ((scan && this.exposedToSky(m)) || m.sunTimer > 0);
      if (burning) {
        m.sunTimer += dt;
        if (m.sunTimer > BURN_TIME) {
          this.particles.spawn(m.x, m.y + m.height * 0.6, m.z, 0.25, 0.25, 0.25);
          this.onMobDead?.(m.kind, m.x, m.y + m.height * 0.6, m.z);
          this.removeAt(i);
        }
      } else if (m.sunTimer > 0) {
        m.sunTimer = Math.max(0, m.sunTimer - dt * 2);
      }
    }

    // 生成节律：4~8s 一次尝试；白天四种被动生物均匀随机，夜晚三种敌对均匀随机
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 4 + Math.random() * 4;
      const passive = daylight > 0.55;
      const PASSIVES: MobKind[] = ['pig', 'sheep', 'cow', 'chicken'];
      // 夜晚敌对池：末影人权重较低（MC 较稀有）
      const HOSTILES: MobKind[] = [
        'zombie', 'skeleton', 'creeper', 'spider',
        'zombie', 'skeleton', 'creeper', 'spider',
        'enderman',
      ];
      const pool = passive ? PASSIVES : HOSTILES;
      const kind: MobKind = pool[Math.floor(Math.random() * pool.length)];
      const cap = passive ? MAX_PASSIVE : MAX_ZOMBIES;
      let n = 0;
      for (const m of this.mobs) {
        if (m.dying) continue;
        if (passive ? !HOSTILE.has(m.kind) : HOSTILE.has(m.kind)) n++;
      }
      if (n < cap) this.trySpawn(px, pz, kind);
    }
  }
}

/** 射线 vs AABB（slab 法）：命中返回进入距离 t，未命中返回 null */
function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number | null {
  let tmin = 0;
  let tmax = Infinity;
  const axes: [number, number, number, number][] = [
    [ox, dx, x0, x1],
    [oy, dy, y0, y1],
    [oz, dz, z0, z1],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
