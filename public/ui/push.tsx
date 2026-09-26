import { accountApi } from '../api.ts';
import { useEffect, useRef, useState } from "react";
import {
  localState,
  selectedAccount,
  isUnlocked,
  syncAfterCurrent,
} from "../offline.ts";
import type { PushStatus } from "../types.d.ts";
import { Dialog } from "./dialog.tsx";
import { message } from "./store.ts";
const digest = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export function PushDialog({ close }: { close: () => void }) {
  const [status, setStatus] = useState("Checking this device…"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [subscribed, setSubscribed] = useState(false),
    [available, setAvailable] = useState(false);
  const id = useRef(selectedAccount()),
    alive = useRef(true),
    registration = useRef<ServiceWorkerRegistration | undefined>(undefined),
    config = useRef<PushStatus | null>(null),
    existing = useRef<PushSubscription | null>(null);
  function check() {
    if (!alive.current || !isUnlocked() || selectedAccount() !== id.current)
      throw new Error("Unlock this account to change notifications.");
  }
  async function refresh() {
    check();
    const [c, r] = await Promise.all([
      accountApi(id.current).push.status(),
      navigator.serviceWorker.getRegistration(),
    ]);
    const subscription = await r?.pushManager.getSubscription();
    const hash = subscription && (await digest(subscription.endpoint));
    check();
    config.current = c;
    registration.current = r;
    existing.current = subscription || null;
    const on = !!subscription && c.subscriptionIds.includes(hash || "");
    setSubscribed(on);
    setAvailable(c.available && !!r?.active);
    setStatus(
      !c.available
        ? "Your administrator needs to set TASKPATH_ORIGIN to the public HTTPS address."
        : !r?.active
          ? "The offline app is still installing. Close this dialog and try again shortly."
          : on
            ? "Background reminders are on for this device, including while the vault is locked."
            : "Background reminders are off on this device.",
    );
  }
  useEffect(() => {
    alive.current = true;
    if (
      !window.isSecureContext ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setStatus(
        "This browser does not support background notifications here. On iPhone or iPad, install the Home Screen app on iOS 16.4 or later.",
      );
      setBusy(false);
    } else
      void refresh()
        .catch((e) => {
          if (alive.current) setError(message(e));
        })
        .finally(() => {
          if (alive.current) setBusy(false);
        });
    return () => {
      alive.current = false;
    };
  }, []);
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      check();
      if (subscribed) {
        await accountApi(id.current).push.unsubscribe(await digest(existing.current!.endpoint));
        await existing.current!.unsubscribe();
        for (const n of await registration.current!.getNotifications())
          if (n.tag.startsWith("taskpath-reminder-")) n.close();
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted")
          throw new Error(
            "Notifications were not allowed. Change this in your browser or device settings.",
          );
        check();
        const publicKey = config.current?.publicKey;
        if (typeof publicKey !== "string" || !/^[\w-]{80,100}$/.test(publicKey))
          throw new Error(
            "Background notifications are unavailable. Reopen online after updating.",
          );
        const base = publicKey.replace(/-/g, "+").replace(/_/g, "/");
        const key = Uint8Array.from(
          atob(base + "=".repeat((4 - (base.length % 4)) % 4)),
          (c) => c.charCodeAt(0),
        );
        const live = await navigator.serviceWorker.ready;
        check();
        if (!live.active)
          throw new Error("The offline app is still installing.");
        registration.current = live;
        try {
          existing.current = await live.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          });
        } catch (e) {
          throw new Error(
            `Could not reach the browser push service (${e instanceof Error ? e.name : "push service error"}). Check connection, permissions, VPN or ad-blocker.`,
            { cause: e },
          );
        }
        check();
        await accountApi(id.current).push.subscribe(existing.current.toJSON());
        check();
        await localState((r) => {
          r.pushEnabled = true;
          r.reminderPublished = {};
        }, id.current);
      }
      check();
      setStatus("Updating reminder schedules…");
      await syncAfterCurrent();
      await refresh();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Dialog id="push-dialog" title="Background reminders" onClose={close}>
      <p>
        Get “You have a reminder in Taskpath” while the app is closed or locked.
        Task titles and notes never appear in notifications.
      </p>
      <p>
        Enabling shares reminder times, random identifiers and this device's
        push subscription with your server and browser push provider.
      </p>
      <p id="push-status">{status}</p>
      {error && (
        <p id="push-error" role="alert" className="form-error">
          {error}
        </p>
      )}
      <button
        id="push-toggle"
        className="primary-button"
        disabled={busy || !available}
        onClick={() => void toggle()}
      >
        {subscribed ? "Turn off on this device" : "Enable on this device"}
      </button>
    </Dialog>
  );
}
