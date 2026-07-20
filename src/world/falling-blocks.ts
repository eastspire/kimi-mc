import * as THREE from 'three';
import type { World } from './world';
import type { BlockDef } from '../core/model-loader';
import { AIR } from '../core/block-registry';
import { buildBlockGeometry, type MeshArrays } from '../render/mesher';

// ============================================================
// 重力方块（沙子/沙砾）下落实体（MC falling block entity）
//  - 支撑消失的 falling 方块转为实体，受重力垂直坠落
//  - 落地：目标格可占据（空气/可替换/水）则还原为方块，否则散为掉落物由上层处理
//  - 几何复用区块网格慢路径（与掉落物同渲染管线，共享图集材质）
//  - 每个实体一个 Mesh，落地即销毁；连锁坍塌由落地后唤醒上方触发
// ============================================================

const GRAVITY = 28;
const TERMINAL = -40;

interface FallingBlock {
  def: BlockDef;
  mesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  vy: number;
}

export class FallingBlockManager {
  private list: FallingBlock[] = [];
  private geoCache = new Map<number, THREE.BufferGeometry | null>();

  constructor(
    private scene: THREE.Scene,
    private world: World,
    /** 区块图集材质（与区块/掉落物共享，aLight 缺失按 0 → 仅日光） */
    private blockMat: THREE.Material,
    /** 落地写回方块（走 applyEdit：重建网格 + 记入存档） */
    private applyEdit: (x: number, y: number, z: number, id: number) => void,
    /** 无法落地时散为物品掉落（可选） */
    private onDrop?: (def: BlockDef, x: number, y: number, z: number) => void,
  ) {}

  get count(): number {
    return this.list.length;
  }

  private geoFor(def: BlockDef): THREE.BufferGeometry | null {
    if (this.geoCache.has(def.id)) return this.geoCache.get(def.id)!;
    const arr = buildBlockGeometry(def);
    const geo = arr ? geoFromArrays(arr) : null;
    this.geoCache.set(def.id, geo);
    return geo;
  }

  /** 目标格是否可被下落方块占据（空气 / 可替换植物 / 水） */
  private canOccupy(id: number): boolean {
    if (id === AIR) return true;
    const def = this.world.reg.def(id);
    return !!def && (def.replaceable || def.fluid);
  }

  /**
   * 尝试让某格方块开始下落：若是 falling 方块且下方可占据，
   * 移除原方块并生成下落实体，返回 true。由方块编辑/生成后唤醒调用。
   */
  tryStart(bx: number, by: number, bz: number): boolean {
    const id = this.world.getBlock(bx, by, bz);
    const def = this.world.reg.def(id);
    if (!def || !def.falling) return false;
    if (!this.canOccupy(this.world.getBlock(bx, by - 1, bz))) return false;

    // 原方块移除（走 applyEdit 保证网格/存档一致），生成实体
    this.applyEdit(bx, by, bz, AIR);
    const geo = this.geoFor(def);
    if (!geo) return true;
    const mesh = new THREE.Mesh(geo, this.blockMat);
    const cx = bx + 0.5;
    const cz = bz + 0.5;
    mesh.position.set(cx, by + 0.5, cz);
    this.scene.add(mesh);
    this.list.push({ def, mesh, x: cx, y: by + 0.5, z: cz, vy: 0 });
    return true;
  }

  private removeAt(i: number): void {
    this.scene.remove(this.list[i].mesh);
    this.list.splice(i, 1);
  }

  update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      b.vy = Math.max(TERMINAL, b.vy - GRAVITY * dt);
      const ny = b.y + b.vy * dt;
      const bx = Math.floor(b.x);
      const bz = Math.floor(b.z);
      // 实体底面中心：坠落穿过目标格顶面时落地
      const footY = ny - 0.5;
      const landCell = Math.floor(footY + 1e-4);
      const targetId = this.world.getBlock(bx, landCell, bz);

      if (b.vy <= 0 && !this.canOccupy(targetId)) {
        // 落地：放在支撑格之上
        const placeY = landCell + 1;
        if (this.canOccupy(this.world.getBlock(bx, placeY, bz))) {
          this.applyEdit(bx, placeY, bz, b.def.id);
        } else {
          // 极端情况（落点被瞬间占据）→ 散为物品
          this.onDrop?.(b.def, b.x, b.y, b.z);
        }
        this.removeAt(i);
        continue;
      }
      // 穿过水/可替换格时直接占据该格（落入水中即定）
      if (b.vy <= 0 && targetId !== AIR && this.canOccupy(targetId)) {
        this.applyEdit(bx, landCell, bz, b.def.id);
        this.removeAt(i);
        continue;
      }
      b.y = ny;
      b.mesh.position.set(b.x, b.y, b.z);
      // 掉出世界底部：直接消失
      if (b.y < -8) this.removeAt(i);
    }
  }
}

function geoFromArrays(arr: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr.positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uvs, 2));
  g.setAttribute('aTile', new THREE.Float32BufferAttribute(arr.tiles, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr.colors, 3));
  g.setIndex(arr.indices);
  g.translate(-0.5, -0.5, -0.5);
  return g;
}
