import { BlockRegistry, AIR } from '../core/block-registry';
import { Noise2D, Noise3D, hash2i, hash3i } from './noise';

// ============================================================
// 世界生成：高度图 + 温度/湿度生物群系 + 洞穴 + 矿石 + 树
// 区块 16×128×16，海平面 32
// ============================================================

export const CHUNK_X = 16;
export const CHUNK_Y = 128;
export const CHUNK_Z = 16;
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

export class WorldGen {
  private heightNoise: Noise2D;
  private detailNoise: Noise2D;
  private tempNoise: Noise2D;
  private humidNoise: Noise2D;
  private caveNoiseA: Noise3D;
  private caveNoiseB: Noise3D;
  private treeSalt: number;
  private oreSalt: number;

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

  constructor(
    public readonly seed: number,
    reg: BlockRegistry,
  ) {
    this.heightNoise = new Noise2D(seed ^ 0x1a2b3c);
    this.detailNoise = new Noise2D(seed ^ 0x4d5e6f);
    this.tempNoise = new Noise2D(seed ^ 0x7a8b9c);
    this.humidNoise = new Noise2D(seed ^ 0xadbecf);
    this.caveNoiseA = new Noise3D(seed ^ 0x102030);
    this.caveNoiseB = new Noise3D(seed ^ 0x405060);
    this.treeSalt = seed ^ 0x7ee5;
    this.oreSalt = seed ^ 0x0e5;

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

    return data;
  }
}
