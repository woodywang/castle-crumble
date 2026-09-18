import Phaser from 'phaser';
import { EVT, GameScene, type GameResult, type GameSceneData, type HudState } from './game/GameScene';
import { NetClient } from './net/NetClient';
import { PHYS } from './physics/config';
import { Hud } from './ui/hud';
import { ChatPanel, Lobby } from './ui/lobby';
import { Menu } from './ui/menu';

/**
 * 入口：创建 Phaser 实例（不启用 Phaser 自带物理，物理由 CastleWorld 自己跑 Matter.js），
 * 并把 HTML UI（菜单 / 大厅 / HUD / 聊天 / 结算）和场景通过 game.events 连接起来。
 */
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: PHYS.world.width,
  height: PHYS.world.height,
  backgroundColor: '#6fb7ff',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [GameScene],
  input: { activePointers: 3 },
  render: { antialias: true, roundPixels: false },
});

let lastData: GameSceneData = {};
const net = new NetClient();

const hud = new Hud(
  (i) => game.events.emit(EVT.WEAPON_SELECT, i),
  () => game.events.emit(EVT.MELEE),
);

const gameChatEl = document.getElementById('game-chat')!;
const gameChat = new ChatPanel(net, 'game', 'game-chat-log', 'game-emotes', 'game-chat-form', 'game-chat-input');
net.on('chat', (m) => gameChat.add(m.name, m.text));

const netStatus = document.getElementById('net-status')!;
net.on('status', (s) => {
  netStatus.hidden = !(s === 'reconnecting' || s === 'disconnected') || !net.room;
  netStatus.textContent = s === 'reconnecting' ? '连接中断，正在重连…' : '与服务器断开连接';
});
net.on('room', (room) => {
  const opp = room.players.find((p) => p.playerId !== net.playerId);
  if (room.started && opp && !opp.connected) gameChat.add('', `${opp.name} 掉线了，等待重连…`, true);
});

const menu = new Menu(
  ({ name, skinId, levelId }) => {
    lastData = { levelId, skinId, playerName: name };
    startGame();
  },
  () => { if (lastData.net) { backToMenu(); } else startGame(); },
  () => backToMenu(),
);

const lobby = new Lobby(
  net,
  () => menu.showMenu(),
  () => {
    // 房间开始 → 进入在线对战
    lastData = { ...lastData, net };
    gameChat.clear();
    gameChatEl.hidden = false;
    startGame();
  },
);

menu.onCreateRoom = async ({ name, skinId }) => {
  const room = await net.createRoom(name, skinId);
  lastData = { skinId, playerName: name };
  lobby.show(room);
};
menu.onJoinRoom = async ({ name, skinId }, code) => {
  const room = await net.joinRoom(code, name, skinId);
  lastData = { skinId, playerName: name };
  lobby.show(room);
};

function startGame() {
  hud.show();
  if (game.scene.isActive('Game')) game.scene.getScene('Game').scene.restart(lastData);
  else game.scene.start('Game', lastData);
}

function backToMenu() {
  game.scene.stop('Game');
  hud.hide();
  gameChatEl.hidden = true;
  if (lastData.net) { net.leaveRoom(); lastData = { ...lastData, net: undefined }; }
  menu.showMenu();
}

// 场景一启动就自动 start 了（Phaser 默认启动 scene 列表第一个），先停掉等菜单
game.events.once(Phaser.Core.Events.READY, () => { game.scene.stop('Game'); });

game.events.on(EVT.HUD, (s: HudState) => hud.update(s));
game.events.on(EVT.OVER, (r: GameResult) => menu.showResult(r));

menu.showMenu();
