import Matter from 'matter-js';
import { CATEGORY, PHYS, SIDE_GROUP, type WeaponId } from './config';
import type { Block, Fragment, GravityWell, Knight, LevelDef, Projectile, Side, WorldEvents, WorldStats } from './types';
import type { WorldSnapshot } from '../net/protocol';

/** mulberry32：小而确定的伪随机数生成器，多人两端用同一种子 → 同一序列 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { Engine, World, Bodies, Body, Events, Composite, Vector } = Matter;

/**
 * CastleWorld —— 纯 Matter.js 的权威物理世界，不依赖任何渲染库。
 *
 * 设计目标：
 *  1. 客户端渲染层（Phaser）只读取 body 位置绘图；
 *  2. 同一份代码可以在 Node 服务器上跑（多人权威物理）；
 *  3. 所有可玩性数值来自 ./config.ts。
 *
 * 职责：搭建城堡刚体、发射弹体、碰撞伤害、爆炸/冰冻/重力井、碎片、结构完整性统计。
 */
export class CastleWorld {
  readonly engine: Matter.Engine;
  readonly level: LevelDef;

  readonly blocks = new Map<number, Block>();
  readonly projectiles = new Map<number, Projectile>();
  readonly fragments = new Map<number, Fragment>();
  readonly knights = new Map<Side, Knight>();
  readonly wells: GravityWell[] = [];

  /** 世界内部时间（ms），只随 step 增加，方便服务器/客户端保持一致 */
  time = 0;

  stats: WorldStats = { damageByOwner: {}, blocksDestroyedByOwner: {}, totalDamage: 0 };

  private nextId = 1;
  private rng: () => number;
  private initialIntegrity: Record<Side, number> = { left: 0, right: 0 };
  private flagBlocks: Partial<Record<Side, Block>> = {};
  private fallenFlags = new Set<Side>();
  private listeners: { [K in keyof WorldEvents]?: WorldEvents[K][] } = {};

  /** 弹体 body.id → 拥有者，用于把伤害计到玩家头上（多人贡献统计） */
  private lastToucher = new Map<number, string>();

  constructor(level: LevelDef) {
    this.level = level;
    this.rng = mulberry32(level.seed || 1);
    this.engine = Engine.create({
      gravity: { x: 0, y: PHYS.gravityY },
      positionIterations: PHYS.positionIterations,
      velocityIterations: PHYS.velocityIterations,
      constraintIterations: PHYS.constraintIterations,
      // 注意：不能开 enableSleeping —— Matter 的休眠刚体在失去下方支撑时不会自动醒来，
      // 会出现「砖块 / 旗帜悬在半空」的 bug。城堡规模（<150 刚体）不需要休眠优化。
      enableSleeping: false,
    });
    this.buildGround();
    this.buildCastle();
    this.spawnKnights();
    this.initialIntegrity = { left: this.rawIntegrity('left'), right: this.rawIntegrity('right') };
    Events.on(this.engine, 'collisionStart', (e) => this.onCollisions(e.pairs));
  }

  /* ------------------------------------------------------------------ 事件 */

  on<K extends keyof WorldEvents>(name: K, fn: WorldEvents[K]) {
    const list = (this.listeners[name] ??= []) as WorldEvents[K][];
    list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }

  private emit<K extends keyof WorldEvents>(name: K, ...args: Parameters<WorldEvents[K]>) {
    for (const fn of this.listeners[name] ?? []) (fn as (...a: unknown[]) => void)(...args);
  }

  /* ------------------------------------------------------------------ 搭建 */

