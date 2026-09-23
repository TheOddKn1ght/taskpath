import { getInstallPrompt, subscribeInstall, installApp } from "./install";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Task, Status, ArchiveReceipt } from "../types.js";
import {
  subscribe,
  getSnapshot,
  navigate,
  mutate,
  move,
  refresh,
  message,
  columns,
} from "./store";
import {
  isUnlocked,
  lock,
  offlineRequest,
  syncAfterCurrent,
  selectedAccount,
} from "../offline.js";
import { Auth, PasswordDialog, changeAccount } from "./auth";
import { Board, dateLabel } from "./board";
import { Files } from "./files";
import { Editor } from "./editor";
import { Dialog } from "./dialog";
import { ThemeDialog, ThemeIcon } from "./theme";
import { PrivacyCopy, GuideCopy } from "./copy";
import { PushDialog } from "./push";
import { ImportDialog } from "./import";
import { PickerProvider, Select } from "./pickers";
import { Icon } from "./icons";
import { GREETINGS } from "./greetings";
export function App() {
  const state = useSyncExternalStore(subscribe, getSnapshot),
    [publicDialog, setPublicDialog] = useState<"theme" | "privacy" | null>(
      null,
    );
  useLayoutEffect(() => {
    document.body.classList.toggle("vault-locked", state.phase !== "unlocked");
    if (state.phase !== "unlocked") setPublicDialog(null);
  }, [state.phase, state.epoch]);
  return (
    <>
      {state.phase === "loading" ? (
        <section id="vault-loading" role="status">
          <h1>
            taskpath<span>.</span>
          </h1>
          <p className="loading-status">
            <span className="loading-spinner" />
            Opening your workspace…
          </p>
        </section>
      ) : state.phase === "locked" ? (
        <Auth
          theme={() => setPublicDialog("theme")}
          privacy={() => setPublicDialog("privacy")}
        />
      ) : (
        <PickerProvider key={state.epoch}>
          <Workspace
            theme={() => setPublicDialog("theme")}
            privacy={() => setPublicDialog("privacy")}
          />
        </PickerProvider>
      )}
      {publicDialog === "theme" && (
        <ThemeDialog close={() => setPublicDialog(null)} />
      )}{" "}
      {publicDialog === "privacy" && (
        <Dialog
          id="privacy-dialog"
          title="Privacy notice"
          onClose={() => setPublicDialog(null)}
        >
          <PrivacyCopy />
        </Dialog>
      )}
    </>
  );
}
function Workspace({
  theme,
  privacy,
}: {
  theme: () => void;
  privacy: () => void;
}) {
  const state = useSyncExternalStore(subscribe, getSnapshot),
    { board, route } = state;
  const [editor, setEditor] = useState<{
      task: Task | null;
      status: Status;
    } | null>(null),
    [details, setDetails] = useState<string | null>(null),
    [modal, setModal] = useState<
      "password" | "nickname" | "push" | "import" | "guide" | null
    >(null),
    [toast, setToast] = useState<{
      text: string;
      undo?: () => Promise<void>;
    } | null>(null),
    [collapsed, setCollapsed] = useState(() => {
      try {
        return localStorage.getItem("taskpath-sidebar-collapsed") === "true";
      } catch {
        return false;
      }
    }),
    [keyboard, setKeyboard] = useState(false),
    [notifications, setNotifications] = useState(() => {
      try {
        return localStorage.getItem("taskpath-notifications") !== "off";
      } catch {
        return true;
      }
    }),
    [, render] = useState(0);
  const install = useSyncExternalStore(subscribeInstall, getInstallPrompt);
  const alive = useRef(true),
    menu = useRef<HTMLDetailsElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    notificationBusy = useRef(false),
    desktopNotifications = useRef(new Set<Notification>()),
    exports = useRef(new Set<string>()),
    greeting = useRef<{ period: string; phrase: string } | null>(null);
  const notify = (text: string, undo?: () => Promise<void>) => {
    if (!alive.current || !isUnlocked()) return;
    clearTimeout(timer.current);
    setToast({ text, undo });
    timer.current = setTimeout(
      () => {
        if (alive.current) setToast(null);
      },
      undo ? 15000 : 5000,
    );
  };
  const run = (fn: () => Promise<unknown>) =>
    void fn().catch((e) => notify(message(e)));
  const edit = (task: Task) => {
    if (task.archivedAt) setDetails(task.id);
    else setEditor({ task, status: task.status });
  };
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isUnlocked()) return;
      if (document.querySelector('dialog[open], #task-context-menu, .task-menu-popover')) return;
      if (event.key === "Escape") {
        for (const open of document.querySelectorAll<HTMLDetailsElement>(".task-menu[open], .app-menu[open]")) {
          open.open = false;
          open.querySelector("summary")?.focus();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat ||
        (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (getSnapshot().route.view !== "board") navigate({ view: "board" });
        setEditor({ task: null, status: "later" });
      } else if (event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#search")?.focus();
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, []);
  useEffect(() => {
    alive.current = true;
    const pref = (e: StorageEvent) => {
      if (e.key === "taskpath-sidebar-collapsed" || e.key === null) {
        try {
          setCollapsed(
            localStorage.getItem("taskpath-sidebar-collapsed") === "true",
          );
        } catch {}
      }
    };
    window.addEventListener("storage", pref);
    return () => {
      alive.current = false;
      for (const notification of desktopNotifications.current) {
        notification.onclick = null;
        notification.close();
      }
      desktopNotifications.current.clear();
      clearTimeout(timer.current);
      for (const url of exports.current) URL.revokeObjectURL(url);
      exports.current.clear();
      window.removeEventListener("storage", pref);
    };
  }, []);
  useEffect(() => {
    let full = innerHeight;
    const update = () => {
      const vp = visualViewport;
      if (!vp) return;
      const editing = document.activeElement?.matches(
        'input,textarea,[contenteditable="true"]',
      );
      if (!editing) full = innerHeight;
      setKeyboard(
        matchMedia("(max-width:760px)").matches &&
          !!editing &&
          vp.scale === 1 &&
          full - vp.height > 120,
      );
    };
    const abort = new AbortController();
    for (const name of ["resize", "focusin", "focusout"])
      window.addEventListener(name, update, { signal: abort.signal });
    visualViewport?.addEventListener("resize", update, {
      signal: abort.signal,
    });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    document.body.classList.toggle("files-view", route.view === "files");
    return () => document.body.classList.remove("files-view");
  }, [route.view]);
  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: WebMCPTool) => {
      try {
        Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => {});
      } catch {}
    };
    register({
      name: "list_tasks",
      description: "Read the tasks in this Taskpath workspace.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => {
        const b = await offlineRequest("/api/board");
        return { tasks: b.tasks.filter((t) => !t.archivedAt) };
      },
    });
    register({
      name: "create_task",
      description: "Create a task and save it to the selected Taskpath column.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 240 },
          status: { type: "string", enum: Object.keys(columns) },
        },
        required: ["title", "status"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input) => ({
        task: (await mutate("/api/tasks", "POST", input)).task,
      }),
    });
    register({
      name: "move_task",
      description:
        "Move a saved Taskpath task into Later, This Week, Today, or Done.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: Object.keys(columns) },
        },
        required: ["id", "status"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input) => {
        if (
          !input ||
          typeof input.id !== "string" ||
          typeof input.status !== "string" ||
          !Object.hasOwn(columns, input.status)
        )
          throw new Error("Invalid task or column.");
        await mutate(`/api/tasks/${input.id}`, "PATCH", {
          status: input.status,
        });
        return { id: input.id, status: input.status };
      },
    });
    return () => {
      lifecycle.abort();
      for (const name of ["list_tasks", "create_task", "move_task"])
        try {
          context.unregisterTool?.(name);
        } catch {}
    };
  }, []);
  useLayoutEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const view = document.getElementById(
      route.view === "files" ? "files-view" : "board",
    );
    const animation = view?.animate(
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 160, easing: "ease-out" },
    );
    return () => animation?.cancel();
  }, [route.view]);
  const enabled =
    notifications &&
    "Notification" in window &&
    Notification.permission === "granted";
  useEffect(() => {
    if (!board) return;
    const upcoming = board.tasks.filter(
      (t) =>
        !t.archivedAt &&
        t.reminderAt &&
        !t.reminderDismissedAt &&
        t.status !== "done" &&
        t.reminderAt > board.serverTime,
    );
    const timer = upcoming.length
      ? setTimeout(
          () => void refresh(),
          Math.max(
            500,
            Math.min(
              60000,
              Math.min(...upcoming.map((t) => Date.parse(t.reminderAt!))) -
                Date.parse(board.serverTime) +
                100,
            ),
          ),
        )
      : undefined;
    if (board.reminders.length && enabled && !notificationBusy.current) {
      notificationBusy.current = true;
      void (async () => {
        try {
          const { tasks } = await offlineRequest(
            "/api/reminders/claim",
            "POST",
            {},
          );
          if (!alive.current || !isUnlocked() || !tasks.length) return;
          const task = tasks.length === 1 ? tasks[0] : null;
          const n = new Notification("Taskpath reminder", {
            body: "You have a reminder in Taskpath.",
            tag: task
              ? "taskpath-reminder-" + task.reminderToken
              : "taskpath-reminders",
            icon: document.querySelector<HTMLLinkElement>(
              'link[rel="apple-touch-icon"]',
            )?.href,
          });
          desktopNotifications.current.add(n);
          n.onclose = () => desktopNotifications.current.delete(n);
          const taskId = task?.id;
          n.onclick = () => {
            window.focus();
            n.close();
            const current = getSnapshot().board?.tasks.find(
              (t) => t.id === taskId,
            );
            if (alive.current && isUnlocked() && current) edit(current);
          };
        } catch {
        } finally {
          notificationBusy.current = false;
        }
      })();
    }
    return () => clearTimeout(timer);
  }, [board, enabled]);
  async function toggleNotifications() {
    if (!("Notification" in window) || !isSecureContext) {
      notify(
        "Desktop notifications are unavailable. In-app reminders still work.",
      );
      return;
    }
    let next = false;
    if (!enabled) {
      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission;
      next = permission === "granted";
    }
    if (!alive.current) return;
    setNotifications(next);
    try {
      localStorage.setItem("taskpath-notifications", next ? "on" : "off");
    } catch {}
    notify(next ? "Desktop notifications enabled." : "Using in-app reminders.");
  }
  async function remove(task: Task) {
    await mutate(`/api/tasks/${task.id}`, "DELETE");
    notify("Task deleted.", async () => {
      await mutate(`/api/tasks/${task.id}/restore`, "POST");
      notify("Task restored.");
    });
  }
  function archiveNotice(undo: ArchiveReceipt[]) {
    if (!undo.length) {
      notify("No completed tasks to archive.");
      return;
    }
    notify(
      undo.length === 1 ? "Task archived." : `${undo.length} tasks archived.`,
      async () => {
        const result = await mutate("/api/tasks/archive-undo", "POST", {
          undo,
        });
        notify(
          `${result.restored} tasks restored.${result.skipped ? ` ${result.skipped} changed since archiving and were skipped.` : ""}`,
        );
      },
    );
  }
  async function archive(task: Task) {
    archiveNotice(
      (await mutate(`/api/tasks/${task.id}/archive`, "POST")).undo || [],
    );
  }
  async function download(markdown: boolean) {
    const result = markdown
      ? await offlineRequest("/api/export?format=markdown")
      : await offlineRequest("/api/export");
    if (!alive.current || !isUnlocked()) return;
    const url = URL.createObjectURL(
      new Blob(
        [typeof result === "string" ? result : JSON.stringify(result, null, 2)],
        { type: markdown ? "text/markdown;charset=utf-8" : "application/json" },
      ),
    );
    exports.current.add(url);
    const a = document.createElement("a");
    a.href = url;
    a.download = `taskpath-${board?.day || "export"}.${markdown ? "md" : "json"}`;
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      exports.current.delete(url);
    }, 1000);
  }
  const period = (() => {
    const hour = new Date().getHours();
    return hour < 6
      ? "night"
      : hour < 12
        ? "morning"
        : hour < 18
          ? "afternoon"
          : "evening";
  })();
  if (!greeting.current || greeting.current.period !== period) {
    const list = [...GREETINGS.general, ...GREETINGS[period]];
    greeting.current = {
      period,
      phrase: list[Math.floor(Math.random() * list.length)],
    };
  }
  const tags = [
    ...new Set([
      ...(board?.tasks.flatMap((t) => t.tags) || []),
      ...(route.tag ? [route.tag] : []),
    ]),
  ].sort();
  const archived = board?.tasks.find((t) => t.id === details && t.archivedAt);
  const completed =
    board?.tasks.filter((t) => !t.archivedAt && t.status === "done").length ||
    0;
  const week = board
    ? (() => {
        const start = new Date(board.week + "T12:00:00Z"),
          end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 6);
        const format = (d: Date) =>
          d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          });
        return `${format(start)} – ${format(end)}`;
      })()
    : "This week";
  const options = [
    {
      label: enabled
        ? "Turn off desktop notifications"
        : "Enable desktop notifications",
      fn: () => run(toggleNotifications),
    },
    { label: "Background reminders…", fn: () => setModal("push") },
    { label: "Import Markdown…", fn: () => setModal("import") },
    { label: "Export Markdown", fn: () => run(() => download(true)) },
    { label: "Export JSON", fn: () => run(() => download(false)) },
    ...(install
      ? [
          {
            label: "Install Taskpath",
            fn: () =>
              run(async () => {
                await installApp();
              }),
          },
        ]
      : []),
    { label: "How it works", fn: () => setModal("guide") },
    {
      label: `Archive all completed (${completed})`,
      disabled: !completed,
      fn: () =>
        run(async () =>
          archiveNotice(
            (await mutate("/api/tasks/archive-completed", "POST")).undo || [],
          ),
        ),
    },
    { label: "Nickname…", fn: () => setModal("nickname") },
    { label: "Switch account", fn: () => run(changeAccount) },
    { label: "Change password…", fn: () => setModal("password") },
    { label: "Lock", fn: () => run(lock) },
  ];
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("board")?.focus();
          document.getElementById("board")?.scrollIntoView({ block: "start" });
        }}
      >
        Skip to your tasks
      </a>
      <main
        id="main"
        className={`${collapsed ? "sidebar-collapsed " : ""}${keyboard ? "mobile-keyboard" : ""}`}
      >
        <aside id="sidebar">
          <button
            id="sidebar-toggle"
            className="icon-button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              setCollapsed(!collapsed);
              try {
                localStorage.setItem(
                  "taskpath-sidebar-collapsed",
                  String(!collapsed),
                );
              } catch {}
            }}
          >
            <Icon name="sidebar" />
          </button>
          <nav aria-label="Workspace">
            {(["board", "archive", "files"] as const).map((view) => (
              <button
                key={view}
                data-view={view}
                aria-label={view[0].toUpperCase() + view.slice(1)}
                aria-current={route.view === view ? "page" : undefined}
                onClick={() => {
                  navigate({ view });
                  if (
                    route.view !== view &&
                    matchMedia("(max-width:760px)").matches
                  )
                    window.scrollTo({ top: 0, behavior: "instant" });
                }}
              >
                <Icon name={view} />
                <span className="nav-label">
                  {view[0].toUpperCase() + view.slice(1)}
                </span>
              </button>
            ))}
          </nav>
        </aside>
        <div className="workspace-content">
          <header className="app-header">
            <div className="app-heading">
              <h1>
                taskpath<span>.</span>
              </h1>
              <span id="greeting" className="week-label">
                {board?.nickname
                  ? `${greeting.current.phrase}, ${board.nickname}`
                  : ""}
              </span>
              <span id="week-label" className="week-label">
                {week}
              </span>
            </div>
            <div className="toolbar">
              <label className="search">
                <Icon name="search" />
                <input
                  id="search"
                  type="search"
                  aria-label="Search tasks"
                  placeholder="Search"
                  value={route.query}
                  onChange={(e) => navigate({ query: e.target.value }, true)}
                />
              </label>
              <Select
                id="category-filter"
                label="Filter tasks by category"
                value={route.category}
                options={[
                  { value: "all", label: "All tasks" },
                  { value: "work", label: "Work" },
                  { value: "personal", label: "Personal" },
                ]}
                onChange={(v) =>
                  navigate({ category: v as typeof route.category }, true)
                }
              />
              <Select
                id="tag-filter"
                label="Filter tasks by tag"
                value={route.tag}
                search
                options={[
                  { value: "", label: "All tags" },
                  ...tags.map((value) => ({ value, label: value })),
                ]}
                onChange={(tag) => navigate({ tag }, true)}
              />
              <button
                id="new-task"
                className="primary-button"
                aria-label="New task"
                hidden={route.view === "archive"}
                onClick={() => setEditor({ task: null, status: "later" })}
              >
                <Icon name="plus" />
                New task
              </button>
              <button
                id="theme-toggle"
                className="icon-button theme-toggle"
                aria-label="Choose theme"
                onClick={theme}
              >
                <ThemeIcon />
              </button>
              <details
                ref={menu}
                className="app-menu"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector("summary")?.focus();
                  }
                }}
                onBlur={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  )
                    event.currentTarget.open = false;
                }}
              >
                <summary className="icon-button" aria-label="Workspace options">
                  <Icon name="more" />
                </summary>
                <div className="menu-content">
                  {options.map((o) => (
                    <button
                      key={o.label}
                      disabled={"disabled" in o && o.disabled}
                      onClick={() => {
                        if (menu.current) menu.current.open = false;
                        o.fn();
                      }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </details>
            </div>
          </header>
          {state.error && (
            <div id="error-banner" className="error-banner" role="alert">
              <span>{state.error}</span>
              <button
                className="subtle-button"
                onClick={() =>
                  run(async () => {
                    await syncAfterCurrent();
                    await refresh();
                  })
                }
              >
                Try again
              </button>
            </div>
          )}
          {route.view === "board" && !!board?.reminders.length && (
            <section
              id="reminder-panel"
              className="reminder-panel"
              aria-label="Due reminders"
            >
              {board.reminders.map((t) => (
                <div className="reminder-row" key={t.id}>
                  <Icon name="bell" />
                  <button className="reminder-open" onClick={() => edit(t)}>
                    <strong>{t.title}</strong>
                    <span>{dateLabel(t.reminderAt)}</span>
                  </button>
                  {(["snooze", "dismiss"] as const).map((action) => (
                    <button
                      key={action}
                      className="subtle-button"
                      disabled={state.busy}
                      onClick={() =>
                        run(() =>
                          mutate(`/api/tasks/${t.id}/reminder`, "POST", {
                            action,
                            reminderAt: t.reminderAt,
                          }),
                        )
                      }
                    >
                      {action === "snooze" ? "Snooze 10m" : "Dismiss"}
                    </button>
                  ))}
                </div>
              ))}
            </section>
          )}
          {route.view === "files" ? (
            <Files />
          ) : board ? (
            <Board
              board={board}
              route={route}
              actions={{
                edit,
                create: (status) => setEditor({ task: null, status }),
                remove,
                archive,
                notify,
              }}
            />
          ) : (
            <section id="board" className="board" aria-busy="true">
              <p className="loading-message loading-status" role="status">
                <span className="loading-spinner" />
                Opening your tasks…
              </p>
            </section>
          )}
          <footer className="board-footer">
            <p>Plan your week. Pick your day.</p>
            <button className="subtle-button" onClick={privacy}>
              Privacy notice
            </button>
            {state.authRequired && (
              <a
                href="/login"
                onClick={(e) => {
                  e.preventDefault();
                  run(lock);
                }}
              >
                Sign in to sync
              </a>
            )}
            <span id="save-status" className="save-status" role="status">
              <span className="status-dot" />
              {state.connection}
            </span>
          </footer>
        </div>
      </main>
      {editor && board && (
        <Editor
          key={editor.task?.id || "new"}
          {...editor}
          board={board}
          initialTag={route.tag}
          initialCategory={route.category === "work" ? "work" : "personal"}
          close={() => setEditor(null)}
          remove={remove}
          archive={archive}
          notify={notify}
          notifications={toggleNotifications}
        />
      )}
      {archived && (
        <Dialog
          id="archive-details-dialog"
          title="Archived task"
          onClose={() => setDetails(null)}
        >
          <div id="archive-details-content">
            <h3>{archived.title}</h3>
            <p className="archive-meta">
              {columns[archived.status]} · {archived.category} · Archived{" "}
              {dateLabel(archived.archivedAt)}
            </p>
            <p className="archive-notes">{archived.notes}</p>
            <p>Tags: {archived.tags.join(", ")}</p>
            {archived.dueDate && <p>Due: {archived.dueDate}</p>}
            {archived.reminderAt && (
              <p>
                Reminder: {dateLabel(archived.reminderAt)} (
                {archived.reminderDismissedAt
                  ? "dismissed"
                  : "paused while archived"}
                )
              </p>
            )}
          </div>
          <div className="dialog-actions">
            <button
              className="subtle-button danger"
              onClick={() =>
                run(async () => {
                  await remove(archived);
                  setDetails(null);
                })
              }
            >
              Delete task
            </button>
            <button
              className="primary-button"
              onClick={() =>
                run(async () => {
                  await mutate(`/api/tasks/${archived.id}/unarchive`, "POST");
                  setDetails(null);
                })
              }
            >
              Restore task
            </button>
          </div>
        </Dialog>
      )}
      {modal === "password" && <PasswordDialog close={() => setModal(null)} />}{" "}
      {modal === "nickname" && (
        <Nickname
          initial={board?.nickname || ""}
          close={() => setModal(null)}
        />
      )}{" "}
      {modal === "push" && <PushDialog close={() => setModal(null)} />}{" "}
      {modal === "import" && (
        <ImportDialog close={() => setModal(null)} notify={notify} />
      )}{" "}
      {modal === "guide" && (
        <Dialog
          id="guide-dialog"
          title="How it works"
          onClose={() => setModal(null)}
        >
          <GuideCopy />
          <p>
            Your planning timezone: {board?.timezone}. Weeks begin on Monday.
          </p>
        </Dialog>
      )}
      {toast && (
        <div id="toast" className="toast" role="status">
          <span id="toast-message">{toast.text}</span>
          {toast.undo && (
            <button
              id="toast-action"
              onClick={() => {
                const undo = toast.undo!;
                setToast(null);
                run(undo);
              }}
            >
              Undo
            </button>
          )}
          <button
            id="toast-close"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      )}
      <div id="announcer" className="sr-only" aria-live="polite">
        {board?.reminders.length
          ? `${board.reminders.length} reminders are due.`
          : ""}
      </div>
    </>
  );
}
function Nickname({ initial, close }: { initial: string; close: () => void }) {
  const [error, setError] = useState(""),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  return (
    <Dialog id="nickname-dialog" title="Your nickname" onClose={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await mutate("/api/profile", "POST", {
              nickname: new FormData(e.currentTarget).get("nickname"),
            });
            if (alive.current) close();
          } catch (e) {
            if (alive.current) setError(message(e));
          }
        }}
      >
        <label className="field">
          Nickname (optional)
          <input name="nickname" defaultValue={initial} maxLength={80} />
        </label>
        <p className="schedule-hint">
          Only used for your greeting. Sign in with your user ID. Stored
          encrypted in your vault.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button">Save</button>
      </form>
    </Dialog>
  );
}
