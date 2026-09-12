interface SyncManager { register(tag:string):Promise<void> }
interface ServiceWorkerRegistration { readonly sync?:SyncManager }