  private buildGround() {
    const { width } = PHYS.world;
    const tag = (b: Matter.Body) => { (b as unknown as { gameId: number }).gameId = this.nextId++; return b; };
    const ground = Bodies.rectangle(width / 2, this.level.groundY + 40, width * 3, 80, {
      isStatic: true, label: 'ground',
      friction: PHYS.ground.friction, restitution: PHYS.ground.restitution,
      collisionFilter: { category: CATEGORY.GROUND, mask: 0xffff },
    });
    // 左右两侧的空气墙，防止碎片飞出世界太远
    const wallL = Bodies.rectangle(-60, 0, 100, 4000, { isStatic: true, label: 'wall', collisionFilter: { category: CATEGORY.GROUND, mask: 0xffff } });
    const wallR = Bodies.rectangle(width + 60, 0, 100, 4000, { isStatic: true, label: 'wall', collisionFilter: { category: CATEGORY.GROUND, mask: 0xffff } });
    World.add(this.engine.world, [tag(ground), tag(wallL), tag(wallR)]);
  }

  /** 砖块 id → 关卡定义，供多人和解时「复活」本地误毁的砖块 */
  private blockDefs = new Map<number, import('./types').BlockDef>();

  private buildCastle() {
    for (const def of this.level.blocks) {
      const id = this.nextId++;
      this.blockDefs.set(id, def);
      this.createBlock(id, def, def.x, def.y, def.angle ?? 0, PHYS.materials[def.material].hp);
    }
  }

  private createBlock(id: number, def: import('./types').BlockDef, x: number, y: number, angle: number, hp: number): Block {
    const mat = PHYS.materials[def.material];
    const body = Bodies.rectangle(x, y, def.w, def.h, {
      label: 'block',
      density: mat.density,
      friction: mat.friction,
      frictionStatic: 1,
      restitution: mat.restitution,
      angle,
      collisionFilter: { category: CATEGORY.BLOCK, mask: 0xffff },
    });
    const block: Block = { id, body, def, hp, maxHp: mat.hp, frozen: false, originX: def.x, originY: def.y };
    (body as unknown as { gameId: number }).gameId = id;
    this.blocks.set(id, block);
    if (def.kind === 'flag') this.flagBlocks[def.side ?? 'right'] = block;
    World.add(this.engine.world, body);
    return block;
  }

  private spawnKnights() {
    const k = PHYS.knight;
    for (const side of ['left', 'right'] as Side[]) {
      const sp = this.level.spawn[side];
      if (!sp) continue;
      const body = Bodies.rectangle(sp.x, sp.y, k.width, k.height, {
        label: 'knight',
        density: k.density,
        friction: k.friction,
        frictionStatic: 1,
        restitution: 0,
        chamfer: { radius: 8 },
        collisionFilter: { category: CATEGORY.KNIGHT, mask: 0xffff, group: SIDE_GROUP[side] },
      });
      Body.setInertia(body, Infinity); // 不翻滚，站着
      (body as unknown as { gameId: number; side: Side }).gameId = this.nextId++;
      (body as unknown as { side: Side }).side = side;
      const knight: Knight = { side, body, hp: k.hp, maxHp: k.hp, alive: true, moveDir: 0 };
      this.knights.set(side, knight);
      World.add(this.engine.world, body);
    }
  }

  /* ------------------------------------------------------------------ 玩家动作 */

  /** 设置骑士行走方向（-1/0/1），在 step 中持续应用 */
  moveKnight(side: Side, dir: number) {
    const k = this.knights.get(side);
    if (k && k.alive) k.moveDir = Math.sign(dir);
  }

  getKnight(side: Side) { return this.knights.get(side); }
  isKnightDead(side: Side) { const k = this.knights.get(side); return !!k && !k.alive; }

