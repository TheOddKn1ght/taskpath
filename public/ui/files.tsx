import { useEffect, useRef, useState } from "react";
import {
  addFile,
  listFiles,
  readStoredFile,
  renameStoredFile,
  deleteStoredFile,
  fileStatus,
  syncFiles,
} from "../file-client.js";
import { isUnlocked } from "../offline.js";
import { Dialog } from "./dialog";
import { message } from "./store";
const size = (bytes: number) =>
  bytes >= 1e6
    ? `${(bytes / 1e6).toLocaleString("en", { maximumFractionDigits: 2 })} MB`
    : `${bytes.toLocaleString("en")} bytes`;
export function Files() {
  const [data, setData] = useState<Awaited<
      ReturnType<typeof listFiles>
    > | null>(null),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false),
    [preview, setPreview] = useState<{ url: string; name: string } | null>(
      null,
    ),
    [edit, setEdit] = useState<{
      id: string;
      name: string;
      remove: boolean;
    } | null>(null);
  const input = useRef<HTMLInputElement>(null),
    alive = useRef(true),
    urls = useRef(new Set<string>()),
    revision = useRef(0),
    working = useRef(false);
  async function refresh() {
    const r = ++revision.current;
    try {
      const next = await listFiles();
      if (alive.current && isUnlocked() && r === revision.current)
        setData(next);
    } catch (e) {
      if (alive.current) setError(message(e));
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    window.addEventListener("taskpath-files", refresh);
    return () => {
      alive.current = false;
      revision.current++;
      window.removeEventListener("taskpath-files", refresh);
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, []);
  async function action(fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      if (alive.current) await refresh();
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function upload(files: File[]) {
    void action(async () => {
      for (const file of files) {
        if (!alive.current || !isUnlocked()) return;
        await addFile(file);
      }
    });
  }
  async function open(id: string, view: boolean) {
    const file = await readStoredFile(id);
    try {
      if (!alive.current || !isUnlocked()) return;
      if (view && !file.imageType)
        throw new Error("This format is download-only.");
      const url = URL.createObjectURL(
        new Blob([file.bytes], {
          type: view ? file.imageType! : "application/octet-stream",
        }),
      );
      urls.current.add(url);
      if (view) setPreview({ url, name: file.details.name });
      else {
        const a = document.createElement("a");
        a.href = url;
        a.download = file.details.name;
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.current.delete(url);
        }, 30000);
      }
    } finally {
      file.bytes.fill(0);
    }
  }
  const files =
    data?.files
      .filter((f) =>
        f.details.name
          .normalize("NFC")
          .toLocaleLowerCase()
          .includes(query.normalize("NFC").toLocaleLowerCase()),
      )
      .sort(
        (a, b) =>
          b.envelope.createdAt.localeCompare(a.envelope.createdAt) ||
          a.envelope.fileId.localeCompare(b.envelope.fileId),
      ) || [];
  const closePreview = () => {
    if (preview) {
      URL.revokeObjectURL(preview.url);
      urls.current.delete(preview.url);
    }
    setPreview(null);
  };
  return (
    <section
      id="files-view"
      aria-label="Encrypted files"
      className={drag ? "files-dragover" : ""}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        upload([...e.dataTransfer.files]);
      }}
    >
      <header className="files-heading">
        <div>
          <h2>Files</h2>
          <p className="files-usage">
            {data?.quota
              ? `${size(data.files.reduce((n, f) => n + f.bytes, 0))} on this device · ${size(data.quota.usedBytes)} / ${size(data.quota.quotaBytes)} synced${data.quota.usedBytes > data.quota.quotaBytes ? " · Over quota" : ""}`
              : "Connect once to refresh the storage allowance. Default: 10 MB."}
          </p>
        </div>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          Upload files
        </button>
        <input
          type="file"
          ref={input}
          multiple
          hidden
          onChange={(e) => {
            upload([...(e.target.files || [])]);
            e.target.value = "";
          }}
        />
        <button
          className="secondary-button"
          onClick={() => void action(syncFiles)}
        >
          Retry sync
        </button>
      </header>
      <input
        type="search"
        aria-label="Search files"
        placeholder="Search filenames"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="files-status" role="status">
        {error ||
          data?.error ||
          (data?.deletions.length
            ? `${data.deletions.length} deletion(s) waiting to sync`
            : "Files are encrypted before leaving this device.")}
      </p>
      <div className="files-list">
        {files.map((f) => (
          <article className="file-row" key={f.envelope.fileId}>
            <div className="file-info">
              <h3>{f.details.name}</h3>
              <p>
                {size(f.bytes)} ·{" "}
                {new Date(f.envelope.createdAt).toLocaleDateString("en")} ·{" "}
                {fileStatus(f)}
              </p>
            </div>
            <div className="file-actions">
              <button
                className="secondary-button"
                disabled={busy || !f.cached || "unreadable" in f}
                onClick={() =>
                  void action(() => open(f.envelope.fileId, false))
                }
              >
                Download
              </button>
              {["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
                f.details.type,
              ) && (
                <button
                  className="secondary-button"
                  disabled={busy || !f.cached || "unreadable" in f}
                  onClick={() =>
                    void action(() => open(f.envelope.fileId, true))
                  }
                >
                  Preview
                </button>
              )}
              <button
                className="secondary-button"
                disabled={busy || "unreadable" in f}
                onClick={() =>
                  setEdit({
                    id: f.envelope.fileId,
                    name: f.details.name,
                    remove: false,
                  })
                }
              >
                Rename
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  setEdit({
                    id: f.envelope.fileId,
                    name: f.details.name,
                    remove: true,
                  })
                }
              >
                {f.pending === "upload" ? "Discard" : "Delete"}
              </button>
            </div>
          </article>
        ))}
        {!files.length && (
          <p className="files-empty">
            {query
              ? "No matching files."
              : "Drop files here or choose Upload files."}
          </p>
        )}
      </div>
      {preview && (
        <Dialog
          id="file-preview"
          title={preview.name}
          className="file-preview"
          onClose={closePreview}
        >
          <img
            alt={preview.name}
            src={preview.url}
            onError={() =>
              setError(
                "This image cannot be displayed. You can download the original file.",
              )
            }
          />
        </Dialog>
      )}
      {edit && (
        <Dialog
          id="file-action"
          title={edit.remove ? "Delete file" : "Rename file"}
          className="file-action-dialog"
          onClose={() => setEdit(null)}
          busy={busy}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name"));
              void action(async () => {
                if (edit.remove) await deleteStoredFile(edit.id);
                else await renameStoredFile(edit.id, name);
                if (alive.current) setEdit(null);
              });
            }}
          >
            <p>
              {edit.remove
                ? `Permanently delete “${edit.name}”? This cannot be undone.`
                : "Choose a filename."}
            </p>
            {!edit.remove && (
              <input
                name="name"
                aria-label="Filename"
                defaultValue={edit.name}
                maxLength={255}
                autoFocus
              />
            )}
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEdit(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy}>
                {edit.remove ? "Delete permanently" : "Save"}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
