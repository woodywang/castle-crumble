import Phaser from 'phaser';

/** 4 种骑士皮肤（多人时用于区分玩家） */
export const SKINS = [
  { id: 0, name: '红', body: 0xe74c3c, dark: 0xa93226 },
  { id: 1, name: '蓝', body: 0x3498db, dark: 0x1f618d },
  { id: 2, name: '绿', body: 0x2ecc71, dark: 0x1e8449 },
  { id: 3, name: '黄', body: 0xf1c40f, dark: 0xb7950b },
];

/**
 * 程序化生成所有占位贴图（后期可直接替换为美术资源，key 不变）。
 * 在 Scene.create() 里调用一次。
 */
export function generateTextures(scene: Phaser.Scene) {
  const g = scene.make.graphics({ x: 0, y: 0 }, false);

  // 粒子：火花 / 烟 / 碎石
  g.clear(); g.fillStyle(0xffffff, 1); g.fillCircle(6, 6, 6); g.generateTexture('spark', 12, 12);
  g.clear(); g.fillStyle(0xffffff, 0.8); g.fillCircle(12, 12, 12); g.generateTexture('smoke', 24, 24);
  g.clear(); g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 8, 8); g.generateTexture('grit', 8, 8);

  // 骑士：圆润卡通造型，按皮肤色生成
  for (const skin of SKINS) {
    g.clear();
    // 身体（盔甲）
    g.fillStyle(0xbfc9d4, 1); g.fillRoundedRect(14, 30, 36, 34, 10);
    g.lineStyle(3, 0x4a5563, 1); g.strokeRoundedRect(14, 30, 36, 34, 10);
    // 披风 / 战袍（皮肤色）
    g.fillStyle(skin.body, 1); g.fillRoundedRect(20, 36, 24, 22, 6);
    g.lineStyle(2, skin.dark, 1); g.strokeRoundedRect(20, 36, 24, 22, 6);
    // 头盔
    g.fillStyle(0xd5dde6, 1); g.fillCircle(32, 20, 18);
    g.lineStyle(3, 0x4a5563, 1); g.strokeCircle(32, 20, 18);
    // 面罩（深色）+ 眼睛
    g.fillStyle(0x2c3e50, 1); g.fillRoundedRect(18, 16, 28, 10, 4);
    g.fillStyle(0xffffff, 1); g.fillCircle(26, 21, 2.5); g.fillCircle(38, 21, 2.5);
    // 头盔羽饰（皮肤色）
    g.fillStyle(skin.body, 1); g.fillEllipse(32, 4, 10, 12);
    // 靴子
    g.fillStyle(0x5a3a1e, 1); g.fillRoundedRect(16, 60, 14, 8, 3); g.fillRoundedRect(34, 60, 14, 8, 3);
    g.generateTexture(`knight_${skin.id}`, 64, 70);
  }

  // 剑（枢轴在左端）
  g.clear();
  g.fillStyle(0x7f5a2b, 1); g.fillRect(0, 6, 14, 6);          // 剑柄
  g.fillStyle(0xf1c40f, 1); g.fillRect(12, 2, 6, 14);          // 护手
  g.fillStyle(0xecf0f1, 1); g.fillTriangle(18, 4, 18, 14, 60, 9); // 剑身
  g.lineStyle(1.5, 0x7f8c8d, 1); g.strokeTriangle(18, 4, 18, 14, 60, 9);
  g.generateTexture('sword', 60, 18);

  // 弹体
  g.clear(); g.fillStyle(0x2c3e50, 1); g.fillCircle(12, 12, 12); g.fillStyle(0x7f8c8d, 0.7); g.fillCircle(8, 8, 4); g.generateTexture('proj_cannon', 24, 24);
  g.clear(); g.fillStyle(0x34495e, 1); g.fillCircle(12, 14, 10); g.fillStyle(0xe67e22, 1); g.fillRect(11, 0, 3, 6); g.fillStyle(0xf1c40f, 1); g.fillCircle(12, 1, 2.5); g.generateTexture('proj_bomb', 24, 26);
  g.clear(); g.fillStyle(0x9be7ff, 1); g.fillCircle(11, 11, 10); g.lineStyle(2, 0xffffff, 1); g.strokeCircle(11, 11, 6); g.generateTexture('proj_freeze', 22, 22);
  g.clear(); g.fillStyle(0x8e44ad, 1); g.fillCircle(11, 11, 10); g.lineStyle(2, 0xd7bde2, 1); g.strokeCircle(11, 11, 5); g.generateTexture('proj_gravity', 22, 22);
  g.clear(); g.fillStyle(0xe74c3c, 1); g.fillCircle(13, 13, 13); g.fillStyle(0xf39c12, 1); g.fillCircle(13, 13, 7); g.generateTexture('proj_blast', 26, 26);

  g.destroy();
}