  /** 发射弹体。速度单位为像素/步（Matter 约定）。 */
  fire(weapon: WeaponId, x: number, y: number, vx: number, vy: number, ownerId = 'p1', ownerSide?: Side): Projectile {
    const def = PHYS.weapons[weapon];
    const body = Bodies.circle(x, y, def.radius, {
      label: 'projectile',
      density: def.density,
      restitution: def.restitution,
      friction: 0.6,
      frictionAir: def.frictionAir,
      collisionFilter: {
        category: CATEGORY.PROJECTILE,
        mask: CATEGORY.GROUND | CATEGORY.BLOCK | CATEGORY.PROJECTILE | CATEGORY.KNIGHT,
        group: ownerSide ? SIDE_GROUP[ownerSide] : 0, // 与自己同组 → 不会打到自己
      },
    });
    Body.setVelocity(body, { x: vx, y: vy });
    const id = this.nextId++;
    (body as unknown as { gameId: number }).gameId = id;
    const p: Projectile = { id, body, weapon, ownerId, bornAt: this.time, restingSince: null, triggered: false };
    this.projectiles.set(id, p);
    World.add(this.engine.world, body);
    return p;
  }

  /** 近战挥砍：对 (x,y) 前方 dir 方向、range 内的砖块施加冲击 + 伤害 */
  melee(x: number, y: number, dir: 1 | -1, ownerId = 'p1'): number {
    const { range, force, damage } = PHYS.melee;
    let hits = 0;
    for (const block of this.blocks.values()) {
      const dx = block.body.position.x - x;
      const dy = block.body.position.y - y;
      if (Math.sign(dx) !== dir && Math.abs(dx) > 10) continue;
      const d = Math.hypot(dx, dy);
      if (d > range) continue;
      const falloff = 1 - d / range;
      Body.setVelocity(block.body, {
        x: block.body.velocity.x + dir * force * (0.5 + falloff),
        y: block.body.velocity.y - force * 0.6 * falloff,
      });
      Body.setAngularVelocity(block.body, block.body.angularVelocity + dir * 0.15);
      this.applyDamage(block, damage * (0.4 + 0.6 * falloff), ownerId, block.body.position.x, block.body.position.y);
      hits++;
    }
    if (hits) this.emit('impact', x + dir * 40, y, 0.4);
    return hits;
  }

  /* ------------------------------------------------------------------ 步进 */

  /** 固定步长推进一次物理。 */
  step() {
    this.time += PHYS.timeStepMs;
    this.applyGravityWells();
    this.applyKnightMovement();
    Engine.update(this.engine, PHYS.timeStepMs);
    this.updateProjectiles();
    this.updateFragments();
    this.checkFlag();
  }

  private applyKnightMovement() {
    for (const k of this.knights.values()) {
      if (!k.alive) continue;
      const b = k.body;
      if (k.moveDir !== 0) {
        Body.setVelocity(b, { x: k.moveDir * PHYS.knight.walkSpeed, y: b.velocity.y });
      } else if (Math.abs(b.velocity.x) > 0.01) {
        Body.setVelocity(b, { x: b.velocity.x * 0.6, y: b.velocity.y }); // 松手快速停下
      }
      // 掉出世界 → 直接死亡
      if (b.position.y > PHYS.world.height + 100) this.killKnight(k);
    }
  }

  private applyGravityWells() {
    for (let i = this.wells.length - 1; i >= 0; i--) {
      const w = this.wells[i];
      if (this.time > w.endsAt) { this.wells.splice(i, 1); continue; }
      for (const block of this.blocks.values()) {
        const b = block.body;
        const dx = w.x - b.position.x, dy = w.y - b.position.y;
        const d = Math.hypot(dx, dy);
        if (d > w.radius || d < 1) continue;
        const k = (w.strength * (1 - d / w.radius)) / d;
        // 重力井直接叠加速度（卡通感更强，也让沉睡中的砖块醒来）
        Body.setVelocity(b, { x: b.velocity.x + dx * k, y: b.velocity.y + dy * k });
        Matter.Sleeping.set(b, false);
      }
    }
  }

