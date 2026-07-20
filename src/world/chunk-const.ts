// ============================================================
// 区块尺寸常量（独立模块，无依赖）：
// 单独抽出以避免 worldgen ↔ village/stronghold 之间因常量值 import
// 形成的运行时循环 import（在原生 ESM Worker 中会触发 TDZ / undefined）。
// ============================================================

export const CHUNK_X = 16;
export const CHUNK_Y = 128;
export const CHUNK_Z = 16;
