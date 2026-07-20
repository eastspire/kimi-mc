// ============================================================
// 世界存档：IndexedDB 原生 API（无新依赖）
//   meta   库：种子 + 玩家状态（位置/视角/飞行）
//   chunks 库：仅玩家修改过的区块，Uint8Array 经 RLE 压缩
// ============================================================

const DB_NAME = 'mc-web';
const DB_VERSION = 1;
const META_STORE = 'meta';
const CHUNK_STORE = 'chunks';
const META_KEY = 'save';

export const CHUNK_VOLUME = 16 * 16 * 128;

export interface PlayerSave {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  flying: boolean;
  /** 生存模式生命体征；旧存档缺省 → 满值 */
  hp?: number;
  hunger?: number;
  /** 经验（当前级内进度）与等级；旧存档缺省 → 0 */
  xp?: number;
  level?: number;
}

export type GameMode = 'creative' | 'survival';

/** 快捷栏存档槽位：{ b: 方块id } / { f: 食物id } / { t: 工具id, d?: 耐久 }，n 为数量 */
/** 快捷栏存档槽位：{ b: 方块id } / { f: 食物id } / { t: 工具id, d?: 耐久, e?: 附魔 }，n 为数量 */
export type SavedHotSlot =
  | { b: number; n: number }
  | { f: string; n: number }
  | { t: string; n: number; d?: number; e?: Record<string, number> };

export interface SaveMeta {
  version: number;
  seed: number;
  seedText: string;
  player: PlayerSave;
  savedAt: number;
  /** 昼夜累计秒数（含天数）；旧存档缺省 → 默认上午 */
  dayTime?: number;
  /** 游戏模式；旧存档缺省 → creative */
  mode?: GameMode;
  /** 生存模式快捷栏内容；创造模式不保存 */
  hotbar?: (SavedHotSlot | null)[];
  /** 生存模式背包主栏 27 格 */
  inv?: (SavedHotSlot | null)[];
  /** 生存模式盔甲栏 4 格（头/胸/腿/靴） */
  armor?: (SavedHotSlot | null)[];
  /** 世界中的熔炉状态（位置+内容+燃烧/烧炼进度） */
  furnaces?: {
    p: [number, number, number];
    i: SavedHotSlot | null;
    f: SavedHotSlot | null;
    o: SavedHotSlot | null;
    burn: number;
    burnMax: number;
    cook: number;
  }[];
  /** 床设置的重生点；缺省 → 世界出生点 */
  spawnPoint?: { x: number; y: number; z: number };
  /** 玩家所在维度；缺省 → overworld */
  dimension?: 'overworld' | 'nether' | 'end' | 'aether';
  /** 下界修改过的区块（键 "cx,cz" → RLE 字节，存档外单独携带，避免与主世界键冲突） */
  netherChunks?: Map<string, Uint8Array>;
  /** 末地修改过的区块 */
  endChunks?: Map<string, Uint8Array>;
  /** 天堂修改过的区块 */
  aetherChunks?: Map<string, Uint8Array>;
  /** 地图已探索数据（维度名 → Map<"cx,cz", 16×16 颜色字节>） */
  maps?: Record<string, Map<string, Uint8Array>>;
  /** 末影龙是否已被击败（击败后不再生成，末地留返回传送门） */
  dragonDefeated?: boolean;
}

/** meta 入库前的线性格式：Map 转可结构化克隆的 [key, RLE][] */
interface StoredMeta extends Omit<SaveMeta, 'netherChunks' | 'endChunks' | 'aetherChunks' | 'maps'> {
  netherChunks?: [string, Uint8Array][];
  endChunks?: [string, Uint8Array][];
  aetherChunks?: [string, Uint8Array][];
  /** 地图：维度名 → [key, 值][] 线性化（key 为区块 "cx,cz"，值为该区块 16×16 颜色字节） */
  maps?: Record<string, [string, Uint8Array][]>;
}

export interface LoadedSave {
  meta: SaveMeta;
  chunks: Map<string, Uint8Array>;
}

/** 行程长度编码：[count_lo, count_hi, value] × N */
export function rleEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    let run = 1;
    while (i + run < data.length && data[i + run] === v && run < 65535) run++;
    out.push(run & 0xff, run >> 8, v);
    i += run;
  }
  return new Uint8Array(out);
}

export function rleDecode(raw: Uint8Array): Uint8Array {
  if (raw.length % 3 !== 0) throw new Error('RLE 数据长度非法');
  const out = new Uint8Array(CHUNK_VOLUME);
  let o = 0;
  for (let i = 0; i < raw.length; i += 3) {
    const run = raw[i] | (raw[i + 1] << 8);
    if (run === 0 || o + run > CHUNK_VOLUME) throw new Error('RLE 数据损坏');
    out.fill(raw[i + 2], o, o + run);
    o += run;
  }
  if (o !== CHUNK_VOLUME) throw new Error('RLE 解压长度不符');
  return out;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 请求失败'));
  });
}

