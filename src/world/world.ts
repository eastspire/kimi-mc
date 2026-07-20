import { BlockRegistry, AIR } from '../core/block-registry';
import { CHUNK_X, CHUNK_Y, CHUNK_Z } from './worldgen';

// ============================================================
// 世界存储：Map<"cx,cz", Uint8Array>，方块编辑即标记脏区块
// ============================================================

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export interface BlockEdit {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
  y: number;
}

export class World {
  readonly chunks = new Map<string, Uint8Array>();

  constructor(public readonly reg: BlockRegistry) {}

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  setChunk(cx: number, cz: number, data: Uint8Array): void {
    this.chunks.set(chunkKey(cx, cz), data);
  }

  deleteChunk(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
  }

  /**
   * 读取方块。y<0 视为基岩（碰撞兜底），y 超高或区块未加载视为空气。
   */
  getBlock(wx: number, y: number, wz: number): number {
    if (y < 0) return this.reg.id('bedrock');
    if (y >= CHUNK_Y) return AIR;
    const cx = Math.floor(wx / CHUNK_X);
    const cz = Math.floor(wz / CHUNK_Z);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return AIR;
    const lx = wx - cx * CHUNK_X;
    const lz = wz - cz * CHUNK_Z;
    return chunk[lx + CHUNK_X * (lz + CHUNK_Z * y)];
  }

  setBlock(wx: number, y: number, wz: number, id: number): BlockEdit | null {
    if (y < 0 || y >= CHUNK_Y) return null;
    const cx = Math.floor(wx / CHUNK_X);
    const cz = Math.floor(wz / CHUNK_Z);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk) return null;
    const lx = wx - cx * CHUNK_X;
    const lz = wz - cz * CHUNK_Z;
    chunk[lx + CHUNK_X * (lz + CHUNK_Z * y)] = id;
    return { cx, cz, lx, lz, y };
  }

  isSolid(wx: number, y: number, wz: number): boolean {
    return this.reg.isSolid(this.getBlock(wx, y, wz));
  }

  /** 从高处向下找第一个可站立位置（出生点用） */
  findSpawnY(wx: number, wz: number): number {
    for (let y = CHUNK_Y - 1; y > 0; y--) {
      if (this.isSolid(wx, y, wz)) return y + 1;
    }
    return 70;
  }
}
