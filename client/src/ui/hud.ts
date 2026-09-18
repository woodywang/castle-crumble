import { PHYS, WEAPON_ORDER, type WeaponId } from '../physics/config';
import type { HudState } from '../game/GameScene';

/**
 * HTML HUD：只做 DOM 更新，不持有游戏状态。
 * 通过回调把「切武器 / 近战」意图交还给游戏。
 */
export class Hud {
  private root = document.getElementById('hud')!;
  private integrityFill = document.getElementById('integrity-fill')!;
  private integrityBar = this.integrityFill.parentElement!;
  private integrityText = document.getElementById('integrity-text')!;
  private myFill = document.getElementById('my-fill')!;
  private myBar = document.getElementById('my-bar')!;
  private myText = document.getElementById('my-text')!;
  private turnText = document.getElementById('turn-text')!;
  private damageText = document.getElementById('damage-text')!;
  private weaponsEl = document.getElementById('weapons')!;
  private powerBar = document.getElementById('power-bar')!;
  private powerFill = document.getElementById('power-fill')!;
  private mobileControls = document.getElementById('mobile-controls')!;
  private weaponButtons = new Map<WeaponId, HTMLButtonElement>();
  private lastIntegrity = -1;
  private lastMine = -1;
  private lastMyHp = -1;
  private lastEnemyHp = -1;

  constructor(private onWeapon: (index: number) => void, onMelee: () => void) {
    WEAPON_ORDER.forEach((w, i) => {
      const def = PHYS.weapons[w];
      const btn = document.createElement('button');
      btn.className = 'weapon';
      btn.innerHTML = `<span>${def.icon}</span><small>${def.label}</small><span class="ammo">0</span>`;
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.onWeapon(i); });
      this.weaponsEl.appendChild(btn);
      this.weaponButtons.set(w, btn);
    });
    document.getElementById('btn-melee')!.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); onMelee(); });
  }

  show() { this.root.hidden = false; }
  hide() { this.root.hidden = true; }

  update(s: HudState) {
    const duel = s.mode === 'duel';
    if (Math.round(s.enemyIntegrity) !== this.lastIntegrity || Math.round(s.enemyHp) !== this.lastEnemyHp) {
      this.lastIntegrity = Math.round(s.enemyIntegrity); this.lastEnemyHp = Math.round(s.enemyHp);
      this.integrityFill.style.width = `${s.enemyIntegrity}%`;
      this.integrityText.textContent = duel ? `敌方 ❤${Math.round(s.enemyHp)} · 城堡 ${this.lastIntegrity}%` : `结构完整性 ${this.lastIntegrity}%`;
      this.integrityBar.classList.toggle('low', s.enemyIntegrity < 35);
    }
    this.myBar.hidden = !duel;
    if (duel && (Math.round(s.myIntegrity) !== this.lastMine || Math.round(s.myHp) !== this.lastMyHp)) {
      this.lastMine = Math.round(s.myIntegrity); this.lastMyHp = Math.round(s.myHp);
      this.myFill.style.width = `${s.myIntegrity}%`;
      this.myText.textContent = `我方 ❤${Math.round(s.myHp)} · 城堡 ${this.lastMine}%`;
      this.myBar.classList.toggle('low', s.myIntegrity < 35);
    }
    this.turnText.textContent = s.turnLabel;
    this.turnText.classList.toggle('enemy', duel && !s.myTurn);
    this.damageText.textContent = `伤害 ${s.damage}`;
    for (const [w, btn] of this.weaponButtons) {
      const unlimited = s.unlimited.includes(w);
      btn.classList.toggle('active', w === s.weapon);
      btn.classList.toggle('empty', !unlimited && s.ammo[w] <= 0);
      btn.querySelector('.ammo')!.textContent = unlimited ? '∞' : String(s.ammo[w]);
    }
    this.weaponsEl.classList.toggle('locked', duel && !s.myTurn);
    this.powerBar.hidden = !s.charging;
    this.powerFill.style.width = `${Math.round(s.power * 100)}%`;
    this.mobileControls.hidden = !s.isTouch || duel; // 对战模式站在塔顶，不提供近战
    document.body.classList.toggle('touch', s.isTouch);
  }
}
