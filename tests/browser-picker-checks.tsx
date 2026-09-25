import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  PickerProvider,
  Select,
  DatePicker,
  TagButton,
  type Option,
} from "../public/ui/pickers";
export async function pickerChecks(
  assert: (condition: unknown, message: string) => void,
) {
  const host = document.createElement("dialog");
  host.setAttribute("aria-label", "Picker fixture");
  document.body.append(host);
  host.showModal();
  let setOptions!: (value: Option[]) => void,
    setReminder!: (value: string) => void,
    removeTags!: () => void;
  let tags: string[] = [];
  function Fixture() {
    const [category, categoryChange] = useState("personal"),
      [due, dueChange] = useState("2026-09-12"),
      [reminder, reminderChange] = useState(""),
      [selected, changeTags] = useState<string[]>([]),
      [showTags, show] = useState(true),
      [options, optionsChange] = useState<Option[]>([
        { value: "personal", label: "Personal" },
        { value: "work", label: "Work" },
        { value: "disabled", label: "Disabled", disabled: true },
      ]);
    setOptions = optionsChange;
    setReminder = reminderChange;
    removeTags = () => show(false);
    return (
      <PickerProvider>
        <form>
          <input type="hidden" name="category" value={category} />
          <Select
            value={category}
            options={options}
            label="Category"
            onChange={categoryChange}
          />
          <input type="hidden" id="task-due-date" value={due} />
          <DatePicker value={due} onChange={dueChange} />
          <input type="hidden" id="task-reminder" value={reminder} />
          <DatePicker value={reminder} timed onChange={reminderChange} />
          {showTags && (
            <TagButton
              available={["home", "work"]}
              tags={selected}
              onChange={(next) => {
                tags = next;
                changeTags(next);
              }}
            />
          )}
        </form>
      </PickerProvider>
    );
  }
  const root = createRoot(host);
  flushSync(() => root.render(<Fixture />));
  const select = host.querySelector<HTMLInputElement>('[name="category"]')!,
    due = host.querySelector<HTMLInputElement>("#task-due-date")!,
    reminder = host.querySelector<HTMLInputElement>("#task-reminder")!;
  const trigger = (input: HTMLElement) =>
    input.nextElementSibling as HTMLButtonElement;
  const activate = (node: HTMLElement) => flushSync(() => node.click());
  const input = (node: HTMLInputElement, value: string) =>
    flushSync(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const closePicker = () => {
    const d = panel();
    if (d) press(d, "Escape");
  };
  const panel = () =>
    document.querySelector<HTMLDialogElement>(".picker-surface")!;
  const press = (node: HTMLElement, key: string) =>
    flushSync(() =>
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      ),
    );
  const click = (label: string) => {
    const node = [
      ...panel().querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === label);
    if (!node) throw new Error("Missing picker action: " + label);
    activate(node);
  };
  const frame = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const originalTheme = document.documentElement.dataset.theme;
  try {
    const colors = new Set<string>();
    for (const theme of [
      "light",
      "dark",
      "gruvbox-light",
      "gruvbox-dark",
      "nord",
      "catppuccin",
      "rose-pine", "midnight", "plum", "ocean", "sand", "lavender", "ice",
    ]) {
      document.documentElement.dataset.theme = theme;
      activate(trigger(due));
      await frame();
      await Promise.all(
        panel()
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
      colors.add(getComputedStyle(panel()).backgroundColor);
      const box = panel().getBoundingClientRect();
      assert(
        box.left >= 0 &&
          box.right <= innerWidth + 1 &&
          box.top >= 0 &&
          box.bottom <= innerHeight + 1,
        `picker stays in the viewport in ${theme} (${box.left}, ${box.top}, ${box.right}, ${box.bottom}; ${innerWidth}×${innerHeight})`,
      );
      assert(
        [...panel().querySelectorAll("button")].every(
          (button) => button.getBoundingClientRect().height >= 43.99,
        ),
        `picker touch targets are at least 44px in ${theme}`,
      );
      closePicker();
    }
    assert(colors.size === 13, "all thirteen picker themes use their own palette");
    assert(
      select.type === "hidden" &&
        due.type === "hidden" &&
        reminder.type === "hidden",
      "pickers hide all native selectors and calendar inputs",
    );
    assert(
      trigger(due).getAttribute("aria-label")?.startsWith("Due date:"),
      "hidden date fields retain a named accessible trigger",
    );
    activate(trigger(select));
    await frame();
    press(document.activeElement as HTMLElement, "End");
    press(document.activeElement as HTMLElement, " ");
    // Synthetic Space does not synthesize a click; inspect the actual focused option then activate it.
    assert(
      document.activeElement?.textContent?.startsWith("Work"),
      "list keyboard navigation skips disabled options",
    );
    activate(document.activeElement as HTMLButtonElement);
    assert(
      select.value === "work" &&
        new FormData(host.querySelector("form")!).get("category") === "work" &&
        !panel(),
      "custom selection commits the same form value and closes",
    );
    activate(trigger(select));
    flushSync(() =>
      setOptions([
        { value: "personal", label: "Personal" },
        { value: "work", label: "Work" },
        { value: "office", label: "Home office" },
      ]),
    );
    assert(
      panel().textContent?.includes("Home office"),
      "open lists refresh when their options change",
    );
    press(panel(), "Escape");
    assert(
      host.open && !panel(),
      "Escape closes only the picker above an editor",
    );
    activate(trigger(due));
    await frame();
    press(document.activeElement as HTMLElement, "ArrowRight");
    assert(
      document.activeElement?.getAttribute("aria-label") === "2026-09-13",
      "calendar arrow navigation moves focus without selecting",
    );
    const manual = panel().querySelector<HTMLInputElement>("input")!;
    input(manual, "2026-02-29");
    click("Apply");
    assert(
      !!panel() &&
        !panel().querySelector<HTMLElement>('[role="alert"]')!.hidden &&
        due.value === "2026-09-12",
      "invalid calendar input stays in the picker without changing the draft",
    );
    input(manual, "2028-02-29");
    click("Cancel");
    assert(due.value === "2026-09-12", "Cancel discards date-picker changes");
    activate(trigger(due));
    input(panel().querySelector("input")!, "2028-02-29");
    click("Apply");
    assert(
      due.value === "2028-02-29",
      "Apply commits a valid leap date to the editor only",
    );
    activate(trigger(due));
    click("Clear");
    assert(due.value === "", "Clear removes the editor date");
    activate(trigger(reminder));
    await frame();
    await Promise.all(
      panel()
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
    const reminderBox = panel().getBoundingClientRect();
    assert(
      Math.abs(reminderBox.left + reminderBox.width / 2 - innerWidth / 2) < 1 &&
        (innerWidth <= 760
          ? Math.abs(reminderBox.bottom - innerHeight) < 1
          : Math.abs(
              reminderBox.top + reminderBox.height / 2 - innerHeight / 2,
            ) < 1),
      "reminder is centered in the desktop viewport or bottom-aligned on phones",
    );
    const fields = panel().querySelectorAll("input");
    input(fields[0], "2026-09-20");
    click("Apply");
    assert(
      !!panel() && reminder.value === "",
      "new reminders require an explicit time",
    );
    input(fields[1], "13:07");
    click("Apply");
    assert(
      reminder.value === "2026-09-20T13:07",
      "reminder picker keeps minute-precision local form values",
    );
    activate(trigger(reminder));
    await frame();
    assert(
      !panel().querySelector('[aria-label="Choose time"]') &&
        panel()
          .querySelector('[aria-label="Hour 13"]')
          ?.getAttribute("aria-selected") === "true" &&
        panel()
          .querySelector('[aria-label="Minute 07"]')
          ?.getAttribute("aria-selected") === "true",
      "combined time chooser preserves the existing time without a redundant clock button",
    );
    panel().querySelector<HTMLButtonElement>('[aria-label="Hour 13"]')!.focus();
    press(document.activeElement as HTMLElement, "End");
    assert(
      document.activeElement?.getAttribute("aria-label") === "Hour 23",
      "time list keyboard navigation reaches the last hour",
    );
    activate(document.activeElement as HTMLButtonElement);
    activate(
      panel().querySelector<HTMLButtonElement>('[aria-label="Minute 59"]')!,
    );
    assert(
      panel().querySelector<HTMLInputElement>('[aria-label="Time (HH:mm)"]')!
        .value === "23:59" && reminder.value === "2026-09-20T13:07",
      "hour and minute selection changes only the reminder draft",
    );
    assert(
      !panel().querySelector<HTMLElement>(".picker-calendar")!.hidden &&
        !panel().querySelector<HTMLElement>(".picker-time")!.hidden,
      "calendar and time remain visible together during time selection",
    );
    activate(
      panel().querySelector<HTMLButtonElement>(
        '.picker-calendar [aria-label="2026-09-21"]',
      )!,
    );
    assert(
      panel().querySelector<HTMLInputElement>(
        '[aria-label="Date (YYYY-MM-DD)"]',
      )!.value === "2026-09-21" &&
        panel().querySelector<HTMLInputElement>('[aria-label="Time (HH:mm)"]')!
          .value === "23:59",
      "choosing a calendar day preserves the chosen time",
    );
    click("Cancel");
    assert(
      reminder.value === "2026-09-20T13:07",
      "Cancel discards the chosen time",
    );
    activate(trigger(reminder));
    press(panel(), "Escape");
    assert(
      !panel() && host.open && reminder.value === "2026-09-20T13:07",
      "Escape cancels the combined picker without closing the task editor",
    );
    flushSync(() => setReminder(""));
    activate(trigger(reminder));
    input(
      panel().querySelector<HTMLInputElement>(
        '[aria-label="Date (YYYY-MM-DD)"]',
      )!,
      "2026-09-20",
    );
    activate(
      panel().querySelector<HTMLButtonElement>('[aria-label="Hour 00"]')!,
    );
    click("Apply");
    assert(
      !!panel() && reminder.value === "",
      "choosing only an hour does not supply an implicit minute",
    );
    activate(
      panel().querySelector<HTMLButtonElement>('[aria-label="Minute 00"]')!,
    );
    click("Apply");
    assert(
      reminder.value === "2026-09-20T00:00",
      "time chooser applies midnight with explicit hour and minute",
    );
    const anchor = host.querySelector<HTMLElement>("#browse-tags")!;
    activate(anchor);
    const search = panel().querySelector("input")!;
    input(search, " ERRANDS ");
    press(search, "Enter");
    assert(
      tags.join() === "errands",
      "tag picker creates and normalizes tags with Enter",
    );
    const option = [
      ...panel().querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ].find((node) => node.dataset.value === "errands")!;
    activate(option);
    assert(
      tags.length === 0,
      "tag picker toggles selected chips without saving a task",
    );
    flushSync(removeTags);
    await frame();
    assert(!panel(), "removing the trigger closes and clears its picker");
    activate(trigger(select));
    host.close();
    await frame();
    assert(!panel(), "closing the owner editor clears its picker");
    host.showModal();
    activate(trigger(due));
    flushSync(() => window.dispatchEvent(new Event("taskpath-locked")));
    assert(!panel(), "locking removes picker contents and date drafts");
  } finally {
    if (originalTheme) document.documentElement.dataset.theme = originalTheme;
    else delete document.documentElement.dataset.theme;
    flushSync(() => root.unmount());
    host.close();
    host.remove();
  }
}
