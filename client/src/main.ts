import Phaser from 'phaser';
import { EVT, GameScene, type GameResult, type GameSceneData, type HudState } from './game/GameScene';
import { PHYS } from './physics/config';
import { Hud } from './ui/hud';
import { Menu } from './ui/menu';

/**
 * 入口：创建 Phaser 实例（不启用 Phaser 自带物理，物理由 CastleWorld 自己跑 Matter.js），
 * 并把 HTML UI 和场景通过 game.events 连接起来。
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

const hud = new Hud(
  (i) => game.events.emit(EVT.WEAPON_SELECT, i),
  () => game.events.emit(EVT.MELEE),
);

const menu = new Menu(
  ({ name, skinId, levelId }) => {
    lastData = { levelId, skinId, playerName: name };
    startGame();
  },
  () => startGame(),
  () => { game.scene.stop('Game'); hud.hide(); },
);

function startGame() {
  hud.show();
  if (game.scene.isActive('Game')) game.scene.getScene('Game').scene.restart(lastData);
  else game.scene.start('Game', lastData);
}

// 场景一启动就自动 start 了（Phaser 默认启动 scene 列表第一个），先停掉等菜单
game.events.once(Phaser.Core.Events.READY, () => { game.scene.stop('Game'); });

game.events.on(EVT.HUD, (s: HudState) => hud.update(s));
game.events.on(EVT.OVER, (r: GameResult) => menu.showResult(r));

menu.showMenu();
