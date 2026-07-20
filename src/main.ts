import * as THREE from 'three';
import './style.css';
import { createAtlas, TILE_INDEX, type AtlasResult } from './core/atlas';
import { loadBlocks, type BlockDef } from './core/model-loader';
import { BlockRegistry, AIR } from './core/block-registry';
import { Persistence, type LoadedSave } from './core/persistence';
import { WorldGen, SEA_LEVEL, parseSeedInput } from './world/worldgen';
import { World, chunkKey } from './world/world';
import { ChunkManager } from './render/chunk-manager';
import { Sky } from './render/sky';
import { Controls } from './player/controls';
import { PlayerBody, EYE_HEIGHT } from './player/physics';
import { raycastVoxel, type RayHit } from './player/raycast';
import { Hud } from './ui/hud';
import { Hotbar } from './ui/hotbar';
import { DebugPanel } from './ui/debug';
import { StartScreen } from './ui/start-screen';
import { Sfx } from './audio/sfx';
import { Particles } from './fx/particles';

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
      try { await persistence.clear(); } catch { /* 忽略清理失败 */ }
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
    onCreate: (seedText) => {
      const begin = (): void => {
        const { seed, label } = parseSeedInput(seedText);
        startGame(atlas, registry, defs, persistence, null, seed, label);
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
        persistence.clear().catch(() => { /* 清理失败也继续 */ }).then(begin);
      } else {
        begin();
      }
    },
    onContinue: () => {
      if (!save) return;
      startGame(atlas, registry, defs, persistence, save, save.meta.seed, save.meta.seedText);
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
): void {
  startScreen.showGenerating();

  // ---- 渲染基础 ----
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.getElementById('game')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.rotation.order = 'YXZ';
  const BASE_FOV = 75;
  const SPRINT_FOV = 85;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- 世界（存档区块覆盖到新生成的地形上） ----
  const worldGen = new WorldGen(seed, registry);
  const world = new World(registry);
  // 本会话内“玩家修改过的区块”权威副本：与世界共享同一 Uint8Array 引用，
  // 因此编辑即时反映，保存时编码即为最新状态
  const modifiedChunks: Map<string, Uint8Array> = save?.chunks ?? new Map();
  const chunkManager = new ChunkManager(
    scene, world, worldGen, atlas, defs,
    (cx, cz) => modifiedChunks.get(chunkKey(cx, cz)) ?? null,
  );
  const sky = new Sky(scene, renderer);
  const particles = new Particles(scene);

  // ---- 玩家（有存档则恢复位置/视角/飞行） ----
  const body = new PlayerBody(world);
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

  // 诊断钩子（控制台调试用）
  (window as unknown as { __mc: unknown }).__mc = { chunkManager, world, body };

  // ---- UI / 音效 ----
  const hud = new Hud();
  const debugPanel = new DebugPanel();
  const sfx = new Sfx();
  const hotbar = new Hotbar(registry.hotbar, atlas.canvas, (def) => hud.showItemName(def.display));

  // ---- 目标方块高亮 + 裂纹 ----
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.85 }),
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
  let attackHeld = false;
  let useHeld = false;
  let useCooldown = 0;
  let breakKey = '';
  let breakProgress = 0;
  let currentHit: RayHit | null = null;
  let stepDist = 0;
  let sprinting = false;

  const controls = new Controls(renderer.domElement, {
    onToggleFly: () => {
      body.flying = !body.flying;
      if (body.flying) body.vy = 0;
    },
    onHotbar: (i) => hotbar.select(i),
    onDebugToggle: () => debugPanel.toggle(),
    onAttack: (down) => { attackHeld = down; if (!down) { breakProgress = 0; breakKey = ''; } },
    onUse: (down) => { useHeld = down; if (down) useCooldown = 0; },
    onSneak: (v) => { body.sneaking = v; },
    onSprint: () => { if (!body.flying) sprinting = true; },
  });
  if (save) {
    controls.yaw = save.meta.player.yaw;
    controls.pitch = save.meta.player.pitch;
  }
  controls.onWheel = (dir) => hotbar.scroll(dir);
  controls.onLockChange = (locked) => {
    hud.setPauseHint(state === 'playing' && !locked);
  };
  renderer.domElement.addEventListener('click', () => {
    if (state === 'playing' && !controls.locked) controls.lock();
  });

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
            x: body.x, y: body.y, z: body.z,
            yaw: controls.yaw, pitch: controls.pitch,
            flying: body.flying,
          },
          savedAt: Date.now(),
        },
        modifiedChunks,
      )
      .catch((e) => console.warn('自动保存失败', e))
      .finally(() => { saving = false; });
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
    return [atlas.tileColors[tile * 3], atlas.tileColors[tile * 3 + 1], atlas.tileColors[tile * 3 + 2]];
  }

  /** 写入方块并同步：网格重建 + 修改集合（存档用） */
  function applyEdit(wx: number, y: number, wz: number, id: number): void {
    const edit = world.setBlock(wx, y, wz, id);
    if (!edit) return;
    chunkManager.markEdited(edit.cx, edit.cz, edit.lx, edit.lz);
    const data = world.chunks.get(chunkKey(edit.cx, edit.cz));
    if (data) modifiedChunks.set(chunkKey(edit.cx, edit.cz), data);
  }

  function breakBlock(x: number, y: number, z: number): void {
    const id = world.getBlock(x, y, z);
    const def = registry.def(id);
    if (!def || def.hardness < 0) return;
    applyEdit(x, y, z, AIR);
    const [r, g, b] = tileColorOf(def);
    particles.spawn(x + 0.5, y + 0.5, z + 0.5, r, g, b);
    sfx.playBreak();
  }

  function placeBlock(): void {
    if (!currentHit) return;
    const def = hotbar.current;
    const tx = currentHit.x + currentHit.nx;
    const ty = currentHit.y + currentHit.ny;
    const tz = currentHit.z + currentHit.nz;
    const existing = world.getBlock(tx, ty, tz);
    if (existing !== AIR) {
      const ed = registry.def(existing);
      if (!ed || (!ed.replaceable && !ed.fluid)) return;
    }
    if (def.solid && body.intersectsBlock(tx, ty, tz)) return; // 不能放进自己身体
    applyEdit(tx, ty, tz, def.id);
    sfx.playPlace();
  }

  function updateInteraction(dt: number): void {
    // 射线
    camera.getWorldDirection(tmpDir);
    const eye = camera.position;
    currentHit = raycastVoxel(world, eye.x, eye.y, eye.z, tmpDir.x, tmpDir.y, tmpDir.z, 5);

    if (currentHit) {
      highlight.visible = true;
      highlight.position.set(currentHit.x + 0.5, currentHit.y + 0.5, currentHit.z + 0.5);
    } else {
      highlight.visible = false;
    }

    // 破坏
    let cracking = false;
    if (attackHeld && currentHit) {
      const def = registry.def(currentHit.block);
      const key = `${currentHit.x},${currentHit.y},${currentHit.z}`;
      if (def && def.hardness >= 0) {
        if (key !== breakKey) {
          breakKey = key;
          breakProgress = 0;
        }
        if (def.hardness === 0) {
          breakBlock(currentHit.x, currentHit.y, currentHit.z);
          breakKey = '';
        } else {
          breakProgress += dt / (def.hardness * 1.5);
          if (breakProgress >= 1) {
            breakBlock(currentHit.x, currentHit.y, currentHit.z);
            breakProgress = 0;
            breakKey = '';
          } else {
            cracking = true;
            const stage = Math.min(9, Math.floor(breakProgress * 10));
            atlas.crackTexture.offset.x = stage * 0.1;
            crackMesh.position.set(currentHit.x + 0.5, currentHit.y + 0.5, currentHit.z + 0.5);
          }
        }
      }
    } else {
      breakProgress = 0;
      breakKey = '';
    }
    crackMesh.visible = cracking;

    // 放置（按住以约 4.5/s 连放）
    useCooldown -= dt;
    if (useHeld && useCooldown <= 0) {
      placeBlock();
      useCooldown = 0.22;
    }
  }

  function facingText(): string {
    camera.getWorldDirection(tmpDir);
    const ax = Math.abs(tmpDir.x), az = Math.abs(tmpDir.z);
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
    hud.showItemName(hotbar.current.display);
  };

  // ---- 主循环 ----
  // 后台标签页 rAF 会被浏览器暂停，用看门狗定时器保底推进（生成/保存不中断），
  // 隐藏时跳过实际渲染以省 GPU
  const clock = new THREE.Clock();
  let physAcc = 0;
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
    debugPanel.tickFrame(dt);
    const hidden = document.hidden;

    if (state === 'loading') {
      const p = chunkManager.update(body.x, body.z, 4, 24);
      if (p >= 1) {
        state = 'ready';
        startScreen.setReady(enterWorld);
      } else {
        startScreen.setProgress(`正在生成世界… ${Math.round(p * 100)}%`, p);
      }
      sky.update(dt, camera, [chunkManager.opaqueMat, chunkManager.waterMat]);
      camera.position.set(body.x, body.y + EYE_HEIGHT, body.z);
      if (!hidden) renderer.render(scene, camera);
      return;
    }

    if (state === 'playing' && controls.locked) {
      // 物理（固定步长子迭代）
      physAcc = Math.min(physAcc + dt, 0.12);
      const input = {
        forward: (controls.keys.has('KeyW') ? 1 : 0) - (controls.keys.has('KeyS') ? 1 : 0),
        strafe: (controls.keys.has('KeyD') ? 1 : 0) - (controls.keys.has('KeyA') ? 1 : 0),
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

      updateInteraction(dt);
    }

    // 相机（冲刺时视野外扩，平滑过渡）
    camera.position.set(body.x, body.y + body.eyeHeight(), body.z);
    camera.rotation.set(controls.pitch, controls.yaw, 0);
    const targetFov = sprinting && state === 'playing' && controls.locked ? SPRINT_FOV : BASE_FOV;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
      camera.updateProjectionMatrix();
    }

    // 区块流式更新（游戏中保守预算）
    chunkManager.update(body.x, body.z, state === 'playing' ? 1 : 4, state === 'playing' ? 6 : 24);

    sky.update(dt, camera, [chunkManager.opaqueMat, chunkManager.waterMat]);
    particles.update(dt);
    hud.update(dt);
    debugPanel.update(dt, () =>
      [
        `XYZ: ${body.x.toFixed(2)} / ${body.y.toFixed(2)} / ${body.z.toFixed(2)}`,
        `区块: ${Math.floor(body.x / 16)}, ${Math.floor(body.z / 16)}  朝向: ${facingText()}`,
        `已加载区块: ${chunkManager.loadedCount}  已网格化: ${chunkManager.meshedCount}  已修改: ${modifiedChunks.size}`,
        `第 ${sky.day} 天  种子: ${seedLabel}`,
        body.flying ? '飞行中' : body.inWater ? '游泳中' : sprinting ? '冲刺中' : body.onGround ? '地面' : '空中',
      ].join('\n'),
    );

    if (!hidden) renderer.render(scene, camera);
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
