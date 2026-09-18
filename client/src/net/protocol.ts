import type { WeaponId } from '../physics/config';

/**
 * 客户端 ↔ 服务器 Socket.io 消息协议（第 2 步实现多人时使用）。
 * 先在这里定义类型，让 client / server 共用同一份定义。
 */
export type RoomMode = 'coop' | 'pvp';

export interface PlayerInfo { id: string; name: string; skinId: number; ready: boolean }

export interface RoomState {
  code: string;
  mode: RoomMode;
  hostId: string;
  players: PlayerInfo[];
  started: boolean;
}

/** 客户端 → 服务器 */
export interface ClientToServer {
  'room:create': (p: { name: string; skinId: number; mode: RoomMode }, cb: (res: { ok: true; room: RoomState } | { ok: false; error: string }) => void) => void;
  'room:join': (p: { code: string; name: string; skinId: number }, cb: (res: { ok: true; room: RoomState } | { ok: false; error: string }) => void) => void;
  'room:leave': () => void;
  'room:start': () => void;
  'game:input': (p: { x: number; aimAngle: number; charging: boolean }) => void;
  'game:fire': (p: { weapon: WeaponId; x: number; y: number; vx: number; vy: number; seq: number }) => void;
  'game:melee': (p: { x: number; y: number; dir: 1 | -1 }) => void;
  'chat:send': (p: { text: string }) => void;
  'chat:emote': (p: { emote: string }) => void;
}

/** 服务器 → 客户端 */
export interface ServerToClient {
  'room:state': (room: RoomState) => void;
  'game:start': (p: { levelId: string; seed: number; mode: RoomMode }) => void;
  'game:snapshot': (p: { tick: number; blocks: [id: number, x: number, y: number, angle: number, hp: number][]; projectiles: [id: number, x: number, y: number, weapon: WeaponId][]; players: { id: string; x: number; aimAngle: number }[] }) => void;
  'game:event': (p: { type: 'explosion' | 'destroyed' | 'freeze' | 'well' | 'fire'; x: number; y: number; radius?: number; id?: number; ownerId?: string; weapon?: WeaponId }) => void;
  'game:over': (p: { winnerId: string | null; damageByOwner: Record<string, number> }) => void;
  'chat:message': (p: { from: string; name: string; text: string; emote?: string }) => void;
}
