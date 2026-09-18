import { SKINS } from '../game/textures';
import type { GameResult } from '../game/GameScene';

export interface MenuChoice { name: string; skinId: number; levelId: string }

/** 主菜单 + 结算弹窗 */
export class Menu {
  /** 由 main.ts 注入：创建 / 加入在线房间 */
  onCreateRoom: ((c: Omit<MenuChoice, 'levelId'>) => Promise<void>) | null = null;
  onJoinRoom: ((c: Omit<MenuChoice, 'levelId'>, code: string) => Promise<void>) | null = null;
  private note = document.getElementById('menu-note')!;
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

    const roomInput = document.getElementById('room-input') as HTMLInputElement;
    const createBtn = document.getElementById('btn-create') as HTMLButtonElement;
    const joinBtn = document.getElementById('btn-join') as HTMLButtonElement;
    const busy = (b: boolean, text: string) => { createBtn.disabled = joinBtn.disabled = b; this.note.textContent = text; };
    const choice = () => {
      const name = this.nameInput.value.trim() || '骑士';
      localStorage.setItem('cc.name', name);
      return { name, skinId: this.skinId };
    };
    createBtn.addEventListener('click', async () => {
      busy(true, '正在创建房间…');
      try { await this.onCreateRoom?.(choice()); this.hideMenu(); busy(false, '在线对轰：创建房间后把 4 位房间号发给朋友。'); }
      catch (e) { busy(false, `创建失败：${(e as Error).message}`); }
    });
    joinBtn.addEventListener('click', async () => {
      const code = roomInput.value.trim().toUpperCase();
      if (code.length !== 4) { this.note.textContent = '请输入 4 位房间号'; return; }
      busy(true, '正在加入房间…');
      try { await this.onJoinRoom?.(choice(), code); this.hideMenu(); busy(false, '在线对轰：创建房间后把 4 位房间号发给朋友。'); }
      catch (e) { busy(false, `加入失败：${(e as Error).message}`); }
    });
    roomInput.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') joinBtn.click(); });
    this.nameInput.addEventListener('keydown', (ev) => ev.stopPropagation());
    document.getElementById('btn-retry')!.addEventListener('click', () => { this.result.hidden = true; this.onRetry(); });
    document.getElementById('btn-menu')!.addEventListener('click', () => { this.result.hidden = true; this.onBackToMenu(); this.showMenu(); });
  }

  showMenu() { this.menu.hidden = false; }
  hideMenu() { this.menu.hidden = true; }

  showResult(r: GameResult) {
    document.getElementById('result-title')!.textContent = r.won ? '🎉 胜利！' : '💀 失败';
    document.getElementById('btn-retry')!.textContent = r.online ? '回主菜单' : '再来一局';
    document.getElementById('result-reason')!.textContent = r.reason;
    const rows: [string, string | number][] = r.mode === 'duel'
      ? [['我方造成伤害', r.damage], [r.online ? '对手造成伤害' : '敌方造成伤害', r.enemyDamage], ['我方城堡', `${r.myIntegrity}%`], [r.online ? '对手城堡' : '敌方城堡', `${r.enemyIntegrity}%`]]
      : [['造成伤害', r.damage], ['摧毁砖块', r.blocksDestroyed], ['剩余完整性', `${r.enemyIntegrity}%`]];
    document.getElementById('result-stats')!.innerHTML = rows.map(([k, v]) => `<li>${k}<b>${v}</b></li>`).join('');
    this.result.hidden = false;
  }
}
