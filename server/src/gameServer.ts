import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ClientToServer, GameEvent, GameEventInput, RoomState, ServerToClient } from '../../client/src/net/protocol';
import { SOCKET_PATH } from '../../client/src/net/protocol.js';
import { MemoryRoomStore, RedisRoomStore, type RoomStore } from './roomStore.js';

type IO = Server<ClientToServer, ServerToClient>;
type Sock = Socket<ClientToServer, ServerToClient>;

/** 每个连接上挂的会话信息（仅本实例内存，重连后通过 room:rejoin 重建） */
interface Session { code: string; playerId: string }

const MAX_PLAYERS = 2;
const genCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();

/**
 * 把游戏服务挂到一个 http.Server 上。
 * 服务器不跑物理，只做：房间 / 座位 / 事件中继（带 seq）/ 聊天 / 重连补拉。
 *
 * 多实例（Vercel）：
 *  - 房间状态与事件日志放 Redis（RedisRoomStore）；
 *  - Socket.IO 用 redis-adapter 做跨实例广播；
 *  - 没有 REDIS_URL 时退回内存（本地开发或单实例也能玩）。
 */
export async function attachGameServer(httpServer: HttpServer): Promise<IO> {
  const io: IO = new Server(httpServer, {
    path: SOCKET_PATH,
    cors: { origin: '*' },
    transports: ['websocket'], // Vercel Function 上只能走 WebSocket
  });

  let store: RoomStore = new MemoryRoomStore();
  const redisUrl = process.env.REDIS_URL ?? process.env.KV_URL;
  if (redisUrl) {
    try {
      const { createClient } = await import('redis');
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const pub = createClient({ url: redisUrl });
      const sub = pub.duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      store = new RedisRoomStore(pub);
      console.log('[castle-crumble] Redis room store + adapter enabled');
    } catch (err) {
      console.error('[castle-crumble] Redis init failed, falling back to memory:', err);
    }
  } else {
    console.log('[castle-crumble] no REDIS_URL, using in-memory room store');
  }

  const sessions = new Map<string, Session>(); // socket.id → session

  const broadcastRoom = (room: RoomState) => io.to(room.code).emit('room:state', room);

  const publicRoom = (room: RoomState): RoomState => room;

  io.on('connection', (socket: Sock) => {
    socket.on('room:create', async ({ playerId, name, skinId }, cb) => {
      let code = genCode();
      while (await store.get(code)) code = genCode();
      const room: RoomState = {
        code, mode: 'duel', hostPlayerId: playerId, started: false,
        seed: (Math.random() * 0x7fffffff) | 0,
        levelId: 'duel-1',
        eventCount: 0,
        players: [{ playerId, name: clean(name), skinId: skinId | 0, side: 'left', connected: true }],
      };
      await store.set(room);
      sessions.set(socket.id, { code, playerId });
      await socket.join(code);
      cb({ ok: true, data: publicRoom(room) });
      broadcastRoom(room);
    });

    socket.on('room:join', async ({ code, playerId, name, skinId }, cb) => {
      code = String(code ?? '').trim().toUpperCase();
      const room = await store.get(code);
      if (!room) return cb({ ok: false, error: '房间不存在' });
      const existing = room.players.find((p) => p.playerId === playerId);
      if (!existing) {
        if (room.started) return cb({ ok: false, error: '游戏已开始' });
        if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: '房间已满（对轰模式 2 人）' });
        room.players.push({ playerId, name: clean(name), skinId: skinId | 0, side: room.players.some((p) => p.side === 'left') ? 'right' : 'left', connected: true });
      } else {
        existing.connected = true; existing.name = clean(name); existing.skinId = skinId | 0;
      }
      await store.set(room);
      sessions.set(socket.id, { code, playerId });
      await socket.join(code);
      cb({ ok: true, data: publicRoom(room) });
      broadcastRoom(room);
    });

    socket.on('room:rejoin', async ({ code, playerId, lastSeq }, cb) => {
      code = String(code ?? '').trim().toUpperCase();
      const room = await store.get(code);
      const me = room?.players.find((p) => p.playerId === playerId);
      if (!room || !me) return cb({ ok: false, error: '座位已失效' });
      me.connected = true;
      await store.set(room);
      sessions.set(socket.id, { code, playerId });
      await socket.join(code);
      const missed = await store.eventsAfter(code, lastSeq | 0);
      cb({ ok: true, data: { room: publicRoom(room), missed } });
      broadcastRoom(room);
    });

    socket.on('room:start', async (cb) => {
      const s = sessions.get(socket.id);
      const room = s && (await store.get(s.code));
      if (!room) return cb({ ok: false, error: '不在房间中' });
      if (room.hostPlayerId !== s!.playerId) return cb({ ok: false, error: '只有房主能开始' });
      if (room.players.length < MAX_PLAYERS) return cb({ ok: false, error: '等待对手加入' });
      room.started = true;
      await store.set(room);
      cb({ ok: true, data: publicRoom(room) });
      broadcastRoom(room);
    });

    socket.on('game:event', async (e) => {
      const s = sessions.get(socket.id);
      if (!s) return;
      const room = await store.get(s.code);
      if (!room || !room.started) return;
      const ev: GameEvent = await store.appendEvent(s.code, sanitizeEvent(e));
      room.eventCount = ev.seq;
      await store.set(room);
      io.to(s.code).emit('game:event', ev);
    });

    socket.on('game:aim', (p) => {
      const s = sessions.get(socket.id);
      if (!s) return;
      // 纯表现层数据，不入日志，转发给房间里的其他人
      socket.to(s.code).emit('game:aim', { side: sideOfSession(s, socket) ?? 'left', angle: +p.angle || 0, power: clamp01(+p.power), charging: !!p.charging });
    });

    socket.on('chat:send', async ({ text }) => {
      const s = sessions.get(socket.id);
      if (!s) return;
      const room = await store.get(s.code);
      const me = room?.players.find((p) => p.playerId === s.playerId);
      const msg = String(text ?? '').slice(0, 200).trim();
      if (!me || !msg) return;
      io.to(s.code).emit('chat:message', { playerId: me.playerId, name: me.name, text: msg, ts: Date.now() });
    });

    const leave = async (explicit: boolean) => {
      const s = sessions.get(socket.id);
      if (!s) return;
      sessions.delete(socket.id);
      const room = await store.get(s.code);
      if (!room) return;
      const me = room.players.find((p) => p.playerId === s.playerId);
      if (!me) return;
      if (explicit || !room.started) {
        // 主动离开 / 未开局时掉线：释放座位
        room.players = room.players.filter((p) => p.playerId !== s.playerId);
        if (!room.players.length) { await store.delete(room.code); return; }
        if (room.hostPlayerId === s.playerId) room.hostPlayerId = room.players[0].playerId;
      } else {
        // 对局中掉线（比如 Vercel 函数到时切断）：保留座位，等 room:rejoin
        me.connected = false;
      }
      await store.set(room);
      broadcastRoom(room);
    };
    socket.on('room:leave', () => { void leave(true); });
    socket.on('disconnect', () => { void leave(false); });

    // 记住每个 socket 的阵营，给 game:aim 用（避免每次查 store）
    function sideOfSession(_s: Session, sock: Sock) {
      return (sock.data as { side?: 'left' | 'right' }).side;
    }
    socket.use(async ([event], next) => {
      if ((event === 'game:aim') && !(socket.data as { side?: string }).side) {
        const s = sessions.get(socket.id);
        const room = s && (await store.get(s.code));
        (socket.data as { side?: string }).side = room?.players.find((p) => p.playerId === s!.playerId)?.side ?? undefined;
      }
      next();
    });
  });

  return io;
}

function clean(name: unknown) { return String(name ?? '').trim().slice(0, 12) || '骑士'; }
function clamp01(v: number) { return Math.max(0, Math.min(1, v || 0)); }

/** 只放行协议里定义的字段，防止客户端塞垃圾进事件日志 */
function sanitizeEvent(e: GameEventInput): GameEventInput {
  switch (e.type) {
    case 'fire':
      return { type: 'fire', side: e.side === 'right' ? 'right' : 'left', weapon: e.weapon, angle: +e.angle || 0, power: clamp01(+e.power) };
    case 'sync':
      return { type: 'sync', side: e.side === 'right' ? 'right' : 'left', snapshot: { blocks: e.snapshot?.blocks ?? [], knights: e.snapshot?.knights ?? [] } };
    case 'over':
      return { type: 'over', winner: e.winner === 'left' || e.winner === 'right' ? e.winner : null, cause: (['king', 'castle', 'flag', 'draw'] as const).includes(e.cause) ? e.cause : 'draw' };
    default:
      return { type: 'over', winner: null, cause: 'draw' };
  }
}
