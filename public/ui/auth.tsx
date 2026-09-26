import { authApi } from '../api.ts';
import { startAuthentication } from "./auth-startup.ts";
import { useEffect, useRef, useState } from "react";
import {
  createVault,
  unlockVault,
  replacePassword,
  validUserId,
  normalizeNickname,
} from "../crypto.ts";
import {
  localState,
  activate,
  restoreRemembered,
  isUnlocked,
  syncAfterCurrent,
  switchAccount,
  selectedAccount,
  offlineRequest,
} from "../offline.ts";
import { loadAccount } from "../persistence.ts";
import { errorStatus } from "../errors.ts";
import { getSnapshot, publish, message } from "./store.ts";
import { Dialog } from "./dialog.tsx";
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get("setup"),
  invited = fragment.get("user");
if (token) history.replaceState(null, "", location.pathname + location.search);
export async function initializeAuth() {
  const epoch = getSnapshot().epoch;
  await startAuthentication({
    invitation: !!token,
    load: loadAccount,
    restore: restoreRemembered,
    current: () => epoch === getSnapshot().epoch,
    ready: (phase) => {
      if (phase === "unlocked")
        window.dispatchEvent(new Event("taskpath-unlocked"));
      else publish({ phase });
    },
    failure: (error) => publish({ phase: "locked", error }),
  });
}
export async function changeAccount() {
  token = null;
  invited = null;
  const id = selectedAccount();
  await switchAccount(null);
  await authApi.logout(id).catch(() => {});
}
const configuration = async (id: string | null) => {
  if (!id) throw new Error("Select an account first.");
  return authApi.configuration(id);
};
export function Auth({
  theme,
  privacy,
}: {
  theme: () => void;
  privacy: () => void;
}) {
  const form = useRef<HTMLFormElement>(null),
    mounted = useRef(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(getSnapshot().error),
    [id, setId] = useState(invited || selectedAccount() || "");
  useEffect(() => {
    mounted.current = true;
    const failure = (e: CustomEvent<string>) => setError(e.detail);
    const account = () => setId(invited || selectedAccount() || "");
    window.addEventListener("taskpath-locked", account);
    window.addEventListener("taskpath-lock-error", failure);
    return () => {
      mounted.current = false;
      form.current?.reset();
      window.removeEventListener("taskpath-lock-error", failure);
      window.removeEventListener("taskpath-locked", account);
    };
  }, []);
  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const el = e.currentTarget,
      data = new FormData(el);
    setBusy(true);
    setError("");
    let epoch = getSnapshot().epoch;
    const valid = () =>
      mounted.current &&
      getSnapshot().phase !== "unlocked" &&
      epoch === getSnapshot().epoch;
    try {
      const userId = id.trim().toLowerCase();
      if (!validUserId(userId))
        throw new Error(
          "Enter the user ID from your invitation, not your nickname.",
        );
      if (!crypto.subtle)
        throw new Error(
          "Open Taskpath over HTTPS or localhost to use encryption.",
        );
      if (selectedAccount() !== userId) {
        await switchAccount(userId);
        epoch = getSnapshot().epoch;
      }
      const record = await localState();
      let config,
        online = true;
      try {
        config = await configuration(userId);
      } catch (error) {
        if (errorStatus(error)) throw error;
        online = false;
        config = record.config;
      }
      const password = String(data.get("password"));
      let key,
        nickname = "";
      if (token) {
        if (config)
          throw new Error(
            "This invitation has already been used. Open the normal app URL to sign in.",
          );
        if (!online) throw new Error("Connect to accept your invitation.");
        if (password !== data.get("confirm"))
          throw new Error("The passwords do not match.");
        nickname = normalizeNickname(data.get("nickname"));
        const vault = await createVault(password);
        if (!valid()) return;
        await authApi.setup({ userId, token, config: vault.config, credential: vault.credential });
        config = vault.config;
        key = vault.key;
        token = null;
        invited = null;
      } else {
        if (!config)
          throw new Error(
            online
              ? "User ID or password is incorrect, or the account is not available."
              : "This account has not been downloaded to this browser. Connect to sign in first.",
          );
        if (record.config && record.config.vaultId !== config.vaultId)
          throw new Error(
            "Vault identity changed. Existing encrypted changes were kept.",
          );
        let unlocked;
        try {
          unlocked = await unlockVault(password, config);
        } catch {
          throw new Error("User ID or password is incorrect.");
        }
        key = unlocked.key;
        if (!valid()) return;
        if (online)
          await authApi.login({
            userId,
            credential: unlocked.credential,
            revision: config.revision,
          });
      }
      if (!valid()) return;
      await activate(
        config,
        key,
        data.get("remember") === "on",
        record.lockEpoch,
      );
      if (nickname) {
        await syncAfterCurrent();
        if (isUnlocked() && selectedAccount() === userId)
          await offlineRequest("/api/profile", "POST", { nickname });
      } else void syncAfterCurrent().catch(() => {});
    } catch (error) {
      if (valid()) setError(message(error));
    } finally {
      for (const input of el.querySelectorAll<HTMLInputElement>(
        'input[type="password"]',
      ))
        input.value = "";
      data.delete("password");
      data.delete("confirm");
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section id="unlock-screen" className="auth-shell">
      <header className="auth-header">
        <h1>
          taskpath<span>.</span>
        </h1>
        <button id="unlock-theme" className="secondary-button" onClick={theme}>
          Switch theme
        </button>
      </header>
      <div className="auth-card">
        <h2 id="unlock-title">
          {token ? "Your private vault" : "Unlock Taskpath"}
        </h2>
        <p>
          {token
            ? "Save your user ID and password. There is no password recovery."
            : "Enter your user ID and vault password. Works offline after your first download."}
        </p>
        <form ref={form} id="unlock-form" onSubmit={submit}>
          <label className="field">
            User ID
            <input
              id="unlock-user"
              value={id}
              onChange={(e) => setId(e.target.value)}
              readOnly={!!token}
              required
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={34}
            />
          </label>
          <label className="field">
            Password
            <input
              id="unlock-password"
              name="password"
              type="password"
              required
              maxLength={2048}
              autoComplete={token ? "new-password" : "current-password"}
            />
          </label>
          {token && (
            <>
              <label className="field">
                Confirm password
                <input
                  name="confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                />
              </label>
              <label className="field">
                Nickname (optional)
                <input name="nickname" maxLength={80} />
              </label>
            </>
          )}
          <label className="remember-option">
            <input name="remember" type="checkbox" /> Remember this device
          </label>
          <p className="schedule-hint">
            Anyone using this browser profile may access your tasks when
            remembered. Otherwise, closing or reloading locks the workspace.
          </p>
          {error && (
            <p id="unlock-error" className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            id="unlock-submit"
            className="primary-button auth-submit"
            disabled={busy}
            aria-busy={busy}
          >
            {busy
              ? token
                ? "Creating vault…"
                : "Unlocking…"
              : token
                ? "Create vault"
                : "Unlock"}
          </button>
          <p role="status" className="sr-only">
            {busy
              ? token
                ? "Creating your vault…"
                : "Unlocking your workspace…"
              : ""}
          </p>
        </form>
      </div>
      <p className="auth-note">
        Use 15–1,024 characters. A password manager is recommended. Forgotten
        passwords cannot be recovered by the server.
      </p>
      <div className="privacy-entry">
        <button className="subtle-button" data-privacy-open onClick={privacy}>
          Privacy notice
        </button>
      </div>
    </section>
  );
}
export function PasswordDialog({ close }: { close: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  return (
    <Dialog
      id="password-dialog"
      title="Change password"
      onClose={close}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const el = e.currentTarget,
            data = new FormData(el);
          setBusy(true);
          setError("");
          const id = selectedAccount(),
            epoch = getSnapshot().epoch;
          try {
            if (data.get("new") !== data.get("confirm"))
              throw new Error("The new passwords do not match.");
            if (!id) throw new Error("Select an account first.");
            const config = await configuration(id);
            if (
              !config ||
              config.vaultId !== (await localState()).config?.vaultId
            )
              throw new Error("Vault identity changed.");
            const replacement = await replacePassword(
              String(data.get("current")),
              String(data.get("new")),
              config,
            );
            if (epoch !== getSnapshot().epoch || !isUnlocked()) return;
            await authApi.changePassword(id, { ...replacement, revision: config.revision });
            await localState((record) => {
              if (
                record.config?.vaultId === config.vaultId &&
                record.config.revision < replacement.config.revision
              )
                record.config = replacement.config;
            }, id);
            await authApi.login({
              userId: id,
              credential: replacement.credential,
              revision: replacement.config.revision,
            });
            if (alive.current) close();
          } catch (e) {
            if (alive.current)
              setError(
                e instanceof Error && e.name === "OperationError"
                  ? "Current password is incorrect."
                  : message(e),
              );
          } finally {
            el.reset();
            if (alive.current) setBusy(false);
          }
        }}
      >
        {(
          ["Current password", "New password", "Confirm new password"] as const
        ).map((label, i) => (
          <label className="field" key={label}>
            {label}
            <input
              name={["current", "new", "confirm"][i]}
              type="password"
              required
              autoComplete={i ? "new-password" : "current-password"}
            />
          </label>
        ))}
        <p className="schedule-hint">
          Other devices must sign in again. Copied decryption keys cannot be
          revoked. There is no password reset.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button className="primary-button" disabled={busy}>
          Change password
        </button>
      </form>
    </Dialog>
  );
}
