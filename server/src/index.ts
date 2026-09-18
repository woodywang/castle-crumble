import { createServer } from 'node:http';
import { attachGameServer } from './gameServer';

/**
 * 本地开发运行器：把与 Vercel Function（/api/socket.ts）完全相同的游戏服务跑在 3002 端口。
 * 客户端 dev 模式通过 VITE_SOCKET_URL=http://localhost:3002 连接。
 */
const PORT = Number(process.env.PORT ?? 3002);

const http = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
  res.writeHead(404); res.end();
});

attachGameServer(http).then(() => {
  http.listen(PORT, () => console.log(`[castle-crumble] multiplayer server listening on :${PORT}`));
});
