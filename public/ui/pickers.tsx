import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  matchingOptions,
  monthDays,
  shiftDate,
  shiftMonth,
  validCalendarDate,
} from "../picker-model.js";
import { localReminderValue, reminderFromInput } from "../dates.js";
import { normalizeTags } from "../tags.js";
export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}
type Panel = {
  anchor: HTMLElement;
  title: string;
  content: ReactNode;
  timed?: boolean;
  date?: boolean;
};
const PickerContext = createContext<{
  open: (panel: Panel) => void;
  close: () => void;
  invalidate: () => void;
}>({ open() {}, close() {}, invalidate() {} });
export function PickerProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [, revision] = useState(0);
  const invalidate = useCallback(() => revision((n) => n + 1), []);
  return (
    <PickerContext.Provider
      value={{ open: setPanel, close: () => setPanel(null), invalidate }}
    >
      {children}
      {panel &&
        createPortal(
          <Surface
            key={panel.title}
            panel={panel}
            close={() => setPanel(null)}
          />,
          document.body,
        )}
    </PickerContext.Provider>
  );
}
function Surface({ panel, close }: { panel: Panel; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null),
    content = useRef<HTMLDivElement>(null),
    finish = useRef(close);
  finish.current = close;
  useLayoutEffect(() => {
    const d = ref.current!,
      anchor = panel.anchor,
      owner = anchor.closest("dialog");
    const abort = new AbortController(),
      options = { signal: abort.signal };
    function place() {
      if (
        !anchor.isConnected ||
        (owner && !owner.open) ||
        document.body.classList.contains("vault-locked")
      ) {
        finish.current();
        return;
      }
      const vp = window.visualViewport,
        left = vp?.offsetLeft || 0,
        top = vp?.offsetTop || 0,
        width = vp?.width || innerWidth,
        height = vp?.height || innerHeight,
        mobile = matchMedia("(max-width:760px)").matches;
      d.classList.toggle("picker-sheet", mobile);
      d.style.width = `${mobile ? width : Math.min(panel.timed ? 600 : 360, width - 16)}px`;
      d.style.maxHeight = `${Math.max(100, height - (mobile ? 8 : 16))}px`;
      if (mobile) {
        d.style.left = left + "px";
        d.style.top = top + height - d.getBoundingClientRect().height + "px";
      } else if (panel.timed) {
        d.style.removeProperty("left");
        d.style.removeProperty("top");
      } else {
        const r = anchor.getBoundingClientRect(),
          b = d.getBoundingClientRect();
        d.style.left =
          Math.max(left + 8, Math.min(r.left, left + width - b.width - 8)) +
          "px";
        d.style.top =
          Math.max(
            top + 8,
            Math.min(r.bottom + 6, top + height - b.height - 8),
          ) + "px";
      }
    }
    anchor.setAttribute("aria-expanded", "true");
    d.showModal();
    place();
    const observer = new MutationObserver(() => {
      if (!anchor.isConnected || (owner && !owner.open)) finish.current();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    const resize = new ResizeObserver(place);
    resize.observe(content.current!);
    for (const ev of ["resize", "scroll"]) {
      window.addEventListener(ev, place, { ...options, capture: true });
      window.visualViewport?.addEventListener(ev, place, options);
    }
    owner?.addEventListener("close", close, options);
    window.addEventListener("taskpath-locked", close, options);
    const frame = requestAnimationFrame(() => {
      const first =
        matchMedia("(max-width:760px)").matches &&
        d.querySelector('input[type="search"]')
          ? d.querySelector<HTMLElement>("h2")
          : d.querySelector<HTMLElement>('[autofocus], [tabindex="0"]') ||
            d.querySelector<HTMLElement>("input, .picker-body button");
      first?.focus({ preventScroll: true });
    });
    return () => {
      abort.abort();
      observer.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
      d.close();
      anchor.setAttribute("aria-expanded", "false");
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
    };
  }, [panel.anchor, panel.timed]);
  return (
    <dialog
      ref={ref}
      className={
        "picker-surface" +
        (panel.date ? " picker-date" : "") +
        (panel.timed ? " picker-datetime" : "")
      }
      aria-label={panel.title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
        if (e.key === "Tab") {
          const items = [
            ...e.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
            ),
          ].filter((n) => n.tabIndex >= 0 && n.getClientRects().length);
          if (e.shiftKey && document.activeElement === items[0]) {
            e.preventDefault();
            items.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
            e.preventDefault();
            items[0]?.focus();
          }
        }
      }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (
          e.target === e.currentTarget &&
          (e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom)
        )
          close();
      }}
    >
      <header className="picker-header">
        <h2 tabIndex={-1}>{panel.title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={"Close " + panel.title}
          onClick={close}
        >
          ×
        </button>
      </header>
      <div ref={content} className="picker-content picker-body">
        {panel.content}
      </div>
    </dialog>
  );
}
export function Select({
  value,
  options,
  onChange,
  label,
  id,
  search = false,
  move = false,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  label: string;
  id?: string;
  search?: boolean;
  move?: boolean;
}) {
  const picker = useContext(PickerContext),
    latest = useRef({ value, options, onChange });
  latest.current = { value, options, onChange };
  useLayoutEffect(picker.invalidate, [options, value, picker.invalidate]);
  return (
    <button
      type="button"
      id={id}
      data-picker-for={id}
      className={"picker-trigger" + (move ? " picker-move" : "")}
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label={`${label}: ${options.find((o) => o.value === value)?.label || "Choose"}`}
      onClick={(e) =>
        picker.open({
          anchor: e.currentTarget,
          title: label,
          content: (
            <List
              label={label}
              source={() => latest.current.options}
              selected={() => [latest.current.value]}
              choose={(v) => {
                latest.current.onChange(v);
                picker.close();
              }}
              search={search}
            />
          ),
        })
      }
    >
      {options.find((o) => o.value === value)?.label || "Choose"}
    </button>
  );
}
export function List({
  label,
  source,
  selected,
  choose,
  search = false,
  multiple = false,
  create,
}: {
  label: string;
  source: () => Option[];
  selected: () => string[];
  choose: (v: string) => void;
  search?: boolean;
  multiple?: boolean;
  create?: (v: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [, update] = useState(0),
    ref = useRef<HTMLDivElement>(null),
    prefix = useRef({ text: "", at: 0 });
  const picker = useContext(PickerContext),
    options = matchingOptions(source(), query),
    [current, setCurrent] = useState(
      selected()[0] || options.find((o) => !o.disabled)?.value || "",
    );
  const enabled = options.filter((o) => !o.disabled),
    active = enabled.some((o) => o.value === current)
      ? current
      : enabled[0]?.value;
  const add =
    !!create &&
    !!query.trim() &&
    !source().some(
      (o) => o.value === query.trim().normalize("NFC").toLowerCase(),
    );
  function pick(v: string) {
    try {
      choose(v);
      setError("");
      update((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function focus(v: string | undefined) {
    if (v !== undefined) {
      setCurrent(v);
      ref.current
        ?.querySelectorAll<HTMLButtonElement>("[data-value]")
        .forEach((el) => {
          if (el.dataset.value === v) el.focus();
        });
    }
  }
  function keys(e: KeyboardEvent) {
    const i = enabled.findIndex((o) => o.value === active);
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      focus(
        enabled[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? enabled.length - 1
              : (i + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) %
                enabled.length
        ]?.value,
      );
    } else if (
      (e.target as HTMLElement).tagName === "INPUT" &&
      e.key === "Enter" &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      if (add) addTag();
      else if (active) pick(active);
    } else if (
      (e.target as HTMLElement).tagName !== "INPUT" &&
      e.key.length === 1 &&
      e.key !== " " &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      prefix.current = {
        text:
          Date.now() - prefix.current.at > 700
            ? e.key
            : prefix.current.text + e.key,
        at: Date.now(),
      };
      focus(
        enabled.find((o) =>
          o.label.toLowerCase().startsWith(prefix.current.text.toLowerCase()),
        )?.value,
      );
    }
  }
  function addTag() {
    try {
      create?.(query);
      setQuery("");
      setError("");
      update((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <>
      {search && (multiple || source().length > 1 || query) && (
        <input
          type="search"
          placeholder="Search"
          aria-label={"Search " + label.toLowerCase()}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={keys}
          autoComplete="off"
        />
      )}
      <div
        className="picker-options"
        ref={ref}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        onKeyDown={keys}
      >
        {options.map((o) => (
          <button
            type="button"
            key={o.value}
            className="picker-option"
            role="option"
            aria-selected={selected().includes(o.value)}
            data-value={o.value}
            disabled={o.disabled}
            tabIndex={o.value === active ? 0 : -1}
            onFocus={() => setCurrent(o.value)}
            onClick={() => pick(o.value)}
          >
            {o.label}
            <span aria-hidden="true">
              {selected().includes(o.value) ? "✓" : ""}
            </span>
          </button>
        ))}
        {!options.length && <p className="picker-empty">No matching options</p>}
      </div>
      {add && (
        <button type="button" className="picker-create" onClick={addTag}>
          Add “{query.trim()}”
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {multiple && (
        <button
          type="button"
          className="primary-button picker-done"
          onClick={picker.close}
        >
          Done
        </button>
      )}
    </>
  );
}
export function TagButton({
  available,
  tags,
  onChange,
}: {
  available: string[];
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const picker = useContext(PickerContext),
    latest = useRef({ available, tags, onChange });
  latest.current = { available, tags, onChange };
  useLayoutEffect(picker.invalidate, [available, tags, picker.invalidate]);
  const update = (next: string[]) => {
    const normal = normalizeTags(next);
    latest.current.tags = normal;
    latest.current.onChange(normal);
  };
  return (
    <button
      type="button"
      id="browse-tags"
      className="secondary-button"
      aria-haspopup="dialog"
      onClick={(e) =>
        picker.open({
          anchor: e.currentTarget,
          title: "Tags",
          content: (
            <List
              label="Tags"
              multiple
              search
              source={() =>
                [
                  ...new Set([
                    ...latest.current.available,
                    ...latest.current.tags,
                  ]),
                ]
                  .sort()
                  .map((value) => ({ value, label: value }))
              }
              selected={() => latest.current.tags}
              choose={(v) =>
                update(
                  latest.current.tags.includes(v)
                    ? latest.current.tags.filter((t) => t !== v)
                    : [...latest.current.tags, v],
                )
              }
              create={(v) => update([...latest.current.tags, v])}
            />
          ),
        })
      }
    >
      Choose tags
    </button>
  );
}
export function DatePicker({
  value,
  onChange,
  timed = false,
}: {
  value: string;
  onChange: (value: string) => void;
  timed?: boolean;
}) {
  const picker = useContext(PickerContext),
    label = timed ? "Remind me" : "Due date";
  return (
    <button
      type="button"
      className="picker-trigger"
      aria-haspopup="dialog"
      aria-label={`${label}: ${value.replace("T", " · ") || "Choose date"}`}
      onClick={(e) =>
        picker.open({
          anchor: e.currentTarget,
          title: label,
          timed,
          date: true,
          content: (
            <Calendar
              initial={value}
              timed={timed}
              commit={(v) => {
                onChange(v);
                picker.close();
              }}
            />
          ),
        })
      }
    >
      {value.replace("T", " · ") || "Choose date"}
    </button>
  );
}
export function Calendar({
  initial,
  timed,
  commit,
}: {
  initial: string;
  timed: boolean;
  commit: (v: string) => void;
}) {
  const today = localReminderValue(new Date().toISOString()).slice(0, 10),
    [date, setDate] = useState(initial.slice(0, 10)),
    [time, setTime] = useState(initial.slice(11, 16)),
    [cursor, setCursor] = useState(validCalendarDate(date) ? date : today),
    [error, setError] = useState("");
  const picker = useContext(PickerContext),
    calendar = useRef<HTMLDivElement>(null),
    focus = useRef(false);
  useLayoutEffect(() => {
    if (focus.current) {
      calendar.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      focus.current = false;
    }
  }, [cursor]);
  const days = monthDays(cursor),
    month = new Date(cursor + "T12:00:00Z").toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  const changeCursor = (v: string) => {
    focus.current = true;
    setCursor(v);
  };
  function key(e: KeyboardEvent, value: string) {
    const offsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    let next = value;
    if (e.key in offsets) next = shiftDate(value, offsets[e.key]);
    else if (e.key === "PageUp" || e.key === "PageDown")
      next = shiftMonth(value, e.key === "PageUp" ? -1 : 1);
    else if (e.key === "Home" || e.key === "End") {
      const day = (new Date(value + "T12:00:00Z").getUTCDay() + 6) % 7;
      next = shiftDate(value, e.key === "Home" ? -day : 6 - day);
    } else return;
    e.preventDefault();
    changeCursor(next);
  }
  return (
    <>
      <div className="picker-datetime-layout">
        <div className="picker-date-section">
          <div className="picker-calendar" ref={calendar}>
            <div className="picker-month">
              <button
                type="button"
                aria-label="Previous month"
                disabled={cursor.startsWith("0001-01")}
                onClick={() => changeCursor(shiftMonth(cursor, -1))}
              >
                ‹
              </button>
              <strong aria-live="polite">{month}</strong>
              <button
                type="button"
                aria-label="Next month"
                disabled={cursor.startsWith("9999-12")}
                onClick={() => changeCursor(shiftMonth(cursor, 1))}
              >
                ›
              </button>
            </div>
            <div className="picker-days" role="grid" aria-label={month}>
              <div className="picker-week" role="row">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                  <span key={d} role="columnheader">
                    {d}
                  </span>
                ))}
              </div>
              {Array.from({ length: days.length / 7 }, (_, row) => (
                <div key={row} className="picker-week" role="row">
                  {days.slice(row * 7, row * 7 + 7).map((d, i) => (
                    <div
                      key={d || i}
                      role="gridcell"
                      aria-selected={d ? d === date : undefined}
                    >
                      {d && (
                        <button
                          type="button"
                          aria-label={d}
                          aria-current={d === today ? "date" : undefined}
                          tabIndex={d === cursor ? 0 : -1}
                          onKeyDown={(e) => key(e, d)}
                          onClick={() => {
                            setDate(d);
                            changeCursor(d);
                          }}
                        >
                          {Number(d.slice(8))}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="subtle-button"
            onClick={() => {
              setDate(today);
              changeCursor(today);
            }}
          >
            Today
          </button>
        </div>
        {timed && <TimeChooser value={time} change={setTime} />}
      </div>
      <div className="picker-date-fields">
        <label>
          Date · YYYY-MM-DD
          <input
            aria-label="Date (YYYY-MM-DD)"
            placeholder="YYYY-MM-DD"
            maxLength={10}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              if (validCalendarDate(e.target.value)) setCursor(e.target.value);
            }}
          />
        </label>
        {timed && (
          <label>
            Time · 24-hour
            <input
              aria-label="Time (HH:mm)"
              placeholder="HH:mm"
              maxLength={5}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        )}
      </div>
      {timed && (
        <p className="picker-hint">
          Timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="picker-actions">
        <button
          type="button"
          className="subtle-button"
          onClick={() => commit("")}
        >
          Clear
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={picker.close}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            try {
              if (!validCalendarDate(date))
                throw new Error("Enter a valid date as YYYY-MM-DD.");
              const v = date + (timed ? "T" + time : "");
              if (timed) reminderFromInput(v);
              commit(v);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Apply
        </button>
      </div>
    </>
  );
}
function TimeChooser({
  value,
  change,
}: {
  value: string;
  change: (v: string) => void;
}) {
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(value),
    [parts, setParts] = useState<(number | null)[]>(
      valid ? value.split(":").map(Number) : [null, null],
    );
  const previous = useRef(value),
    ref = useRef<HTMLDivElement>(null),
    typed = useRef({ text: "", at: 0 });
  useLayoutEffect(() => {
    if (previous.current !== value) {
      previous.current = value;
      setParts(valid ? value.split(":").map(Number) : [null, null]);
    }
  }, [value, valid]);
  useLayoutEffect(() => {
    for (const list of ref.current!.querySelectorAll<HTMLElement>(
      '[role="listbox"]',
    )) {
      const item = list.querySelector<HTMLElement>('[tabindex="0"]');
      if (item)
        list.scrollTop =
          item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
    }
  }, []);
  return (
    <div className="picker-time" ref={ref}>
      <div className="picker-time-header">
        <strong>Time</strong>
        <span className="picker-time-value" aria-live="polite">
          {parts
            .map((p) => (p === null ? "––" : String(p).padStart(2, "0")))
            .join(":")}
        </span>
      </div>
      <div className="picker-time-columns">
        {[24, 60].map((count, col) => (
          <div key={col}>
            <p>{col ? "Minute" : "Hour"}</p>
            <div
              className="picker-time-list"
              role="listbox"
              aria-label={col ? "Minute" : "Hour"}
            >
              {Array.from({ length: count }, (_, n) => (
                <button
                  key={n}
                  type="button"
                  className="picker-option"
                  role="option"
                  aria-label={`${col ? "Minute" : "Hour"} ${String(n).padStart(2, "0")}`}
                  aria-selected={parts[col] === n}
                  tabIndex={n === (parts[col] ?? 0) ? 0 : -1}
                  data-value={n}
                  onFocus={(e) => {
                    for (const b of e.currentTarget.parentElement!.querySelectorAll(
                      "button",
                    ))
                      b.tabIndex = b === e.currentTarget ? 0 : -1;
                  }}
                  onKeyDown={(e) => {
                    let next = n;
                    if (e.key === "ArrowUp" || e.key === "ArrowDown")
                      next =
                        (n + (e.key === "ArrowUp" ? -1 : 1) + count) % count;
                    else if (e.key === "Home" || e.key === "End")
                      next = e.key === "Home" ? 0 : count - 1;
                    else if (/^\d$/.test(e.key)) {
                      typed.current = {
                        text:
                          Date.now() - typed.current.at > 700
                            ? e.key
                            : (typed.current.text + e.key).slice(-2),
                        at: Date.now(),
                      };
                      next = Number(typed.current.text);
                    } else if (
                      e.key === "ArrowLeft" ||
                      e.key === "ArrowRight"
                    ) {
                      e.preventDefault();
                      ref.current
                        ?.querySelectorAll('[role="listbox"]')
                        [1 - col]?.querySelector<HTMLElement>('[tabindex="0"]')
                        ?.focus();
                      return;
                    } else return;
                    e.preventDefault();
                    e.currentTarget.parentElement
                      ?.querySelector<HTMLElement>(`[data-value="${next}"]`)
                      ?.focus();
                  }}
                  onClick={() => {
                    const next = [...parts];
                    next[col] = n;
                    setParts(next);
                    if (next.every((p) => p !== null)) {
                      const v = next
                        .map((p) => String(p).padStart(2, "0"))
                        .join(":");
                      previous.current = v;
                      change(v);
                    }
                  }}
                >
                  {String(n).padStart(2, "0")}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
