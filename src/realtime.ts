// Notifications only. Task data and all writes stay on the authenticated HTTP API.
export interface RealtimeSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export type RealtimeData = { userId: string; authorized: () => boolean };

type ManagedSocket = RealtimeSocket & { data: RealtimeData };

export class Realtime {
  private sockets = new Set<ManagedSocket>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private heartbeatMs = 25000) {}

  private valid(socket: ManagedSocket) {
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

  private open(socket: ManagedSocket) {
    if (!this.valid(socket)) return;
    this.sockets.add(socket);
    socket.send('{"type":"ready"}');
    this.timer ??= setInterval(() => {
      for (const connection of this.sockets) {
        if (this.valid(connection)) connection.send('{"type":"heartbeat"}');
      }
    }, this.heartbeatMs);
  }

  private message(socket: ManagedSocket) {
    socket.close(1008, 'Use the HTTP sync API');
  }

  private closed(socket: ManagedSocket) {
    this.sockets.delete(socket);
    this.stopTimerIfEmpty();
  }

  // Attach a native WebSocket upgraded via Deno.upgradeWebSocket.
  attach(socket: WebSocket, data: RealtimeData): void {
    const managed: ManagedSocket = {
      data,
      send: (message: string) => { if (socket.readyState === WebSocket.OPEN) { try { socket.send(message); } catch { /* closing */ } } },
      close: (code?: number, reason?: string) => { try { socket.close(code, reason); } catch { /* already closed */ } },
    };
    socket.onopen = () => this.open(managed);
    socket.onmessage = () => this.message(managed);
    socket.onclose = () => this.closed(managed);
    socket.onerror = () => this.closed(managed);
    if (socket.readyState === WebSocket.OPEN) this.open(managed);
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const socket of this.sockets) socket.close(1001, 'Server restarting');
    this.sockets.clear();
  }
}
