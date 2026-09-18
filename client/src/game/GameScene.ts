import Phaser from 'phaser';
import { CastleWorld } from '../physics/CastleWorld';
import { PHYS, WEAPON_ORDER, type WeaponId } from '../physics/config';
import { LEVELS, THEMES } from '../physics/levels';
import { chargeToSpeed, predictTrajectory } from '../physics/Trajectory';
import type { Block, Fragment, LevelDef, Projectile, Side } from '../physics/types';
import { planAiShot } from './ai';
import { Effects } from './Effects';
import { InputController } from './InputController';
import { Player } from './Player';
import { generateTextures } from './textures';

export interface GameSceneData {
  levelId?: string;
  skinId?: number;
  playerName?: string;
}

export interface GameResult {
  won: boolean;
  reason: string;
  damage: number;
  enemyDamage: number;
  blocksDestroyed: number;
  myIntegrity: number;
  enemyIntegrity: number;
  mode: 'demolish' | 'duel';
}

/** 场景 → UI 的事件名（main.ts / hud.ts 订阅 game.events） */
export const EVT = {
  HUD: 'hud:update',
  OVER: 'game:over',
  WEAPON_SELECT: 'ui:weapon',
  MELEE: 'ui:melee',
} as const;

export interface HudState {
  mode: 'demolish' | 'duel';
  enemyIntegrity: number;
  myIntegrity: number;
  damage: number;
  weapon: WeaponId;
  ammo: Record<WeaponId, number>;
  unlimited: WeaponId[];
  power: number;
  charging: boolean;
  isTouch: boolean;
  myHp: number;
  enemyHp: number;
  /** 对战：当前回合提示；空字符串 = 不显示 */
  turnLabel: string;
  myTurn: boolean;
}

type Phase = 'aim' | 'flying' | 'switching' | 'aiThinking' | 'aiCharging';

const ME: Side = 'left';
const ENEMY: Side = 'right';

/**
 * 主场景：支持两种模式
 *  - duel     ：双城对轰（玩家在左、AI 在右，回合制互射）
 *  - demolish ：训练模式，单人拆右侧城堡
 * 物理由 CastleWorld 固定步长推进；本场景负责输入 → 动作、body → 精灵、特效、回合流程、HUD 事件。
 */
export class GameScene extends Phaser.Scene {
  private world!: CastleWorld;
  private level!: LevelDef;
  private me!: Player;
  private enemy: Player | null = null;
  private input2!: InputController;
  private fx!: Effects;

  private blockViews = new Map<number, Phaser.GameObjects.Rectangle>();
  private projViews = new Map<number, Phaser.GameObjects.Image>();
  private fragViews = new Map<number, Phaser.GameObjects.Rectangle>();
  private aimLine!: Phaser.GameObjects.Graphics;
  private turnText!: Phaser.GameObjects.Text;

  private weapon: WeaponId = 'cannon';
  private ammo!: Record<WeaponId, number>;
  private chargeStart: number | null = null;
  private power = 0;
  private accumulator = 0;
  private over = false;
  private skinId = 0;
  private playerName = '骑士';
  private quietSince: number | null = null;

  // 对战回合状态
  private turn: Side = ME;
  private phase: Phase = 'aim';
  private phaseAt = 0;
  private aiPlan: ReturnType<typeof planAiShot> = null;

  constructor() { super('Game'); }

  init(data: GameSceneData) {
    this.level = (LEVELS[data.levelId ?? 'duel-1'] ?? LEVELS['duel-1'])();
    this.skinId = data.skinId ?? 0;
    this.playerName = data.playerName ?? '骑士';
    this.ammo = { ...this.level.ammo };
    this.weapon = 'cannon';
    this.over = false;
    this.accumulator = 0;
    this.chargeStart = null;
    this.quietSince = null;
    this.turn = ME;
    this.phase = 'aim';
    this.aiPlan = null;
    this.enemy = null;
  }

  get isDuel() { return this.level.mode === 'duel'; }

