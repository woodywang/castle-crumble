import Phaser from 'phaser';
import { CastleWorld } from '../physics/CastleWorld';
import { PHYS, WEAPON_ORDER, type WeaponId } from '../physics/config';
import { LEVELS, THEMES } from '../physics/levels';
import { chargeToSpeed, predictTrajectory } from '../physics/Trajectory';
import type { Block, Fragment, LevelDef, Projectile, Side } from '../physics/types';
import type { NetClient } from '../net/NetClient';
import type { GameEvent, OverCause } from '../net/protocol';
import { planAiShot } from './ai';
import { Effects } from './Effects';
import { InputController } from './InputController';
import { Player } from './Player';
import { generateTextures } from './textures';

export interface GameSceneData {
  levelId?: string;
  skinId?: number;
  playerName?: string;
  /** 在线对战：传入已就位的 NetClient（房间已 started） */
  net?: NetClient;
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
  online: boolean;
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
  turnLabel: string;
  myTurn: boolean;
}

type Phase = 'aim' | 'flying' | 'switching' | 'aiThinking' | 'aiCharging';

const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

/**
 * 主场景：三种玩法共用一套渲染 / 回合逻辑
 *  - demolish：训练，单人拆右侧城堡
 *  - duel（本地）：左=玩家、右=AI，回合制互射
 *  - duel（在线）：两端各跑同一份确定性物理，只同步开火事件；房主每回合发快照做和解
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
  private enemyAimLine!: Phaser.GameObjects.Graphics;
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

  // 阵营
  private mySide: Side = 'left';
  private get theirSide(): Side { return other(this.mySide); }

  // 回合状态
  private turn: Side = 'left';
  private phase: Phase = 'aim';
  private phaseAt = 0;
  private aiPlan: ReturnType<typeof planAiShot> = null;

  // 在线
  private net: NetClient | null = null;
  private netOff: (() => void)[] = [];
  private pendingEvents: GameEvent[] = [];
  private remoteAim: { angle: number; power: number; charging: boolean } | null = null;
  private lastAimSent = 0;
  private overSent = false;

  constructor() { super('Game'); }

  init(data: GameSceneData) {
    this.net = data.net ?? null;
    const seed = this.net?.room?.seed ?? 1;
    const levelId = this.net ? (this.net.room?.levelId ?? 'duel-1') : (data.levelId ?? 'duel-1');
    this.level = (LEVELS[levelId] ?? LEVELS['duel-1'])(seed);
    this.skinId = data.skinId ?? 0;
    this.playerName = data.playerName ?? '骑士';
    this.mySide = this.net?.mySide ?? 'left';
    this.ammo = { ...this.level.ammo };
    this.weapon = 'cannon';
    this.over = false;
    this.overSent = false;
    this.accumulator = 0;
    this.chargeStart = null;
    this.quietSince = null;
    this.turn = 'left';
    this.phase = 'aim';
    this.aiPlan = null;
    this.enemy = null;
    this.pendingEvents = [];
    this.remoteAim = null;
  }

  get isDuel() { return this.level.mode === 'duel'; }
  get isOnline() { return !!this.net; }
  get myTurn() { return !this.isDuel || (this.turn === this.mySide && this.phase === 'aim'); }

  create() {
    generateTextures(this);
    this.drawBackground();
    this.fx = new Effects(this);

    this.world = new CastleWorld(this.level);
    for (const block of this.world.blocks.values()) this.createBlockView(block);

    // 骑士是真正的物理刚体（站在自家前塔顶上），Player 只是渲染代理
    this.me = new Player(this, this.world.getKnight(this.mySide)!, this.skinId, this.playerName);
    this.me.facing = this.mySide === 'left' ? 1 : -1;
    this.me.aimAngle = this.mySide === 'left' ? -Math.PI / 4 : Math.PI + Math.PI / 4;
    if (this.isDuel) {
      const opp = this.net?.opponent;
      const enemySkin = opp ? opp.skinId : (this.skinId + 1) % 4;
      this.enemy = new Player(this, this.world.getKnight(this.theirSide)!, enemySkin, opp ? opp.name : 'AI 国王');
      this.enemy.facing = this.theirSide === 'left' ? 1 : -1;
      this.enemy.aimAngle = this.theirSide === 'left' ? -Math.PI / 4 : Math.PI + Math.PI / 4;
    }

    this.aimLine = this.add.graphics().setDepth(30);
    this.enemyAimLine = this.add.graphics().setDepth(29);
    this.turnText = this.add.text(PHYS.world.width / 2, 70, '', { fontFamily: 'sans-serif', fontSize: '26px', fontStyle: 'bold', color: '#fff', stroke: '#2c3e50', strokeThickness: 6 }).setOrigin(0.5).setDepth(60);
    this.input2 = new InputController(this, () => this.fx.unlockAudio());

    this.bindWorldEvents();
    if (this.net) this.bindNet(this.net);
    // 调试钩子（dev 环境）：在控制台用 __cc.world / __cc.scene 检查状态
    if (import.meta.env.DEV) (window as unknown as { __cc: unknown }).__cc = { scene: this, world: this.world };
    this.game.events.on(EVT.WEAPON_SELECT, this.onUiWeapon, this);
    this.game.events.on(EVT.MELEE, this.onUiMelee, this);
    this.events.once('shutdown', () => {
      this.game.events.off(EVT.WEAPON_SELECT, this.onUiWeapon, this);
      this.game.events.off(EVT.MELEE, this.onUiMelee, this);
      for (const off of this.netOff) off();
      this.netOff = [];
      this.world.destroy();
    });

    if (this.isOnline) {
      // 在线：两端都从「右方回合结束 → 切换」开始，切换时房主发第一份快照（覆盖开局堆叠沉降差异），
      // 然后左方进入第一回合。这样第一发炮弹一定是在两端一致的状态下发出的。
      this.turn = 'right';
      this.setPhase('switching');
    } else if (this.isDuel) {
      this.announce('你的回合', '#ffe066');
    }
    this.pushHud();
  }

  private onUiWeapon(i: number) { this.input2.requestWeapon(i); }
  private onUiMelee() { this.input2.requestMelee(); }

  /* -------------------------------------------------------------- 在线事件 */

  private bindNet(net: NetClient) {
    this.netOff.push(net.on('event', (e) => {
      if (e.type === 'fire' && e.side === this.mySide) return; // 自己的开火已本地应用
      this.pendingEvents.push(e);
    }));
    this.netOff.push(net.on('aim', (p) => {
      if (p.side !== this.theirSide) return;
      this.remoteAim = p;
      if (this.enemy) this.enemy.aimAngle = p.angle;
    }));
  }

  /** 按本地回合状态消费远端事件：开火只在「轮到对方且世界静止」时应用，保证两端在同一状态下发射 */
  private drainNetEvents() {
    while (this.pendingEvents.length) {
      const e = this.pendingEvents[0];
      if (e.type === 'fire') {
        if (!(this.turn === e.side && this.phase === 'aim')) return; // 等本地回合切过去
        this.pendingEvents.shift();
        const shooter = e.side === this.mySide ? this.me : this.enemy!;
        shooter.aimAngle = e.angle;
        console.debug('[net] remote fire applied, seq', e.seq);
        this.fireFrom(shooter, e.weapon, e.power, e.side);
        this.remoteAim = null;
        this.setPhase('flying');
      } else if (e.type === 'sync') {
        if (e.side === this.mySide) { this.pendingEvents.shift(); continue; }
        // 本地也完全静止后再对齐（或本地已在等待对手 / 超时），避免把还在倒塌的砖块硬拽到位
        const waitedTooLong = this.time.now - this.phaseAt > PHYS.duel.settle.maxWaitMs;
        if (!this.world.isSettled() && !waitedTooLong) return;
        this.pendingEvents.shift();
        this.world.applySnapshot(e.snapshot);
        console.debug('[net] snapshot applied, seq', e.seq);
      } else if (e.type === 'over') {
        this.pendingEvents.shift();
        if (!this.over) this.finish(e.winner === this.mySide, this.describeCause(e.cause, e.winner === this.mySide), e.cause, false);
      }
    }
  }

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
      g.lineStyle(2, 0xffffff, 0.25);
      for (let y = this.level.groundY + 12; y < height; y += 16) g.lineBetween(width / 2, y, width / 2, y + 8);
    }
    const title = this.isOnline ? `${this.level.name} · 房间 ${this.net?.room?.code ?? ''}` : this.level.name;
    this.add.text(width / 2, 22, title, { fontFamily: 'sans-serif', fontSize: '18px', color: '#ffffff', stroke: '#2c3e50', strokeThickness: 4 }).setOrigin(0.5, 0).setDepth(5);
  }

  /* -------------------------------------------------------------- 视图 */

  private createBlockView(block: Block) {
    const theme = THEMES[this.level.theme];
    const [fill, stroke] = theme.colors[block.def.material];
    const r = this.add.rectangle(block.body.position.x, block.body.position.y, block.def.w, block.def.h, fill)
      .setStrokeStyle(2, stroke, 1).setDepth(10);
    if (block.def.kind === 'flag') {
      r.setDepth(12);
      const skins = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f];
      const isMine = this.isDuel && block.def.side === this.mySide;
      const bannerColor = isMine ? skins[this.skinId] : (this.isDuel && this.net?.opponent ? skins[this.net.opponent.skinId % 4] : fill);
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
    this.world.on('blockRevived', (block) => this.createBlockView(block));
    this.world.on('explosion', (x, y, r) => this.fx.explosion(x, y, r));
    this.world.on('freeze', (x, y, r) => {
      this.fx.freeze(x, y, r);
      for (const b of this.world.blocks.values()) if (b.frozen) this.blockViews.get(b.id)?.setFillStyle(0x9be7ff).setStrokeStyle(2, 0x5fb8e8);
    });
    this.world.on('gravityWell', (w) => this.fx.gravityWell(w.x, w.y, w.radius, w.endsAt - this.world.time));
    this.world.on('impact', (x, y, s) => this.fx.impact(x, y, s));
    this.world.on('projectileRemoved', (p) => { this.projViews.get(p.id)?.destroy(); this.projViews.delete(p.id); });
    this.world.on('flagFallen', (side) => {
      const mine = this.isDuel && side === this.mySide;
      this.popText(PHYS.world.width / 2, 200, mine ? '我方旗帜倒塌！' : '敌方旗帜倒塌！', mine ? '#ff6b6b' : '#ffe066', 36);
    });
    this.world.on('knightDamaged', (k, dmg, x, y) => {
      const view = k.side === this.mySide ? this.me : this.enemy;
      view?.flashHurt();
      if (dmg > 0) {
        this.popText(x, y - 30, `-${Math.round(dmg)}`, k.side === this.mySide ? '#ff6b6b' : '#ffe066', 22);
        this.fx.impact(x, y, 0.6);
        this.cameras.main.shake(120, 0.004);
      }
    });
    this.world.on('knightDied', (k) => {
      const view = k.side === this.mySide ? this.me : this.enemy;
      view?.die();
      this.fx.explosion(k.body.position.x, k.body.position.y, 60);
      this.popText(k.body.position.x, k.body.position.y - 60, k.side === this.mySide ? '国王阵亡！' : '敌方国王阵亡！', k.side === this.mySide ? '#ff6b6b' : '#ffe066', 30);
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

    if (input.restartRequested && !this.isOnline) { this.scene.restart({ levelId: this.level.id, skinId: this.skinId, playerName: this.playerName }); return; }

    const canAct = !this.over && this.myTurn;

    if (!this.over) {
      // 在线模式骑士不可走动：走动会改变物理状态，破坏两端一致性
      this.world.moveKnight(this.mySide, this.isOnline ? 0 : input.moveDir);
      if (input.hasAim) this.me.setAim(input.aimX, input.aimY);
      if (input.weaponRequested !== null) this.weapon = WEAPON_ORDER[input.weaponRequested];
    } else {
      this.world.moveKnight(this.mySide, 0);
    }

    if (canAct) {
      // 近战只在训练模式开放（对战里骑士站在自家塔顶，挥砍只会拆自己的城）
      if (!this.isDuel && input.meleeRequested && this.me.canMelee(time)) {
        this.me.playMelee(time);
        this.fx.swing();
        this.world.melee(this.me.handX, this.me.handY, this.me.facing, this.mySide);
      }
      if (input.charging && this.hasAmmo(this.weapon)) {
        this.chargeStart ??= time;
        this.power = Phaser.Math.Clamp((time - this.chargeStart) / PHYS.charge.durationMs, 0, 1);
      } else if (input.fireRequested && this.chargeStart !== null) {
        const power = this.power;
        this.fireFrom(this.me, this.weapon, power, this.mySide);
        this.net?.sendEvent({ type: 'fire', side: this.mySide, weapon: this.weapon, angle: this.me.aimAngle, power });
        this.chargeStart = null;
        if (this.isDuel) this.setPhase('flying');
      } else {
        this.chargeStart = null;
        this.power = 0;
      }
      // 把瞄准预览发给对手（限频）
      if (this.net && time - this.lastAimSent > 100) {
        this.lastAimSent = time;
        this.net.sendAim(this.me.aimAngle, this.power, this.chargeStart !== null);
      }
    } else {
      this.chargeStart = null;
      this.power = 0;
    }

    // 固定步长物理（最多补 4 步，防止后台切回时爆炸式追帧）。
    // 对战的「瞄准」阶段世界本来就是静止的，这时暂停步进：多人两端才能在完全相同的状态上应用开火事件
    //（否则哪一端多跑了几步，骑士/砖块的微小抖动相位不同，混沌放大后崩塌结果就会不一样）。
    const paused = this.isDuel && this.phase === 'aim' && !this.over;
    if (paused) {
      this.accumulator = 0;
    } else {
      this.accumulator += Math.min(delta, 100);
      let steps = 0;
      while (this.accumulator >= PHYS.timeStepMs && steps < 4) {
        this.world.step();
        this.accumulator -= PHYS.timeStepMs;
        steps++;
      }
    }

    if (this.isDuel && !this.over) this.updateDuel(time);
    if (this.net) this.drainNetEvents();

    this.syncViews();
    this.me.update();
    this.enemy?.update();
    this.drawAim(canAct && (input.charging || !this.input2.isTouch));
    this.drawEnemyAim();
    this.pushHud();
    // 在线模式只由房主（left）判定胜负并广播，客人等 over 事件，避免两端判定不一致
    if (!this.over && !(this.isOnline && this.mySide !== 'left')) this.checkEnd();
  }

  /* -------------------------------------------------------------- 对战回合流程 */

  private setPhase(p: Phase) { this.phase = p; this.phaseAt = this.time.now; }

  private updateDuel(now: number) {
    const elapsed = now - this.phaseAt;
    switch (this.phase) {
      case 'flying':
        // 等弹体消失且所有砖块静止（或超时兜底），再切回合；多人时这是两端状态一致的前提
        if (this.world.isSettled() || (this.world.isQuiet() && elapsed > PHYS.duel.settle.maxWaitMs)) this.setPhase('switching');
        break;
      case 'switching':
        if (elapsed >= PHYS.duel.turnSwitchDelayMs) {
          this.turn = other(this.turn);
          // 在线：房主（left）在每次回合切换时广播快照，客人据此和解。
          // 房主自己也套用同一份（四舍五入后的）快照，保证两端从字节级一致的状态继续模拟。
          if (this.net && this.mySide === 'left') {
            const snapshot = this.world.getSnapshot();
            this.world.applySnapshot(snapshot);
            this.net.sendEvent({ type: 'sync', side: 'left', snapshot });
          }
          if (this.turn === this.mySide) { this.setPhase('aim'); this.announce('你的回合', '#ffe066'); }
          else if (this.isOnline) { this.setPhase('aim'); this.announce('对手回合', '#ff8a80'); }
          else { this.setPhase('aiThinking'); this.announce('敌方回合', '#ff8a80'); }
        }
        break;
      case 'aiThinking':
        if (elapsed >= PHYS.duel.aiThinkMs && this.enemy) {
          const king = this.world.getKnight(this.mySide);
          this.aiPlan = planAiShot(this.enemy.handX, this.enemy.handY, -1, this.world.blocksOf(this.mySide), this.level.groundY, king?.alive ? king.body.position : null);
          if (!this.aiPlan) { this.setPhase('switching'); break; }
          this.enemy.aimAngle = this.aiPlan.angle;
          this.enemy.facing = -1;
          this.setPhase('aiCharging');
        }
        break;
      case 'aiCharging':
        if (elapsed >= PHYS.duel.aiChargeMs && this.enemy && this.aiPlan) {
          this.fireFrom(this.enemy, this.aiPlan.weapon, this.aiPlan.power, this.theirSide);
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

  private fireFrom(shooter: Player, weapon: WeaponId, power: number, ownerSide: Side) {
    const def = PHYS.weapons[weapon];
    const speed = chargeToSpeed(power, def.minSpeed, def.maxSpeed);
    shooter.facing = Math.cos(shooter.aimAngle) >= 0 ? 1 : -1;
    const vx = Math.cos(shooter.aimAngle) * speed;
    const vy = Math.sin(shooter.aimAngle) * speed;
    const p = this.world.fire(weapon, shooter.handX, shooter.handY, vx, vy, ownerSide, ownerSide);
    this.createProjView(p);
    this.fx.shoot(power);
    shooter.playMelee(this.time.now);
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

  private trajectoryPoints(shooter: Player, weapon: WeaponId, power: number) {
    const def = PHYS.weapons[weapon];
    const speed = chargeToSpeed(power, def.minSpeed, def.maxSpeed);
    return predictTrajectory(
      shooter.handX, shooter.handY,
      Math.cos(shooter.aimAngle) * speed, Math.sin(shooter.aimAngle) * speed,
      { groundY: this.level.groundY, frictionAir: def.frictionAir, steps: 140 },
    );
  }

  /** 抛物线预瞄：虚线点，蓄力越大越亮/越长 */
  private drawAim(visible: boolean) {
    this.aimLine.clear();
    if (!visible || this.over || !this.hasAmmo(this.weapon)) return;
    const pts = this.trajectoryPoints(this.me, this.weapon, this.chargeStart !== null ? this.power : 0.5);
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

  /** 在线：对手蓄力时显示其大致弹道（红色淡线），增加对抗感 */
  private drawEnemyAim() {
    this.enemyAimLine.clear();
    if (!this.isOnline || !this.enemy || this.over || this.turn !== this.theirSide || !this.remoteAim?.charging) return;
    const pts = this.trajectoryPoints(this.enemy, 'cannon', this.remoteAim.power);
    for (let i = 0; i < pts.length; i += 4) {
      this.enemyAimLine.fillStyle(0xff8a80, (1 - i / pts.length) * 0.35);
      this.enemyAimLine.fillCircle(pts[i].x, pts[i].y, 3);
    }
  }

  private pushHud() {
    let turnLabel = '';
    if (this.isDuel) {
      const oppName = this.isOnline ? (this.net?.opponent?.name ?? '对手') : '敌方';
      turnLabel = this.turn === this.mySide
        ? (this.phase === 'aim' ? '你的回合 · 瞄准开火' : '弹体飞行中…')
        : (this.phase === 'aim' && this.isOnline ? `${oppName} 瞄准中…` : `${oppName}回合…`);
    }
    const state: HudState = {
      mode: this.level.mode,
      enemyIntegrity: this.world.getIntegrity(this.theirSide),
      myIntegrity: this.isDuel ? this.world.getIntegrity(this.mySide) : 100,
      damage: Math.round(this.world.stats.damageByOwner[this.mySide] ?? 0),
      weapon: this.weapon,
      ammo: this.ammo,
      unlimited: this.isDuel ? (PHYS.duel.unlimitedWeapons as WeaponId[]) : [],
      power: this.power,
      charging: this.chargeStart !== null,
      isTouch: this.input2.isTouch,
      myHp: this.world.getKnight(this.mySide)?.hp ?? 0,
      enemyHp: this.world.getKnight(this.theirSide)?.hp ?? 0,
      turnLabel,
      myTurn: this.myTurn,
    };
    this.game.events.emit(EVT.HUD, state);
  }

  private checkEnd() {
    const me = this.mySide, them = this.theirSide;
    if (this.isDuel) {
      const enemyDead = this.world.isKnightDead(them);
      const meDead = this.world.isKnightDead(me);
      if (enemyDead && !meDead) return this.finish(true, this.describeCause('king', true), 'king');
      if (meDead && !enemyDead) return this.finish(false, this.describeCause('king', false), 'king');
      if (meDead && enemyDead) return this.finish(false, this.describeCause('draw', false), 'draw');
      const enemyDown = this.world.isCastleDown(them);
      const meDown = this.world.isCastleDown(me);
      if (enemyDown && !meDown) return this.finish(true, this.describeCause(this.world.isFlagFallen(them) ? 'flag' : 'castle', true), this.world.isFlagFallen(them) ? 'flag' : 'castle');
      if (meDown && !enemyDown) return this.finish(false, this.describeCause(this.world.isFlagFallen(me) ? 'flag' : 'castle', false), this.world.isFlagFallen(me) ? 'flag' : 'castle');
      if (meDown && enemyDown) { const won = this.world.getIntegrity(them) <= this.world.getIntegrity(me); return this.finish(won, this.describeCause('castle', won), 'castle'); }
      return;
    }
    if (this.world.isKnightDead(me)) return this.finish(false, '骑士被砸死了…');
    if (this.world.isCastleDown(them)) {
      this.finish(true, this.world.isFlagFallen(them) ? '国王旗帜倒塌！' : '城堡结构崩塌！');
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

  /** 把中立的结算原因翻译成本端视角的文案 */
  private describeCause(cause: OverCause, won: boolean): string {
    const opp = this.isOnline ? '对手' : '敌方';
    switch (cause) {
      case 'king': return won ? `${opp}国王阵亡！` : '我方国王阵亡…';
      case 'flag': return won ? `${opp}旗帜倒塌！` : '我方旗帜倒塌…';
      case 'castle': return won ? `${opp}城堡结构崩塌！` : '我方城堡崩塌…';
      case 'draw': return '两位国王同归于尽…';
    }
  }

  private finish(won: boolean, reason: string, cause: OverCause = 'castle', broadcast = true) {
    if (this.over) return;
    this.over = true;
    this.aimLine.clear();
    this.enemyAimLine.clear();
    this.announce(won ? '胜利！' : '失败…', won ? '#ffe066' : '#ff8a80');
    if (this.net && broadcast && !this.overSent) {
      this.overSent = true;
      this.net.sendEvent({ type: 'over', winner: won ? this.mySide : this.theirSide, cause });
    }
    this.time.delayedCall(1500, () => {
      const result: GameResult = {
        won, reason,
        mode: this.level.mode,
        online: this.isOnline,
        damage: Math.round(this.world.stats.damageByOwner[this.mySide] ?? 0),
        enemyDamage: Math.round(this.world.stats.damageByOwner[this.theirSide] ?? 0),
        blocksDestroyed: this.world.stats.blocksDestroyedByOwner[this.mySide] ?? 0,
        myIntegrity: Math.round(this.isDuel ? this.world.getIntegrity(this.mySide) : 100),
        enemyIntegrity: Math.round(this.world.getIntegrity(this.theirSide)),
      };
      this.game.events.emit(EVT.OVER, result);
    });
  }
}
