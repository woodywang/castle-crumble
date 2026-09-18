import { PHYS } from './config';

/**
 * 抛物线预瞄：复刻 Matter.js 的 Verlet 积分（固定步长），
 * 这样预瞄线和真实弹道几乎完全一致。
 *
 * Matter 每步：
 *   v = v_prev * (1 - frictionAir) + gravity * scale * dt²
 *   pos += v
 */
export function predictTrajectory(
  x: number, y: number, vx: number, vy: number,
  opts: { steps?: number; groundY: number; frictionAir?: number },
): { x: number; y: number }[] {
  const dt = PHYS.timeStepMs;
  const gravityPerStep = PHYS.gravityY * 0.001 * dt * dt; // Matter 默认 gravity.scale = 0.001
  const airK = 1 - (opts.frictionAir ?? 0);
  const steps = opts.steps ?? 120;
  const pts: { x: number; y: number }[] = [];
  let px = x, py = y, cvx = vx, cvy = vy;
  for (let i = 0; i < steps; i++) {
    cvx *= airK;
    cvy = cvy * airK + gravityPerStep;
    px += cvx;
    py += cvy;
    if (py > opts.groundY) break;
    pts.push({ x: px, y: py });
  }
  return pts;
}

/** 蓄力比例 → 出手速度 */
export function chargeToSpeed(power: number, minSpeed: number, maxSpeed: number): number {
  const p = Math.max(0, Math.min(1, power));
  return minSpeed + (maxSpeed - minSpeed) * p;
}
