# 🏰 Castle Crumble

双城对轰（Castle Busters 式）网页游戏：你和对手各守一座由刚体拼装的城堡，隔空互射抛物线炮弹，
先把对面城堡打垮的赢。物理连锁崩塌 + 卡通骑士。纯浏览器运行，PC + 手机可玩。

当前模式：
- **双城对轰 · 对战 AI**（主模式，回合制）：玩家在左、AI 在右，轮流开火
- **训练 · 拆城堡**：单人限弹药拆一座城堡
- **在线对轰（2 人）**：创建房间 → 把 4 位房间号给朋友 → 加入 → 房主开始。带大厅、文字聊天 + 表情、断线重连

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vite + TypeScript + Phaser 3（仅渲染/输入，不使用其内置物理） |
| 物理 | Matter.js —— `client/src/physics/CastleWorld.ts` 是纯 Matter 实现，不依赖 Phaser，可直接在 Node 服务器上跑权威物理 |
| UI | 原生 HTML/CSS overlay（`client/index.html` + `client/src/ui`） |
| 多人 | Socket.IO 跑在 **Vercel Function**（`api/socket.ts`，WebSocket 传输）；本地开发用 `server/` 同一份代码起 Node 服务。房间状态：有 `REDIS_URL` 时存 Redis（跨实例），否则存内存 |

## 目录结构

```
castle-crumble/
├─ client/                     # 前端（可静态托管到 Vercel / Cloudflare Pages）
│  ├─ index.html               # HUD / 主菜单 / 结算 的 HTML overlay
│  └─ src/
│     ├─ main.ts               # 入口：Phaser 实例 + UI 与场景的事件连线
│     ├─ physics/              # ★ 纯 Matter.js 物理，客户端 / 服务器共用
│     │  ├─ config.ts          #   所有物理 & 玩法参数（重力、砖块血量、爆炸半径、武器…）
│     │  ├─ CastleWorld.ts     #   权威物理世界：城堡搭建、国王刚体与 HP、弹体、碰撞伤害、爆炸/冰冻/重力井、碎片、完整性
│     │  ├─ levels.ts          #   城堡布局（镜像 Builder，同一段描述生成左右两座城堡）+ 4 套主题配色
│     │  ├─ Trajectory.ts      #   抛物线预瞄（复刻 Matter 的积分，预瞄线 = 真实弹道）
│     │  └─ types.ts
│     ├─ game/                 # Phaser 渲染层
│     │  ├─ GameScene.ts       #   主场景：固定步长驱动物理、body → 精灵同步、回合流程、胜负判定
│     │  ├─ ai.ts              #   AI 瞄准：复用弹道预测做暴力搜索 + 角度噪声
│     │  ├─ Player.ts          #   骑士渲染代理（跟随物理刚体，HP 条、受击/死亡表现）
│     │  ├─ InputController.ts #   PC 键鼠 + 手机虚拟摇杆/触屏蓄力，统一成「输入意图」
│     │  ├─ Effects.ts         #   粒子、震屏、WebAudio 合成占位音效
│     │  └─ textures.ts        #   程序化生成占位贴图（4 色骑士皮肤、弹体、粒子）
│     └─ ui/                   # HTML HUD / 菜单 / 结算
│     ├─ net/
│     │  ├─ protocol.ts        # Socket.IO 消息协议类型 + 快照格式（client / server 共用）
│     │  └─ NetClient.ts       # 客户端封装：持久 playerId、自动重连 + 补拉事件
├─ api/
│  └─ socket.ts                # ★ Vercel Function 入口（Socket.IO over WebSocket）
├─ server/src/
│  ├─ gameServer.ts            # 房间 / 座位 / 事件中继（带 seq）/ 聊天 / 重连补拉 —— 不跑物理
│  ├─ roomStore.ts             # 房间存储：Memory（单实例）/ Redis（Vercel 多实例）
│  └─ index.ts                 # 本地开发运行器（:3002），与 api/socket.ts 共用 gameServer
├─ vercel.json                 # 前端静态 + /api/socket/* rewrite 到函数，maxDuration 300s
└─ package.json                # npm workspaces；根依赖供 Vercel 函数使用
```

## 本地启动

需要 Node.js ≥ 18。

```bash
npm install
```

前端（单人 Demo 已可玩）：

```bash
npm run dev:client
```

打开 http://localhost:5173 。手机在同一局域网下访问终端打印的 `Network:` 地址即可（Vite 已加 `--host`）。

多人中继服务（本地开发；前端 dev 模式通过 `client/.env.development` 里的 `VITE_SOCKET_URL` 连它）：

```bash
npm run dev:server
```

默认端口 3002，可用环境变量 `PORT` 覆盖。两个浏览器窗口即可自测（注意：同源标签共享 localStorage 里的 playerId，第二个窗口请用隐身模式或另一浏览器）。

类型检查 / 打包：

```bash
npm run typecheck
npm run build     # 产物在 client/dist，直接静态托管
```

## 部署（纯 Vercel）

前端与多人函数在同一个 Vercel 项目里：

```bash
vercel --prod
```

