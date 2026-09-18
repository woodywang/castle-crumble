import type { GameEvent, GameEventInput, RoomState } from '../../client/src/net/protocol';

/**
 * 房间存储抽象。
 *  - MemoryRoomStore：本地开发 / 单实例
 *  - RedisRoomStore ：Vercel 多实例（Function 实例之间不共享内存，房间必须放外部存储）
 */
export interface RoomStore {
  get(code: string): Promise<RoomState | null>;
  set(room: RoomState): Promise<void>;
  delete(code: string): Promise<void>;
  /** 追加事件并返回分配的 seq（原子） */
  appendEvent(code: string, e: GameEventInput): Promise<GameEvent>;
  eventsAfter(code: string, seq: number): Promise<GameEvent[]>;
}

const ROOM_TTL_S = 60 * 60 * 3; // 房间 3 小时无活动自动过期

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, RoomState>();
  private events = new Map<string, GameEvent[]>();
  async get(code: string) { return this.rooms.get(code) ?? null; }
  async set(room: RoomState) { this.rooms.set(room.code, room); }
  async delete(code: string) { this.rooms.delete(code); this.events.delete(code); }
  async appendEvent(code: string, e: GameEventInput) {
    const list = this.events.get(code) ?? [];
    const ev = { ...e, seq: list.length + 1 } as GameEvent;
    list.push(ev);
    this.events.set(code, list);
    const room = this.rooms.get(code);
    if (room) room.eventCount = ev.seq;
    return ev;
  }
  async eventsAfter(code: string, seq: number) { return (this.events.get(code) ?? []).filter((e) => e.seq > seq); }
}

/** node-redis v4 客户端的最小类型（避免把 redis 类型强绑到接口） */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  rPush(key: string, value: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class RedisRoomStore implements RoomStore {
  constructor(private redis: RedisLike) {}
  private k(code: string) { return `cc:room:${code}`; }
  private ke(code: string) { return `cc:events:${code}`; }
  async get(code: string) { const s = await this.redis.get(this.k(code)); return s ? (JSON.parse(s) as RoomState) : null; }
  async set(room: RoomState) { await this.redis.set(this.k(room.code), JSON.stringify(room), { EX: ROOM_TTL_S }); }
  async delete(code: string) { await this.redis.del([this.k(code), this.ke(code)]); }
  async appendEvent(code: string, e: GameEventInput) {
    // RPUSH 返回列表长度，天然就是递增 seq（同一房间的事件顺序由 Redis 保证）
    const placeholder = JSON.stringify({ ...e, seq: 0 });
    const seq = await this.redis.rPush(this.ke(code), placeholder);
    await this.redis.expire(this.ke(code), ROOM_TTL_S);
    return { ...e, seq } as GameEvent;
  }
  async eventsAfter(code: string, seq: number) {
    const raw = await this.redis.lRange(this.ke(code), seq, -1);
    // 列表下标即 seq-1，回填 seq
    return raw.map((s, i) => ({ ...(JSON.parse(s) as GameEvent), seq: seq + i + 1 }));
  }
}
