import Phaser from 'phaser';

/**
 * 统一 PC + 手机输入：
 *  PC  ：A/D 或 ←/→ 移动；鼠标移动瞄准；按住左键蓄力、松开发射；空格近战；1-5 切武器；R 重开
 *  手机：屏幕左下 1/3 区域为虚拟摇杆（拖动控制左右）；其余区域按住即蓄力并跟随手指瞄准，松开发射
 *
 * 输出一个「意图」快照，GameScene 不关心具体来源。
 */
export interface InputState {
  moveDir: number;                 // -1 / 0 / 1
  aimX: number; aimY: number;      // 世界坐标
  charging: boolean;
  fireRequested: boolean;          // 本帧松手发射
  meleeRequested: boolean;
  weaponRequested: number | null;  // 0..4
  restartRequested: boolean;
  hasAim: boolean;
}

export class InputController {
  readonly isTouch: boolean;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private state: InputState = { moveDir: 0, aimX: 0, aimY: 0, charging: false, fireRequested: false, meleeRequested: false, weaponRequested: null, restartRequested: false, hasAim: false };
  private joystickPointer: Phaser.Input.Pointer | null = null;
  private aimPointer: Phaser.Input.Pointer | null = null;
  private joyStartX = 0;
  private touchMove = 0;
  private pendingFire = false;
  private pendingMelee = false;
  private pendingWeapon: number | null = null;
  private pendingRestart = false;
  /** 摇杆 UI（仅手机） */
  private joyBase?: Phaser.GameObjects.Arc;
  private joyKnob?: Phaser.GameObjects.Arc;

  constructor(private scene: Phaser.Scene, private onFirstInteraction: () => void) {
    this.isTouch = scene.sys.game.device.input.touch && !scene.sys.game.device.os.desktop;
    scene.input.addPointer(2);

    const kb = scene.input.keyboard;
    if (kb) {
      this.keys = kb.addKeys('A,D,LEFT,RIGHT,SPACE,ONE,TWO,THREE,FOUR,FIVE,R') as Record<string, Phaser.Input.Keyboard.Key>;
      kb.on('keydown-SPACE', () => { this.pendingMelee = true; });
      kb.on('keydown-R', () => { this.pendingRestart = true; });
      ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].forEach((k, i) => kb.on(`keydown-${k}`, () => { this.pendingWeapon = i; }));
    }

    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.onFirstInteraction();
      if (this.isTouch && this.inJoystickZone(p)) {
        this.joystickPointer = p; this.joyStartX = p.x;
        this.showJoystick(p.x, p.y);
        return;
      }
      if (this.aimPointer) return;
      this.aimPointer = p;
      this.state.charging = true;
      this.state.aimX = p.worldX; this.state.aimY = p.worldY; this.state.hasAim = true;
    });
    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (p === this.joystickPointer) {
        const dx = Phaser.Math.Clamp(p.x - this.joyStartX, -50, 50);
        this.touchMove = Math.abs(dx) < 8 ? 0 : Math.sign(dx);
        this.joyKnob?.setPosition(this.joyStartX + dx, this.joyKnob.y);
        return;
      }
      if (!this.isTouch || p === this.aimPointer) {
        this.state.aimX = p.worldX; this.state.aimY = p.worldY; this.state.hasAim = true;
      }
    });
    const release = (p: Phaser.Input.Pointer) => {
      if (p === this.joystickPointer) { this.joystickPointer = null; this.touchMove = 0; this.hideJoystick(); return; }
      if (p === this.aimPointer) {
        this.aimPointer = null;
        if (this.state.charging) this.pendingFire = true;
        this.state.charging = false;
      }
    };
    scene.input.on('pointerup', release);
    scene.input.on('pointerupoutside', release);
  }

  /** 由 HUD 按钮触发（手机端近战 / 切武器） */
  requestMelee() { this.pendingMelee = true; }
  requestWeapon(i: number) { this.pendingWeapon = i; }

  private inJoystickZone(p: Phaser.Input.Pointer) {
    const cam = this.scene.cameras.main;
    return p.x < cam.width * 0.3 && p.y > cam.height * 0.45;
  }

  private showJoystick(x: number, y: number) {
    this.joyBase ??= this.scene.add.circle(0, 0, 48, 0xffffff, 0.15).setStrokeStyle(2, 0xffffff, 0.5).setDepth(100).setScrollFactor(0);
    this.joyKnob ??= this.scene.add.circle(0, 0, 22, 0xffffff, 0.5).setDepth(101).setScrollFactor(0);
    this.joyBase.setPosition(x, y).setVisible(true);
    this.joyKnob.setPosition(x, y).setVisible(true);
  }
  private hideJoystick() { this.joyBase?.setVisible(false); this.joyKnob?.setVisible(false); }

  /** 每帧读取一次；单次事件（发射/近战/切武器）读取后自动清零 */
  poll(): InputState {
    let dir = 0;
    if (this.keys.A?.isDown || this.keys.LEFT?.isDown) dir -= 1;
    if (this.keys.D?.isDown || this.keys.RIGHT?.isDown) dir += 1;
    if (this.isTouch) dir = this.touchMove;
    this.state.moveDir = dir;
    this.state.fireRequested = this.pendingFire; this.pendingFire = false;
    this.state.meleeRequested = this.pendingMelee; this.pendingMelee = false;
    this.state.weaponRequested = this.pendingWeapon; this.pendingWeapon = null;
    this.state.restartRequested = this.pendingRestart; this.pendingRestart = false;
    return this.state;
  }
}