- `vercel.json`：`buildCommand` 打前端到 `client/dist`；`/api/socket/(.*)` rewrite 到 `api/socket.ts`；函数 `maxDuration` 300s。
- WebSocket 需要 Fluid compute（2025-04 之后新建的项目默认开启）。
- **多实例**：Vercel 不同 Function 实例不共享内存，两个玩家可能落到不同实例。到 Vercel Marketplace 加一个 Redis（Upstash 等），把连接串配成环境变量 `REDIS_URL`，服务会自动切换到 Redis 房间存储 + Socket.IO Redis adapter。没配时只有落到同一实例的玩家能互相看到（低流量时通常如此）。
- 函数到达最大时长会切断连接：客户端自动重连并用 `lastSeq` 补拉漏掉的事件，对局不中断。

## 多人同步模型（确定性锁步 + 房主快照和解）

服务器不跑物理。两端客户端各自运行同一份 `CastleWorld`（同种子、同步长），只转发「开火」事件；房主在每次回合切换时广播一份全精度快照，客人据此对齐。为了做到两端逐字节一致，踩过并修掉的坑：

1. **瞄准阶段暂停物理步进**：世界静止时多跑几步也会改变骑士/砖块的微抖动相位，开火后被混沌放大成完全不同的崩塌。两端都在 `aim` 阶段不 step，开火事件就一定在同一状态上应用。
2. **快照不能四舍五入**：角度差 0.005 rad 在 260px 横梁两端就是 0.65px，会「插进」柱子被求解器弹开。
3. **套用快照后清接触缓存**（`Pairs.clear`）：Matter 求解器用上一帧接触冲量热启动，瞬移后旧冲量会把结构踢倒。
4. **等世界完全静止再切回合 / 打快照**（`isSettled`，带超时兜底），并清掉纯表现的碎片。
5. **爆炸不用随机数**；随机只留给碎片这类不影响砖块的表现物。
6. **统一刚体数组顺序**（按 gameId 排序）并支持按快照复活本地误毁的砖块，作为跨浏览器浮点差异的兜底。

实测两个 Chromium 标签对局三回合，客人端在每次套用快照前与房主的最大位置差为 0、HP 差为 0。

## 玩法与操作

**双城对轰**（Castle Busters 式）：回合制。你的国王（骑士）站在自家前塔顶上，对面 AI 国王同样如此。
你的回合内瞄准、蓄力、开火（炮弹 / 炸弹无限，魔法各 1 发），弹体落地后轮到 AI。
**先把对方国王打死的一方获胜**——国王是真正的物理刚体，会被：
- 炮弹 / 炸弹直接命中（一发满蓄力炮弹基本秒杀）
- 城堡塌下来的砖块砸伤
- 塔被打垮后从高处摔下摔伤
兜底规则：一方城堡完整性 ≤ 10% 或旗帜落地也判负。
**训练模式**：弹药有限，目标同上。

| 平台 | 操作 |
| --- | --- |
| PC | `A/D` / `←/→` 移动 · 鼠标瞄准 · **按住左键蓄力，松开发射** · `空格` 近战挥砍 · `1-5` 切武器 · `R` 重开 |
| 手机 | 左下区域拖动 = 虚拟摇杆 · 其余区域按住 = 蓄力并跟随手指瞄准，松开发射 · 右下 ⚔️ 近战 |

武器（弹药在 `config.ts` 里调）：

- **炮弹**：重、直接撞击伤害高，适合打柱子
- **炸弹**：接触即爆，范围冲击 + 伤害
- **冰冻 ❄**：范围内砖块变脆（HP ×0.3、摩擦降低），之后一碰就碎
- **重力井 🌀**：持续 2.5 秒把附近砖块吸向一点，把整层结构拽塌
- **大爆炸 ☄**：更大半径的爆炸

## 物理模型简述

- 每块砖 / 梁 / 柱都是独立刚体，材质（stone / wood / ice / mud）决定密度、血量、摩擦。
- 碰撞伤害 = `impulseFactor × min(质量) × 相对法向速度`，弹体命中额外加成；低速接触不掉血，防止静止堆叠自伤。
- 砖块血量归零 → 移除刚体、生成 4 块碎片（只与地面碰撞，不再破坏其他砖），碎片 2.2 秒后淡出。
- 结构完整性按阵营分别统计 = 仍在原位（位移 < 45px）砖块的剩余 HP 之和 / 初始值。被推倒的砖即使没碎也算「失效」，鼓励连锁崩塌打法。
- 旗帜不可摧毁，必须真正掉到地面才算倒塌（避免一发擦到旗杆就秒胜）。
- Matter 的 `enableSleeping` 必须关闭：休眠刚体失去支撑后不会自动醒来，会悬在半空。
- 固定步长 1/60 s，客户端与服务器一致，为多人权威同步铺路。

## 路线图

- [x] 第 1 步：项目结构 + 双城对轰（vs AI）+ 训练拆城堡（本版本）
- [x] 第 2 步：多人房间 + 2 人在线对轰（确定性锁步 + 房主快照和解）+ 文字聊天与表情 + 断线重连，纯 Vercel 部署
- [ ] 第 3 步：UI 打磨、手机操作优化、更多关卡与主题（木头哨塔 / 沙漠泥砖 / 冰雪堡垒）、4 人合作模式
