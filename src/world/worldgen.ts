import { BlockRegistry, AIR } from '../core/block-registry';
import { Noise2D, Noise3D, hash2i, hash3i } from './noise';
import { CHUNK_X, CHUNK_Y, CHUNK_Z } from './chunk-const';
import { applyVillage } from './village';
import { applyStronghold } from './stronghold';

// ============================================================
// 世界生成：高度图 + 温度/湿度生物群系 + 洞穴 + 矿石 + 树
// 区块 16×128×16，海平面 32
// ============================================================

export const SEA_LEVEL = 32;

/**
 * 解析种子输入：纯数字按数值取低 32 位（MC 风格），
 * 其他字符串经 FNV-1a 哈希，留空则随机生成。
 * 世界生成全部使用种子化噪声/哈希，同一种子必然同一世界。
 */
export function parseSeedInput(text: string): { seed: number; label: string } {
  const t = text.trim();
  if (t === '') {
    const seed = (Math.random() * 0x7fffffff) | 0;
    return { seed, label: String(seed) };
  }
  if (/^-?\d+$/.test(t)) {
    const seed = Number(t) | 0;
    return { seed, label: String(seed) };
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return { seed: h | 0, label: t };
}

export const enum Biome {
  Plains,
  Desert,
  Forest,
}

/** 维度：主世界 / 下界 / 末地 / 天堂（同一 WorldGen 类按维度走不同地形分支） */
export type Dimension = 'overworld' | 'nether' | 'end' | 'aether';

/** 下界岩浆海平面（此高度及以下灌岩浆） */
export const NETHER_LAVA_LEVEL = 11;

export class WorldGen {
  private heightNoise: Noise2D;
  private detailNoise: Noise2D;
  private tempNoise: Noise2D;
  private humidNoise: Noise2D;
  private caveNoiseA: Noise3D;
  private caveNoiseB: Noise3D;
  private treeSalt: number;
  private oreSalt: number;
  /** 结构生成（村庄/要塞）盐 */
  readonly structSalt: number;
  /** 维度（主世界地表 / 下界封闭洞穴） */
  readonly dimension: Dimension;

  // 方块 id 缓存
  private idStone: number;
  private idDirt: number;
  private idGrass: number;
  private idSand: number;
  private idSandstone: number;
  private idLog: number;
  private idLeaves: number;
  private idBedrock: number;
  private idWater: number;
  private idCoal: number;
  private idIron: number;
  private idGold: number;
  private idDiamond: number;
  private idLapis: number;
  private idRedstone: number;
  private idEmerald: number;
  private idTallGrass: number;
  private idFlowerRed: number;
  private idFlowerYellow: number;
  // 下界方块 id 缓存
  private idNetherrack: number;
  private idSoulSand: number;
  private idLava: number;
  private idGlowstone: number;
  // 末地/天堂方块 id 缓存
  private idEndStone: number;
  private idEndStoneBricks: number;
  idEndPortalFrame: number;
  private idAetherGrass: number;
  private idAetherDirt: number;
  private idHolystone: number;
  private idAetherLog: number;
  private idAetherLeaves: number;
  private idObsidian: number;
  private idEndCrystal: number;
  // 结构生成（村庄/要塞）方块 id
  idOakLog: number;
  idOakPlanks: number;
  idGlass: number;
  idCobble: number;
  idTorch: number;
  idFarmland: number;
  idWheat: number[];
  idStoneBricks: number;
  idEndPortalFrameEye: number;
  idEndPortal: number;

  constructor(
    public readonly seed: number,
    reg: BlockRegistry,
    dimension: Dimension = 'overworld',
  ) {
    this.dimension = dimension;
    this.heightNoise = new Noise2D(seed ^ 0x1a2b3c);
    this.detailNoise = new Noise2D(seed ^ 0x4d5e6f);
    this.tempNoise = new Noise2D(seed ^ 0x7a8b9c);
    this.humidNoise = new Noise2D(seed ^ 0xadbecf);
    this.caveNoiseA = new Noise3D(seed ^ 0x102030);
    this.caveNoiseB = new Noise3D(seed ^ 0x405060);
    this.treeSalt = seed ^ 0x7ee5;
    this.oreSalt = seed ^ 0x0e5;
    this.structSalt = seed ^ 0x57c7;

    this.idStone = reg.id('stone');
    this.idDirt = reg.id('dirt');
    this.idGrass = reg.id('grass_block');
    this.idSand = reg.id('sand');
    this.idSandstone = reg.id('sandstone');
    this.idLog = reg.id('oak_log');
    this.idLeaves = reg.id('oak_leaves');
    this.idBedrock = reg.id('bedrock');
    this.idWater = reg.id('water');
    this.idCoal = reg.id('coal_ore');
    this.idIron = reg.id('iron_ore');
    this.idGold = reg.id('gold_ore');
    this.idDiamond = reg.id('diamond_ore');
    this.idLapis = reg.id('lapis_ore');
    this.idRedstone = reg.id('redstone_ore');
    this.idEmerald = reg.id('emerald_ore');
    this.idTallGrass = reg.id('tall_grass');
    this.idFlowerRed = reg.id('flower_red');
    this.idFlowerYellow = reg.id('flower_yellow');
    // 结构生成（村庄/要塞）用到的方块
    this.idOakLog = reg.id('oak_log');
    this.idOakPlanks = reg.id('oak_planks');
    this.idGlass = reg.id('glass');
    this.idCobble = reg.id('cobblestone');
    this.idTorch = reg.id('torch');
    this.idFarmland = reg.id('farmland');
    this.idWheat = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => reg.id(`wheat_${i}`));
    this.idStoneBricks = reg.id('stone_bricks');
    this.idEndPortalFrameEye = reg.byName.has('end_portal_frame_eye')
      ? reg.id('end_portal_frame_eye')
      : reg.id('end_portal_frame');
    this.idEndPortal = reg.byName.has('end_portal')
      ? reg.id('end_portal')
      : reg.id('nether_portal');
    // 下界（缺名回退占位，保证旧 blocks.json 不崩）
    const opt = (n: string, fallback: number): number =>
      reg.byName.has(n) ? reg.id(n) : fallback;
    this.idNetherrack = opt('netherrack', this.idStone);
    this.idSoulSand = opt('soul_sand', this.idDirt);
    this.idLava = opt('lava', this.idWater);
    this.idGlowstone = opt('glowstone', this.idStone);
    // 末地/天堂（同样带回退，保证向前兼容）
    this.idEndStone = opt('end_stone', this.idStone);
    this.idEndStoneBricks = opt('end_stone_bricks', this.idStone);
    this.idEndPortalFrame = opt('end_portal_frame', this.idStone);
    this.idAetherGrass = opt('aether_grass', this.idGrass);
    this.idAetherDirt = opt('aether_dirt', this.idDirt);
    this.idHolystone = opt('holystone', this.idStone);
    this.idAetherLog = opt('aether_log', this.idLog);
    this.idAetherLeaves = opt('aether_leaves', this.idLeaves);
    this.idObsidian = opt('obsidian', this.idBedrock);
    this.idEndCrystal = opt('end_crystal', this.idGlowstone);
    // 供结构生成（要塞/龙岛柱）使用，此处占位避免未用告警
    void this.idEndStoneBricks;
    void this.idEndPortalFrame;
    void this.idObsidian;
  }

  /** 地表高度（纯函数，跨区块一致） */
  heightAt(wx: number, wz: number): number {
    const continent = this.heightNoise.fbm(wx * 0.004, wz * 0.004, 4);
    const detail = this.detailNoise.fbm(wx * 0.028 + 53.7, wz * 0.028 - 31.2, 3);
    const h = 36 + continent * 15 + detail * 3.5;
    return Math.max(4, Math.min(CHUNK_Y - 20, Math.floor(h)));
  }

  biomeAt(wx: number, wz: number): Biome {
    const t = this.tempNoise.fbm(wx * 0.0016 + 1000, wz * 0.0016 - 1000, 3);
    const h = this.humidNoise.fbm(wx * 0.0016 - 1000, wz * 0.0016 + 1000, 3);
    if (t > 0.22 && h < -0.08) return Biome.Desert;
    if (h > 0.16) return Biome.Forest;
    return Biome.Plains;
  }

  /** 洞穴判定（两条噪声带交叠 → 意面状隧道） */
  private isCave(wx: number, y: number, wz: number): boolean {
    const a = this.caveNoiseA.fbm(wx * 0.045, y * 0.075, wz * 0.045, 3);
    if (Math.abs(a) > 0.055) return false;
    const b = this.caveNoiseB.fbm(wx * 0.05 + 77.7, y * 0.08, wz * 0.05 - 55.5, 3);
    return Math.abs(b) < 0.055;
  }

  private oreAt(wx: number, y: number, wz: number): number {
    const s = this.oreSalt;
    if (y < 70 && hash3i(wx, y, wz, s ^ 0xc0a1) < 0.011) return this.idCoal;
    if (y < 40 && hash3i(wx, y, wz, s ^ 0x1205) < 0.0055) return this.idIron;
    if (y < 30 && hash3i(wx, y, wz, s ^ 0x1a91) < 0.002) return this.idLapis;
    if (y < 20 && hash3i(wx, y, wz, s ^ 0x601d) < 0.002) return this.idGold;
    if (y < 16 && hash3i(wx, y, wz, s ^ 0xed57) < 0.0025) return this.idRedstone;
    if (y < 16 && hash3i(wx, y, wz, s ^ 0xd1a0) < 0.0012) return this.idDiamond;
    if (y < 24 && hash3i(wx, y, wz, s ^ 0x3ee1d) < 0.0008) return this.idEmerald;
    return AIR;
  }

  /** 某列是否长树（纯函数，含树干高度） */
  private treeAt(wx: number, wz: number): { h: number } | null {
    const biome = this.biomeAt(wx, wz);
    const r = hash2i(wx, wz, this.treeSalt);
    const p = biome === Biome.Forest ? 0.02 : biome === Biome.Plains ? 0.003 : 0;
    if (r >= p) return null;
    const ground = this.heightAt(wx, wz);
    if (ground <= SEA_LEVEL + 1) return null;
    return { h: 4 + ((hash2i(wx, wz, this.treeSalt ^ 0xbeef) * 3) | 0) };
  }

  generateChunk(cx: number, cz: number): Uint8Array {
    switch (this.dimension) {
      case 'nether':
        return this.generateNetherChunk(cx, cz);
      case 'end':
        return this.generateEndChunk(cx, cz);
      case 'aether':
        return this.generateAetherChunk(cx, cz);
      default:
        return this.generateOverworldChunk(cx, cz);
    }
  }

  private generateOverworldChunk(cx: number, cz: number): Uint8Array {
    const data = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
    const idx = (x: number, y: number, z: number): number => x + CHUNK_X * (z + CHUNK_Z * y);
    const bx = cx * CHUNK_X;
    const bz = cz * CHUNK_Z;

    // ---- 地形立柱 ----
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const wx = bx + x;
        const wz = bz + z;
        const h = this.heightAt(wx, wz);
        const biome = this.biomeAt(wx, wz);
        const beach = h <= SEA_LEVEL + 2;

        for (let y = 0; y <= h; y++) {
          // 基岩：y=0 必有，1~2 层粗糙
          if (y === 0 || (y === 1 && hash3i(wx, y, wz, this.oreSalt ^ 0xbed) < 0.6) || (y === 2 && hash3i(wx, y, wz, this.oreSalt ^ 0xbed) < 0.2)) {
            data[idx(x, y, z)] = this.idBedrock;
            continue;
          }
          // 洞穴（不穿破地表/海床）
          if (y > 3 && y < h - 5 && this.isCave(wx, y, wz)) continue;

          if (y === h) {
            // 表层
            if (biome === Biome.Desert) data[idx(x, y, z)] = this.idSand;
            else if (h <= SEA_LEVEL) data[idx(x, y, z)] = beach ? this.idSand : this.idDirt;
            else if (beach) data[idx(x, y, z)] = this.idSand;
            else data[idx(x, y, z)] = this.idGrass;
          } else if (y > h - 4) {
            // 亚表层
            data[idx(x, y, z)] = biome === Biome.Desert || beach ? this.idSand : this.idDirt;
          } else if (y > h - 7 && biome === Biome.Desert) {
            data[idx(x, y, z)] = this.idSandstone;
          } else {
            const ore = this.oreAt(wx, y, wz);
            data[idx(x, y, z)] = ore !== AIR ? ore : this.idStone;
          }
        }

        // 海面以下灌水
        for (let y = h + 1; y <= SEA_LEVEL; y++) data[idx(x, y, z)] = this.idWater;

        // 表层植被
        if (data[idx(x, h, z)] === this.idGrass && h + 1 < CHUNK_Y) {
          const r = hash2i(wx, wz, this.treeSalt ^ 0xf10a);
          if (r < 0.045) data[idx(x, h + 1, z)] = this.idTallGrass;
          else if (r < 0.055) {
            data[idx(x, h + 1, z)] =
              hash2i(wx, wz, this.treeSalt ^ 0xf10b) < 0.5 ? this.idFlowerRed : this.idFlowerYellow;
          }
        }
      }
    }

    // ---- 树（含邻区块伸进来的树冠：扫描外扩 2 格的树位，保证边界一致） ----
    for (let tz = -2; tz < CHUNK_Z + 2; tz++) {
      for (let tx = -2; tx < CHUNK_X + 2; tx++) {
        const wx = bx + tx;
        const wz = bz + tz;
        const tree = this.treeAt(wx, wz);
        if (!tree) continue;
        const ground = this.heightAt(wx, wz);
        const top = ground + tree.h; // 树干最高格
        const put = (lx: number, y: number, lz: number, id: number, onlyAir: boolean): void => {
          if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z || y < 1 || y >= CHUNK_Y) return;
          const i = idx(lx, y, lz);
          if (onlyAir && data[i] !== AIR) return;
          data[i] = id;
        };
        // 树冠：两层 5×5（随机去角）+ 一层 3×3 + 顶层十字
        const leafRnd = (dx: number, dy: number, dz: number): number =>
          hash3i(wx + dx, top + dy, wz + dz, this.treeSalt ^ 0x1eaf);
        for (let dy = tree.h - 2; dy <= tree.h - 1; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
              if (Math.abs(dx) === 2 && Math.abs(dz) === 2 && leafRnd(dx, dy, dz) < 0.5) continue;
              put(tx + dx, ground + dy, tz + dz, this.idLeaves, true);
            }
          }
        }
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx !== 0 && dz !== 0 && leafRnd(dx, tree.h, dz) < 0.5) continue;
            put(tx + dx, ground + tree.h, tz + dz, this.idLeaves, true);
          }
        }
        put(tx, top + 1, tz, this.idLeaves, true);
        put(tx + 1, top + 1, tz, this.idLeaves, true);
        put(tx - 1, top + 1, tz, this.idLeaves, true);
        put(tx, top + 1, tz + 1, this.idLeaves, true);
        put(tx, top + 1, tz - 1, this.idLeaves, true);
        // 树干（最后放，优先于树叶）
        for (let y = ground + 1; y <= top; y++) put(tx, y, tz, this.idLog, false);
      }
    }

    // ---- 要塞结构（地下，跨区块无缝）：先覆盖出石砖房间/传送门 ----
    applyStronghold(this, cx, cz, data);
    // ---- 村庄结构（地表，跨区块无缝）：最后覆盖，优先于地形与树 ----
    applyVillage(this, cx, cz, data);

    return data;
  }

  // ============================================================
  // 下界维度（MC 1.16- 简化）：封闭洞窟维度
  //  - 顶/底基岩封闭（顶 y≥120 基岩盖，底 y=0 基岩）
  //  - 主体下界岩，两条 3D 噪声挖出连通大洞窟
  //  - y≤NETHER_LAVA_LEVEL 灌岩浆海；谷地灵魂沙；洞顶垂挂萤石簇
  // ============================================================
  private generateNetherChunk(cx: number, cz: number): Uint8Array {
    const data = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
    const idx = (x: number, y: number, z: number): number =>
      x + CHUNK_X * (z + CHUNK_Z * y);
    const bx = cx * CHUNK_X;
    const bz = cz * CHUNK_Z;
    const TOP = CHUNK_Y - 1; // 127

    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const wx = bx + x;
        const wz = bz + z;
        // 谷地起伏（低频），决定灵魂沙分布与地表微起伏
        const valley = this.detailNoise.fbm(wx * 0.02 + 400, wz * 0.02 - 400, 3);

        for (let y = 0; y <= TOP; y++) {
          // 基岩底（y=0 必有，1~2 层粗糙）与基岩顶（y=127 必有，124~126 粗糙）
          if (
            y === 0 ||
            (y === 1 && hash3i(wx, y, wz, this.oreSalt ^ 0xbed) < 0.6) ||
            (y === 2 && hash3i(wx, y, wz, this.oreSalt ^ 0xbed) < 0.2) ||
            y === TOP ||
            (y === TOP - 1 && hash3i(wx, y, wz, this.oreSalt ^ 0xbed2) < 0.6) ||
            (y === TOP - 2 && hash3i(wx, y, wz, this.oreSalt ^ 0xbed2) < 0.2)
          ) {
            data[idx(x, y, z)] = this.idBedrock;
            continue;
          }
          // 洞窟：两条 3D 噪声带交叠 → 大型连通空腔
          const a = this.caveNoiseA.fbm(wx * 0.016, y * 0.024, wz * 0.016, 3);
          const b = this.caveNoiseB.fbm(
            wx * 0.018 + 300,
            y * 0.026,
            wz * 0.018 - 210,
            3,
          );
          const open = Math.abs(a) < 0.26 && Math.abs(b) < 0.26;
          if (open) {
            // 岩浆海：低于海平面的空腔灌岩浆
            if (y <= NETHER_LAVA_LEVEL) data[idx(x, y, z)] = this.idLava;
            // 否则留空气
            continue;
          }
          // 灵魂沙谷地（仅岩浆海平面附近的实心表层）
          if (
            valley > 0.18 &&
            y <= NETHER_LAVA_LEVEL + 6 &&
            y > NETHER_LAVA_LEVEL
          ) {
            data[idx(x, y, z)] = this.idSoulSand;
            continue;
          }
          data[idx(x, y, z)] = this.idNetherrack;
        }
      }
    }

    // ---- 洞顶垂挂萤石簇（找"上实体、下空气"的顶面随机挂） ----
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const wx = bx + x;
        const wz = bz + z;
        if (hash2i(wx, wz, this.oreSalt ^ 0x910be) > 0.012) continue;
        // 从顶部向下找首个"实体下接空气"的洞顶，向下挂 1~3 格萤石
        for (let y = 118; y > NETHER_LAVA_LEVEL + 8; y--) {
          const here = data[idx(x, y, z)];
          const below = data[idx(x, y - 1, z)];
          if (here !== this.idNetherrack || below !== AIR) continue;
          const len = 1 + ((hash3i(wx, y, wz, this.oreSalt ^ 0x910c) * 3) | 0);
          for (let k = 1; k <= len; k++) {
            if (y - k < 1) break;
            data[idx(x, y - k, z)] = this.idGlowstone;
          }
          break;
        }
      }
    }

    return data;
  }

  // ============================================================
  // 末地维度（MC 简化）：悬浮主岛
  //  - 中央一座末地石大岛（半径随距离衰减的圆顶），四周散布小岛
  //  - 全维度无昼夜、无基岩顶底（下方虚空）；基岩仅在岛芯
  //  - 末地传送门房间由结构生成（要塞）负责，这里只出地形
  // ============================================================
  private generateEndChunk(cx: number, cz: number): Uint8Array {
    const data = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
    const idx = (x: number, y: number, z: number): number =>
      x + CHUNK_X * (z + CHUNK_Z * y);
    const bx = cx * CHUNK_X;
    const bz = cz * CHUNK_Z;
    const ISLAND_Y = 64; // 主岛基准高度

    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const wx = bx + x;
        const wz = bz + z;
        // 距世界中心距离：主岛为中央圆顶（半径 ~64）
        const dc = Math.hypot(wx, wz);
        // 岛屿起伏（低频噪声让岛面不平）
        const bump = this.detailNoise.fbm(wx * 0.05 + 900, wz * 0.05 - 900, 3);
        // 主岛：中心厚、边缘薄直至消失
        const mainT = 1 - Math.min(1, dc / 64);
        // 散布小岛：另一组噪声在大范围内零星凸起
        const small = this.heightNoise.fbm(wx * 0.02 + 777, wz * 0.02 - 555, 3);
        const smallT = Math.max(0, (small - 0.55) * 2);
        const t = Math.max(mainT, smallT * 0.6);
        if (t <= 0) continue; // 虚空

        // 岛厚：中心最厚 ~14，边缘渐薄；叠加起伏
        const thick = Math.floor(t * 14 + bump * 3);
        const top = ISLAND_Y + Math.floor(bump * 2);
        const bottom = top - Math.max(2, thick);
        for (let y = bottom; y <= top; y++) {
          if (y < 1 || y >= CHUNK_Y) continue;
          // 岛芯个别点放基岩（装饰/传送点基底）；其余末地石
          data[idx(x, y, z)] =
            y === bottom && hash3i(wx, y, wz, this.oreSalt ^ 0xe7d) < 0.02
              ? this.idBedrock
              : this.idEndStone;
        }
      }
    }

    // ---- 黑曜石柱环绕主岛中心（末影水晶塔，龙战核心）----
    // 8 根柱绕 (0,0) 半径 30 均布，柱顶放末影水晶；纯函数，跨区块无缝
    const idObsidian = this.idObsidian;
    const idCrystal = this.idEndCrystal;
    const PILLARS = 8;
    for (let i = 0; i < PILLARS; i++) {
      const ang = (i / PILLARS) * Math.PI * 2;
      const px = Math.round(Math.cos(ang) * 30);
      const pz = Math.round(Math.sin(ang) * 30);
      // 柱高确定性（20~32）
      const ph = 20 + Math.floor(hash2i(px, pz, this.structSalt ^ 0xd1) * 12);
      const baseY = ISLAND_Y + 1;
      // 只生成本区块覆盖到的柱体方块
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const wx = px + dx;
          const wz = pz + dz;
          const lx = wx - bx;
          const lz = wz - bz;
          if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z) continue;
          for (let dy = 0; dy < ph; dy++) {
            const y = baseY + dy;
            if (y < 1 || y >= CHUNK_Y) continue;
            data[idx(lx, y, lz)] = idObsidian;
          }
          // 柱顶：基岩 + 末影水晶（仅中心柱顶）
          if (dx === 0 && dz === 0) {
            const topY = baseY + ph;
            if (topY < CHUNK_Y) data[idx(lx, topY, lz)] = this.idBedrock;
            if (topY + 1 < CHUNK_Y) data[idx(lx, topY + 1, lz)] = idCrystal;
          }
        }
      }
    }

    return data;
  }

  // ============================================================
  // 天堂维度（Aether 风格简化）：浮空群岛
  //  - 大片浮空岛（云泥底 + 青绿草面 + 圣石芯），下方虚空
  //  - 明亮天空；岛上点缀天堂树
  // ============================================================
  private generateAetherChunk(cx: number, cz: number): Uint8Array {
    const data = new Uint8Array(CHUNK_X * CHUNK_Y * CHUNK_Z);
    const idx = (x: number, y: number, z: number): number =>
      x + CHUNK_X * (z + CHUNK_Z * y);
    const bx = cx * CHUNK_X;
    const bz = cz * CHUNK_Z;
    const BASE_Y = 72;

    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        const wx = bx + x;
        const wz = bz + z;
        // 浮空岛：低频噪声成片，超过阈值才成岛
        const land = this.heightNoise.fbm(wx * 0.012 + 1500, wz * 0.012 - 1500, 4);
        const detail = this.detailNoise.fbm(wx * 0.05 + 77, wz * 0.05 - 33, 3);
        const t = land - 0.12; // 阈值：只有正区域成岛
        if (t <= 0) continue;

        // 岛顶高度随低频起伏，岛厚随 t 增大
        const top = BASE_Y + Math.floor(land * 16 + detail * 3);
        const thick = Math.max(2, Math.floor(4 + t * 18));
        const bottom = top - thick;
        for (let y = bottom; y <= top; y++) {
          if (y < 1 || y >= CHUNK_Y) continue;
          if (y === top) data[idx(x, y, z)] = this.idAetherGrass;
          else if (y > top - 3) data[idx(x, y, z)] = this.idAetherDirt;
          else data[idx(x, y, z)] = this.idHolystone;
        }

        // 表层点缀：天堂树（借树判定盐，概率较低）
        if (data[idx(x, top, z)] === this.idAetherGrass && top + 1 < CHUNK_Y) {
          const r = hash2i(wx, wz, this.treeSalt ^ 0xae7);
          if (r < 0.012) {
            const th = 4 + ((hash2i(wx, wz, this.treeSalt ^ 0xae8) * 3) | 0);
            const ttop = top + th;
            const put = (
              lx: number,
              y: number,
              lz: number,
              id: number,
              onlyAir: boolean,
            ): void => {
              if (
                lx < 0 ||
                lx >= CHUNK_X ||
                lz < 0 ||
                lz >= CHUNK_Z ||
                y < 1 ||
                y >= CHUNK_Y
              )
                return;
              const i = idx(lx, y, lz);
              if (onlyAir && data[i] !== AIR) return;
              data[i] = id;
            };
            for (let dy = th - 2; dy <= th - 1; dy++)
              for (let dx = -2; dx <= 2; dx++)
                for (let dz = -2; dz <= 2; dz++)
                  put(x + dx, top + dy, z + dz, this.idAetherLeaves, true);
            for (let dx = -1; dx <= 1; dx++)
              for (let dz = -1; dz <= 1; dz++)
                put(x + dx, top + th, z + dz, this.idAetherLeaves, true);
            put(x, ttop + 1, z, this.idAetherLeaves, true);
            put(x + 1, ttop + 1, z, this.idAetherLeaves, true);
            put(x - 1, ttop + 1, z, this.idAetherLeaves, true);
            put(x, ttop + 1, z + 1, this.idAetherLeaves, true);
            put(x, ttop + 1, z - 1, this.idAetherLeaves, true);
            for (let y = top + 1; y <= ttop; y++)
              put(x, y, z, this.idAetherLog, false);
          }
        }
      }
    }
    return data;
  }
}
