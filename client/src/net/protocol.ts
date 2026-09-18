import type { WeaponId } from '../physics/config';
import type { Side } from '../physics/types';

/**
 * 客户端 ↔ 服务器 Socket.IO 消息协议（client / server 共用同一份定义）。
 *
 * 多人架构（纯 Vercel）：
 *  - 服务器只做「房间管理 + 事件中继 + 聊天」，不跑物理；
 *  - 两端客户端各自运行同一份确定性物理（同种子、同步长），只同步开火事件；
 *  - 房主（left）每回合结束广播一次压缩快照，对方据此和解，消除跨浏览器浮点漂移；
 *  - 断线重连后用 lastSeq 补拉漏掉的事件。
 */
export type RoomMode = 'duel';

export interface PlayerInfo {
  /** 持久玩家 id（localStorage 里的 uuid），重连时用它找回座位 */
  playerId: string;
  name: string;
  skinId: number;
  side: Side | null;
  connected: boolean;
}

export interface RoomState {
  code: string;
  mode: RoomMode;
  hostPlayerId: string;
  players: PlayerInfo[];
  started: boolean;
  seed: number;
  levelId: string;
  /** 已广播的游戏事件数（事件 seq 从 1 开始） */
  eventCount: number;
}

/** 广播给房间的游戏事件（带全局递增 seq，保证可补拉） */
export type GameEvent =
  | { seq: number; type: 'fire'; side: Side; weapon: WeaponId; angle: number; power: number }
  | { seq: number; type: 'sync'; side: Side; snapshot: WorldSnapshot }
  | { seq: number; type: 'over'; winner: Side | null; cause: OverCause };

/** 结算原因（中立代码，各端按自己的阵营翻译成文案） */
export type OverCause = 'king' | 'castle' | 'flag' | 'draw';

/** 压缩世界快照：房主 → 客人 */
export interface WorldSnapshot {
  /** [id, x, y, angle, hp] */
  blocks: [number, number, number, number, number][];
  /** [side(0=left,1=right), x, y, hp, alive] */
  knights: [number, number, number, number, number][];
}

/** 分布式 Omit：对联合类型逐成员去掉字段（普通 Omit 会把联合塌缩成公共字段） */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** 客户端发出的事件（seq 由服务器分配） */
export type GameEventInput = DistributiveOmit<GameEvent, 'seq'>;

export interface Ack<T> { ok: true; data: T }
export interface Nak { ok: false; error: string }
export type Reply<T> = Ack<T> | Nak;

/** 客户端 → 服务器 */
export interface ClientToServer {
  'room:create': (p: { playerId: string; name: string; skinId: number }, cb: (r: Reply<RoomState>) => void) => void;
  'room:join': (p: { code: string; playerId: string; name: string; skinId: number }, cb: (r: Reply<RoomState>) => void) => void;
  /** 重连：找回座位并补拉 lastSeq 之后的事件 */
  'room:rejoin': (p: { code: string; playerId: string; lastSeq: number }, cb: (r: Reply<{ room: RoomState; missed: GameEvent[] }>) => void) => void;
  'room:leave': () => void;
  'room:start': (cb: (r: Reply<RoomState>) => void) => void;
  'game:event': (e: GameEventInput) => void;
  /** 对手瞄准预览（纯表现，不入事件日志） */
  'game:aim': (p: { angle: number; power: number; charging: boolean }) => void;
  'chat:send': (p: { text: string }) => void;
}

/** 服务器 → 客户端 */
export interface ServerToClient {
  'room:state': (room: RoomState) => void;
  'game:event': (e: GameEvent) => void;
  'game:aim': (p: { side: Side; angle: number; power: number; charging: boolean }) => void;
  'chat:message': (p: { playerId: string; name: string; text: string; ts: number }) => void;
}

/** Socket.IO 路径：本地 dev 与 Vercel Function 保持一致（Vercel 下函数挂在 /api/socket） */
export const SOCKET_PATH = '/api/socket/socket.io';

export const EMOTES = ['👍', '😂', '😱', '🔥', '💣', '🏳️'];