  private updateProjectiles() {
    const { maxLifeMs, sleepSpeed, sleepMs } = PHYS.projectile;
    const { width, height } = PHYS.world;
    for (const p of [...this.projectiles.values()]) {
      const b = p.body;
      const speed = Math.hypot(b.velocity.x, b.velocity.y);
      const outOfWorld = b.position.y > height + 300 || b.position.x < -400 || b.position.x > width + 400;
      if (speed < sleepSpeed) p.restingSince ??= this.time; else p.restingSince = null;
      const rested = p.restingSince !== null && this.time - p.restingSince > sleepMs;
      if (outOfWorld || rested || this.time - p.bornAt > maxLifeMs) this.removeProjectile(p);
    }
  }

  private updateFragments() {
    for (const f of [...this.fragments.values()]) {
      if (this.time - f.bornAt > PHYS.fragments.lifeMs || f.body.position.y > PHYS.world.height + 200) {
        Composite.remove(this.engine.world, f.body);
        this.fragments.delete(f.id);
      }
    }
  }

  private checkFlag() {
    for (const side of ['left', 'right'] as Side[]) {
      const flag = this.flagBlocks[side];
      if (!flag || this.fallenFlags.has(side)) continue;
      // 旗帜必须真正落到地面附近才算「倒塌」（意味着主堡已经塌掉或旗帜被打飞出去），
      // 只是被打歪、躺在屋顶上不算，避免一发炸弹碰到旗杆就秒胜。
      const dropped = flag.body.position.y > this.level.groundY - PHYS.integrity.flagGroundMargin;
      if (dropped) {
        this.fallenFlags.add(side);
        this.emit('flagFallen', side);
      }
    }
  }

  /* ------------------------------------------------------------------ 碰撞与伤害 */

  private onCollisions(pairs: Matter.Pair[]) {
    for (const pair of pairs) {
      const a = pair.bodyA, b = pair.bodyB;
      const pa = this.projectileOf(a), pb = this.projectileOf(b);
      const ba = this.blockOf(a), bb = this.blockOf(b);
      const ka = this.knightOf(a), kb = this.knightOf(b);

      // 相对法向速度 → 冲量 → 伤害
      const rel = Vector.sub(a.velocity, b.velocity);
      const normal = (pair as unknown as { collision: { normal: Matter.Vector } }).collision?.normal ?? { x: 0, y: 1 };
      const relSpeed = Math.abs(Vector.dot(rel, normal));
      const contact = this.contactPoint(pair) ?? Vector.mult(Vector.add(a.position, b.position), 0.5);

      if (relSpeed >= PHYS.damage.minRelSpeed) {
        const mass = Math.min(a.isStatic ? Infinity : a.mass, b.isStatic ? Infinity : b.mass);
        let dmg = PHYS.damage.impulseFactor * (Number.isFinite(mass) ? mass : Math.max(a.mass, b.mass)) * relSpeed;
        if (pa || pb) dmg *= PHYS.damage.projectileBonus;
        dmg = Math.min(dmg, PHYS.damage.maxPerHit);
        const owner = pa?.ownerId ?? pb?.ownerId ?? this.lastToucher.get(a.id) ?? this.lastToucher.get(b.id) ?? 'world';
        if (ba) { this.applyDamage(ba, dmg, owner, contact.x, contact.y); if (owner !== 'world') this.lastToucher.set(a.id, owner); }
        if (bb) { this.applyDamage(bb, dmg, owner, contact.x, contact.y); if (owner !== 'world') this.lastToucher.set(b.id, owner); }
        if (relSpeed > 4) this.emit('impact', contact.x, contact.y, Math.min(1, relSpeed / 25));
      }
      // 骑士受伤：被弹体命中 / 被塌落的砖砸 / 摔到地面
      if (relSpeed >= PHYS.knight.minHurtSpeed) {
        const knightDmg = (k: Knight, other: Matter.Body) => {
          const m = other.isStatic ? k.body.mass : Math.min(k.body.mass, other.mass);
          let d = PHYS.damage.impulseFactor * m * relSpeed * PHYS.knight.damageFactor;
          if (pa || pb) d *= PHYS.damage.projectileBonus;
          this.hurtKnight(k, Math.min(d, PHYS.damage.maxPerHit), contact.x, contact.y);
        };
        if (ka) knightDmg(ka, b);
        if (kb) knightDmg(kb, a);
      }

      // 特殊弹体触发（只在第一次接触时）
      if (pa && !pa.triggered) this.triggerProjectile(pa, contact.x, contact.y);
      if (pb && !pb.triggered) this.triggerProjectile(pb, contact.x, contact.y);
    }
  }