  create() {
    generateTextures(this);
    this.drawBackground();
    this.fx = new Effects(this);

    this.world = new CastleWorld(this.level);
    for (const block of this.world.blocks.values()) this.createBlockView(block);

    // 骑士是真正的物理刚体（站在自家前塔顶上），Player 只是渲染代理
    this.me = new Player(this, this.world.getKnight(ME)!, this.skinId, this.playerName);
    if (this.isDuel) {
      const enemySkin = (this.skinId + 1) % 4;
      this.enemy = new Player(this, this.world.getKnight(ENEMY)!, enemySkin, 'AI 国王');
      this.enemy.facing = -1;
      this.enemy.aimAngle = Math.PI + Math.PI / 4;
    }

    this.aimLine = this.add.graphics().setDepth(30);
    this.turnText = this.add.text(PHYS.world.width / 2, 70, '', { fontFamily: 'sans-serif', fontSize: '26px', fontStyle: 'bold', color: '#fff', stroke: '#2c3e50', strokeThickness: 6 }).setOrigin(0.5).setDepth(60);
    this.input2 = new InputController(this, () => this.fx.unlockAudio());

    this.bindWorldEvents();
    this.game.events.on(EVT.WEAPON_SELECT, this.onUiWeapon, this);
    this.game.events.on(EVT.MELEE, this.onUiMelee, this);
    this.events.once('shutdown', () => {
      this.game.events.off(EVT.WEAPON_SELECT, this.onUiWeapon, this);
      this.game.events.off(EVT.MELEE, this.onUiMelee, this);
      this.world.destroy();
    });

    if (this.isDuel) this.announce('你的回合', '#ffe066');
    this.pushHud();
  }

  private onUiWeapon(i: number) { this.input2.requestWeapon(i); }
  private onUiMelee() { this.input2.requestMelee(); }

  /* -------------------------------------------------------------- 背景 */

  private drawBackground() {
    const theme = THEMES[this.level.theme];
    const { width, height } = PHYS.world;
    const g = this.add.graphics().setDepth(-10);
    g.fillGradientStyle(theme.sky[0], theme.sky[0], theme.sky[1], theme.sky[1], 1);
    g.fillRect(0, 0, width, height);
    g.fillStyle(0xffffff, 0.85);
    for (const [cx, cy, s] of [[180, 110, 1], [520, 70, 0.8], [900, 130, 1.2], [1150, 60, 0.7]]) {
      g.fillCircle(cx, cy, 28 * s); g.fillCircle(cx + 30 * s, cy - 10 * s, 36 * s); g.fillCircle(cx + 65 * s, cy, 26 * s);
      g.fillRect(cx - 10 * s, cy, 90 * s, 26 * s);
    }
    g.fillStyle(theme.hill, 0.6);
    g.fillEllipse(200, this.level.groundY + 40, 700, 260);
    g.fillEllipse(900, this.level.groundY + 60, 900, 300);
    g.fillStyle(theme.ground, 1);
    g.fillRect(0, this.level.groundY, width, height - this.level.groundY);
    g.fillStyle(0x000000, 0.12);
    g.fillRect(0, this.level.groundY, width, 6);
    if (this.isDuel) {
      // 中线（装饰）
      g.lineStyle(2, 0xffffff, 0.25);
      for (let y = this.level.groundY + 12; y < height; y += 16) g.lineBetween(width / 2, y, width / 2, y + 8);
    }
    this.add.text(width / 2, 22, this.level.name, { fontFamily: 'sans-serif', fontSize: '18px', color: '#ffffff', stroke: '#2c3e50', strokeThickness: 4 }).setOrigin(0.5, 0).setDepth(5);
  }

  /* -------------------------------------------------------------- 视图 */

  private createBlockView(block: Block) {
    const theme = THEMES[this.level.theme];
    const [fill, stroke] = theme.colors[block.def.material];
    const r = this.add.rectangle(block.body.position.x, block.body.position.y, block.def.w, block.def.h, fill)
      .setStrokeStyle(2, stroke, 1).setDepth(10);
    if (block.def.kind === 'flag') {
      r.setDepth(12);
      // 己方旗帜用骑士皮肤色，敌方用红色
      const isMine = this.isDuel && block.def.side === ME;
      const bannerColor = isMine ? [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f][this.skinId] : fill;
      const banner = this.add.triangle(0, 0, 0, 0, 34, 10, 0, 20, bannerColor).setOrigin(0, 0).setDepth(12);
      (r as unknown as { banner: Phaser.GameObjects.Triangle }).banner = banner;
      r.setFillStyle(0xd9a066).setStrokeStyle(2, 0x7d5222);
    }
    this.blockViews.set(block.id, r);
  }

