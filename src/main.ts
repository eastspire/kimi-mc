import * as THREE from 'three';
import './style.css';
import { createAtlas, TILE_INDEX, type AtlasResult } from './core/atlas';
import { loadBlocks, type BlockDef } from './core/model-loader';
import { BlockRegistry, AIR } from './core/block-registry';
import {
  Persistence,
  type LoadedSave,
  type GameMode,
} from './core/persistence';
import {
  WorldGen,
  SEA_LEVEL,
  parseSeedInput,
  type Dimension,
} from './world/worldgen';
import { World, chunkKey } from './world/world';
import { ChunkManager, RENDER_DIST } from './render/chunk-manager';
import { Sky, DAY_LENGTH } from './render/sky';
import { Hand } from './render/hand';
import { Clouds } from './render/clouds';
import { Controls } from './player/controls';
import { PlayerBody, EYE_HEIGHT } from './player/physics';
import { raycastVoxel, type RayHit } from './player/raycast';
import { Hud } from './ui/hud';
import { Hotbar } from './ui/hotbar';
import { Inventory } from './ui/inventory';
import { SurvivalInventory, emptyHotSlot } from './ui/survival-inventory';
import { CraftingTable } from './ui/crafting-table';
import {
  FurnaceUI,
  newFurnace,
  serializeFurnace,
  tickFurnace,
  type FurnaceState,
} from './ui/furnace-ui';
import { resolveSlot } from './ui/hotbar';
import type { SmeltOut } from './item/smelting';
import { TOOLS, miningSpeed, canHarvest } from './item/tools';
import { DebugPanel } from './ui/debug';
import { StartScreen } from './ui/start-screen';
import { Sfx } from './audio/sfx';
import { Particles } from './fx/particles';
import { MobManager } from './mob/manager';
import { EnderDragon } from './mob/dragon';
import { ArrowManager } from './mob/arrows';
import { TntManager } from './world/tnt';
import { FluidSimulator } from './world/fluid';
import { FallingBlockManager } from './world/falling-blocks';
import { RedstoneSimulator } from './world/redstone';
import type { MobKind } from './mob/mob';
import { DropManager } from './item/drops';
import { XpManager } from './item/xp';
import { FOODS } from './item/foods';
import type { HotSlot } from './ui/hotbar';
import { EnchantUI } from './ui/enchant-ui';
import { TradingUI } from './ui/trading-ui';
import { WorldMap } from './ui/world-map';
import { armorById, armorReduction } from './item/armor';
import {
  efficiencyMult,
  sharpnessBonus,
  protectionBonus,
  unbreakingKeep,
  fortuneMult,
} from './item/enchant';
import type { ToolStack } from './ui/hotbar';

// ============================================================
// 主入口：加载模型 → 主菜单（种子/存档）→ 生成世界 → 游戏主循环
// ============================================================

type GameState = 'loading' | 'ready' | 'playing';

const startScreen = new StartScreen();

async function boot(): Promise<void> {
  try {
    const atlas = createAtlas();
    // 方块模型定义全部通过 HTTP 从 public/models 加载
    const { defs, hotbar } = await loadBlocks('models', TILE_INDEX);
    const registry = new BlockRegistry(defs, hotbar);

    // 读取本地存档（损坏则回退为无存档）
    const persistence = new Persistence();
    let save: LoadedSave | null = null;
    try {
      await persistence.open();
      save = await persistence.load();
    } catch (e) {
      console.warn('存档损坏或 IndexedDB 不可用，按无存档处理', e);
      save = null;
      try {
        await persistence.clear();
      } catch {
        /* 忽略清理失败 */
      }
    }

    showMenu(atlas, registry, defs, persistence, save);
  } catch (e) {
    startScreen.showError((e as Error).message);
  }
}

function showMenu(
  atlas: AtlasResult,
  registry: BlockRegistry,
  defs: (BlockDef | null)[],
  persistence: Persistence,
  save: LoadedSave | null,
): void {
  let createArmed = false;
  let createArmTimer = 0;
  startScreen.showChoice(save !== null, {
    onCreate: (seedText, mode) => {
      const begin = (): void => {
        const { seed, label } = parseSeedInput(seedText);
        startGame(atlas, registry, defs, persistence, null, seed, label, mode);
      };
      if (save && !createArmed) {
        // 两段确认：3 秒内再次点击才删除旧存档（不用原生 confirm，避免模态阻断）
        createArmed = true;
        startScreen.setCreateLabel('确认删除旧存档？再点一次');
        createArmTimer = window.setTimeout(() => {
          createArmed = false;
          startScreen.setCreateLabel('创建新世界');
        }, 3000);
        return;
      }
      window.clearTimeout(createArmTimer);
      createArmed = false;
      if (save) {
        persistence
          .clear()
          .catch(() => {
            /* 清理失败也继续 */
          })
          .then(begin);
      } else {
        begin();
      }
    },
    onContinue: () => {
      if (!save) return;
      startGame(
        atlas,
        registry,
        defs,
        persistence,
        save,
        save.meta.seed,
        save.meta.seedText,
        save.meta.mode ?? 'creative',
      );
    },
  });
}

