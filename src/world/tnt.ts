import * as THREE from 'three';
import type { World } from '../world/world';

// ============================================================
// 点燃的 TNT 实体：闪烁 + 受重力下落，默认引信 4 秒（MC 80 ticks）
//  - 白闪频率随引信接近尾声加快（MC 视觉一致）
//  - 几何/材质全局共享，每个实体仅一个 Mesh
//  - 连锁：爆炸波及的 TNT 方块以 0.5~1.5s 随机短引信点燃（MC 10-30 tick）
// ============================================================

const FUSE = 4;
const GRAVITY = 25;
const MAX_FALL = 20;

interface PrimedTnt {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  vy: number;
  fuse: number;
  flashing: boolean;
}

let geo: THREE.BoxGeometry | null = null;
let matRed: THREE.MeshLambertMaterial | null = null;
let matWhite: THREE.MeshLambertMaterial | null = null;

export class TntManager {
  private list: PrimedTnt[] = [];

  constructor(
    private scene: THREE.Scene,
    private world: World,
    /** 引信尽爆炸回调（地形破坏/伤害由外部实现） */
    private onExplode: (x: number, y: number, z: number) => void,
  ) {
    if (!geo) {
      geo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
      matRed = new THREE.MeshLambertMaterial({ color: 0xc02818 });
      matWhite = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.6,
      });
    }
  }

  get count(): number {
    return this.list.length;
  }

  /** 维度切换时换绑世界并清除引信中的 TNT（属于旧维度场景） */
  setWorld(w: World): void {
    this.world = w;
    for (const t of this.list) this.scene.remove(t.mesh);
    this.list.length = 0;
  }

  /** 在 (x,y,z) 生成点燃的 TNT（fuse 秒，默认 4）；初始小幅上弹（MC） */
  ignite(x: number, y: number, z: number, fuse = FUSE): void {
    const mesh = new THREE.Mesh(geo!, matRed!);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.list.push({ mesh, x, y, z, vy: 2, fuse, flashing: false });
  }

  private removeAt(i: number): void {
    this.scene.remove(this.list[i].mesh);
    this.list.splice(i, 1);
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      t.fuse -= dt;
      if (t.fuse <= 0) {
        this.removeAt(i);
        this.onExplode(t.x, t.y, t.z);
        continue;
      }
      // 下落：脚下方块实体则停在其顶面
      t.vy = Math.max(-MAX_FALL, t.vy - GRAVITY * dt);
      const ny = t.y + t.vy * dt;
      const footY = ny - 0.49;
      if (
        t.vy < 0 &&
        this.world.isSolid(Math.floor(t.x), Math.floor(footY), Math.floor(t.z))
      ) {
        t.y = Math.floor(footY) + 1 + 0.49;
        t.vy = 0;
      } else {
        t.y = ny;
      }
      // 白闪：频率随引信减少加快
      const rate = t.fuse < 1 ? 20 : t.fuse < 2 ? 10 : 5;
      const flash = Math.floor(t.fuse * rate) % 2 === 1;
      if (flash !== t.flashing) {
        t.flashing = flash;
        t.mesh.material = flash ? matWhite! : matRed!;
      }
      t.mesh.position.set(t.x, t.y, t.z);
    }
  }
}