  private createProjView(p: Projectile) {
    const img = this.add.image(p.body.position.x, p.body.position.y, `proj_${p.weapon}`).setDepth(25);
    this.projViews.set(p.id, img);
  }

  private createFragView(f: Fragment) {
    const theme = THEMES[this.level.theme];
    const [fill, stroke] = theme.colors[f.material];
    const r = this.add.rectangle(f.body.position.x, f.body.position.y, f.w, f.h, fill).setStrokeStyle(1, stroke).setDepth(9);
    this.tweens.add({ targets: r, alpha: 0, delay: PHYS.fragments.lifeMs * 0.6, duration: PHYS.fragments.lifeMs * 0.4 });
    this.fragViews.set(f.id, r);
  }

  private bindWorldEvents() {
    const theme = THEMES[this.level.theme];
    this.world.on('blockDamaged', (block, dmg, x, y) => {
      const v = this.blockViews.get(block.id);
      if (!v) return;
      const ratio = block.hp / block.maxHp;
      const [fill, stroke] = theme.colors[block.def.material];
      if (block.def.kind !== 'flag') v.setFillStyle(block.frozen ? 0x9be7ff : Phaser.Display.Color.IntegerToColor(fill).darken(Math.round((1 - ratio) * 45)).color);
      v.setStrokeStyle(2 + (1 - ratio) * 3, stroke);
      if (dmg > 25) this.popText(x, y, `-${Math.round(dmg)}`, '#ffdd57');
    });
    this.world.on('blockDestroyed', (block, x, y) => {
      const v = this.blockViews.get(block.id);
      (v as unknown as { banner?: Phaser.GameObjects.Triangle })?.banner?.destroy();
      v?.destroy();
      this.blockViews.delete(block.id);
      this.fx.shatter(x, y, theme.colors[block.def.material][0]);
    });
    this.world.on('explosion', (x, y, r) => this.fx.explosion(x, y, r));
    this.world.on('freeze', (x, y, r) => {
      this.fx.freeze(x, y, r);
      for (const b of this.world.blocks.values()) if (b.frozen) this.blockViews.get(b.id)?.setFillStyle(0x9be7ff).setStrokeStyle(2, 0x5fb8e8);
    });
    this.world.on('gravityWell', (w) => this.fx.gravityWell(w.x, w.y, w.radius, w.endsAt - this.world.time));
    this.world.on('impact', (x, y, s) => this.fx.impact(x, y, s));
    this.world.on('projectileRemoved', (p) => { this.projViews.get(p.id)?.destroy(); this.projViews.delete(p.id); });
    this.world.on('flagFallen', (side) => {
      const mine = this.isDuel && side === ME;
      this.popText(PHYS.world.width / 2, 200, mine ? '我方旗帜倒塌！' : '敌方旗帜倒塌！', mine ? '#ff6b6b' : '#ffe066', 36);
    });
    this.world.on('knightDamaged', (k, dmg, x, y) => {
      const view = k.side === ME ? this.me : this.enemy;
      view?.flashHurt();
      this.popText(x, y - 30, `-${Math.round(dmg)}`, k.side === ME ? '#ff6b6b' : '#ffe066', 22);
      this.fx.impact(x, y, 0.6);
      this.cameras.main.shake(120, 0.004);
    });
    this.world.on('knightDied', (k) => {
      const view = k.side === ME ? this.me : this.enemy;
      view?.die();
      this.fx.explosion(k.body.position.x, k.body.position.y, 60);
      this.popText(k.body.position.x, k.body.position.y - 60, k.side === ME ? '国王阵亡！' : '敌方国王阵亡！', k.side === ME ? '#ff6b6b' : '#ffe066', 30);
    });
  }

