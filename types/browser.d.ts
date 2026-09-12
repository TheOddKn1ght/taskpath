interface BeforeInstallPromptEvent extends Event { prompt():Promise<void> }
interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
  'taskpath-lock-error': CustomEvent<string>;
}
interface WebMCPTool {
  name:string; description:string; inputSchema:Record<string,unknown>;
  annotations:{readOnlyHint:boolean;untrustedContentHint:boolean};
  execute:(input:Record<string,unknown>)=>Promise<unknown>;
}
interface Document {
  modelContext?: {
    registerTool(tool:WebMCPTool, options?:{signal:AbortSignal}):unknown;
    unregisterTool(name:string):unknown;
    provideContext?(options:{tools:WebMCPTool[]}):unknown;
  };
}