  private contactPoint(pair: Matter.Pair): Matter.Vector | null {
    const contacts = (pair as unknown as { contacts?: { vertex: Matter.Vector }[]; activeContacts?: { vertex: Matter.Vector }[] });
    const list = contacts.contacts ?? contacts.activeContacts;
    if (!list || !list.length) return null;
    let x = 0, y = 0, n = 0;
    for (const c of list) { if (!c?.vertex) continue; x += c.vertex.x; y += c.vertex.y; n++; }
    return n ? { x: x / n, y: y / n } : null;
  }

  private triggerProjectile(p: Projectile, x: number, y: number) {
    const def = PHYS.weapons[p.weapon];
    if (!def.explosion && !def.freeze && !def.gravityWell) return; // 普通炮弹：靠撞击伤害，不移除
    p.triggered = true;
    if (def.explosion) this.explode(x, y, def.explosion.radius, def.explosion.force, def.explosion.damage, p.ownerId, p.weapon);
    if (def.freeze) this.freezeArea(x, y, def.freeze.radius, def.freeze.brittle);
    if (def.gravityWell) {
      const well: GravityWell = { x, y, radius: def.gravityWell.radius, strength: def.gravityWell.strength, endsAt: this.time + def.gravityWell.durationMs };
      this.wells.push(well);
      this.emit('gravityWell', well);
    }
    this.removeProjectile(p);
  }

  /** 爆炸：范围内所有砖块 / 弹体获得径向速度 + 随距离衰减的伤害 */
  explode(x: number, y: number, radius: number, force: number, damage: number, ownerId = 'p1', weapon: WeaponId = 'bomb') {
    const victims: Matter.Body[] = [
      ...[...this.blocks.values()].map((b) => b.body),
      ...[...this.projectiles.values()].map((p) => p.body),
      ...[...this.fragments.values()].map((f) => f.body),
      ...[...this.knights.values()].filter((k) => k.alive).map((k) => k.body),
    ];
    for (const body of victims) {
      const dx = body.position.x - x, dy = body.position.y - y;
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const falloff = 1 - d / radius;
      const nx = d > 0.01 ? dx / d : 0, ny = d > 0.01 ? dy / d : -1;
      Matter.Sleeping.set(body, false);
      Body.setVelocity(body, {
        x: body.velocity.x + nx * force * falloff,
        y: body.velocity.y + (ny - 0.35) * force * falloff, // 略带向上的抛飞感
      });
      // 不用随机数：爆炸结果必须在多人两端完全一致（随机只用于纯表现的碎片）
      Body.setAngularVelocity(body, body.angularVelocity + nx * 0.3 * falloff);
      const block = this.blockOf(body);
      if (block) this.applyDamage(block, damage * falloff, ownerId, body.position.x, body.position.y);
      const knight = this.knightOf(body);
      if (knight) this.hurtKnight(knight, damage * falloff * PHYS.knight.explosionFactor, body.position.x, body.position.y);
    }
    this.emit('explosion', x, y, radius, weapon);
  }

  /** 冰冻：范围内砖块变脆（HP 乘以 brittle），后续任何碰撞更容易碎 */
  freezeArea(x: number, y: number, radius: number, brittle: number) {
    for (const block of this.blocks.values()) {
      const d = Math.hypot(block.body.position.x - x, block.body.position.y - y);
      if (d > radius || block.frozen) continue;
      block.frozen = true;
      block.hp = Math.max(1, block.hp * brittle);
      block.maxHp = Math.max(block.hp, block.maxHp * brittle);
      block.body.friction = 0.05; // 结冰打滑，更容易被推倒
      Matter.Sleeping.set(block.body, false);
    }
    this.emit('freeze', x, y, radius);
  }

