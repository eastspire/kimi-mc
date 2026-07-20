import * as THREE from 'three';

// ============================================================
// 破坏粒子：固定容量 Points，环形覆写，热循环零分配
// ============================================================

const MAX = 1024;

export class Particles {
  private points: THREE.Points;
  private positions = new Float32Array(MAX * 3);
  private colors = new Float32Array(MAX * 3);
  private velocities = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private head = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.positions.fill(-10000);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // 永不剔除
    const mat = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(x: number, y: number, z: number, r: number, g: number, b: number, count = 14): void {
    for (let i = 0; i < count; i++) {
      const idx = this.head;
      this.head = (this.head + 1) % MAX;
      this.positions[idx * 3] = x + (Math.random() - 0.5) * 0.7;
      this.positions[idx * 3 + 1] = y + (Math.random() - 0.5) * 0.7;
      this.positions[idx * 3 + 2] = z + (Math.random() - 0.5) * 0.7;
      this.velocities[idx * 3] = (Math.random() - 0.5) * 3.4;
      this.velocities[idx * 3 + 1] = Math.random() * 3.6 + 1;
      this.velocities[idx * 3 + 2] = (Math.random() - 0.5) * 3.4;
      const jitter = 0.75 + Math.random() * 0.45;
      this.colors[idx * 3] = Math.min(1, r * jitter);
      this.colors[idx * 3 + 1] = Math.min(1, g * jitter);
      this.colors[idx * 3 + 2] = Math.min(1, b * jitter);
      this.life[idx] = 0.5 + Math.random() * 0.35;
    }
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = -10000;
        continue;
      }
      this.velocities[i * 3 + 1] -= 18 * dt;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
    }
    if (any) {
      (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