function startGame(
  atlas: AtlasResult,
  registry: BlockRegistry,
  defs: (BlockDef | null)[],
  persistence: Persistence,
  save: LoadedSave | null,
  seed: number,
  seedLabel: string,
  mode: GameMode,
): void {
  startScreen.showGenerating();

  // ---- 渲染基础 ----
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
  });
  // 像素比上限 1.5：高 DPI 下片元工作量近减半，像素风贴图观感几乎无损
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.autoClear = false; // 手动清屏：主场景后还要叠加手持物二次渲染
  document.getElementById('game')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  camera.rotation.order = 'YXZ';
  // 基础 FOV 可在视频设置中调整（30~110°），冲刺时 +10°（上限 110）
  let baseFov = 75;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    hand.resize(window.innerWidth, window.innerHeight);
  });

  // ---- 四维度世界（主世界/下界/末地/天堂）：各自 World + 生成器 + 区块管理器（独立 Worker 池） ----
  // 下界用不同派生种子，与主世界地形无关；坐标 1:8（下界 1 格 = 主世界 8 格）
  const NETHER_SCALE = 8; // 下界 1 格 = 主世界 8 格（传送门坐标换算）
  const worldGenOver = new WorldGen(seed, registry, 'overworld');
  const worldGenNether = new WorldGen((seed ^ 0x5dee1) | 0, registry, 'nether');
  const worldGenEnd = new WorldGen((seed ^ 0x3e7d) | 0, registry, 'end');
  const worldGenAether = new WorldGen((seed ^ 0xae71) | 0, registry, 'aether');
  // 本会话内"玩家修改过的区块"权威副本：与世界共享同一 Uint8Array 引用，
  // 因此编辑即时反映，保存时编码即为最新状态。主世界用存档键原样；其他维度加前缀。
  const modifiedOver: Map<string, Uint8Array> = save?.chunks ?? new Map();
  const modifiedNether: Map<string, Uint8Array> = new Map();
  if (save?.meta.netherChunks) {
    for (const [k, v] of save.meta.netherChunks) modifiedNether.set(k, v);
  }
  const modifiedEnd: Map<string, Uint8Array> = new Map();
  if (save?.meta.endChunks) {
    for (const [k, v] of save.meta.endChunks) modifiedEnd.set(k, v);
  }
  const modifiedAether: Map<string, Uint8Array> = new Map();
  if (save?.meta.aetherChunks) {
    for (const [k, v] of save.meta.aetherChunks) modifiedAether.set(k, v);
  }
  interface DimCtx {
    world: World;
    gen: WorldGen;
    cm: ChunkManager;
    modified: Map<string, Uint8Array>;
  }
  const dims: Record<Dimension, DimCtx> = {
    overworld: {
      world: new World(registry),
      gen: worldGenOver,
      modified: modifiedOver,
      cm: null as unknown as ChunkManager,
    },
    nether: {
      world: new World(registry),
      gen: worldGenNether,
      modified: modifiedNether,
      cm: null as unknown as ChunkManager,
    },
    end: {
      world: new World(registry),
      gen: worldGenEnd,
      modified: modifiedEnd,
      cm: null as unknown as ChunkManager,
    },
    aether: {
      world: new World(registry),
      gen: worldGenAether,
      modified: modifiedAether,
      cm: null as unknown as ChunkManager,
    },
  };
  const ALL_DIMS: Dimension[] = ['overworld', 'nether', 'end', 'aether'];
  for (const dim of ALL_DIMS) {
    const d = dims[dim];
    d.cm = new ChunkManager(
      scene,
      d.world,
      d.gen,
      atlas,
      defs,
      (cx, cz) => d.modified.get(chunkKey(cx, cz)) ?? null,
      dim,
    );
  }
  // 当前维度（读档恢复；缺省主世界）
  let dimension: Dimension =
    save?.meta.dimension && ALL_DIMS.includes(save.meta.dimension)
      ? save.meta.dimension
      : 'overworld';
  /** 当前维度上下文（世界/区块管理器/修改集随维度切换） */
  const cur = (): DimCtx => dims[dimension];
  const worldGen = dims.overworld.gen; // 出生点用主世界生成器
  const chunkManager = dims.overworld.cm; // 材质/初始设置用（两池共享底层图集材质）
  const sky = new Sky(scene, renderer);
  const clouds = new Clouds(scene, seed);
  const hand = new Hand(chunkManager.opaqueMat);
  hand.resize(window.innerWidth, window.innerHeight);
  // 恢复存档昼夜（旧存档无此字段 → 保持默认上午）
  if (save && Number.isFinite(save.meta.dayTime))
    sky.setTime(save.meta.dayTime!);
  // 常规雾距由 sky.normalFog() 按当前渲染距离给出（水下切换后用于恢复）
  const underwaterColor = new THREE.Color();
  const particles = new Particles(scene);
  const drops = new DropManager(scene, cur().world, chunkManager.opaqueMat);
  const xpManager = new XpManager(scene, cur().world);
  const arrowManager = new ArrowManager(scene, cur().world);
  // 点燃的 TNT：引信尽以 power=4 大爆炸（MC TNT 威力 4、1.14+ 全掉落）
  const tntManager = new TntManager(scene, cur().world, (x, y, z) =>
    explode(x, y, z, 4, 1),
  );
  // 生物掉落（MC 一致）：猪 1-3 生猪排；僵尸 0-2 腐肉+5 经验；羊 1 羊毛+1-2 生羊肉；
  // 牛 1-3 生牛肉+0-2 皮革；鸡 0-2 羽毛+1 生鸡肉；骷髅 0-2 骨头+0-2 箭；
  // 苦力怕 0-2 火药；被动生物 1-3 经验，敌对生物 5 经验
  const mobManager = new MobManager(
    scene,
    cur().world,
    particles,
    (kind, x, y, z) => {
      const xp = (): number => 1 + Math.floor(Math.random() * 3);
      if (kind === 'sheep') {
        const wool = registry.byName.get('white_wool');
        if (wool) drops.spawnBlock(wool, x, y, z);
        const nm = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < nm; i++) drops.spawnFood(FOODS.mutton, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(xp(), x, y, z);
        return;
      }
      if (kind === 'cow') {
        const nb = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < nb; i++) drops.spawnFood(FOODS.beef, x, y, z);
        const nl = Math.floor(Math.random() * 3);
        for (let i = 0; i < nl; i++) drops.spawnTool(TOOLS.leather, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(xp(), x, y, z);
        return;
      }
      if (kind === 'chicken') {
        const nf = Math.floor(Math.random() * 3);
        for (let i = 0; i < nf; i++) drops.spawnTool(TOOLS.feather, x, y, z);
        drops.spawnFood(FOODS.chicken, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(xp(), x, y, z);
        return;
      }
      if (kind === 'skeleton') {
        const nb = Math.floor(Math.random() * 3);
        for (let i = 0; i < nb; i++) drops.spawnTool(TOOLS.bone, x, y, z);
        const na = Math.floor(Math.random() * 3);
        for (let i = 0; i < na; i++) drops.spawnTool(TOOLS.arrow, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(5, x, y, z);
        return;
      }
      if (kind === 'creeper') {
        const ng = Math.floor(Math.random() * 3);
        for (let i = 0; i < ng; i++) drops.spawnTool(TOOLS.gunpowder, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(5, x, y, z);
        return;
      }
      if (kind === 'spider') {
        // 蜘蛛掉 0~2 线（MC）+ 5 经验
        const ns = Math.floor(Math.random() * 3);
        for (let i = 0; i < ns; i++) drops.spawnTool(TOOLS.string, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(5, x, y, z);
        return;
      }
      if (kind === 'enderman') {
        // 末影人掉 0~1 末影珍珠（MC）+ 5 经验
        if (Math.random() < 0.5) drops.spawnTool(TOOLS.ender_pearl, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(5, x, y, z);
        return;
      }
      if (kind === 'zombie_piglin') {
        // 僵尸猪灵掉 0~1 腐肉 + 0~1 金粒（权宜用金锭）+ 5 经验（MC）
        const nr = Math.floor(Math.random() * 2);
        for (let i = 0; i < nr; i++)
          drops.spawnFood(FOODS.rotten_flesh, x, y, z);
        if (Math.random() < 0.5) drops.spawnTool(TOOLS.gold_ingot, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(5, x, y, z);
        return;
      }
      if (kind === 'ghast') {
        // 恶魂掉 0~2 火药 + 0~1 恶魂之泪（权宜用金锭代替）+ 5 经验（MC）
        const ng = Math.floor(Math.random() * 3);
        for (let i = 0; i < ng; i++) drops.spawnTool(TOOLS.gunpowder, x, y, z);
        if (gameMode === 'survival') xpManager.spawn(5, x, y, z);
        return;
      }
      if (kind === 'villager') {
        // 村民死亡不掉落（MC 一致），仅 1~3 经验
        if (gameMode === 'survival') xpManager.spawn(xp(), x, y, z);
        return;
      }
      const n =
        kind === 'pig'
          ? 1 + Math.floor(Math.random() * 3)
          : Math.floor(Math.random() * 3);
      const food = kind === 'pig' ? FOODS.porkchop : FOODS.rotten_flesh;
      for (let i = 0; i < n; i++) drops.spawnFood(food, x, y, z);
      if (gameMode === 'survival')
        xpManager.spawn(kind === 'pig' ? xp() : 5, x, y, z);
    },
    // 鸡下蛋：鸡蛋材料掉在鸡脚下
    (x, y, z) => drops.spawnTool(TOOLS.egg, x, y, z),
  );
  // 调试钩子：控制台 __spawnMob('pig'|'zombie'|'skeleton'|'creeper'|...) 在玩家面前生成生物
  (window as unknown as { __spawnMob: (k: MobKind) => void }).__spawnMob = (
    k,
  ) => {
    mobManager.spawn(k, body.x + 3, body.y + 1, body.z + 3);
  };

  // ---- 玩家（有存档则恢复位置/视角/飞行；坐标属当前维度） ----
  const body = new PlayerBody(cur().world);
  // 末影龙：进入末地时生成，离开/死亡时清理（需在 body/scene 就绪后声明，供下方读档生成）
  let dragon: EnderDragon | null = null;
  let dragonDefeated = save?.meta.dragonDefeated ?? false;
  const idDragonEgg = registry.byName.get('dragon_egg')?.id ?? -1;
  const idEndCrystalBlock = registry.byName.get('end_crystal')?.id ?? -1;
  // 读档落在非主世界时同步刷怪池与氛围（首次进入不触发传送）
  if (dimension !== 'overworld') {
    mobManager.setWorld(cur().world, dimension === 'nether', null, dimension);
    sky.setAtmosphere(dimension);
    clouds.setVisible(dimension === 'aether');
  } else {
    mobManager.setWorld(cur().world, false, worldGenOver, 'overworld');
  }
  // 读档落在末地且龙未击败：直接生成龙
  if (dimension === 'end' && !dragonDefeated) {
    dragon = new EnderDragon(scene);
  }
  if (save) {
    body.x = save.meta.player.x;
    body.y = save.meta.player.y;
    body.z = save.meta.player.z;
    body.flying = save.meta.player.flying;
  } else {
    body.x = 8.5;
    body.z = 8.5;
    body.y = Math.max(worldGen.heightAt(8, 8), SEA_LEVEL) + 2;
  }

  // ---- 游戏模式与生命体征（生存：心/饥饿/摔落/死亡；创造：无敌可飞） ----
  const gameMode: GameMode = save?.meta.mode ?? mode;
  const spawnPos = {
    x: 8.5,
    y: Math.max(worldGen.heightAt(8, 8), SEA_LEVEL) + 2,
    z: 8.5,
  };
  // 重生点：默认世界出生点，睡过床后更新为床位置（MC）
  let spawnPoint = { ...spawnPos };
  {
    const sp = save?.meta.spawnPoint;
    if (
      sp &&
      Number.isFinite(sp.x) &&
      Number.isFinite(sp.y) &&
      Number.isFinite(sp.z)
    )
      spawnPoint = { x: sp.x, y: sp.y, z: sp.z };
  }
  let hp = 20;
  let hunger = 20;
  if (gameMode === 'survival') {
    body.flying = false; // 生存禁止飞行（含读档残留的飞行状态）
    const shp = save?.meta.player.hp;
    const shu = save?.meta.player.hunger;
    if (Number.isFinite(shp)) hp = Math.max(1, Math.min(20, shp!));
    if (Number.isFinite(shu)) hunger = Math.max(0, Math.min(20, shu!));
  }
  let dead = false;
  let hurtInvuln = 0;
  let fallDist = 0;
  let exhaustion = 0;
  let regenTimer = 0;
  let starveTimer = 0;
  let xp = 0;
  let xpLevel = 0;
  if (gameMode === 'survival' && save) {
    const sx = save.meta.player.xp;
    const sl = save.meta.player.level;
    if (Number.isFinite(sx)) xp = Math.max(0, sx!);
    if (Number.isFinite(sl)) xpLevel = Math.max(0, sl!);
  }

  // 诊断钩子（控制台调试用）；__mc 在 controls 创建后才赋值（TDZ）
  // 调试验证钩子：强制昼夜（0..1 为一天内时刻）/ 传送
  (window as unknown as { __setTime: (f: number) => void }).__setTime = (f) =>
    sky.setTime(f * DAY_LENGTH);
  (
    window as unknown as { __tp: (x: number, y: number, z: number) => void }
  ).__tp = (x, y, z) => {
    body.x = x;
    body.y = y;
    body.z = z;
    body.vx = 0;
    body.vy = 0;
    body.vz = 0;
  };
  (
    window as unknown as { __look: (yaw: number, pitch: number) => void }
  ).__look = (yaw, pitch) => {
    controls.yaw = yaw;
    controls.pitch = pitch;
  };
  // 性能基准：同步连跑 n 帧返回 FPS（用于被系统遮挡导致 rAF 冻结的环境）
  (window as unknown as { __bench: (n: number) => number }).__bench = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) frame();
    return Math.round(n / ((performance.now() - t0) / 1000));
  };

  // ---- UI / 音效 ----
  const hud = new Hud();
  const debugPanel = new DebugPanel();
  const sfx = new Sfx();
  // 槽位 → 手持物 + 名称（方块模型 / 食物平面 / 空手）
  const syncHand = (slot: HotSlot): void => {
    if (slot.block) {
      hand.setBlock(slot.block.def);
      hud.showItemName(slot.block.def.display);
    } else if (slot.food) {
      hand.setFood(slot.food.def.texture);
      hud.showItemName(slot.food.def.name);
    } else if (slot.tool) {
      hand.setFood(slot.tool.def.texture); // 工具同为平面斜持
      hud.showItemName(slot.tool.def.name);
    } else {
      hand.setEmpty();
    }
  };
  // 生存模式快捷栏从空开始、方块计数消耗；创造模式 9 方块无限
  const hotbar = new Hotbar(
    gameMode === 'creative' ? registry.hotbar : new Array(9).fill(null),
    atlas.canvas,
    syncHand,
    gameMode === 'survival',
  );
  // 生存读档：恢复快捷栏内容
  if (gameMode === 'survival' && save?.meta.hotbar) {
    hotbar.restore(
      save.meta.hotbar,
      (id) => registry.def(id),
      (fid) => FOODS[fid as keyof typeof FOODS] ?? null,
      (tid) => TOOLS[tid] ?? null,
    );
  }
  syncHand(hotbar.current);

  // ---- 生存背包（E 开关）：27 主栏 + 2×2 合成，光标拿放 ----
  // 主栏数组与合成台/熔炉共享，三个界面数据实时一致
  const invMain: HotSlot[] = Array.from({ length: 27 }, emptyHotSlot);

  // ---- 盔甲栏：4 格（头盔/胸甲/护腿/靴子），存 ToolStack（ArmorDef） ----
  const armorSlots: (ToolStack | null)[] = [null, null, null, null];
  /** 当前总护甲点 + 总保护附魔等级 → 减伤比例 */
  const armorStats = (): { reduction: number; points: number } => {
    let pts = 0;
    let prot = 0;
    for (const s of armorSlots) {
      if (!s) continue;
      const ad = armorById(s.def.id);
      if (ad) pts += ad.armor;
      if (s.ench?.protection) prot += s.ench.protection;
    }
    const reduction = Math.min(
      0.8,
      armorReduction(pts) + protectionBonus(prot),
    );
    return { reduction, points: pts };
  };
  /** 受伤时随机损耗一件已穿盔甲 1 点耐久（含耐久附魔减免） */
  const damageArmor = (): void => {
    const worn = armorSlots
      .map((s, i) => ({ s, i }))
      .filter((x): x is { s: ToolStack; i: number } => x.s !== null);
    if (worn.length === 0) return;
    const pick = worn[Math.floor(Math.random() * worn.length)];
    const keep = unbreakingKeep(pick.s.ench?.unbreaking ?? 0);
    if (Math.random() < keep) return;
    const dur = (pick.s.dur ?? pick.s.def.maxDurability) - 1;
    if (dur <= 0) armorSlots[pick.i] = null;
    else armorSlots[pick.i] = { ...pick.s, dur };
  };
  /** 把槽位内容掉落在指定位置（背包退不下/熔炉破坏散出共用） */
  const dropSlotAt = (slot: HotSlot, x: number, y: number, z: number): void => {
    if (slot.block) drops.spawnBlock(slot.block.def, x, y, z, slot.block.count);
    else if (slot.food)
      drops.spawnFood(slot.food.def, x, y, z, slot.food.count);
    else if (slot.tool)
      drops.spawnTool(slot.tool.def, x, y, z, slot.tool.count, slot.tool.dur);
  };
  const invCallbacks = {
    onClose: () => controls.lock(),
    onDropSlot: (slot: HotSlot) =>
      dropSlotAt(slot, body.x, body.y + 0.5, body.z),
  };
  const survivalInv = new SurvivalInventory(
    registry,
    atlas.canvas,
    hotbar,
    invCallbacks,
    invMain,
    armorSlots,
  );
  // ---- 合成台 3×3（右键工作台方块打开，共享主栏/快捷栏） ----
  const craftingTable = new CraftingTable(
    registry,
    atlas.canvas,
    hotbar,
    invMain,
    invCallbacks,
  );
  // ---- 熔炉：位置 → 状态；右键打开 UI，后台持续烧炼 ----
  const furnaces = new Map<string, FurnaceState>();
  const farmlandId = registry.id('farmland');
  const getFurnace = (x: number, y: number, z: number): FurnaceState => {
    const key = `${x},${y},${z}`;
    let st = furnaces.get(key);
    if (!st) {
      st = newFurnace(x, y, z);
      furnaces.set(key, st);
    }
    return st;
  };
  /** 烧炼产物 → 物品槽位 */
  const resolveSmeltOut = (out: SmeltOut): HotSlot | null => {
    if (out.kind === 'block') {
      const def = registry.byName.get(out.id);
      return def ? { block: { def, count: 1 }, food: null, tool: null } : null;
    }
    if (out.kind === 'food') {
      const fd = FOODS[out.id as keyof typeof FOODS];
      return fd
        ? { block: null, food: { def: fd, count: 1 }, tool: null }
        : null;
    }
    const td = TOOLS[out.id];
    return td ? { block: null, food: null, tool: { def: td, count: 1 } } : null;
  };
  const furnaceUI = new FurnaceUI(atlas.canvas, hotbar, invMain, invCallbacks);

  // ---- 全屏地图（M 键）：按区块记录已探索区域，随存档持久化 ----
  const worldMap = new WorldMap(registry, atlas, save?.meta.maps);
  // 区块落地（生成/读档）即排队采样进地图；采样在每帧限量消化,避免加载高峰集中
  // 扫描全部区块（217 区块 × ~4000 getBlock）一次性打断主线程 → 加载界面卡死。
  for (const dim of ALL_DIMS) {
    const d = dims[dim];
    d.cm.onChunkExplored = (cx, cz) =>
      worldMap.enqueueChunk(d.world, cx, cz, dim);
    // 区块卸载时清理其中的"空烧完且无物品"熔炉状态,防 furnaces Map 随探索无限增长
    // (有物品或仍在烧的保留,玩家回来时不丢进度)。卸载区块本就不该再被每帧 tick。
    d.cm.onChunkUnloaded = (cx, cz) => {
      const bx = cx * 16;
      const bz = cz * 16;
      for (const [key, st] of [...furnaces]) {
        if (
          st.x >= bx && st.x < bx + 16 &&
          st.z >= bz && st.z < bz + 16 &&
          !st.input.block && !st.input.food && !st.input.tool &&
          !st.fuel.block && !st.fuel.food && !st.fuel.tool &&
          !st.output.block && !st.output.food && !st.output.tool
        ) {
          furnaces.delete(key);
        }
      }
    };
    // 加载阶段挂起邻区重网格化：区块落地不再触发四邻反复重建，
    // 待世界稳定（加载完成）后统一按最新版本重排，每区块只网格化一次。
    d.cm.setDeferNeighbors(true);
  }

  // ---- 附魔台：右键打开 UI，消耗经验+青金石给装备附魔 ----
  const enchantUI = new EnchantUI(atlas.canvas, hotbar, invMain, {
    ...invCallbacks,
    getXpLevel: () => xpLevel,
    spendXp: (levels) => {
      spendXpLevels(levels);
    },
    onEnchanted: () => {
      sfx.playXp();
    },
  });

  // ---- 村民交易：右键村民打开 UI，材料换产物（共享主栏/快捷栏） ----
  const tradingUI = new TradingUI(registry, atlas.canvas, hotbar, invMain, {
    ...invCallbacks,
    onTrade: () => {
      sfx.playPickup();
    },
  });
  // 读档：恢复熔炉状态
  if (save?.meta.furnaces) {
    for (const sf of save.meta.furnaces) {
      const st = newFurnace(sf.p[0], sf.p[1], sf.p[2]);
      st.input = resolveSlot(
        sf.i,
        (id) => registry.def(id),
        (fid) => FOODS[fid as keyof typeof FOODS] ?? null,
        (tid) => TOOLS[tid] ?? null,
      );
      st.fuel = resolveSlot(
        sf.f,
        (id) => registry.def(id),
        (fid) => FOODS[fid as keyof typeof FOODS] ?? null,
        (tid) => TOOLS[tid] ?? null,
      );
      st.output = resolveSlot(
        sf.o,
        (id) => registry.def(id),
        (fid) => FOODS[fid as keyof typeof FOODS] ?? null,
        (tid) => TOOLS[tid] ?? null,
      );
      st.burn = sf.burn;
      st.burnMax = sf.burnMax || 1;
      st.cook = sf.cook;
      furnaces.set(`${st.x},${st.y},${st.z}`, st);
    }
  }
  // 生存读档：恢复背包主栏
  if (gameMode === 'survival' && save?.meta.inv)
    survivalInv.restoreMain(save.meta.inv);
  // 生存读档：恢复盔甲栏
  if (gameMode === 'survival' && save?.meta.armor)
    survivalInv.restoreArmor(save.meta.armor);

  // ---- 创造模式物品栏（E 开关，点击放入当前槽位） ----
  const inventory = new Inventory(
    registry.byId.filter((d): d is BlockDef => d !== null && d.selectable),
    atlas.canvas,
    {
      onPick: (def) => {
        hotbar.assign(hotbar.selected, def);
        controls.lock();
      },
      onClose: () => controls.lock(),
    },
  );

  // ---- 目标方块高亮 + 裂纹 ----
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.85,
    }),
  );
  highlight.visible = false;
  scene.add(highlight);

  const crackMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.004, 1.004, 1.004),
    new THREE.MeshBasicMaterial({
      map: atlas.crackTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  crackMesh.visible = false;
  scene.add(crackMesh);

  // ---- 交互状态 ----
  let state: GameState = 'loading';
  // 加载是否仍处于“挂起邻区网格化”的第一阶段（地形生成）
  let deferringLoad = true;
  let attackHeld = false;
  let useHeld = false;
  let useCooldown = 0;
  let breakKey = '';
  let breakProgress = 0;
  let currentHit: RayHit | null = null;
  let stepDist = 0;
  let sprinting = false;
  let underwater = false;
  let portalTimer = 0; // 站立于传送门内的累计秒数（≥1.2 触发跨维度）
  let eatTimer = 0;
  let nextCrunch = 0.4;
  let growTimer = 0; // 作物随机 tick 节流
  let furnaceTickAcc = 0; // 远处熔炉低频 tick 节流
  let bowCharge = 0; // 弓蓄力进度（秒，>0 表示正在拉弓）
  let stareTimer = 0; // 末影人注视计时（>0.25s 激怒）

  const controls = new Controls(renderer.domElement, {
    onToggleFly: () => {
      if (gameMode === 'survival') return; // 生存无飞行
      body.flying = !body.flying;
      if (body.flying) body.vy = 0;
    },
    onHotbar: (i) => hotbar.select(i),
    onDebugToggle: () => debugPanel.toggle(),
    onAttack: (down) => {
      attackHeld = down;
      if (!down) {
        breakProgress = 0;
        breakKey = '';
      }
    },
    onUse: (down) => {
      useHeld = down;
      if (down) useCooldown = 0;
    },
    onSneak: (v) => {
      body.sneaking = v;
    },
    onSprint: () => {
      // 生存：饥饿值 ≤6 无法冲刺（MC 一致）
      if (!body.flying && (gameMode !== 'survival' || hunger > 6))
        sprinting = true;
    },
    onInventory: () => {
      // 创造开 give-me 物品栏；生存开背包+2×2 合成界面
      if (state !== 'playing' || !controls.locked) return;
      if (gameMode === 'creative') {
        if (!inventory.isOpen) inventory.open();
      } else if (
        !survivalInv.isOpen &&
        !craftingTable.isOpen &&
        !furnaceUI.isOpen &&
        !tradingUI.isOpen
      ) {
        survivalInv.open();
      }
    },
    onMap: () => {
      if (state !== 'playing') return;
      if (worldMap.isOpen) {
        worldMap.close();
        controls.lock(); // 关地图后回到指针锁定
      } else {
        // 开地图：释放鼠标便于拖拽，仅当其它界面都关闭时
        if (
          inventory.isOpen ||
          survivalInv.isOpen ||
          craftingTable.isOpen ||
          furnaceUI.isOpen ||
          tradingUI.isOpen
        )
          return;
        worldMap.show(dimension, body.x, body.z);
        document.exitPointerLock();
      }
    },
  });
  if (save) {
    controls.yaw = save.meta.player.yaw;
    controls.pitch = save.meta.player.pitch;
  }
  controls.onWheel = (dir) => hotbar.scroll(dir);
  controls.onLockChange = (locked) => {
    // 物品栏打开或死亡界面或地图打开时不弹暂停菜单（都是解锁状态）
    hud.setPauseHint(
      state === 'playing' &&
        !locked &&
        !inventory.isOpen &&
        !survivalInv.isOpen &&
        !craftingTable.isOpen &&
        !furnaceUI.isOpen &&
        !tradingUI.isOpen &&
        !worldMap.isOpen &&
        !dead,
    );
  };

  // ---- 视频设置：渲染距离滑块（localStorage 持久化，即时生效） ----
  const rdSlider = document.getElementById('rd-slider') as HTMLInputElement;
  const rdValue = document.getElementById('rd-value')!;
  const savedRd = Number(localStorage.getItem('mc-render-dist'));
  const initRd =
    Number.isFinite(savedRd) && savedRd >= 4 && savedRd <= 16
      ? savedRd
      : RENDER_DIST;
  for (const dim of ALL_DIMS)
    dims[dim].cm.setRenderDist(initRd);
  sky.setRenderDist(initRd);
  rdSlider.value = String(initRd);
  rdValue.textContent = String(initRd);
  rdSlider.oninput = () => {
    const v = Number(rdSlider.value);
    rdValue.textContent = String(v);
    for (const dim of ALL_DIMS)
      dims[dim].cm.setRenderDist(v);
    sky.setRenderDist(v);
    localStorage.setItem('mc-render-dist', String(v));
  };
  document.getElementById('resume-btn')!.onclick = () => controls.lock();

  // ---- 经验：MC 升级曲线（≤15 级 2L+7，≤30 级 5L-38，之后 9L-158） ----
  const xpToNext = (l: number): number =>
    l < 16 ? 2 * l + 7 : l < 31 ? 5 * l - 38 : 9 * l - 158;
  const addXp = (v: number): void => {
    xp += v;
    while (xp >= xpToNext(xpLevel)) {
      xp -= xpToNext(xpLevel);
      xpLevel++;
    }
    hud.setXp(xpLevel, xp / xpToNext(xpLevel), gameMode === 'survival');
  };
  hud.setXp(xpLevel, xp / xpToNext(xpLevel), gameMode === 'survival');

  /** 附魔消耗整级经验：先扣当前进度，不足则降级并补满上一级进度 */
  const spendXpLevels = (levels: number): void => {
    for (let i = 0; i < levels; i++) {
      if (xpLevel <= 0) break;
      xpLevel--;
      xp = 0; // MC：附魔按整级扣，清掉当前级进度
    }
    hud.setXp(xpLevel, xp / xpToNext(xpLevel), gameMode === 'survival');
  };

  // ---- 维度切换（主世界 ⇄ 下界，MC 传送门 1:8 坐标） ----
  /**
   * 换绑当前维度：玩家/流体/重力/红石/生物/掉落/经验/箭/TNT 全部切到目标世界，
   * 清空旧维度活跃实体（不跨维度），切换雾/云氛围，并按 1:8 换算玩家坐标。
   */
  const switchDimension = (
    target: Dimension,
    destX: number,
    destY: number,
    destZ: number,
  ): void => {
    if (target === dimension) return;
    dimension = target;
    const w = cur().world;
    body.setWorld(w);
    fluid.setWorld(w);
    gravity.setWorld(w);
    redstone.setWorld(w);
    mobManager.setWorld(
      w,
      target === 'nether',
      target === 'overworld' ? worldGenOver : null,
      target,
    );
    drops.setWorld(w);
    xpManager.setWorld(w);
    arrowManager.setWorld(w);
    tntManager.setWorld(w);
    // 末影龙：进入末地且未被击败则在场（离开末地销毁，回到主世界不保留）
    if (target === 'end' && !dragonDefeated && !dragon) {
      dragon = new EnderDragon(scene);
    } else if (target !== 'end' && dragon) {
      dragon.dispose();
      dragon = null;
    }
    // 氛围：各维度独立天空/雾/云。下界/末地洞窟短视距；主世界/天堂正常远雾。
    sky.setAtmosphere(target);
    clouds.setVisible(target === 'overworld' || target === 'aether');
    const fog = scene.fog as THREE.Fog;
    if (target === 'nether') {
      fog.near = 6;
      fog.far = 64; // 洞窟内短视距
    } else if (target === 'end') {
      fog.near = 12;
      fog.far = 96; // 末地虚空中视距
    } else {
      const nf = sky.normalFog();
      fog.near = nf.near;
      fog.far = nf.far;
    }
    // 重定位（坐标已换算到目标维度）
    body.x = destX;
    body.y = destY;
    body.z = destZ;
    body.vx = 0;
    body.vy = 0;
    body.vz = 0;
    fallDist = 0;
    // 强制新区块流式加载（ensure 以玩家为中心）
    cur().cm.update(destX, destZ, 24, false);
  };

  /** 黑曜石传送门点火：右键门框内侧空气时，把整框内部填为 portal 方块（MC） */
  const idPortalBlock = registry.byName.get('nether_portal')?.id ?? -1;
  const idObsidian = registry.byName.get('obsidian')?.id ?? -1;
  // 其它维度传送门方块
  const idEndPortal = registry.byName.get('end_portal')?.id ?? -1;
  const idAetherPortal = registry.byName.get('aether_portal')?.id ?? -1;
  const idEndFrameEye = registry.byName.get('end_portal_frame_eye')?.id ?? -1;

  /** 玩家脚下/头所在格命中的传送门方块类型 → 目标维度；无则 null */
  const portalAt = (): Dimension | null => {
    const w = cur().world;
    const fx = Math.floor(body.x);
    const fz = Math.floor(body.z);
    for (const yy of [Math.floor(body.y), Math.floor(body.y + 1)]) {
      const id = w.getBlock(fx, yy, fz);
      // 末地门：主世界/其它维度 → 末地；末地内 → 回主世界（龙后返回门）
      if (id === idEndPortal && idEndPortal >= 0)
        return dimension === 'end' ? 'overworld' : 'end';
      // 天堂门：主世界 → 天堂；天堂内 → 回主世界
      if (id === idAetherPortal && idAetherPortal >= 0)
        return dimension === 'aether' ? 'overworld' : 'aether';
      // 下界门：主世界 ⇄ 下界
      if (id === idPortalBlock && idPortalBlock >= 0)
        return dimension === 'nether' ? 'overworld' : 'nether';
    }
    return null;
  };

  /**
   * 在以 (x,y,z) 为内侧空气的竖直黑曜石框内填充传送门方块。
   * 框沿水平轴 (ax,0,az) 延伸：先找该轴两端的黑曜石边界，内部逐格填 portal。
   * 返回是否成功（找到合法框）。
   */
  const ignitePortal = (x: number, y: number, z: number): boolean => {
    if (idPortalBlock < 0 || idObsidian < 0) return false;
    const w = cur().world;
    // 试两个水平轴
    for (const [ax, az] of [
      [1, 0],
      [0, 1],
    ] as const) {
      // 沿 +轴与 -轴找黑曜石边界（框内壁）
      let lo = 0;
      let hi = 0;
      for (let i = 1; i <= 3; i++) {
        if (w.getBlock(x + ax * i, y, z + az * i) === idObsidian) {
          hi = i;
          break;
        }
      }
      for (let i = 1; i <= 3; i++) {
        if (w.getBlock(x - ax * i, y, z - az * i) === idObsidian) {
          lo = i;
          break;
        }
      }
      if (hi === 0 || lo === 0) continue;
      // 底边界：从 y 向下找黑曜石
      let yb = -1;
      for (let i = 1; i <= 4; i++) {
        if (w.getBlock(x, y - i, z) === idObsidian) {
          yb = y - i;
          break;
        }
      }
      if (yb < 0) continue;
      // 顶边界：从 y 向上找黑曜石
      let yt = -1;
      for (let i = 1; i <= 4; i++) {
        if (w.getBlock(x, y + i, z) === idObsidian) {
          yt = y + i;
          break;
        }
      }
      if (yt < 0) continue;
      // 填充内部（不含边框）
      let filled = 0;
      for (let ix = -lo + 1; ix <= hi - 1; ix++) {
        for (let iy = yb + 1; iy <= yt - 1; iy++) {
          const px = x + ax * ix;
          const pz = z + az * ix;
          const cur2 = w.getBlock(px, iy, pz);
          if (cur2 === AIR || cur2 === idPortalBlock) {
            applyEdit(px, iy, pz, idPortalBlock);
            filled++;
          }
        }
      }
      if (filled > 0) {
        sfx.playFuse(); // 点火声近似（MC 为 portal 触发声）
        return true;
      }
    }
    return false;
  };

  /**
   * 触发跨维度传送：target 由 portalAt 判定。
   * 下界按 1:8 换算水平坐标；末地/天堂按 1:1；目标维度就近找可站立处，
   * 若目标点附近无传送门则在落脚处自动建一座（MC 行为）。
   */
  const travelThroughPortal = (target: Dimension): void => {
    // 主世界→下界 ÷8；下界→主世界 ×8；其余维度 1:1
    let nx = body.x;
    let nz = body.z;
    if (target === 'nether') {
      nx = body.x / NETHER_SCALE;
      nz = body.z / NETHER_SCALE;
    } else if (dimension === 'nether' && target === 'overworld') {
      nx = body.x * NETHER_SCALE;
      nz = body.z * NETHER_SCALE;
    }
    const tw = dims[target].world;
    const tx = Math.floor(nx);
    const tz = Math.floor(nz);
    // 各维度起始搜索高度
    const startY =
      target === 'nether' ? 70 : target === 'end' ? 80 : target === 'aether' ? 100 : 90;
    // 先确保目标区块已生成（同步查 findSpawnY 前需有方块）
    dims[target].cm.update(nx, nz, 24, false);
    // 向下找第一个"脚+头为空气/可站立"且下方实心处
    let found = -1;
    const minY = target === 'nether' ? 12 : target === 'end' ? 40 : 2;
    for (let y = Math.min(startY, 118); y > minY; y--) {
      const below = tw.getBlock(tx, y - 1, tz);
      const feet = tw.getBlock(tx, y, tz);
      const head = tw.getBlock(tx, y + 1, tz);
      const solidBelow = below > 0 && registry.isSolid(below);
      const freeFeet = feet === AIR || feet === idPortalBlock;
      const freeHead = head === AIR || head === idPortalBlock;
      if (solidBelow && freeFeet && freeHead) {
        found = y;
        break;
      }
    }
    if (found < 0) {
      // 兜底：末地/天堂落在主岛/浮岛基准高度，主世界用地表，下界用 70
      found =
        target === 'nether'
          ? 70
          : target === 'end'
            ? 66
            : target === 'aether'
              ? 78
              : tw.findSpawnY(tx, tz);
    }
    // 切换维度并落脚
    switchDimension(target, tx + 0.5, found, tz + 0.5);
    // 若目标点附近无传送门方块，建一座迷你门 + 底座，便于回程（MC 生成对侧门）
    ensureReturnPortal(tx, found, tz, target);
  };

  /** 在目标维度 (x,y,z) 附近建一座返程传送门并点亮内部（若附近无现成门） */
  const ensureReturnPortal = (
    x: number,
    y: number,
    z: number,
    target: Dimension,
  ): void => {
    // 返程门方块与框材：末地→末地门+末地石框；天堂→天堂门+荧石框；其余→黑曜石下界门
    let frameId = idObsidian;
    let portalId = idPortalBlock;
    if (target === 'end') {
      frameId = registry.byName.get('end_stone')?.id ?? idObsidian;
      portalId = idEndPortal;
    } else if (target === 'aether') {
      frameId = registry.byName.get('glowstone')?.id ?? idObsidian;
      portalId = idAetherPortal;
    }
    if (portalId < 0 || frameId < 0) return;
    const w = cur().world;
    // 附近 8 格已有 portal 则不建
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -8; dx <= 8; dx++)
        for (let dz = -8; dz <= 8; dz++)
          if (w.getBlock(x + dx, y + dy, z + dz) === portalId) return;
    // 建门：沿 X 轴 4 宽 5 高（底 y，内空 2×3）
    const bx = x - 1;
    const by = y;
    const bz = z;
    for (let ix = 0; ix < 4; ix++) {
      for (let iy = 0; iy < 5; iy++) {
        const isFrame = ix === 0 || ix === 3 || iy === 0 || iy === 4;
        const px = bx + ix;
        const py = by + iy;
        if (isFrame) applyEdit(px, py, bz, frameId);
        else applyEdit(px, py, bz, portalId);
      }
    }
  };

  /**
   * 末影龙死亡后在陨落地建一座"返回主世界"的基岩台 + 末地门。
   * 台中央放返回传送门（玩家站入即回主世界重生点附近）。
   */
  const buildExitPortal = (x: number, y: number, z: number): void => {
    const idBedrock = registry.byName.get('bedrock')?.id ?? -1;
    if (idEndPortal < 0 || idBedrock < 0) return;
    // 基岩平台 5×5
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        applyEdit(x + dx, y, z + dz, idBedrock);
      }
    }
    // 中央 1 格返回门（上方留空供站立）
    applyEdit(x, y + 1, z, idEndPortal);
    // 四角基岩柱（MC 返回门火炬柱简化）
    for (const [ox, oz] of [
      [-2, -2],
      [2, -2],
      [-2, 2],
      [2, 2],
    ] as const) {
      applyEdit(x + ox, y + 1, z + oz, idBedrock);
      applyEdit(x + ox, y + 2, z + oz, idBedrock);
    }
  };

  // ---- 生存：受伤 / 死亡 / 重生 ----
  const deathScreen = document.getElementById('death-screen')!;
  const hurtPlayer = (dmg: number, kbx = 0, kbz = 0): void => {
    if (gameMode !== 'survival' || dead || hurtInvuln > 0) return;
    hurtInvuln = 0.5;
    // 护甲减伤（MC：护甲点 + 保护附魔，上限 80%），并损耗盔甲耐久
    const { reduction } = armorStats();
    const final = Math.max(1, Math.round(dmg * (1 - reduction)));
    if (reduction > 0) damageArmor();
    hp = Math.max(0, hp - final);
    hud.hurtFlash();
    sfx.playHurt();
    if (kbx !== 0 || kbz !== 0) {
      const len = Math.hypot(kbx, kbz) || 1;
      body.vx = (kbx / len) * 6;
      body.vz = (kbz / len) * 6;
      if (body.onGround) body.vy = 3.6;
    }
    if (hp <= 0) {
      // 死亡掉落：快捷栏全部物品原地散出 + 经验球（MC 跑尸回收）
      const spill = hotbar.serialize();
      for (const s of spill) {
        if (!s) continue;
        if ('b' in s) {
          const def = registry.def(s.b);
          if (def) drops.spawnBlock(def, body.x, body.y + 0.5, body.z, s.n);
        } else if ('f' in s) {
          const fd = FOODS[s.f as keyof typeof FOODS];
          if (fd) drops.spawnFood(fd, body.x, body.y + 0.5, body.z, s.n);
        } else {
          const td = TOOLS[s.t];
          if (td) drops.spawnTool(td, body.x, body.y + 0.5, body.z, s.n, s.d);
        }
      }
      hotbar.clearAll();
      // 背包主栏同样散出（MC 死亡全身掉落）
      const spillMain = survivalInv.serializeMain();
      for (const s of spillMain) {
        if (!s) continue;
        if ('b' in s) {
          const def = registry.def(s.b);
          if (def) drops.spawnBlock(def, body.x, body.y + 0.5, body.z, s.n);
        } else if ('f' in s) {
          const fd = FOODS[s.f as keyof typeof FOODS];
          if (fd) drops.spawnFood(fd, body.x, body.y + 0.5, body.z, s.n);
        } else {
          const td = TOOLS[s.t];
          if (td) drops.spawnTool(td, body.x, body.y + 0.5, body.z, s.n, s.d);
        }
      }
      survivalInv.restoreMain([]);
      xpManager.spawn(
        Math.min(100, xpLevel * 7 + xp),
        body.x,
        body.y + 0.5,
        body.z,
      );
      xp = 0;
      xpLevel = 0;
      hud.setXp(0, 0, true);
      dead = true;
      attackHeld = false;
      useHeld = false;
      document.exitPointerLock();
      deathScreen.classList.remove('hidden');
    }
  };
  document.getElementById('respawn-btn')!.onclick = () => {
    // 重生：满状态回出生点（MC 死亡不掉落简化：本版无物品掉落）
    hp = 20;
    hunger = 20;
    fallDist = 0;
    exhaustion = 0;
    regenTimer = 0;
    starveTimer = 0;
    hurtInvuln = 0;
    body.x = spawnPoint.x;
    body.y = spawnPoint.y;
    body.z = spawnPoint.z;
    body.vx = 0;
    body.vy = 0;
    body.vz = 0;
    body.flying = false;
    dead = false;
    deathScreen.classList.add('hidden');
    controls.lock();
  };

  // ---- 平滑光照（AO）开关：通知 Worker 并重网格化，localStorage 持久化 ----
  const aoCheck = document.getElementById('ao-check') as HTMLInputElement;
  const savedAo = localStorage.getItem('mc-smooth-lighting');
  const initAo = savedAo === null ? true : savedAo === '1';
  aoCheck.checked = initAo;
  for (const dim of ALL_DIMS)
    dims[dim].cm.setSmoothLighting(initAo);
  aoCheck.onchange = () => {
    for (const dim of ALL_DIMS)
      dims[dim].cm.setSmoothLighting(aoCheck.checked);
    localStorage.setItem('mc-smooth-lighting', aoCheck.checked ? '1' : '0');
  };

  // ---- 视野角度（FOV）滑块，localStorage 持久化 ----
  const fovSlider = document.getElementById('fov-slider') as HTMLInputElement;
  const fovValue = document.getElementById('fov-value')!;
  const savedFov = Number(localStorage.getItem('mc-fov'));
  if (Number.isFinite(savedFov) && savedFov >= 30 && savedFov <= 110)
    baseFov = savedFov;
  camera.fov = baseFov;
  camera.updateProjectionMatrix();
  fovSlider.value = String(baseFov);
  fovValue.textContent = String(baseFov);
  fovSlider.oninput = () => {
    baseFov = Number(fovSlider.value);
    fovValue.textContent = String(baseFov);
    localStorage.setItem('mc-fov', String(baseFov));
  };
  renderer.domElement.addEventListener('click', () => {
    if (state === 'playing' && !controls.locked) controls.lock();
  });
  // 诊断钩子（控制台调试用）；__world() 返回当前维度世界
  (window as unknown as { __mc: unknown }).__mc = {
    chunkManager,
    dims,
    cur,
    body,
    camera,
    controls,
    sky,
  };

  // ---- 存档 ----
  let saving = false;
  const saveNow = (): void => {
    if (!persistence.available || saving || state === 'loading') return;
    saving = true;
    persistence
      .save(
        {
          version: 1,
          seed,
          seedText: seedLabel,
          player: {
            x: body.x,
            y: body.y,
            z: body.z,
            yaw: controls.yaw,
            pitch: controls.pitch,
            flying: body.flying,
            hp,
            hunger,
            xp,
            level: xpLevel,
          },
          savedAt: Date.now(),
          dayTime: sky.timeValue,
          mode: gameMode,
          hotbar: gameMode === 'survival' ? hotbar.serialize() : undefined,
          inv:
            gameMode === 'survival' ? survivalInv.serializeMain() : undefined,
          armor:
            gameMode === 'survival' ? survivalInv.serializeArmor() : undefined,
          furnaces: [...furnaces.values()].map(serializeFurnace),
          spawnPoint: { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z },
          dimension,
          netherChunks: modifiedNether.size > 0 ? modifiedNether : undefined,
          endChunks: modifiedEnd.size > 0 ? modifiedEnd : undefined,
          aetherChunks: modifiedAether.size > 0 ? modifiedAether : undefined,
          maps: worldMap.serialize(),
          dragonDefeated,
        },
        modifiedOver,
      )
      .catch((e) => console.warn('自动保存失败', e))
      .finally(() => {
        saving = false;
      });
  };
  window.setInterval(saveNow, 30_000); // 每 30s 自动保存
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  window.addEventListener('beforeunload', () => saveNow());

  // ---- 工具函数 ----
  const tmpDir = new THREE.Vector3();

  function tileColorOf(def: BlockDef): [number, number, number] {
    const tile =
      def.faceTiles.up ??
      def.elements[0]?.faces.south?.tile ??
      def.elements[0]?.faces.north?.tile ??
      0;
    return [
      atlas.tileColors[tile * 3],
      atlas.tileColors[tile * 3 + 1],
      atlas.tileColors[tile * 3 + 2],
    ];
  }

  /** 写入方块并同步：网格重建 + 修改集合（存档用）。作用于当前维度世界。 */
  function applyEdit(wx: number, y: number, wz: number, id: number): void {
    const w = cur().world;
    const cm = cur().cm;
    const oldId = w.getBlock(wx, y, wz);
    const edit = w.setBlock(wx, y, wz, id);
    if (!edit) return;
    cm.markEdited(edit.cx, edit.cz, edit.lx, edit.lz);
    // 光照可能跨区块传播（最远 15 格）：涉及光源或邻域有光时按 3×3 重网格化
    const oldLum = oldId > 0 ? (registry.def(oldId)?.luminance ?? 0) : 0;
    const newLum = id > 0 ? (registry.def(id)?.luminance ?? 0) : 0;
    if (oldLum > 0 || newLum > 0 || w.hasLightNear(edit.cx, edit.cz))
      cm.markEditedArea(edit.cx, edit.cz);
    const data = w.chunks.get(chunkKey(edit.cx, edit.cz));
    if (data) cur().modified.set(chunkKey(edit.cx, edit.cz), data);
    // 地图：编辑所在区块重采样（顶面颜色可能改变）
    worldMap.recordChunk(w, edit.cx, edit.cz, dimension);
    // 唤醒流体（水位重算/扩散/消退）与重力方块（上方悬空则开始下落）
    fluid.wake(wx, y, wz);
    gravity.tryStart(wx, y + 1, wz);
    gravity.tryStart(wx, y, wz);
    // 唤醒红石电路（能量重算 / 用电器驱动）
    redstone.wake(wx, y, wz);
  }

  // ---- 水流动 + 重力方块（MC 物理）：与 applyEdit 闭环，方块改动即触发 ----
  const fluid = new FluidSimulator(cur().world, applyEdit);
  const gravity = new FallingBlockManager(
    scene,
    cur().world,
    chunkManager.opaqueMat,
    applyEdit,
    (def, x, y, z) => drops.spawnBlock(def, x, y, z),
  );

  // ---- 红石电路（MC）：电源→红石粉衰减→用电器；方块改动经 applyEdit 唤醒 ----
  const redstone = new RedstoneSimulator(cur().world, {
    setBlock: applyEdit,
    igniteTnt: (x, y, z) => {
      applyEdit(x, y, z, AIR);
      tntManager.ignite(x + 0.5, y + 0.5, z + 0.5);
      sfx.playFuse();
    },
  });

  /**
   * 爆炸（苦力怕 power=3 掉落 30%；TNT power=4 全掉落，MC 1.14+ 规则）：
   *  - 球形破坏，基岩/水（hardness<0）免疫
   *  - 波及的 TNT 方块不掉落，改为 0.5~1.5s 随机短引信连锁点燃（MC 10-30 tick）
   *  - 玩家伤害 = power*5 中心线性衰减至 power*2+1 格；击退方向从爆心指向玩家
   *  - 灰烟粒子 + 爆炸音效；破坏经 applyEdit 自动入存档修改集
   */
  function explode(
    x: number,
    y: number,
    z: number,
    power = 3,
    dropChance = 0.3,
  ): void {
    const R = power;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const cz = Math.floor(z);
    for (let dx = -R; dx <= R; dx++)
      for (let dy = -R; dy <= R; dy++)
        for (let dz = -R; dz <= R; dz++) {
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > R + 0.4) continue; // 圆角球形
          const bx = cx + dx;
          const by = cy + dy;
          const bz = cz + dz;
          const id = cur().world.getBlock(bx, by, bz);
          if (id === AIR) continue;
          const def = registry.def(id);
          if (!def || def.hardness < 0) continue; // 基岩/水免疫
          applyEdit(bx, by, bz, AIR);
          if (def.name === 'tnt') {
            tntManager.ignite(
              bx + 0.5,
              by + 0.5,
              bz + 0.5,
              0.5 + Math.random(),
            );
            continue; // 连锁引爆，不掉落方块实体
          }
          if (Math.random() < dropChance) {
            const drop = dropFor(def);
            if (drop) drops.spawnBlock(drop, bx + 0.5, by + 0.5, bz + 0.5);
          }
        }
    // 玩家伤害与击退（hurtPlayer 内部已判创造无敌）
    const pdx = body.x - x;
    const pdy = body.y + 0.9 - y;
    const pdz = body.z - z;
    const pd = Math.hypot(pdx, pdy, pdz);
    const reach = power * 2 + 1;
    if (pd < reach) {
      const dmg = Math.round(power * 5 * (1 - pd / reach));
      if (dmg > 0) hurtPlayer(dmg, pdx, pdz);
    }
    for (let i = 0; i < 8; i++)
      particles.spawn(
        x + (Math.random() - 0.5) * 2,
        y + Math.random() * 1.5,
        z + (Math.random() - 0.5) * 2,
        0.55,
        0.55,
        0.55,
      );
    sfx.playExplosion();
  }

  /** 箭矢存量（快捷栏 + 背包主栏；MC 允许箭在背包任意位置） */
  function arrowCount(): number {
    let n = survivalInv.countMaterial('arrow');
    for (let i = 0; i < 9; i++) {
      const s = hotbar.slotAt(i);
      if (s.tool && s.tool.def.id === 'arrow') n += s.tool.count;
    }
    return n;
  }

  /** 消耗 1 支箭：快捷栏优先（MC 顺序），其次背包主栏 */
  function consumeArrow(): void {
    for (let i = 0; i < 9; i++) {
      const s = hotbar.slotAt(i);
      if (s.tool && s.tool.def.id === 'arrow' && s.tool.count > 0) {
        s.tool.count--;
        hotbar.setSlotAt(i, s.tool.count <= 0 ? emptyHotSlot() : s);
        return;
      }
    }
    survivalInv.consumeMaterial('arrow');
  }

  /** 消耗当前快捷栏格手持的可堆叠材料 1 个（种子/骨粉等）；空则清空该格 */
  function consumeHeldMaterial(id: string): void {
    const i = hotbar.selected;
    const s = hotbar.slotAt(i);
    if (s.tool && s.tool.def.id === id && s.tool.count > 0) {
      s.tool.count--;
      hotbar.setSlotAt(i, s.tool.count <= 0 ? emptyHotSlot() : s);
    }
  }

  /** 4 格曼哈顿距离内是否存在水（耕地湿润判定，MC 一致） */
  function hasWaterNear(x: number, y: number, z: number): boolean {
    for (let dx = -4; dx <= 4; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -4; dz <= 4; dz++) {
          if (Math.abs(dx) + Math.abs(dz) > 4) continue;
          if (registry.isWater(cur().world.getBlock(x + dx, y + dy, z + dz)))
            return true;
        }
    return false;
  }

  /**
   * 放箭：蓄力 0..1 → 速度 8~32、伤害 1~9（MC 满弓 9 伤害）；
   * 生存消耗 1 箭 + 弓 1 点耐久（385 次），创造不耗箭
   */
  function fireBow(charge: number): void {
    camera.getWorldDirection(tmpDir);
    const eye = camera.position;
    arrowManager.spawn(
      eye.x + tmpDir.x * 0.5,
      eye.y + tmpDir.y * 0.5 - 0.1,
      eye.z + tmpDir.z * 0.5,
      tmpDir.x,
      tmpDir.y,
      tmpDir.z,
      8 + charge * 24,
      false,
      Math.round(1 + charge * 8),
    );
    if (gameMode === 'survival') {
      // 无限附魔：不消耗箭（仍需至少 1 支才可蓄力，MC 一致）
      const hasInfinity = (hotbar.current.tool?.ench?.infinity ?? 0) > 0;
      if (!hasInfinity) consumeArrow();
      damageHeldTool(1);
    }
    sfx.playShoot();
  }

  /** 矿石经验表（MC：煤矿 0-2，钻石 3-7；铁/金需烧炼不给经验） */
  const ORE_XP: Record<string, () => number> = {
    coal_ore: () => Math.floor(Math.random() * 3),
    diamond_ore: () => 3 + Math.floor(Math.random() * 5),
  };

  /** 破坏掉落表：草方块→泥土、石头→圆石（MC），玻璃/树叶→无，其余→自身 */
  function dropFor(def: BlockDef): BlockDef | null {
    if (def.name === 'grass_block') return registry.byName.get('dirt') ?? def;
    if (def.name === 'stone') return registry.byName.get('cobblestone') ?? def;
    if (def.name === 'glass' || def.name === 'oak_leaves') return null;
    return def;
  }

  /** 手持工具掉耐久（生存）；耗尽工具损坏消失并重绘耐久条/同步手持 */
  function damageHeldTool(n: number): void {
    if (gameMode !== 'survival') return;
    const s = hotbar.current;
    if (!s.tool || s.tool.def.maxDurability <= 0) return;
    // 耐久附魔：每级 1/(level+1) 概率免除本次损耗（MC）
    const keep = unbreakingKeep(s.tool.ench?.unbreaking ?? 0);
    for (let i = 0; i < n; i++) {
      if (Math.random() < keep) continue;
      const dur = (s.tool.dur ?? s.tool.def.maxDurability) - 1;
      if (dur <= 0) {
        s.tool = null;
        sfx.playBreak();
        break;
      } else {
        s.tool.dur = dur;
      }
    }
    hotbar.setSlotAt(hotbar.selected, s);
  }

  function breakBlock(x: number, y: number, z: number): void {
    const id = cur().world.getBlock(x, y, z);
    const def = registry.def(id);
    if (!def || def.hardness < 0) return;
    // 末影水晶：一击破坏并爆炸（伤周围，停止龙回血）
    if (def.name === 'end_crystal') {
      applyEdit(x, y, z, AIR);
      explode(x + 0.5, y + 0.5, z + 0.5, 2, 0);
      return;
    }
    applyEdit(x, y, z, AIR);
    // 生存模式：方块实体掉落 + 矿石经验（创造无掉落，MC 一致）
    // 石质矿物需镐达到层级才可采集，否则破坏无掉落（MC 规则）
    if (gameMode === 'survival') {
      const heldTool = hotbar.current.tool?.def ?? null;
      // 时运附魔：提升矿物掉落数量（煤/钻/青金石/红石/绿宝石）
      const fortuneLvl = hotbar.current.tool?.ench?.fortune ?? 0;
      const fmult = fortuneMult(fortuneLvl);
      const lucky = (base: number): number =>
        Math.max(1, Math.round(base * fmult));
      if (canHarvest(def.name, heldTool)) {
        // 煤矿掉煤、钻石矿掉钻石（MC 一致），其余走方块掉落表
        if (def.name === 'coal_ore') {
          drops.spawnTool(TOOLS.coal, x + 0.5, y + 0.5, z + 0.5, lucky(1));
        } else if (def.name === 'diamond_ore') {
          drops.spawnTool(TOOLS.diamond, x + 0.5, y + 0.5, z + 0.5, lucky(1));
        } else if (def.name === 'lapis_ore') {
          // 青金石掉 4~8 个
          const n = 4 + Math.floor(Math.random() * 5);
          drops.spawnTool(
            TOOLS.lapis_lazuli,
            x + 0.5,
            y + 0.5,
            z + 0.5,
            lucky(n),
          );
        } else if (def.name === 'redstone_ore') {
          const n = 4 + Math.floor(Math.random() * 2);
          drops.spawnTool(TOOLS.redstone, x + 0.5, y + 0.5, z + 0.5, lucky(n));
        } else if (def.name === 'emerald_ore') {
          drops.spawnTool(TOOLS.emerald, x + 0.5, y + 0.5, z + 0.5, lucky(1));
        } else if (def.name === 'tall_grass') {
          // 打草概率掉小麦种子（MC ~12.5%）
          if (Math.random() < 0.13)
            drops.spawnTool(TOOLS.wheat_seeds, x + 0.5, y + 0.5, z + 0.5);
        } else if (def.name.startsWith('wheat_')) {
          // 收获：成熟掉 1 小麦 + 0~3 种子；未熟只掉 1 种子
          const stage = Number(def.name.slice(6));
          if (stage >= 7) {
            drops.spawnTool(TOOLS.wheat_item, x + 0.5, y + 0.5, z + 0.5);
            const ns = Math.floor(Math.random() * 4);
            if (ns > 0)
              drops.spawnTool(TOOLS.wheat_seeds, x + 0.5, y + 0.5, z + 0.5, ns);
          } else {
            drops.spawnTool(TOOLS.wheat_seeds, x + 0.5, y + 0.5, z + 0.5);
          }
        } else if (def.name === 'farmland') {
          // 耕地破坏掉泥土（MC 一致）
          const dirt = registry.byName.get('dirt');
          if (dirt) drops.spawnBlock(dirt, x + 0.5, y + 0.5, z + 0.5);
        } else {
          const dd = dropFor(def);
          if (dd) drops.spawnBlock(dd, x + 0.5, y + 0.5, z + 0.5);
        }
        const oreXp = ORE_XP[def.name];
        if (oreXp) {
          const v = oreXp();
          if (v > 0) xpManager.spawn(v, x + 0.5, y + 0.5, z + 0.5);
        }
      }
      // 熔炉被破坏：内容物（原料/燃料/产物）原地散出，无论能否采集本体
      if (def.name === 'furnace') {
        const key = `${x},${y},${z}`;
        const st = furnaces.get(key);
        if (st) {
          for (const slot of [st.input, st.fuel, st.output])
            dropSlotAt(slot, x + 0.5, y + 0.5, z + 0.5);
          furnaces.delete(key);
        }
      }
    }
    const [r, g, b] = tileColorOf(def);
    particles.spawn(x + 0.5, y + 0.5, z + 0.5, r, g, b);
    sfx.playBreak();
    // MC：生存模式每破坏一个有硬度的方块，手持工具 -1 耐久
    if (gameMode === 'survival' && def.hardness > 0) damageHeldTool(1);
  }

  // ---- 睡觉：夜晚右键床 → 黑屏渐隐 → 快进到清晨 + 设重生点（MC） ----
  let sleeping = false;
  const sleepOverlay = document.getElementById('sleep-overlay')!;
  function trySleep(bx: number, by: number, bz: number): void {
    if (sleeping || dead) return;
    const tod = sky.timeOfDay;
    const isNight = tod >= 0.74 || tod <= 0.24;
    if (!isNight) {
      hud.showItemName('你只能在夜晚睡觉');
      return;
    }
    sleeping = true;
    spawnPoint = { x: bx + 0.5, y: by + 1, z: bz + 0.5 };
    sleepOverlay.classList.add('on');
    setTimeout(() => {
      const day0 = Math.floor(sky.timeValue / DAY_LENGTH) * DAY_LENGTH;
      const wake = day0 + (tod >= 0.74 ? DAY_LENGTH : 0) + DAY_LENGTH * 0.25;
      sky.setTime(wake);
      saveNow();
      sleepOverlay.classList.remove('on');
      hud.showItemName('重生点已设置');
      setTimeout(() => {
        sleeping = false;
      }, 950);
    }, 950);
  }

  function placeBlock(): void {
    if (!currentHit) return;
    const slot = hotbar.current;
    if (!slot.block) return; // 空手/食物不可放置
    const def = slot.block.def;
    const tx = currentHit.x + currentHit.nx;
    const ty = currentHit.y + currentHit.ny;
    const tz = currentHit.z + currentHit.nz;
    const existing = cur().world.getBlock(tx, ty, tz);
    if (existing !== AIR) {
      const ed = registry.def(existing);
      if (!ed || (!ed.replaceable && !ed.fluid)) return;
    }
    if (def.solid && body.intersectsBlock(tx, ty, tz)) return; // 不能放进自己身体
    applyEdit(tx, ty, tz, def.id);
    hotbar.consumeBlock(); // 生存计数 -1（创造空操作）
    sfx.playPlace();
  }

  function updateInteraction(dt: number): void {
    // 射线
    camera.getWorldDirection(tmpDir);
    const eye = camera.position;
    currentHit = raycastVoxel(
      cur().world,
      eye.x,
      eye.y,
      eye.z,
      tmpDir.x,
      tmpDir.y,
      tmpDir.z,
      5,
    );

    // 生物拾取：一次 32 格射线同时服务近战判定(≤5 格)与末影人注视(≤32 格),
    // 避免每帧对全部生物做两遍 AABB 扫描。
    const mobRay = mobManager.raycastMob(
      eye.x,
      eye.y,
      eye.z,
      tmpDir.x,
      tmpDir.y,
      tmpDir.z,
      32,
    );
    const mobHit = mobRay && mobRay.dist <= 5 ? mobRay : null;
    const mobPriority =
      mobHit !== null && (!currentHit || mobHit.dist < currentHit.dist);

    // 末影人注视激怒（MC）：准星远距离锁定其头部约 0.25s 即激怒
    const stareHit = mobRay;
    if (stareHit && stareHit.mob.kind === 'enderman' && !stareHit.mob.dying) {
      stareTimer += dt;
      if (stareTimer > 0.25) stareHit.mob.provoked = true;
    } else {
      stareTimer = 0;
    }

    if (currentHit && !mobPriority) {
      highlight.visible = true;
      highlight.position.set(
        currentHit.x + 0.5,
        currentHit.y + 0.5,
        currentHit.z + 0.5,
      );
    } else {
      highlight.visible = false;
    }

    // 攻击生物：按住连击（生物 0.5s 无敌帧限频），击退方向取视线水平分量
    // 近战伤害取手持工具 melee（剑 4~7，锹/斧/镐较低，徒手 1）；剑命中 -2 耐久，其他工具 -1
    if (attackHeld && mobPriority && mobHit) {
      const heldTool = hotbar.current.tool?.def ?? null;
      const sharpLvl = hotbar.current.tool?.ench?.sharpness ?? 0;
      const melee = (heldTool?.melee ?? 1) + sharpnessBonus(sharpLvl);
      if (mobHit.mob.damage(tmpDir.x, tmpDir.z, melee)) {
        sfx.playHurt();
        damageHeldTool(heldTool?.kind === 'sword' ? 2 : 1);
      }
    }
    // 近战攻击末影龙：准星命中龙（大型宽松判定）
    if (attackHeld && dragon && !dragon.dying) {
      const reach = 5;
      if (dragon.hitTest(eye.x + tmpDir.x * 3, eye.y + tmpDir.y * 3, eye.z + tmpDir.z * 3, reach)) {
        const heldTool = hotbar.current.tool?.def ?? null;
        const sharpLvl = hotbar.current.tool?.ench?.sharpness ?? 0;
        const melee = (heldTool?.melee ?? 1) + sharpnessBonus(sharpLvl);
        if (dragon.damage(melee)) {
          sfx.playHurt();
          damageHeldTool(heldTool?.kind === 'sword' ? 2 : 1);
        }
      }
    }

    // 破坏
    let cracking = false;
    if (attackHeld && currentHit && !mobPriority) {
      const def = registry.def(currentHit.block);
      const key = `${currentHit.x},${currentHit.y},${currentHit.z}`;
      if (def && def.hardness >= 0) {
        if (key !== breakKey) {
          breakKey = key;
          breakProgress = 0;
        }
        if (def.hardness === 0 || gameMode === 'creative') {
          breakBlock(currentHit.x, currentHit.y, currentHit.z);
          breakKey = '';
        } else {
          // 工具加成：对应工具类型才有速度倍率（MC：木 2×、石 4×）；效率附魔再加速
          const heldTool = hotbar.current.tool?.def ?? null;
          const effLvl = hotbar.current.tool?.ench?.efficiency ?? 0;
          const base =
            gameMode === 'survival' ? miningSpeed(def.name, heldTool) : 1;
          const mult = base * efficiencyMult(effLvl);
          breakProgress += (dt * mult) / (def.hardness * 1.5);
          if (breakProgress >= 1) {
            breakBlock(currentHit.x, currentHit.y, currentHit.z);
            breakProgress = 0;
            breakKey = '';
          } else {
            cracking = true;
            const stage = Math.min(9, Math.floor(breakProgress * 10));
            atlas.crackTexture.offset.x = stage * 0.1;
            crackMesh.position.set(
              currentHit.x + 0.5,
              currentHit.y + 0.5,
              currentHit.z + 0.5,
            );
          }
        }
      }
    } else {
      breakProgress = 0;
      breakKey = '';
    }
    crackMesh.visible = cracking;

    // 放置（按住以约 4.5/s 连放）；右键工作台方块打开 3×3 合成界面
    useCooldown -= dt;
    if (useHeld && useCooldown <= 0) {
      const hitDef =
        currentHit && !mobPriority ? registry.def(currentHit.block) : null;
      const curTool = hotbar.current.tool?.def ?? null;
      if (mobPriority && mobHit && mobHit.mob.kind === 'villager') {
        // 右键村民：打开交易界面（MC）
        tradingUI.open(mobHit.mob.uid);
        useCooldown = 0.3;
      } else if (hitDef && hitDef.name === 'crafting_table') {
        craftingTable.open();
        useCooldown = 0.3;
      } else if (hitDef && hitDef.name === 'furnace') {
        furnaceUI.open(getFurnace(currentHit!.x, currentHit!.y, currentHit!.z));
        useCooldown = 0.3;
      } else if (hitDef && hitDef.name === 'enchanting_table') {
        enchantUI.open();
        useCooldown = 0.3;
      } else if (hitDef && hitDef.name === 'bed') {
        trySleep(currentHit!.x, currentHit!.y, currentHit!.z);
        useCooldown = 0.3;
      } else if (hitDef && hitDef.name === 'end_portal_frame') {
        // 末地传送门框架：手持末影珍珠右键 → 嵌眼激活（MC 用末影之眼）
        if (curTool?.id === 'ender_pearl') {
          applyEdit(
            currentHit!.x,
            currentHit!.y,
            currentHit!.z,
            idEndFrameEye,
          );
          if (gameMode === 'survival') consumeHeldMaterial('ender_pearl');
          sfx.playPlace();
          hud.showItemName('传送门框架已激活');
        } else {
          hud.showItemName('需要末影珍珠来激活');
        }
        useCooldown = 0.3;
      } else if (
        hitDef &&
        (hitDef.name === 'lever_off' ||
          hitDef.name === 'lever_on' ||
          hitDef.name === 'stone_button')
      ) {
        // 红石电源：拉杆切换 / 按钮脉冲
        if (redstone.activate(currentHit!.x, currentHit!.y, currentHit!.z))
          sfx.playPlace();
        useCooldown = 0.3;
      } else if (hitDef && hitDef.name === 'tnt') {
        // 点燃 TNT（简化：任意手持右键即点，MC 需打火石/火焰弹）
        applyEdit(currentHit!.x, currentHit!.y, currentHit!.z, AIR);
        tntManager.ignite(
          currentHit!.x + 0.5,
          currentHit!.y + 0.5,
          currentHit!.z + 0.5,
        );
        sfx.playFuse();
        useCooldown = 0.3;
      } else if (hitDef && hitDef.name === 'obsidian') {
        // 黑曜石门框右键：尝试点燃下界传送门（命中框内侧空气格填 portal）
        const fx = currentHit!.x + currentHit!.nx;
        const fy = currentHit!.y + currentHit!.ny;
        const fz = currentHit!.z + currentHit!.nz;
        ignitePortal(fx, fy, fz);
        useCooldown = 0.3;
      } else if (
        hitDef &&
        (hitDef.name === 'dirt' || hitDef.name === 'grass_block') &&
        curTool?.kind === 'hoe'
      ) {
        // 锄头开垦：泥土/草方块 → 耕地（MC：手持锄右键）
        applyEdit(currentHit!.x, currentHit!.y, currentHit!.z, farmlandId);
        damageHeldTool(1);
        sfx.playPlace();
        useCooldown = 0.3;
      } else if (
        hitDef &&
        hitDef.name === 'farmland' &&
        curTool?.id === 'wheat_seeds'
      ) {
        // 播种：耕地上方空格种 wheat_0
        const ax = currentHit!.x;
        const ay = currentHit!.y + 1;
        const az = currentHit!.z;
        if (cur().world.getBlock(ax, ay, az) === AIR) {
          applyEdit(ax, ay, az, registry.id('wheat_0'));
          if (gameMode === 'survival') consumeHeldMaterial('wheat_seeds');
          sfx.playPlace();
        }
        useCooldown = 0.3;
      } else if (
        hitDef &&
        hitDef.name.startsWith('wheat_') &&
        curTool?.id === 'bone_meal'
      ) {
        // 骨粉催熟：小麦前进 1~3 阶段
        const stage = Number(hitDef.name.slice(6));
        const next = Math.min(7, stage + 1 + Math.floor(Math.random() * 3));
        applyEdit(
          currentHit!.x,
          currentHit!.y,
          currentHit!.z,
          registry.id(`wheat_${next}`),
        );
        if (gameMode === 'survival') consumeHeldMaterial('bone_meal');
        particles.spawn(
          currentHit!.x + 0.5,
          currentHit!.y + 0.8,
          currentHit!.z + 0.5,
          0.6,
          0.9,
          0.4,
        );
        sfx.playPlace();
        useCooldown = 0.3;
      } else if (curTool?.id === 'redstone' && currentHit) {
        // 红石粉：手持红石右键方块侧面 → 邻格铺红石粉（MC 直接放置）
        const tx = currentHit.x + currentHit.nx;
        const ty = currentHit.y + currentHit.ny;
        const tz = currentHit.z + currentHit.nz;
        const existing = cur().world.getBlock(tx, ty, tz);
        const ed = existing > 0 ? registry.def(existing) : null;
        if (existing === AIR || (ed && ed.replaceable)) {
          applyEdit(tx, ty, tz, registry.id('redstone_dust_off'));
          if (gameMode === 'survival') consumeHeldMaterial('redstone');
          sfx.playPlace();
        }
        useCooldown = 0.3;
      } else {
        placeBlock();
        useCooldown = 0.22;
      }
    }
  }

  function facingText(): string {
    camera.getWorldDirection(tmpDir);
    const ax = Math.abs(tmpDir.x),
      az = Math.abs(tmpDir.z);
    if (ax > az) return tmpDir.x > 0 ? '东 (+X)' : '西 (-X)';
    return tmpDir.z > 0 ? '南 (+Z)' : '北 (-Z)';
  }

  // ---- 进入世界（进度满后才允许点击） ----
  const enterWorld = (): void => {
    // 首次手势启用音频
    sfx.init();
    startScreen.hide();
    state = 'playing';
    controls.lock();
    syncHand(hotbar.current);
  };

  // ---- 主循环 ----
  // 后台标签页 rAF 会被浏览器暂停，用看门狗定时器保底推进（生成/保存不中断），
  // 隐藏时跳过实际渲染以省 GPU
  const clock = new THREE.Clock();
  let physAcc = 0;
  let elapsed = 0; // 游戏内累计秒数（云漂移用）
  let rafQueued = 0;
  let lastFrameAt = performance.now();

  function frame(): void {
    rafQueued = Math.max(0, rafQueued - 1);
    lastFrameAt = performance.now();
    // 隐藏标签下不再登记 rAF（登记了也不会触发，只会积压），由看门狗驱动
    if (rafQueued === 0 && !document.hidden) {
      rafQueued = 1;
      requestAnimationFrame(frame);
    }
    const dt = Math.min(clock.getDelta(), 0.1);
    elapsed += dt;
    debugPanel.tickFrame(dt);
    const hidden = document.hidden;

    if (state === 'loading') {
      const cm = cur().cm;
      const p = cm.update(body.x, body.z, 24, true);
      // 加载期地图采样节流：每帧限量消化落地高峰排队的区块,主线程不被一次性打断
      worldMap.drainQueue(6);
      if (p >= 1) {
        if (deferringLoad) {
          // 第一阶段完成（全部地形已生成）：放开网格化，进入第二阶段
          deferringLoad = false;
          for (const dim of ALL_DIMS) dims[dim].cm.setDeferNeighbors(false);
          startScreen.setProgress('正在构建网格…', 0);
        } else {
          // 第二阶段完成（网格化补齐）：可进入游戏
          state = 'ready';
          startScreen.setReady(enterWorld);
        }
      } else {
        startScreen.setProgress(
          deferringLoad
            ? `正在生成世界… ${Math.round(p * 100)}%`
            : `正在构建网格… ${Math.round(p * 100)}%`,
          p,
        );
      }
      sky.update(dt, camera, []);
      cm.dayUniform.value = sky.daylight;
      camera.position.set(body.x, body.y + EYE_HEIGHT, body.z);
      if (!hidden) {
        renderer.clear();
        renderer.render(scene, camera);
      }
      return;
    }

    if (state === 'playing' && controls.locked) {
      // 物理（固定步长子迭代）
      physAcc = Math.min(physAcc + dt, 0.12);
      const input = {
        forward:
          (controls.keys.has('KeyW') ? 1 : 0) -
          (controls.keys.has('KeyS') ? 1 : 0),
        strafe:
          (controls.keys.has('KeyD') ? 1 : 0) -
          (controls.keys.has('KeyA') ? 1 : 0),
        jump: controls.keys.has('Space'),
        down: controls.keys.has('ShiftLeft') || controls.keys.has('ShiftRight'),
        sprint: sprinting,
        yaw: controls.yaw,
      };
      // 冲刺取消条件：松开前进 / 潜行
      if (sprinting && (input.forward <= 0 || body.sneaking)) sprinting = false;
      while (physAcc > 0) {
        const step = Math.min(physAcc, 1 / 60);
        body.step(input, step);
        physAcc -= step;
      }
      // 冲刺取消条件：迎面撞墙
      if (sprinting && (body.collidedX || body.collidedZ)) sprinting = false;

      // 脚步声
      if (body.onGround && !body.flying) {
        stepDist += Math.hypot(body.vx, body.vz) * dt;
        if (stepDist > 2.2) {
          stepDist = 0;
          sfx.playStep();
        }
      }

      // 摔落伤害（生存）：累计下落距离，落地结算，飞行/落水豁免
      if (gameMode === 'survival' && !dead) {
        if (body.flying || body.inWater) {
          fallDist = 0;
        } else if (!body.onGround && body.vy < 0) {
          fallDist -= body.vy * dt;
        } else if (body.onGround) {
          if (fallDist > 3) hurtPlayer(Math.floor(fallDist - 3));
          fallDist = 0;
        }

        // 饥饿消耗 / 饱食回复 / 饥饿掉血（MC 机制简化）
        const moving = Math.hypot(body.vx, body.vz) > 0.5;
        exhaustion += dt * (sprinting && moving ? 0.6 : moving ? 0.08 : 0.015);
        if (exhaustion >= 30) {
          exhaustion = 0;
          hunger = Math.max(0, hunger - 1);
        }
        if (hunger >= 18 && hp < 20) {
          regenTimer += dt;
          if (regenTimer >= 4) {
            regenTimer = 0;
            hp = Math.min(20, hp + 1);
            exhaustion += 6;
          }
        } else {
          regenTimer = 0;
        }
        if (hunger <= 0) {
          starveTimer += dt;
          if (starveTimer >= 4 && hp > 1) {
            starveTimer = 0;
            hp = Math.max(1, hp - 1);
            hud.hurtFlash();
          }
        } else {
          starveTimer = 0;
        }
        if (hunger <= 6) sprinting = false;
        hurtInvuln = Math.max(0, hurtInvuln - dt);
      }
      hud.setVitals(hp, hunger, gameMode === 'survival');
      hud.setArmor(armorStats().points);

      updateInteraction(dt);
      hand.update(dt, Math.hypot(body.vx, body.vz), body.onGround, attackHeld);
      // 传送门：站立于 portal 方块内累计 1.2s 触发跨维度（目标维度由 portalAt 判定）
      const portalTarget = portalAt();
      if (portalTarget !== null) {
        portalTimer += dt;
        if (portalTimer >= 1.2) {
          portalTimer = 0;
          travelThroughPortal(portalTarget);
        }
      } else {
        portalTimer = 0;
      }
      // 生物：游荡 AI + 追击 + 生成/消失（暂停菜单打开时随世界冻结）
      // 僵尸近战：生存扣 3 血（1.5 心）并击退；骷髅射箭；苦力怕引爆
      mobManager.update(
        dt,
        body.x,
        body.y,
        body.z,
        sky.daylight,
        (m) => {
          hurtPlayer(3, body.x - m.x, body.z - m.z);
        },
        // 骷髅放箭 / 恶魂吐火球：从眼部朝玩家胸口，重力补偿抬枪口 + 少量散布
        (m) => {
          const sx = m.x;
          const sy = m.y + m.height * 0.85;
          const sz = m.z;
          const tx = body.x - sx;
          const tz = body.z - sz;
          const ty0 = body.y + 1.2 - sy;
          const flat = Math.hypot(tx, tz);
          if (m.kind === 'ghast') {
            // 恶魂火球：直线飞行（无下坠），命中即伤（复用箭矢管线）
            const len = Math.hypot(tx, ty0, tz) || 1;
            arrowManager.spawn(
              sx,
              sy,
              sz,
              tx / len,
              ty0 / len,
              tz / len,
              12,
              true,
              5,
              0,
            );
            sfx.playShoot();
            return;
          }
          const t = Math.max(0.2, flat / 14); // 与 arrows.ts SPEED 一致
          let vx = tx;
          let vy = ty0 + 0.5 * 9 * t * t; // 抛物线补偿
          let vz = tz;
          const len = Math.hypot(vx, vy, vz) || 1;
          vx = vx / len + (Math.random() - 0.5) * 0.04;
          vy = vy / len + (Math.random() - 0.5) * 0.04;
          vz = vz / len + (Math.random() - 0.5) * 0.04;
          const l2 = Math.hypot(vx, vy, vz) || 1;
          arrowManager.spawn(sx, sy, sz, vx / l2, vy / l2, vz / l2);
          sfx.playShoot();
        },
        // 苦力怕引爆：地形破坏 + 伤害（mob 由 manager 移除）
        (m) => explode(m.x, m.y + m.height * 0.5, m.z),
        // 苦力怕点燃引信：嘶嘶声
        () => sfx.playFuse(),
      );

      // 末影龙：飞行 AI + 俯冲攻击 + 水晶回血 + 死亡结算（仅末地）
      if (dragon) {
        // 统计存活末影水晶（末地主岛柱顶，供龙回血）
        let crystals = 0;
        if (idEndCrystalBlock >= 0) {
          for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2;
            const cx = Math.round(Math.cos(ang) * 30);
            const cz = Math.round(Math.sin(ang) * 30);
            for (let y = 84; y < 100; y++) {
              if (cur().world.getBlock(cx, y, cz) === idEndCrystalBlock) {
                crystals++;
                break;
              }
            }
          }
        }
        dragon.crystalsAlive = crystals;
        dragon.step(dt, body.x, body.y, body.z, (dmg, kbx, kbz) => {
          hurtPlayer(dmg, kbx, kbz);
        });
        if (dragon.removeMe) {
          // 龙死亡结算：爆经验 + 掉龙蛋 + 激活返回传送门 + 标记已击败
          const ex = Math.floor(dragon.x);
          const ez = Math.floor(dragon.z);
          xpManager.spawn(500, dragon.x, dragon.y, dragon.z); // 大量经验
          if (idDragonEgg >= 0) {
            applyEdit(ex, Math.floor(dragon.y), ez, idDragonEgg);
          }
          // 返回传送门：在龙陨落地放一座末地门框 + 门（回主世界）
          buildExitPortal(ex, Math.floor(dragon.y), ez);
          dragon.dispose();
          dragon = null;
          dragonDefeated = true;
          hud.showItemName('末影龙被击败了！');
          sfx.playExplosion();
          saveNow();
        }
      }

      // 箭矢：抛物线飞行；敌对箭命中玩家扣血（创造/无敌帧由 hurtPlayer 判定），
      // 玩家箭命中生物按蓄力伤害 + 击退；命中末影龙按龙判定
      arrowManager.update(
        dt,
        body.x,
        body.y,
        body.z,
        (dmg) => hurtPlayer(dmg),
        undefined,
        (x, y, z, dmg, vx, vz) => {
          if (dragon && dragon.hitTest(x, y, z, 1)) {
            if (dragon.damage(dmg)) sfx.playHurt();
            return true;
          }
          return mobManager.arrowHit(x, y, z, dmg, vx, vz);
        },
      );

      // 点燃的 TNT：引信/下落/白闪，尽则经回调大爆炸（power=4）
      tntManager.update(dt);

      // 水流动（节流扩散/消退）+ 重力方块坠落
      fluid.update(dt);
      gravity.update(dt);

      // 红石电路：脉冲推进 + 能量重算 + 用电器驱动
      redstone.update(dt);

      // 掉落物：旋转/浮动/拾取（方块/食物均可入快捷栏，满则留在原地）
      drops.update(dt, body.x, body.y + 0.9, body.z, (item) => {
        let ok = true;
        for (let k = 0; k < item.n; k++) {
          const added =
            item.kind === 'food'
              ? hotbar.addFood(item.def)
              : item.kind === 'tool'
                ? hotbar.addTool(item.def, item.dur)
                : hotbar.addBlock(item.def);
          if (!added) {
            ok = false;
            break;
          }
        }
        if (ok) sfx.playPickup();
        return ok;
      });

      // 经验球：吸附拾取 → 升级曲线结算
      xpManager.update(dt, body.x, body.y + 0.9, body.z, (v) => {
        addXp(v);
        sfx.playXp();
      });

      // 熔炉：后台持续烧炼（MC：关闭界面不中断）；UI 打开时标脏刷新。
      // 节流：玩家附近熔炉每帧 tick；远处熔炉视觉不可见,按 0.5s 低频一次性补进度,
      // 且区块卸载后空熔炉已被移除 —— 避免熔炉多时主循环每帧全量扫描。
      furnaceTickAcc += dt;
      const farTick = furnaceTickAcc >= 0.5;
      if (farTick) furnaceTickAcc = 0;
      for (const st of furnaces.values()) {
        const dx = st.x - body.x;
        const dz = st.z - body.z;
        const near = dx * dx + dz * dz < 48 * 48;
        if (!near && !farTick) continue; // 远处熔炉本帧跳过
        // 远处熔炉一次性补上累积时间,保证烧炼进度不落后
        const step = near ? dt : 0.5;
        if (tickFurnace(st, step, resolveSmeltOut)) furnaceUI.markDirty();
      }
      furnaceUI.update();

      // 作物随机 tick（MC：每区块每 tick 随机抽格促生长）。节流：每 0.5s 在玩家
      // 附近随机抽 48 格，命中小麦则按概率推进一阶段；耕地远离水会退化泥土。
      growTimer -= dt;
      if (growTimer <= 0) {
        growTimer = 0.5;
        const px0 = Math.floor(body.x);
        const py0 = Math.floor(body.y);
        const pz0 = Math.floor(body.z);
        for (let n = 0; n < 48; n++) {
          const gx = px0 + ((Math.random() * 33) | 0) - 16;
          const gy = Math.max(1, py0 + ((Math.random() * 17) | 0) - 8);
          const gz = pz0 + ((Math.random() * 33) | 0) - 16;
          const gid = cur().world.getBlock(gx, gy, gz);
          const gdef = gid > 0 ? registry.def(gid) : null;
          if (gdef && gdef.name.startsWith('wheat_')) {
            const stage = Number(gdef.name.slice(6));
            if (stage < 7 && Math.random() < 0.35) {
              applyEdit(gx, gy, gz, registry.id(`wheat_${stage + 1}`));
            }
          } else if (gdef && gdef.name === 'farmland') {
            // 退化：4 格内无水且上方非作物时，概率退回泥土（MC 干旱退化）
            if (Math.random() < 0.02 && !hasWaterNear(gx, gy, gz)) {
              const above = cur().world.getBlock(gx, gy + 1, gz);
              const adef = above > 0 ? registry.def(above) : null;
              if (!adef || !adef.name.startsWith('wheat_'))
                applyEdit(gx, gy, gz, registry.id('dirt'));
            }
          }
        }
      }

      // 进食：手持食物按住右键 1.6s（MC 进食时长），松手/切槽重置
      const curSlot = hotbar.current;
      if (
        useHeld &&
        curSlot.food &&
        gameMode === 'survival' &&
        hunger < 20 &&
        !dead
      ) {
        eatTimer += dt;
        if (eatTimer >= nextCrunch) {
          nextCrunch += 0.4;
          sfx.playEat();
        }
        if (eatTimer >= 1.6) {
          hunger = Math.min(20, hunger + curSlot.food.def.hunger);
          hotbar.consumeFood();
          eatTimer = 0;
          nextCrunch = 0.4;
        }
      } else {
        eatTimer = 0;
        nextCrunch = 0.4;
      }

      // 弓：手持弓按住右键蓄力（MC 满弓 1.2s），松手放箭；无箭不可蓄力
      if (
        useHeld &&
        curSlot.tool?.def.id === 'bow' &&
        !dead &&
        (gameMode !== 'survival' || arrowCount() > 0)
      ) {
        bowCharge = Math.min(1.2, bowCharge + dt);
      } else if (bowCharge > 0) {
        const charge = bowCharge / 1.2;
        if (charge >= 0.1) fireBow(charge); // 低于 10% 蓄力不放箭
        bowCharge = 0;
      }
    }

    // 相机（冲刺时视野外扩，平滑过渡）
    camera.position.set(body.x, body.y + body.eyeHeight(), body.z);
    camera.rotation.set(controls.pitch, controls.yaw, 0);
    const targetFov =
      sprinting && state === 'playing' && controls.locked
        ? Math.min(110, baseFov + 10)
        : baseFov;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
      camera.updateProjectionMatrix();
    }

    // 区块流式更新（游戏中保守上传预算；进度统计仅加载阶段开启）
    cur().cm.update(body.x, body.z, state === 'playing' ? 6 : 24, false);
    // 游戏中继续消化排队的地图采样（玩家移动触发的新区块落地），每帧限量防尖刺
    worldMap.drainQueue(state === 'playing' ? 2 : 8);

    sky.update(dt, camera, []);
    cur().cm.dayUniform.value = sky.daylight;
    clouds.update(elapsed, body.x, body.z, sky.daylight);

    // 水下雾：相机没入水中 → 深蓝绿短视距雾 + 清屏色；出水恢复
    const uw =
      state === 'playing' &&
      registry.isWater(
        cur().world.getBlock(
          Math.floor(camera.position.x),
          Math.floor(camera.position.y),
          Math.floor(camera.position.z),
        ),
      );
    const fog = scene.fog as THREE.Fog;
    if (uw !== underwater) {
      underwater = uw;
      sky.setUnderwater(uw);
      if (uw) {
        fog.near = 2;
        fog.far = 24;
      } else {
        const nf = sky.normalFog(); // 按当前渲染距离恢复常规雾距
        fog.near = nf.near;
        fog.far = nf.far;
      }
    }
    if (underwater) {
      underwaterColor
        .setHex(0x0b3a5e)
        .multiplyScalar(0.25 + 0.75 * sky.daylight);
      fog.color.copy(underwaterColor);
      renderer.setClearColor(underwaterColor);
    }

    particles.update(dt);
    hud.update(dt);
    // 地图：打开时按玩家位置/朝向重绘（世界模拟已冻结，仅读已探索数据）
    worldMap.update(body.x, body.z, controls.yaw, dimension);
    debugPanel.update(dt, () =>
      [
        `XYZ: ${body.x.toFixed(2)} / ${body.y.toFixed(2)} / ${body.z.toFixed(2)}`,
        `区块: ${Math.floor(body.x / 16)}, ${Math.floor(body.z / 16)}  朝向: ${facingText()}  维度: ${dimension === 'nether' ? '下界' : '主世界'}`,
        `已加载区块: ${cur().cm.loadedCount}  已网格化: ${cur().cm.meshedCount}  已修改: ${cur().modified.size}`,
        `第 ${sky.day} 天  种子: ${seedLabel}`,
        body.flying
          ? '飞行中'
          : body.inWater
            ? '游泳中'
            : sprinting
              ? '冲刺中'
              : body.onGround
                ? '地面'
                : '空中',
      ].join('\n'),
    );

    if (!hidden) {
      renderer.clear();
      renderer.render(scene, camera);
      if (state === 'playing') hand.render(renderer);
    }
  }

  frame();
  // 看门狗：rAF 暂停（后台标签）时以低频继续驱动主循环
  window.setInterval(() => {
    if (performance.now() - lastFrameAt > 300) frame();
  }, 300);
  // 重新可见时恢复 rAF 驱动
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && rafQueued === 0) {
      rafQueued = 1;
      requestAnimationFrame(frame);
    }
  });
}

void boot();
