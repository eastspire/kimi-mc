import { buildChunkMesh, type MeshArrays } from './mesher';
import type { BlockDef } from '../core/model-loader';

// ============================================================
// 网格化 Worker：接收带邻边的方块数据，回传 TypedArray（零拷贝转移）
// ============================================================

export interface PackedGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  tiles: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface MeshJobIn {
  type: 'init' | 'mesh';
  defs?: (BlockDef | null)[];
  cx?: number;
  cz?: number;
  version?: number;
  data?: ArrayBuffer;
}

export interface MeshJobOut {
  type: 'mesh';
  cx: number;
  cz: number;
  version: number;
  opaque: PackedGeometry | null;
  translucent: PackedGeometry | null;
}

let defs: (BlockDef | null)[] | null = null;

// DOM lib 的 postMessage 签名与 Worker 不同，这里显式收窄
const post: (msg: MeshJobOut, transfer: Transferable[]) => void =
  (self as unknown as { postMessage: (m: MeshJobOut, t: Transferable[]) => void })
    .postMessage.bind(self);

function pack(arr: MeshArrays | null): PackedGeometry | null {
  if (!arr || arr.indices.length === 0) return null;
  return {
    positions: new Float32Array(arr.positions),
    uvs: new Float32Array(arr.uvs),
    tiles: new Float32Array(arr.tiles),
    colors: new Float32Array(arr.colors),
    indices: new Uint32Array(arr.indices),
  };
}

self.onmessage = (e: MessageEvent<MeshJobIn>) => {
  const m = e.data;
  if (m.type === 'init') {
    defs = m.defs ?? null;
    return;
  }
  if (m.type === 'mesh' && defs && m.data) {
    let out: ReturnType<typeof buildChunkMesh>;
    try {
      out = buildChunkMesh(new Uint8Array(m.data), defs);
    } catch (err) {
      // 网格化异常：回传空结果保证任务闭环，不让 Worker 沉默
      console.error('[mc] 区块网格化失败', m.cx, m.cz, err);
      post(
        { type: 'mesh', cx: m.cx!, cz: m.cz!, version: m.version ?? 0, opaque: null, translucent: null },
        [],
      );
      return;
    }
    const opaque = pack(out.opaque);
    const translucent = pack(out.translucent);
    const transfer: Transferable[] = [];
    for (const g of [opaque, translucent]) {
      if (g) {
        transfer.push(
          g.positions.buffer, g.uvs.buffer, g.tiles.buffer,
          g.colors.buffer, g.indices.buffer,
        );
      }
    }
    post(
      { type: 'mesh', cx: m.cx!, cz: m.cz!, version: m.version ?? 0, opaque, translucent },
      transfer,
    );
  }
};
