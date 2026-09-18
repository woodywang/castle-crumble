import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, GameEvent, GameEventInput, Reply, RoomState, ServerToClient } from './protocol';
import { SOCKET_PATH } from './protocol';
import type { Side } from '../physics/types';

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface NetEvents {
  status: (s: NetStatus) => void;
  room: (room: RoomState) => void;
  event: (e: GameEvent) => void;
  aim: (p: { side: Side; angle: number; power: number; charging: boolean }) => void;
  chat: (p: { playerId: string; name: string; text: string; ts: number }) => void;
}

/**
 * Socket.IO 客户端封装：
 *  - 持久 playerId（localStorage）用于断线后找回座位；
 *  - 自动重连（Vercel Function 到时会切断连接），重连后 room:rejoin 补拉漏掉的事件；
 *  - 事件按 seq 去重、保序，交给场景层。
 */
export class NetClient {
  readonly playerId: string;
  room: RoomState | null = null;
  status: NetStatus = 'idle';
  lastSeq = 0;
  private socket: Socket<ServerToClient, ClientToServer> | null = null;
  private listeners: { [K in keyof NetEvents]?: NetEvents[K][] } = {};

  constructor() {
    let id = localStorage.getItem('cc.playerId');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('cc.playerId', id); }
    this.playerId = id;
  }

  get mySide(): Side | null { return this.room?.players.find((p) => p.playerId === this.playerId)?.side ?? null; }
  get isHost() { return this.room?.hostPlayerId === this.playerId; }
  get opponent() { return this.room?.players.find((p) => p.playerId !== this.playerId) ?? null; }

  on<K extends keyof NetEvents>(name: K, fn: NetEvents[K]) {
    const list = (this.listeners[name] ??= []) as NetEvents[K][];
    list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }
  private emit<K extends keyof NetEvents>(name: K, ...args: Parameters<NetEvents[K]>) {
    for (const fn of this.listeners[name] ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  private setStatus(s: NetStatus) { this.status = s; this.emit('status', s); }

  /** 建立连接（幂等）。URL：dev 用 VITE_SOCKET_URL，生产与页面同源（/api/socket） */
  connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    const url = (import.meta.env.VITE_SOCKET_URL as string | undefined) || window.location.origin;
    this.setStatus('connecting');
    const socket: Socket<ServerToClient, ClientToServer> = io(url, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
    });
    this.socket = socket;

    socket.on('room:state', (room) => { this.room = room; this.emit('room', room); });
    socket.on('game:event', (e) => this.acceptEvent(e));
    socket.on('game:aim', (p) => this.emit('aim', p));
    socket.on('chat:message', (m) => this.emit('chat', m));
    socket.io.on('reconnect_attempt', () => this.setStatus('reconnecting'));
    socket.on('disconnect', () => this.setStatus('reconnecting'));
    socket.on('connect', () => {
      this.setStatus('connected');
      // 重连：找回座位 + 补拉事件
      if (this.room) {
        socket.emit('room:rejoin', { code: this.room.code, playerId: this.playerId, lastSeq: this.lastSeq }, (r) => {
          if (r.ok) { this.room = r.data.room; this.emit('room', r.data.room); for (const e of r.data.missed) this.acceptEvent(e); }
          else { this.room = null; this.setStatus('disconnected'); }
        });
      }
    });

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接服务器超时')), 8000);
      socket.once('connect', () => { clearTimeout(t); resolve(); });
      socket.once('connect_error', (err) => { clearTimeout(t); reject(err); });
    });
  }

  private acceptEvent(e: GameEvent) {
    if (e.seq <= this.lastSeq) return; // 重复
    this.lastSeq = e.seq;
    this.emit('event', e);
  }

  private call<T>(fn: (cb: (r: Reply<T>) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('服务器无响应')), 8000);
      fn((r) => { clearTimeout(t); r.ok ? resolve(r.data) : reject(new Error(r.error)); });
    });
  }

  async createRoom(name: string, skinId: number) {
    await this.connect();
    this.lastSeq = 0;
    const room = await this.call<RoomState>((cb) => this.socket!.emit('room:create', { playerId: this.playerId, name, skinId }, cb));
    this.room = room; this.emit('room', room);
    return room;
  }

  async joinRoom(code: string, name: string, skinId: number) {
    await this.connect();
    this.lastSeq = 0;
    const room = await this.call<RoomState>((cb) => this.socket!.emit('room:join', { code, playerId: this.playerId, name, skinId }, cb));
    this.room = room; this.emit('room', room);
    return room;
  }

  startGame() { return this.call<RoomState>((cb) => this.socket!.emit('room:start', cb)); }

  leaveRoom() { this.socket?.emit('room:leave'); this.room = null; this.lastSeq = 0; }

  sendEvent(e: GameEventInput) { this.socket?.emit('game:event', e); }
  sendAim(angle: number, power: number, charging: boolean) { this.socket?.emit('game:aim', { angle, power, charging }); }
  sendChat(text: string) { this.socket?.emit('chat:send', { text }); }
}
