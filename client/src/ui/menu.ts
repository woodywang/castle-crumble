import { SKINS } from '../game/textures';
import type { GameResult } from '../game/GameScene';

export interface MenuChoice { name: string; skinId: number; levelId: string }

/** 主菜单 + 结算弹窗 */
export class Menu {
  private menu = document.getElementById('menu')!;
  private result = document.getElementById('result')!;
  private nameInput = document.getElementById('name-input') as HTMLInputElement;
  private skinId = Number(localStorage.getItem('cc.skin') ?? 0);

  constructor(private onSingle: (c: MenuChoice) => void, private onRetry: () => void, private onBackToMenu: () => void) {
    this.nameInput.value = localStorage.getItem('cc.name') ?? '';
    const skins = document.getElementById('skins')!;
    for (const s of SKINS) {
      const el = document.createElement('div');
      el.className = 'skin' + (s.id === this.skinId ? ' active' : '');
      el.style.background = `#${s.body.toString(16).padStart(6, '0')}`;
      el.title = s.name;
      el.addEventListener('click', () => {
        this.skinId = s.id; localStorage.setItem('cc.skin', String(s.id));
        skins.querySelectorAll('.skin').forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
      });
      skins.appendChild(el);
    }
    const start = (levelId: string) => {
      const name = this.nameInput.value.trim() || '骑士';
      localStorage.setItem('cc.name', name);
      this.hideMenu();
      this.onSingle({ name, skinId: this.skinId, levelId });
    };
    document.getElementById('btn-duel')!.addEventListener('click', () => start('duel-1'));
    document.getElementById('btn-single')!.addEventListener('click', () => start('demolish-1'));
    document.getElementById('btn-retry')!.addEventListener('click', () => { this.result.hidden = true; this.onRetry(); });
    document.getElementById('btn-menu')!.addEventListener('click', () => { this.result.hidden = true; this.onBackToMenu(); this.showMenu(); });
  }

  showMenu() { this.menu.hidden = false; }
  hideMenu() { this.menu.hidden = true; }

  showResult(r: GameResult) {
    document.getElementById('result-title')!.textContent = r.won ? '🎉 胜利！' : '💀 失败';
    document.getElementById('result-reason')!.textContent = r.reason;
    const rows: [string, string | number][] = r.mode === 'duel'
      ? [['我方造成伤害', r.damage], ['敌方造成伤害', r.enemyDamage], ['我方城堡', `${r.myIntegrity}%`], ['敌方城堡', `${r.enemyIntegrity}%`]]
      : [['造成伤害', r.damage], ['摧毁砖块', r.blocksDestroyed], ['剩余完整性', `${r.enemyIntegrity}%`]];
    document.getElementById('result-stats')!.innerHTML = rows.map(([k, v]) => `<li>${k}<b>${v}</b></li>`).join('');
    this.result.hidden = false;
  }
}
