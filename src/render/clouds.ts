import * as THREE from 'three';
import { Noise2D } from '../world/noise';

// ============================================================
// MC 风格方块云：
//  - 种子化值噪声生成 64×64 格矩形云团（周期 768 格无缝环绕）
//  - 单 mesh 合并几何，半透明白色，y≈108，沿 +X 缓慢漂移
//  - 亮度随昼夜变化；保留雾效（远处自然隐没，水下被雾吞掉）
// ============================================================

const CELL = 12; // 单格水平边长
const GRID = 64; // 周期格数
const PERIOD = CELL * GRID; // 768
const CLOUD_Y = 108;
const THICK = 4;
const THRESHOLD = 0.3; // 噪声阈值，越大云越稀
const DRIFT_SPEED = 1.4; // 格/秒

export class Clouds {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene, seed: number) {
    const noise = new Noise2D((seed ^ 0xc10d5) | 0);
    const filled = new Uint8Array(GRID * GRID);
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        filled[cx + cz * GRID] = noise.fbm(cx * 0.09, cz * 0.09, 3) > THRESHOLD ? 1 : 0;
      }
    }
    const at = (cx: number, cz: number): number =>
      filled[((cx % GRID) + GRID) % GRID + (((cz % GRID) + GRID) % GRID) * GRID];

    // 合并几何：顶/底面恒发，侧面仅在邻格为空时发
    const positions: number[] = [];
    const indices: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
      const base = positions.length / 3;
      positions.push(...a, ...b, ...c, ...d);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        if (!at(cx, cz)) continue;
        const x0 = cx * CELL - PERIOD / 2, x1 = x0 + CELL;
        const z0 = cz * CELL - PERIOD / 2, z1 = z0 + CELL;
        const y0 = 0, y1 = THICK;
        quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // 顶
        quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // 底
        if (!at(cx + 1, cz)) quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +x
        if (!at(cx - 1, cz)) quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
        if (!at(cx, cz + 1)) quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
        if (!at(cx, cz - 1)) quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -z
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);

    this.mat = new THREE.MeshBasicMaterial({
      color: 0xf8f8f8,
      transparent: true,
      opacity: 0.7,
      fog: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.y = CLOUD_Y;
    this.mesh.frustumCulled = false; // 位置按玩家取模对齐，包围球不可靠
    this.mesh.renderOrder = 1; // 画在水面之后，避免透明排序穿帮
    scene.add(this.mesh);
  }

  /** t 为累计秒数；位置按 768 周期对齐玩家（跳跃不可见），云图随漂移滑过 */
  update(t: number, px: number, pz: number, daylight: number): void {
    const drift = (t * DRIFT_SPEED) % PERIOD;
    this.mesh.position.x = drift + Math.round((px - drift) / PERIOD) * PERIOD;
    this.mesh.position.z = Math.round(pz / PERIOD) * PERIOD;
    this.mat.color.setScalar(0.35 + 0.65 * daylight);
  }
}