function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB 事务失败'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB 事务中止'));
  });
}

export class Persistence {
  private db: IDBDatabase | null = null;

  get available(): boolean {
    return this.db !== null;
  }

  async open(): Promise<void> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('无法打开 IndexedDB'));
    });
  }

  /** 读取存档；无存档返回 null；数据损坏抛错（上层回退新世界） */
  async load(): Promise<LoadedSave | null> {
    if (!this.db) return null;
    const t = this.db.transaction([META_STORE, CHUNK_STORE], 'readonly');
    const stored = (await req(t.objectStore(META_STORE).get(META_KEY))) as
      | StoredMeta
      | undefined;
    if (!stored) return null;
    const p = stored.player;
    if (
      typeof stored.seed !== 'number' ||
      !p ||
      ![p.x, p.y, p.z, p.yaw, p.pitch].every((v) => Number.isFinite(v))
    ) {
      throw new Error('存档 meta 损坏');
    }
    const store = t.objectStore(CHUNK_STORE);
    const keys = (await req(store.getAllKeys())) as IDBValidKey[];
    const values = (await req(store.getAll())) as unknown[];
    const chunks = new Map<string, Uint8Array>();
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i];
      if (!(raw instanceof Uint8Array)) throw new Error('存档区块数据类型错误');
      chunks.set(String(keys[i]), rleDecode(raw));
    }
    // 下界修改集解压回 Map
    const meta: SaveMeta = {
      ...stored,
      netherChunks: undefined,
      endChunks: undefined,
      aetherChunks: undefined,
      maps: undefined,
    };
    if (stored.netherChunks) {
      const nm = new Map<string, Uint8Array>();
      for (const [k, raw] of stored.netherChunks) nm.set(k, rleDecode(raw));
      meta.netherChunks = nm;
    }
    if (stored.endChunks) {
      const nm = new Map<string, Uint8Array>();
      for (const [k, raw] of stored.endChunks) nm.set(k, rleDecode(raw));
      meta.endChunks = nm;
    }
    if (stored.aetherChunks) {
      const nm = new Map<string, Uint8Array>();
      for (const [k, raw] of stored.aetherChunks) nm.set(k, rleDecode(raw));
      meta.aetherChunks = nm;
    }
    // 地图已探索数据（直接是 [key, bytes][]，无需 RLE）
    if (stored.maps) {
      const mm: Record<string, Map<string, Uint8Array>> = {};
      for (const [dim, entries] of Object.entries(stored.maps)) {
        const m = new Map<string, Uint8Array>();
        for (const [k, v] of entries) m.set(k, v);
        mm[dim] = m;
      }
      meta.maps = mm;
    }
    return { meta, chunks };
  }

  /** 全量覆写：meta + 所有修改过的区块（先清空区块库防陈旧数据） */
  async save(meta: SaveMeta, chunks: Map<string, Uint8Array>): Promise<void> {
    if (!this.db) return;
    const t = this.db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
    const stored: StoredMeta = {
      ...meta,
      netherChunks: undefined,
      endChunks: undefined,
      aetherChunks: undefined,
      maps: undefined,
    };
    const lin = (
      m: Map<string, Uint8Array> | undefined,
    ): [string, Uint8Array][] | undefined =>
      m ? [...m].map(([k, v]) => [k, rleEncode(v)] as [string, Uint8Array]) : undefined;
    stored.netherChunks = lin(meta.netherChunks);
    stored.endChunks = lin(meta.endChunks);
    stored.aetherChunks = lin(meta.aetherChunks);
    // 地图：直接转 [key, bytes][]（16×16=256B/区块，无需 RLE）
    if (meta.maps) {
      const sm: Record<string, [string, Uint8Array][]> = {};
      for (const [dim, m] of Object.entries(meta.maps)) {
        sm[dim] = [...m].map(([k, v]) => [k, v] as [string, Uint8Array]);
      }
      stored.maps = sm;
    }
    t.objectStore(META_STORE).put(stored, META_KEY);
    const store = t.objectStore(CHUNK_STORE);
    store.clear();
    for (const [key, data] of chunks) {
      store.put(rleEncode(data), key);
    }
    await txDone(t);
  }

  async clear(): Promise<void> {
    if (!this.db) return;
    const t = this.db.transaction([META_STORE, CHUNK_STORE], 'readwrite');
    t.objectStore(META_STORE).clear();
    t.objectStore(CHUNK_STORE).clear();
    await txDone(t);
  }
}
