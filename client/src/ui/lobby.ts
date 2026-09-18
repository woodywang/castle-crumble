import { NetClient } from '../net/NetClient';
import { EMOTES, type RoomState } from '../net/protocol';
import { SKINS } from '../game/textures';

const skinColor = (id: number) => `#${SKINS[id % SKINS.length].body.toString(16).padStart(6, '0')}`;

/** 一个聊天面板（大厅和游戏内各一个），只管 DOM，收发走 NetClient */
export class ChatPanel {
  private log: HTMLElement;
  constructor(private net: NetClient, root: string, logId: string, emotesId: string, formId: string, inputId: string) {
    this.log = document.getElementById(logId)!;
    const emotes = document.getElementById(emotesId)!;
    emotes.innerHTML = '';
    for (const e of EMOTES) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = e;
      b.addEventListener('click', () => this.net.sendChat(e));
      emotes.appendChild(b);
    }
    const form = document.getElementById(formId) as HTMLFormElement;
    const input = document.getElementById(inputId) as HTMLInputElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const t = input.value.trim();
      if (t) this.net.sendChat(t);
      input.value = '';
    });
    // 阻止游戏快捷键抢焦点时误触发（在输入框里按 A/D/空格）
    input.addEventListener('keydown', (ev) => ev.stopPropagation());
    void root;
  }
  add(name: string, text: string, sys = false) {
    const div = document.createElement('div');
    div.className = 'msg' + (sys ? ' sys' : '');
    div.innerHTML = sys ? escape(text) : `<b>${escape(name)}</b>：${escape(text)}`;
    this.log.appendChild(div);
    while (this.log.children.length > 60) this.log.removeChild(this.log.firstChild!);
    this.log.scrollTop = this.log.scrollHeight;
  }
  clear() { this.log.innerHTML = ''; }
}

function escape(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

/** 房间大厅弹窗：房间号、玩家列表、聊天、开始/离开 */
export class Lobby {
  private el = document.getElementById('lobby')!;
  private codeEl = document.getElementById('lobby-code')!;
  private statusEl = document.getElementById('lobby-status')!;
  private playersEl = document.getElementById('lobby-players')!;
  private startBtn = document.getElementById('btn-start') as HTMLButtonElement;
  readonly chat: ChatPanel;

  constructor(private net: NetClient, onLeave: () => void, private onStarted: (room: RoomState) => void) {
    this.chat = new ChatPanel(net, 'lobby', 'lobby-chat-log', 'lobby-emotes', 'lobby-chat-form', 'lobby-chat-input');
    this.startBtn.addEventListener('click', async () => {
      this.startBtn.disabled = true;
      try { await net.startGame(); } catch (e) { this.statusEl.textContent = (e as Error).message; this.startBtn.disabled = false; }
    });
    document.getElementById('btn-lobby-leave')!.addEventListener('click', () => { net.leaveRoom(); this.hide(); onLeave(); });
    net.on('room', (room) => this.render(room));
    net.on('chat', (m) => this.chat.add(m.name, m.text));
  }

  show(room: RoomState) { this.el.hidden = false; this.chat.clear(); this.render(room); }
  hide() { this.el.hidden = true; }

  private started = false;
  private render(room: RoomState) {
    if (this.el.hidden && !room.started) return;
    this.codeEl.textContent = room.code;
    const slots = (['left', 'right'] as const).map((side) => room.players.find((p) => p.side === side) ?? null);
    this.playersEl.innerHTML = slots.map((p, i) => p
      ? `<li class="${p.connected ? '' : 'offline'}"><span class="dot" style="background:${skinColor(p.skinId)}"></span>${escape(p.name)}${p.playerId === room.hostPlayerId ? ' 👑' : ''}<span class="tag">${i === 0 ? '左城' : '右城'}${p.connected ? '' : ' · 离线'}</span></li>`
      : `<li class="empty"><span class="dot" style="background:#ccc"></span>等待玩家…<span class="tag">${i === 0 ? '左城' : '右城'}</span></li>`).join('');
    const full = room.players.length >= 2;
    if (this.net.isHost) {
      this.startBtn.hidden = false;
      this.startBtn.disabled = !full || room.started;
      this.statusEl.textContent = full ? '对手已就位，点击开始！' : '把房间号发给朋友，等待加入…';
    } else {
      this.startBtn.hidden = true;
      this.statusEl.textContent = full ? '等待房主开始…' : '等待玩家加入…';
    }
    if (room.started && !this.started) {
      this.started = true;
      this.hide();
      this.onStarted(room);
    }
    if (!room.started) this.started = false;
  }
}
