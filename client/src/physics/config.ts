/**
 * 物理 & 玩法参数集中配置。
 * 所有数值（重力、砖块血量、爆炸半径、武器速度…）都在这里调，其他文件不要写魔法数字。
 *
 * 单位说明（Matter.js 约定）：
 *  - 长度：像素
 *  - 速度：像素 / 步（1 步 = 1000/60 ms）
 *  - 质量 = 密度 × 面积
 */

export type Material = 'stone' | 'wood' | 'ice' | 'mud' | 'flag';
export type WeaponId = 'cannon' | 'bomb' | 'freeze' | 'gravity' | 'blast';

export interface MaterialDef {
  density: number;
  hp: number;
  friction: number;
  restitution: number;
}

export interface ExplosionDef {
  radius: number;   // 作用半径（像素）
  force: number;    // 中心处施加的速度增量（像素/步）
  damage: number;   // 中心处伤害，随距离线性衰减
}

export interface WeaponDef {
  label: string;
  icon: string;
  radius: number;      // 弹体半径
  density: number;
  minSpeed: number;    // 蓄力 0% 时的出手速度
  maxSpeed: number;    // 蓄力 100% 时的出手速度
  ammo: number;        // 默认弹药数
  restitution: number;
  frictionAir: number;
  explosion?: ExplosionDef;                // 撞击后爆炸（炸弹 / 大爆炸）
  freeze?: { radius: number; brittle: number };   // 冰冻：范围内砖块血量乘以 brittle（变脆）
  gravityWell?: { radius: number; strength: number; durationMs: number }; // 重力井：持续吸引
}

export const PHYS = {
  /** 固定步长（ms）。客户端和服务器都用同一个值，方便后续做权威同步。 */
  timeStepMs: 1000 / 60,
  gravityY: 1,

  /** 求解器迭代次数：越高城堡越稳、越不抖，代价是 CPU。 */
  positionIterations: 8,
  velocityIterations: 6,
  constraintIterations: 2,

  /** 世界尺寸（逻辑坐标，渲染会按比例缩放） */
  world: { width: 1280, height: 720 },

  ground: { friction: 1, restitution: 0 },

  materials: {
    stone: { density: 0.004, hp: 120, friction: 0.9, restitution: 0.05 },
    wood:  { density: 0.002, hp: 70,  friction: 0.8, restitution: 0.1 },
    ice:   { density: 0.003, hp: 45,  friction: 0.3, restitution: 0.1 },
    mud:   { density: 0.003, hp: 60,  friction: 0.9, restitution: 0.02 },
    flag:  { density: 0.002, hp: 9999, friction: 0.9, restitution: 0.05 }, // 旗帜不可摧毁，只能让它掉下来
  } as Record<Material, MaterialDef>,

  /** 碰撞伤害模型：damage = impulseFactor × min(massA, massB) × 相对法向速度 */
  damage: {
    impulseFactor: 0.7,
    minRelSpeed: 1.6,        // 低于此速度的碰撞不算伤害（防止静止堆叠抖动掉血）
    projectileBonus: 1.6,    // 弹体直接命中的额外倍率
    maxPerHit: 400,
  },

  weapons: {
    cannon: {
      label: '炮弹', icon: '●', radius: 12, density: 0.02,
      minSpeed: 12, maxSpeed: 30, ammo: 6, restitution: 0.2, frictionAir: 0,
    },
    bomb: {
      label: '炸弹', icon: '💣', radius: 11, density: 0.008,
      minSpeed: 10, maxSpeed: 26, ammo: 4, restitution: 0.1, frictionAir: 0,
      explosion: { radius: 120, force: 16, damage: 140 },
    },
    freeze: {
      label: '冰冻', icon: '❄', radius: 10, density: 0.005,
      minSpeed: 10, maxSpeed: 26, ammo: 1, restitution: 0, frictionAir: 0,
      freeze: { radius: 150, brittle: 0.3 },
    },
    gravity: {
      label: '重力井', icon: '🌀', radius: 10, density: 0.005,
      minSpeed: 10, maxSpeed: 26, ammo: 1, restitution: 0, frictionAir: 0,
      gravityWell: { radius: 240, strength: 0.45, durationMs: 2500 },
    },
    blast: {
      label: '大爆炸', icon: '☄', radius: 13, density: 0.008,
      minSpeed: 10, maxSpeed: 26, ammo: 1, restitution: 0.1, frictionAir: 0,
      explosion: { radius: 210, force: 24, damage: 240 },
    },
  } as Record<WeaponId, WeaponDef>,

  /**
   * 骑士（国王）：真正的动态刚体，站在自家城堡上。
   * 被炮弹直接命中、被塌下来的砖块砸到、从高处摔下都会掉血，HP 归零即死亡 → 对方获胜。
   */
  knight: {
    hp: 100,
    width: 34, height: 56,
    density: 0.003,
    friction: 0.9,
    damageFactor: 1.0,        // 碰撞伤害倍率（相对砖块公式）
    explosionFactor: 0.8,     // 爆炸伤害倍率
    minHurtSpeed: 3,          // 低于此相对速度的碰撞不掉血（走路/轻微晃动）
    walkSpeed: 4,             // 像素/步
  },

  /** 近战挥砍 */
  melee: { range: 90, force: 10, damage: 70, cooldownMs: 450 },

  /** 砖块碎裂后的碎片 */
  fragments: { perBlock: 4, lifeMs: 2200, maxAlive: 120 },

  /**
   * 结构完整性：
   *  - 每块砖按剩余 HP 计入；
   *  - 位移超过 displacement 像素（被推倒/掉落）视为贡献 0；
   *  - 完整性 ≤ winPercent 判定城堡「崩塌」获胜；
   *  - 国王旗帜落到离地面 flagGroundMargin 像素以内（真正掉到地上）也直接获胜。
   */
  integrity: { displacement: 45, winPercent: 10, flagGroundMargin: 70 },

  /** 双城对战 */
  duel: {
    turnSwitchDelayMs: 1400,   // 弹体落地/爆炸后多久切换回合
    aiThinkMs: 900,            // AI 开火前的思考时间
    aiChargeMs: 1000,          // AI 蓄力表演时间
    aiAngleNoiseDeg: 4,        // AI 瞄准误差（越小越准）
    unlimitedWeapons: ['cannon', 'bomb'] as WeaponId[], // 对战中无限弹药的武器
  },

  /** 蓄力：从 0 到满蓄力所需时间 */
  charge: { durationMs: 1100 },

  /** 弹体存活：落地静止或超时后移除 */
  projectile: { maxLifeMs: 4000, sleepSpeed: 0.6, sleepMs: 700 },
} as const;

export const WEAPON_ORDER: WeaponId[] = ['cannon', 'bomb', 'freeze', 'gravity', 'blast'];

/** 碰撞分组位掩码 */
export const CATEGORY = {
  GROUND: 0x0001,
  BLOCK: 0x0002,
  PROJECTILE: 0x0004,
  FRAGMENT: 0x0008,
  KNIGHT: 0x0010,
} as const;

/** 碰撞组：同一负数组内的刚体互不碰撞 —— 让自己发出的弹体不会打到自己 */
export const SIDE_GROUP = { left: -1, right: -2 } as const;
