import * as THREE from 'three';
import type { BlockDef } from '../core/model-loader';
import { buildBlockGeometry, type MeshArrays } from './mesher';

// ============================================================
// 第一人称手持物：
//  - 独立 Scene + 相机二次渲染（永不穿模、无雾）
//  - 复用 mesher 慢路径建模（十字植物渲染为交叉面片）
//  - 走路摆动 / 切物品 equip 下沉 / 挖掘挥动
// ============================================================

const BASE_POS = new THREE.Vector3(0.56, -0.55, -0.95);
const BASE_ROT = new THREE.Euler(0.12, -0.72, 0);
const EQUIP_TIME = 0.3; // 切物品下沉升起时长（秒）
const SWING_TIME = 0.28; // 单次挥动时长（秒）

function toGeometry(arr: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr.positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uvs, 2));
  g.setAttribute('aTile', new THREE.Float32BufferAttribute(arr.tiles, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr.colors, 3));
  g.setIndex(arr.indices);
  return g;
}

export class Hand {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.05, 10);
  private group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private equipT = 1; // 0→1 升起进度
  private bobPhase = 0;
  private swingT = -1; // <0 表示未在挥动

  constructor(private material: THREE.Material) {
    this.group.position.copy(BASE_POS);
    this.group.rotation.copy(BASE_ROT);
    this.group.scale.setScalar(0.55);
    this.scene.add(this.group);
  }

  /** 切换手持方块：重建网格并触发 equip 动画 */
  setBlock(def: BlockDef): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const arr = buildBlockGeometry(def);
    if (arr) {
      this.mesh = new THREE.Mesh(toGeometry(arr), this.material);
      this.group.add(this.mesh);
    }
    this.equipT = 0;
  }

  /** 每帧推进动画；moveSpeed 为水平速度，attacking 为按住挖掘 */
  update(dt: number, moveSpeed: number, onGround: boolean, attacking: boolean): void {
    // equip：easeOut 下沉回升
    this.equipT = Math.min(1, this.equipT + dt / EQUIP_TIME);
    const eq = 1 - this.equipT;
    const dip = eq * eq * 0.55;

    // 走路摆动（幅度刻意压小，MC 手感）
    if (onGround && moveSpeed > 0.1) this.bobPhase += dt * moveSpeed * 1.6;
    const bobX = Math.sin(this.bobPhase) * 0.014;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.014;

    // 挥动：按住循环，松开后播完当前一次
    if (attacking && this.swingT < 0) this.swingT = 0;
    let swing = 0;
    if (this.swingT >= 0) {
      this.swingT += dt / SWING_TIME;
      if (this.swingT >= 1) this.swingT = attacking ? 0 : -1;
      if (this.swingT >= 0) swing = Math.sin(this.swingT * Math.PI);
    }

    this.group.position.set(
      BASE_POS.x + bobX,
      BASE_POS.y - dip + bobY - swing * 0.1,
      BASE_POS.z - swing * 0.12,
    );
    this.group.rotation.set(
      BASE_ROT.x - swing * 1.0,
      BASE_ROT.y,
      BASE_ROT.z - swing * 0.18,
    );
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 在主场景渲染之后调用：清深度后叠加，手持物永不穿模 */
  render(renderer: THREE.WebGLRenderer): void {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
