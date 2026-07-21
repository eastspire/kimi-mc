// ============================================================
// 方块模型加载器：通过 HTTP fetch 从 public/models 加载
// Minecraft 风格方块模型 JSON（parent / textures / elements）
// 可整体替换为资源包风格 JSON，字段保持一致即可
// ============================================================

import { MAX_BLOCKS } from './block-registry';

export type FaceName = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';
export const FACE_NAMES: readonly FaceName[] = [
  'down',
  'up',
  'north',
  'south',
  'west',
  'east',
];

export interface ModelFace {
  texture: string;
  cullface?: string;
  uv?: number[]; // [u1, v1, u2, v2] 0..16
}

export interface ModelRotation {
  axis: string;
  angle: number;
  origin: number[];
}

export interface ModelElement {
  from: number[];
  to: number[];
  rotation?: ModelRotation;
  faces?: Record<string, ModelFace>;
}

export interface BlockModel {
  parent?: string;
  textures?: Record<string, string>;
  elements?: ModelElement[];
}

export interface BlockSpec {
  id: number;
  display?: string;
  model?: string | null;
  textures?: Record<string, string>;
  solid?: boolean;
  selectable?: boolean;
  renderLayer?: 'solid' | 'cutout' | 'translucent';
  hardness?: number;
  luminance?: number;
  fluid?: boolean;
  cullSame?: boolean;
  replaceable?: boolean;
  /** 重力方块（沙子/沙砾）：下方无支撑时转为下落实体 */
  falling?: boolean;
  /** 水位等级 0..8：0=水源（满格），1..7=水平扩散逐级下沉，8=竖直下落水柱 */
  waterLevel?: number;
}

export interface BlocksFile {
  formatVersion: number;
  hotbar?: string[];
  blocks: Record<string, BlockSpec>;
}

// ---- 运行时（解析后）定义，会原样传给 Worker ----

export interface FaceDef {
  tile: number; // 图集格索引
  cullface?: FaceName;
  uv?: [number, number, number, number]; // 0..1
}

export interface ElementDef {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: { axis: 'y'; angle: number; origin: [number, number, number] };
  faces: Partial<Record<FaceName, FaceDef>>;
}

