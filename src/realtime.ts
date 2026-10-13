import type { ServerWebSocket, WebSocketHandler } from 'bun';

export type RealtimeData = { userId: string; authorized: () => boolean };

// Notifications only. Task data and all writes stay on the authenticated HTTP API.
export class Realtime {
  private sockets = new Set<ServerWebSocket<RealtimeData>>();
  private userSockets = new Map<string, Set<ServerWebSocket<RealtimeData>>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private heartbeatMs = 25000) {}

  private valid(socket: ServerWebSocket<RealtimeData>) {
    if (socket.data.authorized()) return true;
    this.remove(socket);
    socket.close(4401, 'Sign in to sync');
    return false;
  }

  private remove(socket: ServerWebSocket<RealtimeData>) {
    this.sockets.delete(socket);
    const devices = this.userSockets.get(socket.data.userId);
    devices?.delete(socket);
    if (devices?.size === 0) this.userSockets.delete(socket.data.userId);
    if (!this.sockets.size) { clearInterval(this.timer); this.timer = undefined; }
  }

  checkSessions() {
    for (const socket of this.sockets) this.valid(socket);
  }

  notify(userId: string) {
    const devices = this.userSockets.get(userId);
    if (!devices) return;
    for (const socket of devices) {
      if (this.valid(socket)) socket.send('{"type":"changed"}');
    }
  }

  readonly websocket: WebSocketHandler<RealtimeData> = {
    data: {} as RealtimeData,
    maxPayloadLength: 1024,
    backpressureLimit: 16384,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    open: socket => {
      if (!this.valid(socket)) return;
      this.sockets.add(socket);
      let devices = this.userSockets.get(socket.data.userId);
      if (!devices) this.userSockets.set(socket.data.userId, devices = new Set());
      devices.add(socket);
      socket.send('{"type":"ready"}');
      this.timer ??= setInterval(() => {
        for (const connection of this.sockets) {
          if (this.valid(connection)) connection.send('{"type":"heartbeat"}');
        }
      }, this.heartbeatMs);
      this.timer.unref();
    },
    message: socket => { socket.close(1008, 'Use the HTTP sync API'); },
    close: socket => { this.remove(socket); },
  };

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const socket of this.sockets) socket.close(1001, 'Server restarting');
    this.sockets.clear();
    this.userSockets.clear();
  }
}
