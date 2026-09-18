import type Matter from 'matter-js';
import type { Material, WeaponId } from './config';

export type ThemeId = 'stone' | 'wood' | 'desert' | 'ice';

export type Side = 'left' | 'right';

export interface BlockDef {
  /** 所属阵营（对战模式）；单城模式全部为 'right' */
  side?: Side;
  x: number;       // 中心 x
  y: number;       // 中心 y
  w: number;
  h: number;
  material: Material;
  /** flag = 国王旗帜（倒塌即胜利） */
  kind?: 'block' | 'flag';
  angle?: number;
}

/** 地形：两城之间的山（静态凸多边形，顶点顺时针，世界坐标） */
export interface TerrainDef {
  vertices: { x: number; y: number }[];
  /** 雪顶高度（渲染用，0 = 无雪） */
  snowFrom?: number;
}

export interface LevelDef {
  id: string;
  name: string;
  theme: ThemeId;
  groundY: number;
  /** 各阵营骑士出生点（刚体中心）；单城模式只用 left */
  spawn: Partial<Record<Side, { x: number; y: number }>>;
  /** 对战模式：两座城堡；单城模式：只有 right 有城堡 */
  mode: 'demolish' | 'duel';
  /** 随机种子：多人时两端必须一致，保证碎片 / 爆炸的随机量相同 */
  seed: number;
  /** 可选地形（山体等静态障碍） */
  terrain?: TerrainDef[];
  blocks: BlockDef[];
  ammo: Record<WeaponId, number>;
}

export interface Block {
  id: number;
  body: Matter.Body;
  def: BlockDef;
  hp: number;
  maxHp: number;
  frozen: boolean;
  originX: number;
  originY: number;
}

export interface Knight {
  side: Side;
  body: Matter.Body;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 当前行走方向 -1/0/1 */
  moveDir: number;
}

export interface Projectile {
  id: number;
  body: Matter.Body;
  weapon: WeaponId;
  ownerId: string;
  bornAt: number;
  restingSince: number | null;
  triggered: boolean;
}

export interface Fragment {
  id: number;
  body: Matter.Body;
  bornAt: number;
  material: Material;
  w: number;
  h: number;
}

export interface GravityWell {
  x: number;
  y: number;
  radius: number;
  strength: number;
  endsAt: number;
}

/** CastleWorld 对外抛出的事件（渲染层 / 网络层订阅） */
export interface WorldEvents {
  blockDamaged: (block: Block, damage: number, x: number, y: number) => void;
  blockDestroyed: (block: Block, x: number, y: number) => void;
  /** 多人和解：本地已毁但房主仍在的砖块被重建 */
  blockRevived: (block: Block) => void;
  explosion: (x: number, y: number, radius: number, weapon: WeaponId) => void;
  freeze: (x: number, y: number, radius: number) => void;
  gravityWell: (well: GravityWell) => void;
  projectileRemoved: (p: Projectile) => void;
  impact: (x: number, y: number, strength: number) => void;
  flagFallen: (side: Side) => void;
  knightDamaged: (knight: Knight, damage: number, x: number, y: number) => void;
  knightDied: (knight: Knight) => void;
}

export interface WorldStats {
  damageByOwner: Record<string, number>;
  blocksDestroyedByOwner: Record<string, number>;
  totalDamage: number;
}
