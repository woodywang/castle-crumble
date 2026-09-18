import { PHYS, type WeaponId } from '../physics/config';
import { predictTrajectory } from '../physics/Trajectory';
import type { Block } from '../physics/types';

export interface AiShot { weapon: WeaponId; angle: number; speed: number; power: number }

/**
 * AI 瞄准：直接用和玩家预瞄线同一套弹道模拟做「暴力搜索」——
 * 在若干出手速度 × 角度组合里，挑弹道离目标最近的一组，再叠加一点角度噪声当作失误。
 * 好处：完全复用真实弹道公式，不需要解析解，也自然处理了空气阻力。
 */
export function planAiShot(
  fromX: number, fromY: number, dir: 1 | -1,
  targets: Block[], groundY: number,
  enemyKing?: { x: number; y: number } | null,
): AiShot | null {
  if (!targets.length && !enemyKing) return null;

  // 目标偏好：低处、靠近己方（更容易命中）的砖块权重更高；也随机一点让 AI 不死板。
  // 敌方国王本身是高价值目标（直接命中即重伤/击杀），约 40% 概率直瞄国王。
  const candidates = targets.map((b) => ({
    pos: b.body.position,
    score: (b.body.position.y / groundY) * 2 + (1 - Math.abs(b.body.position.x - fromX) / PHYS.world.width) + Math.random() * 0.8,
  }));
  if (enemyKing) candidates.push({ pos: enemyKing, score: Math.random() < 0.4 ? 10 : 0 });
  candidates.sort((a, c) => c.score - a.score);
  const target = candidates[0].pos;

  // 武器：默认炮弹，每 3 发左右丢一次炸弹
  const weapon: WeaponId = Math.random() < 0.35 ? 'bomb' : 'cannon';
  const def = PHYS.weapons[weapon];

  let best: { angle: number; speed: number; dist: number } | null = null;
  for (let si = 0; si <= 6; si++) {
    const speed = def.minSpeed + ((def.maxSpeed - def.minSpeed) * si) / 6;
    // 只搜索朝向敌方的上半区（-80° ~ -10°）
    for (let deg = -80; deg <= -10; deg += 1.5) {
      const angle = (deg * Math.PI) / 180;
      const vx = Math.cos(angle) * speed * dir;
      const vy = Math.sin(angle) * speed;
      const pts = predictTrajectory(fromX, fromY, vx, vy, { groundY, frictionAir: def.frictionAir, steps: 160 });
      let dist = Infinity;
      for (const p of pts) {
        // 弹道越过目标 x 后的点不再考虑（会撞到目标前方的结构）
        const d = Math.hypot(p.x - target.x, p.y - target.y);
        if (d < dist) dist = d;
        if (dir === 1 ? p.x > target.x + 40 : p.x < target.x - 40) break;
      }
      if (!best || dist < best.dist) best = { angle, speed, dist };
    }
  }
  if (!best) return null;

  const noise = ((Math.random() * 2 - 1) * PHYS.duel.aiAngleNoiseDeg * Math.PI) / 180;
  const angle = best.angle + noise;
  const power = (best.speed - def.minSpeed) / Math.max(1e-6, def.maxSpeed - def.minSpeed);
  // 转成世界角度（右方 AI 朝左发射）
  const worldAngle = dir === 1 ? angle : Math.PI - angle;
  return { weapon, angle: worldAngle, speed: best.speed, power };
}
