import * as THREE from 'three';
import type { World } from '../world/world';

// ============================================================
// 经验球：绿色发光小球（MC experience orb）
//  - 抛出散布 → 落地静止；0.5s 后 4 格内吸附玩家，0.9 格拾取
//  - 几何/材质全局共享；脉动缩放；上限 80 个（超出移除最旧）
// ============================================================

const GRAVITY = 16;
const ATTRACT_DELAY = 0.5;
const ATTRACT_DIST = 4;
const PICKUP_DIST = 0.9;
const LIFETIME = 300;
const MAX_ORBS = 80;
const HOVER = 0.15;

interface Orb {
  mesh: THREE.Mesh;
  value: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  grounded: boolean;
}

export class XpManager {
  private orbs: Orb[] = [];
  private readonly geo = new THREE.IcosahedronGeometry(0.09, 0);
  private readonly mat = new THREE.MeshBasicMaterial({ color: 0xa8ff3e });

  constructor(
    private scene: THREE.Scene,
    private world: World,
  ) {}

  get count(): number {
    return this.orbs.length;
  }

  /** 维度切换时换绑世界并清除经验球（属于旧维度场景） */
  setWorld(w: World): void {
    this.world = w;
    for (const o of this.orbs) this.scene.remove(o.mesh);
    this.orbs.length = 0;
  }

  /** 生成总价值为 totalValue 的若干经验球（单球 1~4 点，MC 风格拆分） */
  spawn(totalValue: number, x: number, y: number, z: number): void {
    let v = Math.floor(totalValue);
    while (v > 0) {
      const chunk = Math.min(v, 1 + Math.floor(Math.random() * 4));
      v -= chunk;
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 1.2;
      const mesh = new THREE.Mesh(this.geo, this.mat);
      this.orbs.push({
        mesh,
        value: chunk,
        x,
        y: y + 0.3,
        z,
        vx: Math.cos(ang) * sp,
        vy: 2 + Math.random() * 1.5,
        vz: Math.sin(ang) * sp,
        age: 0,
        grounded: false,
      });
      this.scene.add(mesh);
    }
    while (this.orbs.length > MAX_ORBS) this.removeAt(0);
  }

  private removeAt(i: number): void {
    this.scene.remove(this.orbs[i].mesh);
    this.orbs.splice(i, 1);
  }

  /** 每帧推进；onGain 在拾取时按球面值回调 */
  update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    onGain: (value: number) => void,
  ): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.age += dt;
      if (o.age > LIFETIME || o.y < -8) {
        this.removeAt(i);
        continue;
      }

      const dx = px - o.x;
      const dy = py - o.y;
      const dz = pz - o.z;
      const dist = Math.hypot(dx, dy, dz);

      if (o.age > ATTRACT_DELAY && dist < ATTRACT_DIST) {
        // 吸附：直接朝玩家飞行
        if (dist < PICKUP_DIST) {
          onGain(o.value);
          this.removeAt(i);
          continue;
        }
        const sp = Math.min(7, 3.5 + o.age * 1.5);
        const inv = sp / Math.max(dist, 1e-4);
        o.vx = dx * inv;
        o.vy = dy * inv;
        o.vz = dz * inv;
        o.grounded = false;
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        o.z += o.vz * dt;
      } else if (!o.grounded) {
        // 抛物线 → 落地
        o.vy -= GRAVITY * dt;
        if (o.vy < -30) o.vy = -30;
        o.x += o.vx * dt;
        o.z += o.vz * dt;
        o.vx *= Math.max(0, 1 - dt * 5);
        o.vz *= Math.max(0, 1 - dt * 5);
        const ny = o.y + o.vy * dt;
        const below = Math.floor(ny - HOVER + 1e-4);
        if (o.vy <= 0 && this.world.isSolid(Math.floor(o.x), below, Math.floor(o.z))) {
          o.y = below + 1 + HOVER;
          o.vy = 0;
          o.vx = 0;
          o.vz = 0;
          o.grounded = true;
        } else {
          o.y = ny;
        }
      }

      // 呈现：浮动 + 脉动
      const s = 0.85 + Math.sin(o.age * 6) * 0.2;
      o.mesh.scale.setScalar(s);
      o.mesh.position.set(o.x, o.y + Math.sin(o.age * 2.4) * 0.05, o.z);
    }
  }
}
