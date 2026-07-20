import * as THREE from 'three';
import type { World } from '../world/world';

// ============================================================
// 箭矢投射物：细长盒体 + 抛物线飞行（MC 骷髅射箭）
//  - 重力下坠，命中玩家 AABB 触发伤害回调，命中方块即消失
//  - 几何/材质全局共享，每支箭仅一个 Mesh；60s 兜底消失
// ============================================================

const GRAVITY = 9;
const SPEED = 14;
const MAX_LIFE = 60;

interface Arrow {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  /** true=敌对（骷髅）伤玩家；false=玩家箭伤生物 */
  hostile: boolean;
  /** 命中伤害（玩家箭按蓄力 1~9） */
  dmg: number;
}

let arrowGeo: THREE.BoxGeometry | null = null;
let arrowMat: THREE.MeshBasicMaterial | null = null;

export class ArrowManager {
  private arrows: Arrow[] = [];

  constructor(
    private scene: THREE.Scene,
    private world: World,
  ) {
    if (!arrowGeo) {
      arrowGeo = new THREE.BoxGeometry(0.06, 0.06, 0.5);
      arrowMat = new THREE.MeshBasicMaterial({ color: 0xd8d0c0 });
    }
  }

  get count(): number {
    return this.arrows.length;
  }

  /** 维度切换时换绑世界并清除飞行中的箭（属于旧维度场景） */
  setWorld(w: World): void {
    this.world = w;
    for (const a of this.arrows) this.scene.remove(a.mesh);
    this.arrows.length = 0;
  }

  /** 从 (x,y,z) 朝单位方向 (dx,dy,dz) 射出 */
  spawn(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    speed = SPEED,
    hostile = true,
    dmg = 3,
  ): void {
    const mesh = new THREE.Mesh(arrowGeo!, arrowMat!);
    mesh.position.set(x, y, z);
    mesh.lookAt(x + dx, y + dy, z + dz);
    this.scene.add(mesh);
    this.arrows.push({
      mesh,
      x,
      y,
      z,
      vx: dx * speed,
      vy: dy * speed,
      vz: dz * speed,
      age: 0,
      hostile,
      dmg,
    });
  }

  private removeAt(i: number): void {
    this.scene.remove(this.arrows[i].mesh);
    this.arrows.splice(i, 1);
  }

  /**
   * 每帧推进。敌对箭命中玩家（AABB 以 px,py,pz 为脚底中心）调 onHitPlayer；
   * 玩家箭命中生物调 hitMob（返回 true 即消失）；命中实体方块调 onHitBlock 后消失。
   */
  update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    onHitPlayer: (dmg: number) => void,
    onHitBlock?: (x: number, y: number, z: number) => void,
    hitMob?: (
      x: number,
      y: number,
      z: number,
      dmg: number,
      vx: number,
      vz: number,
    ) => boolean,
  ): void {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.age += dt;
      if (a.age > MAX_LIFE) {
        this.removeAt(i);
        continue;
      }
      a.vy -= GRAVITY * dt;
      // 细分为 4 小步防穿透
      let consumed = false;
      for (let s = 0; s < 4; s++) {
        const step = dt / 4;
        a.x += a.vx * step;
        a.y += a.vy * step;
        a.z += a.vz * step;
        // 玩家箭：优先命中生物
        if (
          !a.hostile &&
          hitMob?.(a.x, a.y, a.z, a.dmg, a.vx * 0.3, a.vz * 0.3)
        ) {
          this.removeAt(i);
          consumed = true;
          break;
        }
        // 命中方块
        if (
          this.world.isSolid(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z))
        ) {
          onHitBlock?.(a.x, a.y, a.z);
          this.removeAt(i);
          consumed = true;
          break;
        }
        // 敌对箭命中玩家：玩家 AABB 半宽 0.35、高 1.8，箭加 0.15 余量
        if (
          a.hostile &&
          Math.abs(a.x - px) < 0.5 &&
          Math.abs(a.z - pz) < 0.5 &&
          a.y > py - 0.2 &&
          a.y < py + 2.0
        ) {
          onHitPlayer(a.dmg);
          this.removeAt(i);
          consumed = true;
          break;
        }
      }
      if (consumed) continue;
      a.mesh.position.set(a.x, a.y, a.z);
      a.mesh.lookAt(a.x + a.vx, a.y + a.vy, a.z + a.vz);
    }
  }
}
