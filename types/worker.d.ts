// Page-only branches of the shared offline module never execute in a worker.
declare const window: EventTarget & {
  addEventListener(type: 'pageshow', listener: (event: Event & { persisted: boolean }) => void): void;
};
interface ServiceWorkerGlobalScopeEventMap {
  sync: ExtendableEvent & { tag: string };
}
interface NotificationOptions { renotify?: boolean }
