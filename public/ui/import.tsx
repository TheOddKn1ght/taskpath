import { useRef, useState, useEffect } from "react";
import { offlineRequest } from "../offline.ts";
import { mutate, message, columns } from "./store.ts";
import { Dialog } from "./dialog.tsx";
import { dateLabel } from "./board.tsx";
import type { Task } from "../types.d.ts";
export function ImportDialog({
  close,
  notify,
}: {
  close: () => void;
  notify: (s: string) => void;
}) {
  const [source, setSource] = useState(""),
    [preview, setPreview] = useState<{
      tasks: Task[];
      skipped: number;
      ignoredBlocks?: number;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const revision = useRef(0),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      revision.current++;
    },
    [],
  );
  function change(v: string) {
    revision.current++;
    setSource(v);
    setPreview(null);
    setError("");
  }
  return (
    <Dialog
      id="import-dialog"
      title="Import Markdown"
      onClose={close}
      busy={busy}
    >
      <p className="import-hint">
        Preview your Markdown before adding tasks. Imports work offline.
      </p>
      <input
        id="markdown-file"
        type="file"
        accept=".md,.markdown,text/markdown,text/plain"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          change("");
          const r = revision.current;
          try {
            if (file.size > 256 * 1024)
              throw new Error("Markdown must be 256 KB or smaller.");
            const text = await file.text();
            if (alive.current && r === revision.current) change(text);
          } catch (e) {
            if (alive.current) setError(message(e));
          }
        }}
      />
      <label className="field">
        Markdown
        <textarea
          id="markdown-text"
          rows={8}
          value={source}
          onChange={(e) => change(e.target.value)}
          disabled={busy}
        />
      </label>
      {error && (
        <p id="import-error" className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        id="preview-markdown"
        className="secondary-button"
        disabled={busy}
        onClick={async () => {
          const r = revision.current;
          setBusy(true);
          setError("");
          try {
            if (new TextEncoder().encode(source).length > 256 * 1024)
              throw new Error("Markdown must be 256 KB or smaller.");
            const result = await offlineRequest("/api/import/preview", "POST", {
              markdown: source,
            });
            if (alive.current && r === revision.current) setPreview(result);
          } catch (e) {
            if (alive.current) setError(message(e));
          } finally {
            if (alive.current) setBusy(false);
          }
        }}
      >
        Preview import
      </button>
      {preview && (
        <section id="import-preview">
          <p id="import-summary">
            {preview.tasks.length} tasks to add · {preview.skipped} duplicates
            skipped
          </p>
          {!!preview.ignoredBlocks && (
            <p>
              {preview.ignoredBlocks} blocks outside task lists were ignored.
            </p>
          )}
          {preview.tasks.some(
            (t) =>
              t.reminderAt &&
              !t.reminderDismissedAt &&
              t.status !== "done" &&
              Date.parse(t.reminderAt) <= Date.now(),
          ) && <p>Past reminders will appear immediately.</p>}
          <ul id="import-tasks">
            {preview.tasks.map((t, i) => (
              <li key={i}>
                <strong>{t.title}</strong>
                <small>
                  {columns[t.status]} · {t.category}
                  {t.tags.length ? " · Tags: " + t.tags.join(", ") : ""}
                  {t.archivedAt ? " · Archived " + dateLabel(t.archivedAt) : ""}
                  {t.dueDate ? " · Due " + t.dueDate : ""}
                  {t.reminderAt ? " · Reminder " + dateLabel(t.reminderAt) : ""}
                </small>
                {t.notes && <small>{t.notes}</small>}
              </li>
            ))}
          </ul>
          {!!preview.tasks.length && (
            <button
              id="confirm-import"
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await mutate("/api/import/markdown", "POST", {
                    tasks: preview.tasks,
                  });
                  if (alive.current) {
                    notify(
                      `${result.imported} tasks imported · ${result.skipped} duplicates skipped.`,
                    );
                    close();
                  }
                } catch (e) {
                  if (alive.current) setError(message(e));
                } finally {
                  if (alive.current) setBusy(false);
                }
              }}
            >
              Import {preview.tasks.length} tasks
            </button>
          )}
        </section>
      )}
    </Dialog>
  );
}