  private applyDamage(block: Block, damage: number, ownerId: string, x: number, y: number) {
    if (damage <= 0 || !this.blocks.has(block.id)) return;
    const actual = Math.min(block.hp, damage);
    block.hp -= actual;
    this.stats.totalDamage += actual;
    this.stats.damageByOwner[ownerId] = (this.stats.damageByOwner[ownerId] ?? 0) + actual;
    this.emit('blockDamaged', block, actual, x, y);
    if (block.hp <= 0) this.destroyBlock(block, ownerId);
  }

  private destroyBlock(block: Block, ownerId: string) {
    this.blocks.delete(block.id);
    Composite.remove(this.engine.world, block.body);
    this.stats.blocksDestroyedByOwner[ownerId] = (this.stats.blocksDestroyedByOwner[ownerId] ?? 0) + 1;
    this.spawnFragments(block);
    this.emit('blockDestroyed', block, block.body.position.x, block.body.position.y);
  }

  private spawnFragments(block: Block) {
    if (this.fragments.size >= PHYS.fragments.maxAlive) return;
    const { perBlock } = PHYS.fragments;
    const { w, h } = block.def;
    const fw = w / 2, fh = h / 2;
    for (let i = 0; i < perBlock; i++) {
      const ox = (i % 2 === 0 ? -1 : 1) * fw * 0.5;
      const oy = (i < 2 ? -1 : 1) * fh * 0.5;
      const body = Bodies.rectangle(block.body.position.x + ox, block.body.position.y + oy, Math.max(6, fw * 0.8), Math.max(6, fh * 0.8), {
        label: 'fragment',
        density: PHYS.materials[block.def.material].density,
        friction: 0.6, restitution: 0.3, frictionAir: 0.01,
        angle: block.body.angle,
        collisionFilter: { category: CATEGORY.FRAGMENT, mask: CATEGORY.GROUND }, // 碎片只和地面碰，不再破坏其他砖
      });
      Body.setVelocity(body, {
        x: block.body.velocity.x + (this.rng() - 0.5) * 8,
        y: block.body.velocity.y - this.rng() * 6,
      });
      Body.setAngularVelocity(body, (this.rng() - 0.5) * 0.5);
      const id = this.nextId++;
      const frag: Fragment = { id, body, bornAt: this.time, material: block.def.material, w: fw * 0.8, h: fh * 0.8 };
      this.fragments.set(id, frag);
      World.add(this.engine.world, body);
    }
  }

  private removeProjectile(p: Projectile) {
    if (!this.projectiles.has(p.id)) return;
    this.projectiles.delete(p.id);
    Composite.remove(this.engine.world, p.body);
    this.emit('projectileRemoved', p);
  }

  private hurtKnight(k: Knight, damage: number, x: number, y: number) {
    if (!k.alive || damage <= 0) return;
    const actual = Math.min(k.hp, damage);
    k.hp -= actual;
    this.emit('knightDamaged', k, actual, x, y);
    if (k.hp <= 0) this.killKnight(k);
  }

  private killKnight(k: Knight) {
    if (!k.alive) return;
    k.alive = false;
    k.hp = 0;
    k.moveDir = 0;
    // 死亡后允许翻倒，变成普通尸体刚体
    Body.setInertia(k.body, k.body.mass * 400);
    Body.setAngularVelocity(k.body, (this.rng() - 0.5) * 0.3);
    this.emit('knightDied', k);
  }

  /* ------------------------------------------------------------------ 多人和解快照 */

