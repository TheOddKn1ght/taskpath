import { startInstallEvents } from "./ui/install";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "./ui/app";
import { startRuntime } from "./ui/store";
import { initializeAuth } from "./ui/auth";
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register("/sw.js", { type: "module", updateViaCache: "none" })
    .catch(() => {});
}
startInstallEvents();
startRuntime(flushSync);
createRoot(document.getElementById("root")!).render(<App />);
void initializeAuth();