export interface BlockDef {
  id: number;
  name: string;
  display: string;
  solid: boolean; // 是否参与碰撞
  occludes: boolean; // 是否遮挡邻接面 / 产生 AO
  cullSame: boolean; // 同类型相邻时剔除共享面（树叶/水/玻璃）
  fluid: boolean;
  selectable: boolean; // 能否被准星选中
  replaceable: boolean; // 放置时能否被直接替换（植物）
  renderLayer: 'solid' | 'cutout' | 'translucent';
  hardness: number; // <0 不可破坏，0 瞬间破坏
  luminance: number;
  /** 重力方块（沙子/沙砾） */
  falling: boolean;
  /** 水位等级 0..8；非流体为 0。fluid=true 时 0=水源、1..7=扩散、8=下落柱 */
  waterLevel: number;
  fullCube: boolean; // 单元素 16^3 六面 → 走贪心合并快路径
  faceTiles: Partial<Record<FaceName, number>>;
  elements: ElementDef[];
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`无法加载 ${url}：网络请求失败（${(e as Error).message}）`);
  }
  if (!res.ok) throw new Error(`无法加载 ${url}：HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`无法解析 ${url}：不是合法 JSON`);
  }
}

export interface LoadedBlocks {
  /** 按方块 id 稀疏索引（空洞为 null），mesher 与 ChunkManager 直接 defs[id] 查表 */
  defs: (BlockDef | null)[];
  hotbar: string[];
}

export async function loadBlocks(
  baseUrl: string,
  tileIndex: ReadonlyMap<string, number>,
): Promise<LoadedBlocks> {
  const file = (await fetchJson(`${baseUrl}/blocks.json`)) as BlocksFile;
  if (!file || typeof file !== 'object' || !file.blocks) {
    throw new Error('blocks.json 格式错误：缺少 blocks 字段');
  }

  // 预算全部模型路径 + 解析 parent 链 → 一次性 Promise.all 并行 fetch，
  // 然后再同步化地解析 blocks。这样启动期不会按方块数触发 N 次串行等待，
  // 首屏加载时间从 ~N*round-trip 压缩到 ~1*round-trip（无论 N 多大）
  const allPaths = new Set<string>();
  const pendingParent = new Set<string>();
  // 第一遍：所有 spec.model 都进 first-hop；parent 留作第二轮解析
  for (const spec of Object.values(file.blocks)) {
    if (!spec.model) continue;
    if (allPaths.has(spec.model)) continue;
    allPaths.add(spec.model);
    pendingParent.add(spec.model);
  }
  // 第二轮：每 first-hop 拉一次 JSON 后解开 parent，加入 allPaths
  // （不再串行等待：所有 first-hop 并发 fetch 完，再一次性 follow parent）
  const firstWave = await Promise.all(
    [...allPaths].map((p) =>
      fetchJson(`${baseUrl}/${p}.json`).then((m) => m as BlockModel),
    ),
  );
  // 建立 path → model 映射；同时 follow parent 链
  const modelJson = new Map<string, BlockModel>();
  [...allPaths].forEach((p, i) => modelJson.set(p, firstWave[i]));
  let added = true;
  while (added) {
    added = false;
    for (const m of modelJson.values()) {
      const cur = m.parent;
      if (cur && !modelJson.has(cur)) {
        allPaths.add(cur);
        added = true;
      }
    }
    if (!added) break;
    const newOnes = [...allPaths].filter((p) => !modelJson.has(p));
    if (newOnes.length === 0) break;
    const fetched = await Promise.all(
      newOnes.map((p) =>
        fetchJson(`${baseUrl}/${p}.json`).then((m) => m as BlockModel),
      ),
    );
    newOnes.forEach((p, i) => modelJson.set(p, fetched[i]));
  }

  const modelCache = modelJson; // 已是已解析 JSON map，不需再 await

  function getModel(path: string): BlockModel {
    const m = modelCache.get(path);
    if (!m) throw new Error(`未预取的模型：${path}`);
    return m;
  }

  /** 沿 parent 链合并 textures（子覆盖父），取最靠近子级的 elements */
  function resolveModel(path: string): {
    textures: Record<string, string>;
    elements: ModelElement[];
  } {
    const chain: BlockModel[] = [];
    let cur: string | undefined = path;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) throw new Error(`模型 parent 循环引用：${cur}`);
      seen.add(cur);
      const m = getModel(cur);
      chain.push(m);
      cur = m.parent;
    }
    const textures: Record<string, string> = {};
    for (let i = chain.length - 1; i >= 0; i--) {
      Object.assign(textures, chain[i].textures ?? {});
    }
    let elements: ModelElement[] = [];
    for (const m of chain) {
      if (m.elements) {
        elements = m.elements;
        break;
      }
    }
    return { textures, elements };
  }

  /** 解析 "#ref" 贴图引用，返回图集 tile 索引 */
  function resolveTile(
    ref: string,
    textures: Record<string, string>,
    where: string,
  ): number {
    let cur = ref;
    const seen = new Set<string>();
    while (cur.startsWith('#')) {
      if (seen.has(cur)) throw new Error(`${where}：贴图引用循环 ${ref}`);
      seen.add(cur);
      const next = textures[cur.slice(1)];
      if (next === undefined)
        throw new Error(`${where}：未定义的贴图引用 ${cur}`);
      cur = next;
    }
    const tile = tileIndex.get(cur);
    if (tile === undefined)
      throw new Error(`${where}：图集中不存在贴图 "${cur}"`);
    return tile;
  }

  const defs: BlockDef[] = [];

  for (const [name, spec] of Object.entries(file.blocks)) {
    const renderLayer = spec.renderLayer ?? 'solid';
    const fluid = spec.fluid ?? false;

    const base: BlockDef = {
      id: spec.id,
      name,
      display: spec.display ?? name,
      solid: spec.solid ?? true,
      occludes: false,
      cullSame: spec.cullSame ?? false,
      fluid,
      selectable: spec.selectable ?? (!fluid && spec.id !== 0),
      replaceable: spec.replaceable ?? false,
      renderLayer,
      hardness: spec.hardness ?? 1,
      luminance: spec.luminance ?? 0,
      falling: spec.falling ?? false,
      waterLevel: fluid ? (spec.waterLevel ?? 0) : 0,
      fullCube: false,
      faceTiles: {},
      elements: [],
    };

    if (spec.model) {
      const { textures, elements } = await resolveModel(spec.model);
      Object.assign(textures, spec.textures ?? {}); // 方块级贴图覆盖模型级
      const where = `方块 ${name}`;

      for (const el of elements) {
        const faces: Partial<Record<FaceName, FaceDef>> = {};
        for (const [fname, face] of Object.entries(el.faces ?? {})) {
          faces[fname as FaceName] = {
            tile: resolveTile(face.texture, textures, where),
            cullface: face.cullface as FaceName | undefined,
            uv: face.uv
              ? [
                  face.uv[0] / 16,
                  face.uv[1] / 16,
                  face.uv[2] / 16,
                  face.uv[3] / 16,
                ]
              : undefined,
          };
        }
        base.elements.push({
          from: [el.from[0], el.from[1], el.from[2]],
          to: [el.to[0], el.to[1], el.to[2]],
          rotation: el.rotation
            ? {
                axis: 'y',
                angle: el.rotation.angle,
                origin: [
                  el.rotation.origin[0],
                  el.rotation.origin[1],
                  el.rotation.origin[2],
                ],
              }
            : undefined,
          faces,
        });
      }

      // 判定是否为标准全立方体（走贪心快路径）
      if (
        base.elements.length === 1 &&
        base.elements[0].from.every((v) => v === 0) &&
        base.elements[0].to.every((v) => v === 16) &&
        !base.elements[0].rotation &&
        FACE_NAMES.every((f) => base.elements[0].faces[f])
      ) {
        base.fullCube = true;
        for (const f of FACE_NAMES)
          base.faceTiles[f] = base.elements[0].faces[f]!.tile;
      }
    }

    // 遮挡规则：全立方且非镂空/半透明 → 遮挡邻面并产生 AO
    base.occludes = base.fullCube && renderLayer === 'solid';
    defs.push(base);
  }

  defs.sort((a, b) => a.id - b.id);
  // 关键：mesher 与 ChunkManager 用 defs[id] 查表，必须按方块 id 索引。
  // 方块定义按 id 升序排序后是稠密数组（index 0..N-1），但当 id 序列中有空洞
  // （当前 blocks.json 在 id=19 处跳号）时，defs[id] 会拿到错位的方块，导致
  // 所有 id>=20 的方块渲染时贴图错位。例如 TNT(id=32) 当时落在 defs[31]，
  // 而 defs[32] 实际是 water_flow_1(id=33)，TNT 放置后被渲染成水。
  // 解决：把数组重新按 id 填到 MAX_BLOCKS 大小的稀疏表，未定义的 id 位置为 null。
  // 消费方（inventory / showMenu 等）只迭代非 null 项即可（for...of 已天然跳过 null，
  // 因为 null 也会触发 drawBlockIcon 等调用方崩溃；需在调用处显式过滤）。
  const byId: (BlockDef | null)[] = new Array(MAX_BLOCKS).fill(null);
  for (const def of defs) byId[def.id] = def;
  return { defs: byId, hotbar: file.hotbar ?? [] };
}
