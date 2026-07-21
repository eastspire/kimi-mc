import * as THREE from 'three';
import type { World } from '../world/world';
import type { BlockDef } from '../core/model-loader';
import { buildBlockGeometry, type MeshArrays } from '../render/mesher';
import type { FoodDef } from './foods';
import type { ToolDef } from './tools';

// ============================================================
// 掉落物：地面旋转浮动的物品实体（MC item entity）
//  - 食物：交叉双面片；方块：0.34 倍微缩 3D 模型（复用网格化慢路径）
//  - 抛出小抛物线 → 落地后贴地（HOVER=0.0625）旋转 + 上下小幅浮动
//  - 0.5s 拾取延迟，1.35 格拾取半径，300s 消失（MC 一致）
// ============================================================

const GRAVITY = 16;
const PICKUP_DELAY = 0.5;
const PICKUP_DIST = 1.35;
const LIFETIME = 300;
const HOVER = 0.0625;

export type DropItem =
  | { kind: 'food'; def: FoodDef; n: number }
  | { kind: 'block'; def: BlockDef; n: number }
  | { kind: 'tool'; def: ToolDef; n: number; dur?: number };

interface Drop {
  item: DropItem;
  group: THREE.Group;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  grounded: boolean;
}

function blockGeoFromArrays(arr: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr.positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uvs, 2));
  g.setAttribute('aTile', new THREE.Float32BufferAttribute(arr.tiles, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr.colors, 3));
  g.setIndex(arr.indices);
  g.translate(-0.5, -0.5, -0.5);
  g.scale(0.34, 0.34, 0.34);
  return g;
}

export class DropManager {
  private drops: Drop[] = [];
  private readonly foodGeo = new THREE.PlaneGeometry(0.42, 0.42);
  private readonly foodMats = new Map<string, THREE.MeshBasicMaterial>();
  private readonly blockGeos = new Map<number, THREE.BufferGeometry | null>();

  constructor(
    private scene: THREE.Scene,
    private world: World,
    /** 方块图集材质（与区块共享，aLight 缺失按 0 处理 → 仅日光） */
    private blockMat: THREE.Material,
  ) {}

  get count(): number {
    return this.drops.length;
  }

  /** 维度切换时换绑世界并清除未拾取掉落物（属于旧维度场景） */
  setWorld(w: World): void {
    this.world = w;
    for (const d of this.drops) this.scene.remove(d.group);
    this.drops.length = 0;
  }

  private spriteMat(def: { id: string; texture: THREE.Texture }): THREE.MeshBasicMaterial {
    let m = this.foodMats.get(def.id);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        map: def.texture,
        transparent: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      });
      this.foodMats.set(def.id, m);
    }
    return m;
  }

  private blockGeo(def: BlockDef): THREE.BufferGeometry | null {
    if (this.blockGeos.has(def.id)) return this.blockGeos.get(def.id)!;
    const arr = buildBlockGeometry(def);
    const geo = arr ? blockGeoFromArrays(arr) : null;
    this.blockGeos.set(def.id, geo);
    return geo;
  }

  private push(item: DropItem, group: THREE.Group, x: number, y: number, z: number): void {
    const ang = Math.random() * Math.PI * 2;
    const sp = 0.8 + Math.random() * 1.2;
    this.drops.push({
      item,
      group,
      x,
      y: y + 0.3,
      z,
      vx: Math.cos(ang) * sp,
      vy: 2.8,
      vz: Math.sin(ang) * sp,
      age: 0,
      grounded: false,
    });
    this.scene.add(group);
  }

  spawnFood(def: FoodDef, x: number, y: number, z: number, n = 1): void {
    const group = new THREE.Group();
    const mat = this.spriteMat(def);
    const p1 = new THREE.Mesh(this.foodGeo, mat);
    const p2 = new THREE.Mesh(this.foodGeo, mat);
    p2.rotation.y = Math.PI / 2;
    group.add(p1, p2);
    this.push({ kind: 'food', def, n }, group, x, y, z);
  }

  /** 工具/材料掉落：交叉双面片（与食物同渲染路径）；dur 保留工具耐久 */
  spawnTool(def: ToolDef, x: number, y: number, z: number, n = 1, dur?: number): void {
    const group = new THREE.Group();
    const mat = this.spriteMat(def);
    const p1 = new THREE.Mesh(this.foodGeo, mat);
    const p2 = new THREE.Mesh(this.foodGeo, mat);
    p2.rotation.y = Math.PI / 2;
    group.add(p1, p2);
    this.push({ kind: 'tool', def, n, dur }, group, x, y, z);
  }

  spawnBlock(def: BlockDef, x: number, y: number, z: number, n = 1): void {
    const geo = this.blockGeo(def);
    if (!geo) return;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geo, this.blockMat));
    this.push({ kind: 'block', def, n }, group, x, y, z);
  }

  private removeAt(i: number): void {
    this.scene.remove(this.drops[i].group);
    this.drops.splice(i, 1);
  }

  /**
   * 每帧推进。onPickup 返回 true 才拾取成功（背包满则留在原地）
   * px/py/pz 为玩家中心（脚底 + ~0.9）
   */
  update(
    dt: number,
    px: number,
    py: number,
    pz: number,
    onPickup: (item: DropItem) => boolean,
  ): void {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      if (d.age > LIFETIME || d.y < -8) {
        this.removeAt(i);
        continue;
      }

      // 拾取判定
      if (d.age > PICKUP_DELAY) {
        const dx = px - d.x;
        const dy = py - d.y;
        const dz = pz - d.z;
        if (
          dx * dx + dy * dy + dz * dz < PICKUP_DIST * PICKUP_DIST &&
          onPickup(d.item)
        ) {
          this.removeAt(i);
          continue;
        }
      }

      // 物理：抛物线 → 落地贴地（HOVER 是 MC 物品实体离地高度）
      if (!d.grounded) {
        d.vy -= GRAVITY * dt;
        if (d.vy < -30) d.vy = -30;
        d.x += d.vx * dt;
        d.z += d.vz * dt;
        d.vx *= Math.max(0, 1 - dt * 5);
        d.vz *= Math.max(0, 1 - dt * 5);
        const ny = d.y + d.vy * dt;
        const bx = Math.floor(d.x);
        const bz = Math.floor(d.z);
        const below = Math.floor(ny - HOVER + 1e-4);
        if (d.vy <= 0 && this.world.isSolid(bx, below, bz)) {
          d.y = below + 1 + HOVER;
          d.vy = 0;
          d.vx = 0;
          d.vz = 0;
          d.grounded = true;
        } else {
          d.y = ny;
        }
      }

      // 呈现：落地后贴地旋转 + 上下小幅浮动（±0.05，避免看起来"悬浮"）
      d.group.position.set(d.x, d.y + Math.sin(d.age * 2.2) * 0.05, d.z);
      d.group.rotation.y = d.age * 1.4;
    }
  }
}
