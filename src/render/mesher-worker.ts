import { buildChunkMesh, type MeshArrays } from './mesher';
import type { BlockDef } from '../core/model-loader';
import { BlockRegistry } from '../core/block-registry';
import { WorldGen } from '../world/worldgen';

// ============================================================
// 区块 Worker：同池双任务
//  - gen：按种子生成地形（噪声计算重，移出主线程防卡顿）
//  - mesh：接收带邻边的方块数据 + 方块光做网格化，回传 TypedArray（零拷贝转移）
//  - config：运行时开关（平滑光照 AO）
// ============================================================

export interface PackedGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  tiles: Float32Array;
  colors: Float32Array;
  lights: Float32Array;
  indices: Uint32Array;
}

export interface MeshJobIn {
  type: 'init' | 'mesh' | 'gen' | 'config';
  defs?: (BlockDef | null)[];
  seed?: number;
  ao?: boolean;
  cx?: number;
  cz?: number;
  version?: number;
  data?: ArrayBuffer;
  light?: ArrayBuffer | null;
}

export interface MeshJobOut {
  type: 'mesh';
  cx: number;
  cz: number;
  version: number;
  opaque: PackedGeometry | null;
  translucent: PackedGeometry | null;
}

/** 地形生成结果；data 长度为 0 表示生成失败（主线程会重新排队） */
export interface GenJobOut {
  type: 'gen';
  cx: number;
  cz: number;
  data: ArrayBuffer;
}

export type JobOut = MeshJobOut | GenJobOut;

let defs: (BlockDef | null)[] | null = null;
let worldGen: WorldGen | null = null;
let aoEnabled = true;

// DOM lib 的 postMessage 签名与 Worker 不同，这里显式收窄
const post: (msg: JobOut, transfer: Transferable[]) => void = (
  self as unknown as { postMessage: (m: JobOut, t: Transferable[]) => void }
).postMessage.bind(self);

function pack(arr: MeshArrays | null): PackedGeometry | null {
  if (!arr || arr.indices.length === 0) return null;
  return {
    positions: new Float32Array(arr.positions),
    uvs: new Float32Array(arr.uvs),
    tiles: new Float32Array(arr.tiles),
    colors: new Float32Array(arr.colors),
    lights: new Float32Array(arr.lights),
    indices: new Uint32Array(arr.indices),
  };
}

self.onmessage = (e: MessageEvent<MeshJobIn>) => {
  const m = e.data;
  if (m.type === 'init') {
    defs = m.defs ?? null;
    aoEnabled = m.ao !== false;
    // 地形生成器：与主线程同一种子同一注册表，结果逐字节一致
    if (defs && typeof m.seed === 'number') {
      const flat = defs.filter((d): d is BlockDef => d !== null);
      const reg = new BlockRegistry(
        flat,
        flat.map((d) => d.name),
      );
      worldGen = new WorldGen(m.seed, reg);
    }
    return;
  }
  if (m.type === 'config') {
    aoEnabled = m.ao !== false;
    return;
  }
  if (m.type === 'gen') {
    if (!worldGen) {
      post({ type: 'gen', cx: m.cx!, cz: m.cz!, data: new ArrayBuffer(0) }, []);
      return;
    }
    try {
      const data = worldGen.generateChunk(m.cx!, m.cz!);
      const buf = data.buffer as ArrayBuffer;
      post({ type: 'gen', cx: m.cx!, cz: m.cz!, data: buf }, [buf]);
    } catch (err) {
      // 生成异常：回传空数据保证任务闭环，主线程会重新排队
      console.error('[mc] 区块生成失败', m.cx, m.cz, err);
      post({ type: 'gen', cx: m.cx!, cz: m.cz!, data: new ArrayBuffer(0) }, []);
    }
    return;
  }
  if (m.type === 'mesh' && defs && m.data) {
    let out: ReturnType<typeof buildChunkMesh>;
    try {
      const lightPad =
        m.light && m.light.byteLength > 0 ? new Uint8Array(m.light) : null;
      out = buildChunkMesh(new Uint8Array(m.data), defs, aoEnabled, lightPad);
    } catch (err) {
      // 网格化异常：回传空结果保证任务闭环，不让 Worker 沉默
      console.error('[mc] 区块网格化失败', m.cx, m.cz, err);
      post(
        {
          type: 'mesh',
          cx: m.cx!,
          cz: m.cz!,
          version: m.version ?? 0,
          opaque: null,
          translucent: null,
        },
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
          g.positions.buffer,
          g.uvs.buffer,
          g.tiles.buffer,
          g.colors.buffer,
          g.lights.buffer,
          g.indices.buffer,
        );
      }
    }
    post(
      {
        type: 'mesh',
        cx: m.cx!,
        cz: m.cz!,
        version: m.version ?? 0,
        opaque,
        translucent,
      },
      transfer,
    );
  }
};
