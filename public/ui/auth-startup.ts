export async function startAuthentication(deps: {
  invitation: boolean;
  load: () => Promise<unknown>;
  restore: () => Promise<boolean>;
  current: () => boolean;
  ready: (phase: "locked" | "unlocked") => void;
  failure: (error: string) => void;
}) {
  try {
    await deps.load();
    if (!deps.current()) return;
    const remembered = !deps.invitation && (await deps.restore());
    if (deps.current()) deps.ready(remembered ? "unlocked" : "locked");
  } catch {
    if (deps.current())
      deps.failure(
        "Could not open device storage. Allow browser storage and reload to unlock your workspace.",
      );
  }
}
