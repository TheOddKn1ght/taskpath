import type { ServerWebSocket, WebSocketHandler } from 'bun';

export type RealtimeData = { userId: string; authorized: () => boolean };

// Notifications only. Task data and all writes stay on the authenticated HTTP API.
export class Realtime {
  private sockets = new Set<ServerWebSocket<RealtimeData>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private heartbeatMs = 25000) {}

  private valid(socket: ServerWebSocket<RealtimeData>) {
    if (socket.data.authorized()) return true;
    this.sockets.delete(socket);
    socket.close(4401, 'Sign in to sync');
    this.stopTimerIfEmpty();
    return false;
  }

  private stopTimerIfEmpty() {
    if (!this.sockets.size) { clearInterval(this.timer); this.timer = undefined; }
  }

  checkSessions() {
    for (const socket of this.sockets) this.valid(socket);
  }

  notify(userId: string) {
    for (const socket of this.sockets) {
      if (this.valid(socket) && socket.data.userId === userId) socket.send('{"type":"changed"}');
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
      socket.send('{"type":"ready"}');
      this.timer ??= setInterval(() => {
        for (const connection of this.sockets) {
          if (this.valid(connection)) connection.send('{"type":"heartbeat"}');
        }
      }, this.heartbeatMs);
      this.timer.unref();
    },
    message: socket => { socket.close(1008, 'Use the HTTP sync API'); },
    close: socket => { this.sockets.delete(socket); this.stopTimerIfEmpty(); },
  };

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const socket of this.sockets) socket.close(1001, 'Server restarting');
    this.sockets.clear();
  }
}