  private popText(x: number, y: number, text: string, color: string, size = 18) {
    const t = this.add.text(x, y, text, { fontFamily: 'sans-serif', fontSize: `${size}px`, fontStyle: 'bold', color, stroke: '#000', strokeThickness: 4 }).setOrigin(0.5).setDepth(60);
    this.tweens.add({ targets: t, y: y - 40, alpha: 0, duration: 800, ease: 'Cubic.Out', onComplete: () => t.destroy() });
  }

  private announce(text: string, color: string) {
    this.turnText.setText(text).setColor(color).setAlpha(1).setScale(1.3);
    this.tweens.killTweensOf(this.turnText);
    this.tweens.add({ targets: this.turnText, scale: 1, duration: 250, ease: 'Back.Out' });
    this.tweens.add({ targets: this.turnText, alpha: 0, delay: 1400, duration: 400 });
  }

  /* -------------------------------------------------------------- 主循环 */

  update(time: number, delta: number) {
    const input = this.input2.poll();

    if (input.restartRequested) { this.scene.restart({ levelId: this.level.id, skinId: this.skinId, playerName: this.playerName }); return; }

    const canAct = !this.over && (!this.isDuel || (this.turn === ME && this.phase === 'aim'));

    if (!this.over) {
      this.world.moveKnight(ME, input.moveDir);
      if (input.hasAim) this.me.setAim(input.aimX, input.aimY);
      if (input.weaponRequested !== null) this.weapon = WEAPON_ORDER[input.weaponRequested];
    } else {
      this.world.moveKnight(ME, 0);
    }

    if (canAct) {
      // 近战只在训练模式开放（对战里骑士站在自家塔顶，挥砍只会拆自己的城）
      if (!this.isDuel && input.meleeRequested && this.me.canMelee(time)) {
        this.me.playMelee(time);
        this.fx.swing();
        this.world.melee(this.me.handX, this.me.handY, this.me.facing, 'me');
      }
      if (input.charging && this.hasAmmo(this.weapon)) {
        this.chargeStart ??= time;
        this.power = Phaser.Math.Clamp((time - this.chargeStart) / PHYS.charge.durationMs, 0, 1);
      } else if (input.fireRequested && this.chargeStart !== null) {
        this.fireFrom(this.me, this.weapon, this.power, 'me');
        this.chargeStart = null;
        if (this.isDuel) this.setPhase('flying');
      } else {
        this.chargeStart = null;
        this.power = 0;
      }
    } else {
      this.chargeStart = null;
      this.power = 0;
    }

    // 固定步长物理（最多补 4 步，防止后台切回时爆炸式追帧）
    this.accumulator += Math.min(delta, 100);
    let steps = 0;
    while (this.accumulator >= PHYS.timeStepMs && steps < 4) {
      this.world.step();
      this.accumulator -= PHYS.timeStepMs;
      steps++;
    }

    if (this.isDuel && !this.over) this.updateDuel(time);

    this.syncViews();
    this.me.update();
    this.enemy?.update();
    this.drawAim(canAct && (input.charging || !this.input2.isTouch));
    this.pushHud();
    if (!this.over) this.checkEnd();
  }

  /* -------------------------------------------------------------- 对战回合流程 */

  private setPhase(p: Phase) { this.phase = p; this.phaseAt = this.time.now; }

  private updateDuel(now: number) {
    const elapsed = now - this.phaseAt;
    switch (this.phase) {
      case 'flying':
        // 等所有弹体落地、重力井结束，再留一点时间给崩塌动画
        if (this.world.isQuiet()) { this.setPhase('switching'); }
        break;
      case 'switching':
        if (elapsed >= PHYS.duel.turnSwitchDelayMs) {
          this.turn = this.turn === ME ? ENEMY : ME;
          if (this.turn === ME) { this.setPhase('aim'); this.announce('你的回合', '#ffe066'); }
          else { this.setPhase('aiThinking'); this.announce('敌方回合', '#ff8a80'); }
        }
        break;
      case 'aiThinking':
        if (elapsed >= PHYS.duel.aiThinkMs && this.enemy) {
          const king = this.world.getKnight(ME);
          this.aiPlan = planAiShot(this.enemy.handX, this.enemy.handY, -1, this.world.blocksOf(ME), this.level.groundY, king?.alive ? king.body.position : null);
          if (!this.aiPlan) { this.setPhase('switching'); break; }
          this.enemy.aimAngle = this.aiPlan.angle;
          this.enemy.facing = -1;
          this.setPhase('aiCharging');
        }
        break;
      case 'aiCharging':
        if (elapsed >= PHYS.duel.aiChargeMs && this.enemy && this.aiPlan) {
          this.fireFrom(this.enemy, this.aiPlan.weapon, this.aiPlan.power, 'ai');
          this.aiPlan = null;
          this.setPhase('flying');
        }
        break;
      case 'aim':
        break;
    }
  }

