import Phaser from 'phaser';
import type { Knight } from '../physics/types';

/**
 * 玩家 / AI 骑士的渲染代理：位置完全跟随 CastleWorld 里的骑士刚体。
 * 负责：贴图、剑的朝向与挥砍动画、头顶名字 + HP 条、死亡表现。
 */
export class Player {
  readonly container: Phaser.GameObjects.Container;
  private sprite: Phaser.GameObjects.Image;
  private sword: Phaser.GameObjects.Image;
  private nameTag: Phaser.GameObjects.Text;
  private hpBar: Phaser.GameObjects.Graphics;
  facing: 1 | -1 = 1;
  aimAngle = -Math.PI / 4; // 弧度，屏幕坐标系（y 向下）
  private lastMelee = -Infinity;
  private dead = false;

  constructor(private scene: Phaser.Scene, readonly knight: Knight, skinId: number, name: string) {
    this.sprite = scene.add.image(0, 0, `knight_${skinId}`);
    this.sword = scene.add.image(18, 6, 'sword').setOrigin(0.05, 0.5);
    this.nameTag = scene.add.text(0, -54, name, { fontFamily: 'sans-serif', fontSize: '14px', color: '#fff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5);
    this.hpBar = scene.add.graphics();
    this.container = scene.add.container(knight.body.position.x, knight.body.position.y, [this.sword, this.sprite, this.nameTag, this.hpBar]).setDepth(20);
    this.drawHp();
  }

  get x() { return this.knight.body.position.x; }
  get y() { return this.knight.body.position.y; }
  /** 出手点（世界坐标） */
  get handX() { return this.x + this.facing * 22; }
  get handY() { return this.y - 8; }

  setAim(targetX: number, targetY: number) {
    this.aimAngle = Math.atan2(targetY - this.handY, targetX - this.handX);
    this.facing = targetX >= this.x ? 1 : -1;
  }

  canMelee(now: number) { return !this.dead && now - this.lastMelee >= 450; }

  playMelee(now: number) {
    this.lastMelee = now;
    this.scene.tweens.killTweensOf(this.sword);
    const base = this.sword.rotation;
    this.scene.tweens.add({
      targets: this.sword, rotation: { from: base - 1.6 * this.facing, to: base + 1.2 * this.facing },
      duration: 160, ease: 'Cubic.Out', yoyo: true,
    });
  }

  /** 受击闪红 */
  flashHurt() {
    this.sprite.setTint(0xff6b6b);
    this.scene.time.delayedCall(120, () => { if (!this.dead) this.sprite.clearTint(); });
    this.drawHp();
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.sprite.setTint(0x888888);
    this.sword.setVisible(false);
    this.hpBar.clear();
    this.nameTag.setText(`${this.nameTag.text} ☠`);
  }

  private drawHp() {
    const g = this.hpBar;
    g.clear();
    const w = 44, h = 6, ratio = Math.max(0, this.knight.hp / this.knight.maxHp);
    g.fillStyle(0x000000, 0.6).fillRoundedRect(-w / 2 - 1, -45, w + 2, h + 2, 3);
    g.fillStyle(ratio > 0.5 ? 0x2ecc71 : ratio > 0.25 ? 0xf1c40f : 0xe74c3c, 1).fillRoundedRect(-w / 2, -44, w * ratio, h, 2);
  }

  update() {
    const b = this.knight.body;
    this.container.setPosition(b.position.x, b.position.y).setRotation(this.dead ? b.angle : 0);
    this.sprite.setFlipX(this.facing < 0);
    this.sword.setPosition(this.facing * 18, 6);
    if (!this.scene.tweens.isTweening(this.sword)) this.sword.rotation = this.aimAngle;
    this.sword.setFlipY(this.facing < 0);
  }

  destroy() { this.container.destroy(); }
}
