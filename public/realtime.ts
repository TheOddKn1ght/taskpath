import type { EncryptedRecord } from './types.js';
interface SocketLike {
  readyState:number; close():void;
  onmessage?: WebSocket['onmessage'];
  onclose?: WebSocket['onclose'];
  onerror?: WebSocket['onerror'];
}
interface RealtimeOptions {
  sync:()=>Promise<unknown>; localState:()=>Promise<Pick<Partial<EncryptedRecord>, "locked" | "authRequired" | "inactive" | "userId"> & { board?: unknown }>; url:string;
  Socket?:new(url:string)=>SocketLike; active?:()=>boolean;
}
// Keep the durable HTTP queue as the only sync path, including after reconnects.
export function createRealtime({ sync, localState, url, Socket = WebSocket, active = () => !document.hidden && navigator.onLine !== false }: RealtimeOptions) {
  const endpoint = new URL('/api/events', url);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: SocketLike | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined, attempts = 0, generation = 0;
  let pulling = false, requested = false;

  async function pull() {
    requested = true;
    if (pulling) return;
    pulling = true;
    try {
      // A notice arriving during a request must cause another read afterwards.
      while (requested) { requested = false; await sync(); }
    } catch { /* The offline queue and polling own error reporting and retries. */ }
    finally { pulling = false; }
  }

  function pause() {
    generation++;
    clearTimeout(retryTimer); retryTimer = undefined;
    clearTimeout(watchdog);
    const previous = socket; socket = undefined;
    previous?.close();
  }

  function retry() {
    if (retryTimer || !active()) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)) * (0.8 + Math.random() * 0.4);
    retryTimer = setTimeout(() => { retryTimer = undefined; void reconcile(); }, delay);
  }

  async function reconcile() {
    const current = generation;
    if (!active()) { pause(); return; }
    let record;
    try { record = await localState(); } catch { return; }
    if (current !== generation) return;
    if (record.inactive || record.locked || record.authRequired || !record.board) { pause(); return; }
    if (socket || retryTimer) return;
    let connection;
    if (record.userId) endpoint.searchParams.set('userId', record.userId);
    try { connection = new Socket(endpoint.href); } catch { retry(); return; }
    socket = connection;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (socket !== connection) return;
        socket = undefined;
        connection.close();
        retry();
        void pull();
      }, 65000);
    };
    armWatchdog();
    connection.onmessage = event => {
      if (socket !== connection) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!['ready', 'changed', 'heartbeat'].includes(message.type)) return;
      attempts = 0;
      armWatchdog();
      if (message.type !== 'heartbeat') void pull();
    };
    connection.onerror = () => { /* onclose schedules reconnect; polling continues. */ };
    connection.onclose = event => {
      if (socket !== connection) return;
      socket = undefined;
      clearTimeout(watchdog);
      retry();
      if (event.code === 4401) void pull();
    };
  }

  return {
    get connected() { return socket?.readyState === 1; },
    reconcile,
    pause,
    resume() {
      clearTimeout(retryTimer); retryTimer = undefined;
      void reconcile();
      void pull();
    },
  };
}
