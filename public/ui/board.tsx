import {
  useRef,
  useState,
  useEffect,
  type DragEvent,
  type PointerEvent,
} from "react";
import type { Board as BoardData, Task, Status, Route } from "../types.js";
import { columns, boardOrder, move, mutate, message, navigate } from "./store";
import { Icon } from "./icons";
import { Select } from "./pickers";
import { TaskMenu } from "./task-menu";
import { dueLabel } from "../dates.js";
export const dateLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(new Date(iso).getFullYear() !== new Date().getFullYear()
          ? { year: "numeric" }
          : {}),
      })
    : "";
interface Actions {
  edit: (task: Task) => void;
  create: (status: Status) => void;
  remove: (t: Task) => Promise<void>;
  archive: (t: Task) => Promise<void>;
  notify: (s: string) => void;
}
export function Board({
  board,
  route,
  actions,
}: {
  board: BoardData;
  route: Route;
  actions: Actions;
}) {
  const [context, setContext] = useState<{
      task: Task;
      x: number;
      y: number;
    } | null>(null),
    menu = useRef<HTMLDivElement>(null),
    [dragging, setDragging] = useState<string | null>(null),
    [target, setTarget] = useState<{
      status: Status;
      beforeId: string | null;
    } | null>(null),
    dragId = useRef<string | null>(null),
    drop = useRef(target),
    touch = useRef<{
      pointer: number;
      x: number;
      y: number;
      startX: number;
      startY: number;
      started: boolean;
    } | null>(null),
    raf = useRef(0),
    origin = useRef<HTMLElement | null>(null);
  const filtered = board.tasks.filter(
    (t) =>
      !!t.archivedAt === (route.view === "archive") &&
      (route.category === "all" || t.category === route.category) &&
      (!route.tag || t.tags.includes(route.tag)) &&
      (!route.query ||
        `${t.title} ${t.notes} ${t.tags.join(" ")}`
          .normalize("NFC")
          .toLocaleLowerCase()
          .includes(route.query.normalize("NFC").toLocaleLowerCase())),
  );
  const run = (fn: () => Promise<unknown>) =>
    void fn().catch((e) => actions.notify(message(e)));
  function clear() {
    cancelAnimationFrame(raf.current);
    dragId.current = null;
    touch.current = null;
    drop.current = null;
    setDragging(null);
    setTarget(null);
  }
  useEffect(() => {
    const cancel = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        clear();
        setContext(null);
      }
    };
    window.addEventListener("keydown", cancel);
    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener("keydown", cancel);
    };
  }, []);
  useEffect(() => {
    if (!context) return;
    const el = menu.current!;
    el.querySelector<HTMLElement>("button")?.focus();
    const rect = el.getBoundingClientRect();
    el.style.left =
      Math.max(8, Math.min(context.x, innerWidth - rect.width - 8)) + "px";
    el.style.top =
      Math.max(8, Math.min(context.y, innerHeight - rect.height - 8)) + "px";
    const dismiss = (e: Event) => {
      if (!el.contains(e.target as Node)) setContext(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      origin.current?.focus({ preventScroll: true });
    };
  }, [context]);
  function mark(element: Element | null, y: number) {
    const column = element?.closest<HTMLElement>(".column");
    if (!column) {
      drop.current = null;
      setTarget(null);
      return;
    }
    const card = element?.closest<HTMLElement>(".task-card");
    if (card?.dataset.id === dragId.current) return;
    let beforeId: string | null = null;
    if (card) {
      beforeId =
        y <
        card.getBoundingClientRect().top +
          card.getBoundingClientRect().height / 2
          ? card.dataset.id!
          : (card.nextElementSibling as HTMLElement | null)?.dataset.id || null;
      if (beforeId === dragId.current)
        beforeId =
          (card?.nextElementSibling?.nextElementSibling as HTMLElement | null)
            ?.dataset.id || null;
    }
    drop.current = { status: column.dataset.status as Status, beforeId };
    setTarget(drop.current);
  }
  function finish() {
    const task = board.tasks.find((t) => t.id === dragId.current),
      dest = drop.current;
    clear();
    if (task && dest) run(() => move(task, dest.status, dest.beforeId));
  }
  function touchMove(e: PointerEvent) {
    const t = touch.current;
    if (!t || t.pointer !== e.pointerId) return;
    t.x = e.clientX;
    t.y = e.clientY;
    if (!t.started) {
      if (Math.hypot(t.x - t.startX, t.y - t.startY) < 7) return;
      t.started = true;
      setDragging(dragId.current);
      const scroll = () => {
        const p = touch.current;
        if (!p) return;
        const n = p.y < 75 ? -9 : p.y > innerHeight - 75 ? 9 : 0;
        if (n) {
          window.scrollBy(0, n);
          mark(document.elementFromPoint(p.x, p.y), p.y);
        }
        raf.current = requestAnimationFrame(scroll);
      };
      raf.current = requestAnimationFrame(scroll);
    }
    e.preventDefault();
    mark(document.elementFromPoint(e.clientX, e.clientY), e.clientY);
  }
  function reordered(t: Task, direction: number) {
    const peers = board.tasks.filter(
      (p) => !p.archivedAt && p.status === t.status,
    );
    const index = peers.findIndex((p) => p.id === t.id);
    if (index + direction < 0 || index + direction >= peers.length) return;
    run(() =>
      move(
        t,
        t.status,
        direction < 0 ? peers[index - 1].id : peers[index + 2]?.id || null,
      ),
    );
  }
  function card(t: Task, index: number, total: number) {
    const archived = !!t.archivedAt;
    return (
      <article
        key={t.id}
        className={`task-card ${archived ? "archived-card" : ""} ${t.status === "done" ? "is-done" : ""} ${dragging === t.id ? "dragging" : ""} ${target?.beforeId === t.id ? "drop-before" : ""}`}
        data-id={t.id}
        draggable={!archived}
        tabIndex={0}
        aria-label={`${t.title}. ${archived ? "Archived" : columns[t.status]}.`}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter") {
            e.preventDefault();
            actions.edit(t);
          }
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            origin.current = e.currentTarget;
            setContext({ task: t, x: r.left, y: r.top });
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          origin.current = e.currentTarget;
          setContext({ task: t, x: e.clientX, y: e.clientY });
        }}
        onDragStart={(e) => {
          if (archived) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", t.id);
          dragId.current = t.id;
          setDragging(t.id);
          setContext(null);
        }}
        onDragEnd={clear}
      >
        <div className={archived ? "archive-copy" : "task-main"}>
          {!archived && (
            <button
              className="complete-button"
              aria-label={`${t.status === "done" ? "Reopen" : "Complete"} ${t.title}`}
              onClick={() =>
                run(() => move(t, t.status === "done" ? "today" : "done"))
              }
            >
              {t.status === "done" && <Icon name="check" />}
            </button>
          )}
          <button className="task-title" onClick={() => actions.edit(t)}>
            {t.title}
          </button>
          {archived && (
            <p className="archive-meta">
              {columns[t.status]} · Archived {dateLabel(t.archivedAt)}
            </p>
          )}
        </div>
        {!archived && t.notes && <p className="task-notes">{t.notes}</p>}
        {!archived &&
          (t.dueDate ||
            (t.reminderAt &&
              !t.reminderDismissedAt &&
              t.status !== "done")) && (
            <div className="task-dates">
              {t.dueDate && (
                <span
                  className={
                    "task-date" +
                    (t.dueDate < board.day && t.status !== "done"
                      ? " overdue"
                      : t.dueDate === board.day
                        ? " due-today"
                        : "")
                  }
                >
                  <Icon name="calendar" />
                  <time dateTime={t.dueDate}>
                    {dueLabel(t.dueDate, board.day).replace(
                      t.status === "done" ? "Overdue · " : "\0",
                      "",
                    )}
                  </time>
                </span>
              )}
              {t.reminderAt &&
                !t.reminderDismissedAt &&
                t.status !== "done" && (
                  <span
                    className="task-reminder"
                    aria-label={"Reminder: " + dateLabel(t.reminderAt)}
                  >
                    <Icon name="bell" />
                    {!t.dueDate && (
                      <time dateTime={t.reminderAt}>
                        {dateLabel(t.reminderAt)}
                      </time>
                    )}
                  </span>
                )}
            </div>
          )}
        {!!t.tags.length && (
          <div className="card-tags">
            {t.tags.slice(0, archived ? 10 : 2).map((tag) => (
              <button
                key={tag}
                className="tag-chip"
                aria-label={"Filter by tag " + tag}
                onClick={() => navigate({ tag }, true)}
              >
                {tag}
              </button>
            ))}
            {!archived && t.tags.length > 2 && (
              <button
                className="tag-chip"
                aria-label={`View all ${t.tags.length} tags`}
                onClick={() => actions.edit(t)}
              >
                +{t.tags.length - 2}
              </button>
            )}
          </div>
        )}
        <div className={archived ? "archive-actions" : "task-bottom"}>
          <div className="task-actions">
            {archived ? (
              <button
                className="secondary-button"
                aria-label={"Restore " + t.title}
                onClick={() =>
                  run(() => mutate(`/api/tasks/${t.id}/unarchive`, "POST"))
                }
              >
                Restore
              </button>
            ) : (
              <>
                <span className="move-control icon-button" title="Move task">
                  <Icon name="move" />
                  <Select
                    label={`Move ${t.title} to a column`}
                    move
                    value={t.status}
                    options={Object.entries(columns).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onChange={(v) => run(() => move(t, v as Status))}
                  />
                </span>
                <button
                  className="icon-button drag-handle"
                  aria-label={"Drag " + t.title}
                  tabIndex={-1}
                  onPointerDown={(e) => {
                    if (e.pointerType === "mouse") return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    dragId.current = t.id;
                    touch.current = {
                      pointer: e.pointerId,
                      x: e.clientX,
                      y: e.clientY,
                      startX: e.clientX,
                      startY: e.clientY,
                      started: false,
                    };
                  }}
                  onPointerMove={touchMove}
                  onPointerUp={() => {
                    if (touch.current?.started) finish();
                    else clear();
                  }}
                  onPointerCancel={() => {
                    if (touch.current) clear();
                  }}
                >
                  <Icon name="grip" />
                </button>
              </>
            )}
            <TaskMenu title={t.title}>
                <button type="button" role="menuitem" onClick={() => actions.edit(t)}>
                  {archived ? "View details" : "Edit task"}
                </button>
                {!archived && (
                  <>
                    <button
                      type="button" role="menuitem"
                      disabled={index === 0}
                      onClick={() => reordered(t, -1)}
                    >
                      Move up
                    </button>
                    <button
                      type="button" role="menuitem"
                      disabled={index === total - 1}
                      onClick={() => reordered(t, 1)}
                    >
                      Move down
                    </button>
                    <button type="button" role="menuitem" onClick={() => run(() => actions.archive(t))}>
                      Archive task
                    </button>
                  </>
                )}
                <button
                      type="button" role="menuitem"
                  className="danger"
                  onClick={() => run(() => actions.remove(t))}
                >
                  Delete task
                </button>
            </TaskMenu>
          </div>
        </div>
      </article>
    );
  }
  return (
    <>
      <section
        id="board"
        className={"board" + (route.view === "archive" ? " is-archive" : "")}
        tabIndex={-1}
        aria-label={
          route.view === "archive" ? "Archived tasks" : "Task planning board"
        }
        onDragOver={(e: DragEvent) => {
          if (!dragId.current) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          mark(e.target as Element, e.clientY);
        }}
        onDrop={(e) => {
          if (!dragId.current) return;
          e.preventDefault();
          mark(e.target as Element, e.clientY);
          finish();
        }}
      >
        {route.view === "archive" ? (
          <>
            <header className="archive-heading">
              <h2>Archive</h2>
              <p>Out of the way, here when you need them.</p>
            </header>
            <div className="archive-list">
              {filtered.length ? (
                filtered
                  .sort(
                    (a, b) =>
                      b.archivedAt!.localeCompare(a.archivedAt!) ||
                      a.id.localeCompare(b.id),
                  )
                  .map((t, i) => card(t, i, filtered.length))
              ) : (
                <p className="archive-empty">
                  {route.query || route.tag || route.category !== "all"
                    ? "No matching archived tasks."
                    : "No archived tasks yet. Archive a task from its menu."}
                </p>
              )}
            </div>
          </>
        ) : (
          boardOrder.map((status) => {
            const tasks = filtered.filter((t) => t.status === status);
            return (
              <section
                key={status}
                className={`column ${status}${target?.status === status ? " drag-over" : ""}`}
                data-status={status}
                aria-labelledby={"column-" + status}
              >
                <header className="column-header">
                  <div className="column-title">
                    <h2 id={"column-" + status}>{columns[status]}</h2>
                    <span className="column-count">{tasks.length}</span>
                  </div>
                </header>
                <div className="task-list">
                  {tasks.length ? (
                    tasks.map((t, i) => card(t, i, tasks.length))
                  ) : (
                    <div className="empty-state">
                      {route.query || route.tag || route.category !== "all"
                        ? "No matching tasks"
                        : "Drop tasks here"}
                    </div>
                  )}
                </div>
                <QuickAdd
                  status={status}
                  route={route}
                  notify={actions.notify}
                />
              </section>
            );
          })
        )}
      </section>
      {context && (
        <div
          ref={menu}
          id="task-context-menu"
          className="context-menu"
          role="menu"
          aria-label={"Actions for " + context.task.title}
          style={{ left: context.x, top: context.y }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setContext(null);
            } else if (
              ["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)
            ) {
              e.preventDefault();
              const items = [
                  ...e.currentTarget.querySelectorAll("button:not(:disabled)"),
                ],
                i = items.indexOf(document.activeElement as HTMLButtonElement);
              (
                items[
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? items.length - 1
                      : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                        items.length
                ] as HTMLElement
              )?.focus();
            }
          }}
        >
          {[
            {
              label: context.task.archivedAt ? "View details" : "Edit task",
              fn: () => actions.edit(context.task),
            },
            ...(context.task.archivedAt
              ? [
                  {
                    label: "Restore task",
                    fn: () =>
                      run(() =>
                        mutate(
                          `/api/tasks/${context.task.id}/unarchive`,
                          "POST",
                        ),
                      ),
                  },
                ]
              : [
                  {
                    label:
                      context.task.status === "done"
                        ? "Reopen in Today"
                        : "Mark as done",
                    fn: () =>
                      run(() =>
                        move(
                          context.task,
                          context.task.status === "done" ? "today" : "done",
                        ),
                      ),
                  },
                  ...Object.entries(columns)
                    .filter(([s]) => s !== context.task.status && s !== "done")
                    .map(([s, label]) => ({
                      label: "Move to " + label,
                      fn: () => run(() => move(context.task, s as Status)),
                    })),
                  { label: "Move up", fn: () => reordered(context.task, -1) },
                  { label: "Move down", fn: () => reordered(context.task, 1) },
                  {
                    label: "Archive task",
                    fn: () => run(() => actions.archive(context.task)),
                  },
                ]),
            {
              label: "Delete task",
              fn: () => run(() => actions.remove(context.task)),
            },
          ].map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                item.fn();
                setContext(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
function QuickAdd({
  status,
  route,
  notify,
}: {
  status: Status;
  route: Route;
  notify: (s: string) => void;
}) {
  const [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  return (
    <form
      className="quick-add"
      data-status={status}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          await mutate("/api/tasks", "POST", {
            title,
            status,
            category: route.category === "work" ? "work" : "personal",
            tags: route.tag ? [route.tag] : [],
          });
          if (alive.current) setTitle("");
        } catch (e) {
          if (alive.current) notify(message(e));
        } finally {
          if (alive.current) setBusy(false);
        }
      }}
    >
      <Icon name="plus" />
      <input
        aria-label={"Quick add task to " + columns[status]}
        placeholder="Add task"
        required
        maxLength={240}
        autoComplete="off"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
      />
      <button aria-label={"Save task to " + columns[status]} disabled={busy}>
        <Icon name="arrow-right" />
      </button>
    </form>
  );
}