  /* -------------------------------------------------------------- 开火 */

  private isUnlimited(w: WeaponId) { return this.isDuel && (PHYS.duel.unlimitedWeapons as WeaponId[]).includes(w); }
  private hasAmmo(w: WeaponId) { return this.isUnlimited(w) || this.ammo[w] > 0; }

  private fireFrom(shooter: Player, weapon: WeaponId, power: number, ownerId: string) {
    const def = PHYS.weapons[weapon];
    const speed = chargeToSpeed(power, def.minSpeed, def.maxSpeed);
    const vx = Math.cos(shooter.aimAngle) * speed;
    const vy = Math.sin(shooter.aimAngle) * speed;
    const p = this.world.fire(weapon, shooter.handX, shooter.handY, vx, vy, ownerId, shooter.knight.side);
    this.createProjView(p);
    this.fx.shoot(power);
    shooter.playMelee(this.time.now); // 复用挥臂动画当作投掷
    if (shooter === this.me) {
      if (!this.isUnlimited(weapon)) this.ammo[weapon]--;
      this.power = 0;
      if (!this.hasAmmo(this.weapon)) {
        const next = WEAPON_ORDER.find((w) => this.hasAmmo(w));
        if (next) this.weapon = next;
      }
    }
  }

  private syncViews() {
    for (const [id, v] of this.blockViews) {
      const b = this.world.blocks.get(id);
      if (!b) continue;
      v.setPosition(b.body.position.x, b.body.position.y).setRotation(b.body.angle);
      const banner = (v as unknown as { banner?: Phaser.GameObjects.Triangle }).banner;
      if (banner) {
        const top = Phaser.Math.RotateAround({ x: b.body.position.x, y: b.body.position.y - b.def.h / 2 }, b.body.position.x, b.body.position.y, b.body.angle);
        banner.setPosition(top.x, top.y).setRotation(b.body.angle);
      }
    }
    for (const p of this.world.projectiles.values()) {
      const v = this.projViews.get(p.id) ?? (this.createProjView(p), this.projViews.get(p.id)!);
      v.setPosition(p.body.position.x, p.body.position.y).setRotation(p.body.angle);
    }
    for (const f of this.world.fragments.values()) {
      if (!this.fragViews.has(f.id)) this.createFragView(f);
      this.fragViews.get(f.id)!.setPosition(f.body.position.x, f.body.position.y).setRotation(f.body.angle);
    }
    for (const [id, v] of this.fragViews) if (!this.world.fragments.has(id)) { v.destroy(); this.fragViews.delete(id); }
  }

  /** 抛物线预瞄：虚线点，蓄力越大越亮/越长 */
  private drawAim(visible: boolean) {
    this.aimLine.clear();
    if (!visible || this.over || !this.hasAmmo(this.weapon)) return;
    const def = PHYS.weapons[this.weapon];
    const speed = chargeToSpeed(this.chargeStart !== null ? this.power : 0.5, def.minSpeed, def.maxSpeed);
    const pts = predictTrajectory(
      this.me.handX, this.me.handY,
      Math.cos(this.me.aimAngle) * speed, Math.sin(this.me.aimAngle) * speed,
      { groundY: this.level.groundY, frictionAir: def.frictionAir, steps: 140 },
    );
    const charging = this.chargeStart !== null;
    for (let i = 0; i < pts.length; i += 3) {
      const a = (1 - i / pts.length) * (charging ? 0.95 : 0.45);
      this.aimLine.fillStyle(charging ? 0xffe066 : 0xffffff, a);
      this.aimLine.fillCircle(pts[i].x, pts[i].y, charging ? 4 : 3);
    }
    if (pts.length) {
      const last = pts[pts.length - 1];
      this.aimLine.lineStyle(2, 0xff6b6b, 0.8).strokeCircle(last.x, last.y, 10);
    }
  }

