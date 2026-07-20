// ============================================================
// 方块模型加载器：通过 HTTP fetch 从 public/models 加载
// Minecraft 风格方块模型 JSON（parent / textures / elements）
// 可整体替换为资源包风格 JSON，字段保持一致即可
// ============================================================

export type FaceName = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';
export const FACE_NAMES: readonly FaceName[] = ['down', 'up', 'north', 'south', 'west', 'east'];

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
  solid: boolean;        // 是否参与碰撞
  occludes: boolean;     // 是否遮挡邻接面 / 产生 AO
  cullSame: boolean;     // 同类型相邻时剔除共享面（树叶/水/玻璃）
  fluid: boolean;
  selectable: boolean;   // 能否被准星选中
  replaceable: boolean;  // 放置时能否被直接替换（植物）
  renderLayer: 'solid' | 'cutout' | 'translucent';
  hardness: number;      // <0 不可破坏，0 瞬间破坏
  luminance: number;
  fullCube: boolean;     // 单元素 16^3 六面 → 走贪心合并快路径
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
  defs: BlockDef[];
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

  // 递归加载模型并解析 parent 链
  const modelCache = new Map<string, BlockModel>();

  async function getModel(path: string): Promise<BlockModel> {
    const cached = modelCache.get(path);
    if (cached) return cached;
    const model = (await fetchJson(`${baseUrl}/${path}.json`)) as BlockModel;
    modelCache.set(path, model);
    return model;
  }

  /** 沿 parent 链合并 textures（子覆盖父），取最靠近子级的 elements */
  async function resolveModel(path: string): Promise<{
    textures: Record<string, string>;
    elements: ModelElement[];
  }> {
    const chain: BlockModel[] = [];
    let cur: string | undefined = path;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) throw new Error(`模型 parent 循环引用：${cur}`);
      seen.add(cur);
      const m = await getModel(cur);
      chain.push(m);
      cur = m.parent;
    }
    const textures: Record<string, string> = {};
    for (let i = chain.length - 1; i >= 0; i--) {
      Object.assign(textures, chain[i].textures ?? {});
    }
    let elements: ModelElement[] = [];
    for (const m of chain) {
      if (m.elements) { elements = m.elements; break; }
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
      if (next === undefined) throw new Error(`${where}：未定义的贴图引用 ${cur}`);
      cur = next;
    }
    const tile = tileIndex.get(cur);
    if (tile === undefined) throw new Error(`${where}：图集中不存在贴图 "${cur}"`);
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
              ? [face.uv[0] / 16, face.uv[1] / 16, face.uv[2] / 16, face.uv[3] / 16]
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
                origin: [el.rotation.origin[0], el.rotation.origin[1], el.rotation.origin[2]],
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
        for (const f of FACE_NAMES) base.faceTiles[f] = base.elements[0].faces[f]!.tile;
      }
    }

    // 遮挡规则：全立方且非镂空/半透明 → 遮挡邻面并产生 AO
    base.occludes = base.fullCube && renderLayer === 'solid';
    defs.push(base);
  }

  defs.sort((a, b) => a.id - b.id);
  return { defs, hotbar: file.hotbar ?? [] };
}
