let prompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
export const getInstallPrompt = () => prompt;
export const subscribeInstall = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function startInstallEvents() {
  const controller = new AbortController();
  window.addEventListener(
    "beforeinstallprompt",
    (event) => {
      event.preventDefault();
      prompt = event;
      listeners.forEach((fn) => fn());
    },
    { signal: controller.signal },
  );
  window.addEventListener(
    "appinstalled",
    () => {
      prompt = null;
      listeners.forEach((fn) => fn());
    },
    { signal: controller.signal },
  );
  return () => controller.abort();
}
export async function installApp() {
  const event = prompt;
  if (!event) return;
  prompt = null;
  listeners.forEach((fn) => fn());
  await event.prompt();
}
