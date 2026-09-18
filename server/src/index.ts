import { createServer } from 'node:http';
import { Server } from 'socket.io';

/**
 * 多人服务骨架（第 2 步会补齐：权威物理 CastleWorld + 快照广播 + PvP 回合）。
 * 当前只提供：健康检查、房间创建/加入、文字聊天，用来验证连通性。
 */
const PORT = Number(process.env.PORT ?? 3001);

interface Player { id: string; name: string; skinId: number; ready: boolean }
interface Room { code: string; mode: 'coop' | 'pvp'; hostId: string; players: Player[]; started: boolean }

const rooms = new Map<string, Room>();
const playerRoom = new Map<string, string>();

const http = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size })); return; }
  res.writeHead(404); res.end();
});
const io = new Server(http, { cors: { origin: '*' } });

const genCode = () => { let c = ''; do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c)); return c; };

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, skinId, mode }, cb) => {
    const room: Room = { code: genCode(), mode, hostId: socket.id, players: [{ id: socket.id, name, skinId, ready: false }], started: false };
    rooms.set(room.code, room); playerRoom.set(socket.id, room.code); socket.join(room.code);
    cb({ ok: true, room }); io.to(room.code).emit('room:state', room);
  });
  socket.on('room:join', ({ code, name, skinId }, cb) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room) return cb({ ok: false, error: '房间不存在' });
    if (room.players.length >= 4) return cb({ ok: false, error: '房间已满（最多 4 人）' });
    if (room.started) return cb({ ok: false, error: '游戏已开始' });
    room.players.push({ id: socket.id, name, skinId, ready: false });
    playerRoom.set(socket.id, room.code); socket.join(room.code);
    cb({ ok: true, room }); io.to(room.code).emit('room:state', room);
  });
  socket.on('chat:send', ({ text }) => {
    const code = playerRoom.get(socket.id); if (!code) return;
    const me = rooms.get(code)?.players.find((p) => p.id === socket.id);
    io.to(code).emit('chat:message', { from: socket.id, name: me?.name ?? '?', text: String(text).slice(0, 200) });
  });
  const leave = () => {
    const code = playerRoom.get(socket.id); if (!code) return;
    const room = rooms.get(code); playerRoom.delete(socket.id); socket.leave(code);
    if (!room) return;
    room.players = room.players.filter((p) => p.id !== socket.id);
    if (!room.players.length) { rooms.delete(code); return; }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    io.to(code).emit('room:state', room);
  };
  socket.on('room:leave', leave);
  socket.on('disconnect', leave);
});

http.listen(PORT, () => console.log(`[castle-crumble] multiplayer server listening on :${PORT}`));