  /** 清掉所有碎片（纯表现物，但会影响引擎求解顺序 → 同步前两端都清掉） */
  clearFragments() {
    for (const f of this.fragments.values()) Composite.remove(this.engine.world, f.body);
    this.fragments.clear();
  }

  /** 压缩快照（房主在回合结束、世界静止时生成）；同时清掉本地碎片，与客人保持同构 */
  getSnapshot(): WorldSnapshot {
    this.clearFragments();
    this.freezeAll();
    this.canonicalizeBodyOrder();
    // 注意：位置 / 角度不能四舍五入！角度差 0.005 rad 在 260px 的横梁两端就是 0.65px，
    // 套用后横梁会「插进」柱子，被求解器猛地弹开 → 整座城堡自己倒掉。全精度的 JSON 一回合也只有几 KB。
    return {
      blocks: [...this.blocks.values()].map((b) => [b.id, b.body.position.x, b.body.position.y, b.body.angle, b.hp]),
      knights: [...this.knights.values()].map((k) => [k.side === 'left' ? 0 : 1, k.body.position.x, k.body.position.y, k.hp, k.alive ? 1 : 0]),
    };
  }

  /**
   * 用房主快照校正本地世界（客人调用）。
   * 只在世界静止时调用，直接把位置 / 角度 / HP 对齐并清零速度；本地多出来的砖块视为已被摧毁。
   */
  applySnapshot(s: WorldSnapshot) {
    this.clearFragments();
    const seen = new Set<number>();
    for (const [id, x, y, angle, hp] of s.blocks) {
      let b = this.blocks.get(id);
      if (!b) {
        // 本地已经把它打碎了，但房主那边还在 → 按快照重建
        const def = this.blockDefs.get(id);
        if (!def) continue;
        b = this.createBlock(id, def, x, y, angle, hp);
        this.emit('blockRevived', b);
      }
      seen.add(id);
      Body.setPosition(b.body, { x, y });
      Body.setAngle(b.body, angle);
      Body.setVelocity(b.body, { x: 0, y: 0 });
      Body.setAngularVelocity(b.body, 0);
      if (hp !== b.hp) { b.hp = hp; this.emit('blockDamaged', b, 0, x, y); }
    }
    for (const b of [...this.blocks.values()]) if (!seen.has(b.id)) this.destroyBlock(b, 'sync');
    this.clearFragments(); // destroyBlock 又会生成碎片，再清一次
    for (const [sideIdx, x, y, hp, alive] of s.knights) {
      const k = this.knights.get(sideIdx === 0 ? 'left' : 'right');
      if (!k) continue;
      Body.setPosition(k.body, { x, y });
      Body.setVelocity(k.body, { x: 0, y: 0 });
      if (hp !== k.hp) { k.hp = hp; this.emit('knightDamaged', k, 0, x, y); }
      if (!alive && k.alive) this.killKnight(k);
    }
    this.freezeAll(); // 速度 / 受力归零 + 清接触缓存，之后两端从同一静止状态继续
    this.canonicalizeBodyOrder();
    this.checkFlag();
  }

  /**
   * 把引擎里的刚体数组按 gameId 排序。
   * 两端创建 / 销毁历史不同会导致数组顺序不同 → 碰撞对顺序不同 → 求解结果有微小差异 → 混沌放大。
   */
  private canonicalizeBodyOrder() {
    const bodies = this.engine.world.bodies;
    bodies.sort((a, b) => ((a as unknown as { gameId?: number }).gameId ?? 0) - ((b as unknown as { gameId?: number }).gameId ?? 0));
    (Composite as unknown as { setModified: (c: Matter.Composite, m: boolean, p: boolean, ch: boolean) => void }).setModified(this.engine.world, true, true, false);
  }

  /* ------------------------------------------------------------------ 查询 */

  private knightOf(body: Matter.Body): Knight | undefined {
    if (body.label !== 'knight') return undefined;
    return this.knights.get((body as unknown as { side: Side }).side);
  }

