import { startInstallEvents } from "./ui/install.ts";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "./ui/app.tsx";
import { startRuntime } from "./ui/store.ts";
import { initializeAuth } from "./ui/auth.tsx";
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .catch(() => {});
}
startInstallEvents();
startRuntime(flushSync);
createRoot(document.getElementById("root")!).render(<App />);
void initializeAuth();
