import type { BlockDef, LevelDef, Side, ThemeId } from './types';
import type { Material } from './config';
import { PHYS } from './config';

/** 城堡主题配色：材质 → [填充色, 描边色] */
export const THEMES: Record<ThemeId, { name: string; sky: [number, number]; ground: number; hill: number; colors: Record<Material, [number, number]> }> = {
  stone: {
    name: '石头城堡', sky: [0x6fb7ff, 0xcfeaff], ground: 0x5dbb63, hill: 0x4aa653,
    colors: { stone: [0x9aa5b1, 0x5f6b78], wood: [0xb5773a, 0x7a4b1f], ice: [0xa8e4ff, 0x5fb8e8], mud: [0xc9955c, 0x8a6236], flag: [0xe74c3c, 0xa93226] },
  },
  wood: {
    name: '木头哨塔', sky: [0x87c5ff, 0xe3f3ff], ground: 0x6cbf5c, hill: 0x4e9e48,
    colors: { stone: [0x8f9aa5, 0x59636e], wood: [0xc98a48, 0x7d5222], ice: [0xa8e4ff, 0x5fb8e8], mud: [0xc9955c, 0x8a6236], flag: [0x2ecc71, 0x1e8449] },
  },
  desert: {
    name: '沙漠泥砖', sky: [0xffc178, 0xffe8c4], ground: 0xe8c17a, hill: 0xd4a85e,
    colors: { stone: [0xb8a48c, 0x7d6b55], wood: [0xa8703a, 0x6b431c], ice: [0xa8e4ff, 0x5fb8e8], mud: [0xd9a066, 0x94632f], flag: [0x9b59b6, 0x6c3483] },
  },
  ice: {
    name: '冰雪堡垒', sky: [0x9ec9ff, 0xf0f8ff], ground: 0xe8f4ff, hill: 0xc7dcf0,
    colors: { stone: [0x8fa3b8, 0x56697d], wood: [0x9c7a55, 0x5e4630], ice: [0xbfeaff, 0x63b9ea], mud: [0xc9955c, 0x8a6236], flag: [0x3498db, 0x1f618d] },
  },
};

/* ---------- 布局辅助 ----------
 * Builder 以「原点 x + 方向 dir」工作：dir = 1 向右展开，dir = -1 镜像向左展开，
 * 这样同一段城堡描述可以直接生成左右对称的两座城堡。
 */

const BRICK = 40;

interface Builder { blocks: BlockDef[]; groundY: number; originX: number; dir: 1 | -1; side: Side }

function px(b: Builder, localX: number) { return b.originX + b.dir * localX; }

function add(b: Builder, localX: number, y: number, w: number, h: number, material: Material, kind?: 'block' | 'flag') {
  b.blocks.push({ side: b.side, x: px(b, localX), y, w, h, material, kind });
}

/** 叠一列砖块：cols 列 × rows 行，返回顶部 y。localLeft 为局部坐标左边缘 */
function tower(b: Builder, localLeft: number, cols: number, rows: number, material: Material, baseY = b.groundY, size = BRICK): number {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      add(b, localLeft + c * size + size / 2, baseY - r * size - size / 2, size, size, material);
    }
  }
  return baseY - rows * size;
}

/** 一层「柱子 + 横梁」结构（Angry Birds 式，容易连锁倒） */
function floor(b: Builder, localLeft: number, width: number, baseY: number, pillarH: number, pillarCount: number, pillarMat: Material, beamMat: Material): number {
  const pillarW = 20, beamH = 20;
  for (let i = 0; i < pillarCount; i++) {
    const lx = pillarCount === 1 ? localLeft + width / 2 : localLeft + pillarW / 2 + (i * (width - pillarW)) / (pillarCount - 1);
    add(b, lx, baseY - pillarH / 2, pillarW, pillarH, pillarMat);
  }
  add(b, localLeft + width / 2, baseY - pillarH - beamH / 2, width, beamH, beamMat);
  return baseY - pillarH - beamH;
}