  private pushHud() {
    const myTurn = !this.isDuel || (this.turn === ME && this.phase === 'aim');
    let turnLabel = '';
    if (this.isDuel) {
      turnLabel = this.turn === ME ? (this.phase === 'aim' ? '你的回合 · 瞄准开火' : '弹体飞行中…') : '敌方回合…';
    }
    const state: HudState = {
      mode: this.level.mode,
      enemyIntegrity: this.world.getIntegrity(ENEMY),
      myIntegrity: this.isDuel ? this.world.getIntegrity(ME) : 100,
      damage: Math.round(this.world.stats.damageByOwner['me'] ?? 0),
      weapon: this.weapon,
      ammo: this.ammo,
      unlimited: this.isDuel ? (PHYS.duel.unlimitedWeapons as WeaponId[]) : [],
      power: this.power,
      charging: this.chargeStart !== null,
      isTouch: this.input2.isTouch,
      myHp: this.world.getKnight(ME)?.hp ?? 0,
      enemyHp: this.world.getKnight(ENEMY)?.hp ?? 0,
      turnLabel,
      myTurn,
    };
    this.game.events.emit(EVT.HUD, state);
  }

  private checkEnd() {
    if (this.isDuel) {
      // 首要胜负条件：国王死亡（中弹 / 被砸 / 摔死）；城堡完全崩塌作为兜底
      const enemyDead = this.world.isKnightDead(ENEMY);
      const meDead = this.world.isKnightDead(ME);
      if (enemyDead && !meDead) return this.finish(true, '敌方国王阵亡！');
      if (meDead && !enemyDead) return this.finish(false, '我方国王阵亡…');
      if (meDead && enemyDead) return this.finish(false, '两位国王同归于尽…');
      const enemyDown = this.world.isCastleDown(ENEMY);
      const meDown = this.world.isCastleDown(ME);
      if (enemyDown && !meDown) return this.finish(true, this.world.isFlagFallen(ENEMY) ? '敌方国王旗帜倒塌！' : '敌方城堡结构崩塌！');
      if (meDown && !enemyDown) return this.finish(false, this.world.isFlagFallen(ME) ? '我方旗帜倒塌…' : '我方城堡崩塌…');
      if (meDown && enemyDown) return this.finish(this.world.getIntegrity(ENEMY) <= this.world.getIntegrity(ME), '两座城堡同时崩塌！');
      return;
    }
    if (this.world.isKnightDead(ME)) return this.finish(false, '骑士被砸死了…');
    if (this.world.isCastleDown(ENEMY)) {
      this.finish(true, this.world.isFlagFallen(ENEMY) ? '国王旗帜倒塌！' : '城堡结构崩塌！');
      return;
    }
    const ammoLeft = WEAPON_ORDER.reduce((s, w) => s + this.ammo[w], 0);
    if (ammoLeft === 0 && this.world.isQuiet()) {
      this.quietSince ??= this.time.now;
      if (this.time.now - this.quietSince > 2500) this.finish(false, '弹药耗尽，城堡仍然屹立');
    } else {
      this.quietSince = null;
    }
  }

  private finish(won: boolean, reason: string) {
    this.over = true;
    this.aimLine.clear();
    this.announce(won ? '胜利！' : '失败…', won ? '#ffe066' : '#ff8a80');
    this.time.delayedCall(1500, () => {
      const result: GameResult = {
        won, reason,
        mode: this.level.mode,
        damage: Math.round(this.world.stats.damageByOwner['me'] ?? 0),
        enemyDamage: Math.round(this.world.stats.damageByOwner['ai'] ?? 0),
        blocksDestroyed: this.world.stats.blocksDestroyedByOwner['me'] ?? 0,
        myIntegrity: Math.round(this.isDuel ? this.world.getIntegrity(ME) : 100),
        enemyIntegrity: Math.round(this.world.getIntegrity(ENEMY)),
      };
      this.game.events.emit(EVT.OVER, result);
    });
  }
}