  private blockOf(body: Matter.Body): Block | undefined {
    if (body.label !== 'block') return undefined;
    return this.blocks.get((body as unknown as { gameId: number }).gameId);
  }

  private projectileOf(body: Matter.Body): Projectile | undefined {
    if (body.label !== 'projectile') return undefined;
    return this.projectiles.get((body as unknown as { gameId: number }).gameId);
  }

  /** 未加权的完整性：某一侧在位砖块的剩余 HP 之和 */
  private rawIntegrity(side: Side): number {
    let sum = 0;
    for (const block of this.blocks.values()) {
      if (block.def.kind === 'flag' || (block.def.side ?? 'right') !== side) continue;
      const moved = Math.hypot(block.body.position.x - block.originX, block.body.position.y - block.originY);
      if (moved > PHYS.integrity.displacement) continue;
      sum += block.hp;
    }
    return sum;
  }

  /** 某一侧城堡的结构完整性百分比 0..100（单城模式城堡在 right） */
  getIntegrity(side: Side = 'right'): number {
    const init = this.initialIntegrity[side];
    if (init <= 0) return 0;
    return Math.max(0, Math.min(100, (this.rawIntegrity(side) / init) * 100));
  }

  isFlagFallen(side: Side = 'right') { return this.fallenFlags.has(side); }

  /** 某一侧城堡是否已判定崩塌 */
  isCastleDown(side: Side = 'right'): boolean {
    return this.isFlagFallen(side) || this.getIntegrity(side) <= PHYS.integrity.winPercent;
  }

  /** 某一侧仍在场的砖块（AI 选目标用） */
  blocksOf(side: Side): Block[] {
    return [...this.blocks.values()].filter((b) => (b.def.side ?? 'right') === side && b.def.kind !== 'flag');
  }

  /** 是否所有弹体都已落地/消失（用于「弹药耗尽后等结算」） */
  isQuiet(): boolean {
    return this.projectiles.size === 0 && this.wells.length === 0;
  }

  /**
   * 世界是否已「完全静止」：无弹体，且所有砖块 / 骑士的速度都低于阈值。
   * 多人回合切换、打快照都必须在这个状态下进行，否则两端会从不同状态继续模拟而分叉。
   */
  isSettled(): boolean {
    if (!this.isQuiet()) return false;
    const { linear, angular } = PHYS.duel.settle;
    for (const b of this.blocks.values()) {
      const v = b.body.velocity;
      if (Math.abs(v.x) > linear || Math.abs(v.y) > linear || Math.abs(b.body.angularVelocity) > angular) return false;
    }
    for (const k of this.knights.values()) {
      const v = k.body.velocity;
      if (Math.abs(v.x) > linear || Math.abs(v.y) > linear) return false;
    }
    return true;
  }

  /** 强制静止：清零所有砖块 / 骑士速度与受力（打快照的一方调用，让本地状态与快照完全一致） */
  freezeAll() {
    for (const b of this.blocks.values()) {
      Body.setVelocity(b.body, { x: 0, y: 0 }); Body.setAngularVelocity(b.body, 0);
      b.body.force = { x: 0, y: 0 }; b.body.torque = 0;
    }
    for (const k of this.knights.values()) { Body.setVelocity(k.body, { x: 0, y: 0 }); k.body.force = { x: 0, y: 0 }; }
    this.resetContacts();
  }

  /**
   * 清空求解器的接触对缓存。
   * Matter 的 Resolver 会用上一帧接触的冲量做「热启动」；砖块被快照瞬移后，
   * 旧冲量会套到新的排布上，等于给整个结构来一脚 → 城堡莫名其妙自己塌掉。
   */
  private resetContacts() {
    Matter.Pairs.clear(this.engine.pairs);
  }

  destroy() {
    Events.off(this.engine, 'collisionStart');
    World.clear(this.engine.world, false);
    Engine.clear(this.engine);
    this.listeners = {};
  }
}
