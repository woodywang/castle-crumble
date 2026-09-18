import { createServer } from 'node:http';
import { attachGameServer } from '../server/src/gameServer.js'; // Vercel ESM 函数需要显式扩展名

/**
 * Vercel Function 入口：Socket.IO 跑在 Fluid compute 上（WebSocket 传输）。
 * 客户端连接路径：/api/socket/socket.io（见 client/src/net/protocol.ts 的 SOCKET_PATH），
 * vercel.json 里把 /api/socket/* 全部 rewrite 到本函数。
 *
 * 注意：多个 Function 实例之间不共享内存，配置 REDIS_URL（Vercel Marketplace → Redis）后
 * 房间状态与广播会通过 Redis 跨实例同步；没配时只在单实例内可用。
 */
const server = createServer((req, res) => {
  if (req.url?.includes('health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, redis: !!(process.env.REDIS_URL ?? process.env.KV_URL) }));
    return;
  }
  res.writeHead(404); res.end();
});

// attach 是异步的（可能要连 Redis）；在第一条连接到来前完成即可
void attachGameServer(server);

export default server;