function flag(b: Builder, localX: number, baseY: number) {
  add(b, localX, baseY - 45, 8, 90, 'flag', 'flag');
}

/**
 * 标准城堡（局部坐标 0 → 约 340 宽）：
 *  前塔（靠近敌方）+ 中央主堡（柱梁三层 + 顶部小屋 + 国王旗帜）+ 后塔
 * dir 决定展开方向：左方城堡 dir = 1（原点在最左），右方城堡 dir = -1（原点在最右）。
 */
function standardCastle(b: Builder) {
  // 后塔（远离敌方一侧）：3 × 4 石砖 + 木梁顶
  let top = tower(b, 0, 3, 4, 'stone');
  add(b, 60, top - 10, 150, 20, 'wood');
  add(b, 25, top - 40, 40, 40, 'stone');
  add(b, 95, top - 40, 40, 40, 'stone');

  // 中央主堡
  let y = floor(b, 130, 220, b.groundY, 90, 3, 'stone', 'wood');
  y = floor(b, 145, 190, y, 75, 3, 'stone', 'wood');
  y = floor(b, 170, 140, y, 60, 2, 'wood', 'wood');
  const keepTop = tower(b, 200, 2, 2, 'stone', y);
  add(b, 240, keepTop - 10, 110, 20, 'wood');
  flag(b, 240, keepTop - 20);

  // 前塔（面向敌方）：石 2 层 + 冰 1 层（弱点）+ 石 2 层
  top = tower(b, 360, 2, 2, 'stone');
  top = tower(b, 360, 2, 1, 'ice', top);
  top = tower(b, 360, 2, 2, 'stone', top);
  add(b, 400, top - 10, 100, 20, 'wood');
}

const fullAmmo = () => ({
  cannon: PHYS.weapons.cannon.ammo, bomb: PHYS.weapons.bomb.ammo,
  freeze: PHYS.weapons.freeze.ammo, gravity: PHYS.weapons.gravity.ammo, blast: PHYS.weapons.blast.ammo,
});

/* ---------- 关卡：双城对轰（主模式） ---------- */

export function buildDuelLevel(theme: ThemeId = 'stone', seed = 1): LevelDef {
  const groundY = 640;
  const { width } = PHYS.world;
  const left: Builder = { blocks: [], groundY, originX: 30, dir: 1, side: 'left' };
  const right: Builder = { blocks: [], groundY, originX: width - 30, dir: -1, side: 'right' };
  standardCastle(left);
  standardCastle(right);
  return {
    id: 'duel-1',
    name: '双城对轰',
    theme,
    groundY,
    mode: 'duel',
    seed,
    // 骑士（国王）站在各自城堡的前塔顶上：前塔 5 层砖 + 木梁 → 梁顶 = groundY - 220
    spawn: {
      left: { x: 30 + 400, y: groundY - 220 - PHYS.knight.height / 2 - 1 },
      right: { x: width - 30 - 400, y: groundY - 220 - PHYS.knight.height / 2 - 1 },
    },
    blocks: [...left.blocks, ...right.blocks],
    ammo: fullAmmo(),
  };
}

/* ---------- 关卡：单城拆除（训练模式） ---------- */

export function buildDemolishLevel(): LevelDef {
  const groundY = 640;
  const b: Builder = { blocks: [], groundY, originX: PHYS.world.width - 60, dir: -1, side: 'right' };
  standardCastle(b);
  return {
    id: 'demolish-1',
    name: '训练 · 拆城堡',
    theme: 'stone',
    groundY,
    mode: 'demolish',
    seed: 1,
    spawn: { left: { x: 150, y: groundY - PHYS.knight.height / 2 - 1 } },
    blocks: b.blocks,
    ammo: fullAmmo(),
  };
}

export const LEVELS: Record<string, (seed?: number) => LevelDef> = {
  'duel-1': (seed) => buildDuelLevel('stone', seed ?? 1),
  'demolish-1': () => buildDemolishLevel(),
};
