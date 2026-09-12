import { closePicker, mountPickers, openTagPicker, refreshPickers } from '/assets/accounts-v16/pickers.js';

export async function pickerChecks(assert: (condition: unknown, message: string) => void) {
  const host = document.createElement('dialog'); host.setAttribute('aria-label', 'Picker fixture');
  host.innerHTML = '<form><label>Category<select name="category"><option value="personal">Personal</option><option value="work">Work</option><option disabled value="disabled">Disabled</option></select></label><label>Due date<input id="task-due-date" name="dueDate" type="date" value="2026-09-12"></label><label>Remind me<input id="task-reminder" type="datetime-local"></label><button type="button" id="test-tags">Tags</button></form>';
  document.body.append(host); host.showModal(); mountPickers(host);
  const select = host.querySelector('select')!, due = host.querySelector<HTMLInputElement>('#task-due-date')!, reminder = host.querySelector<HTMLInputElement>('#task-reminder')!;
  const trigger = (input: HTMLElement) => input.nextElementSibling as HTMLButtonElement;
  const panel = () => document.querySelector<HTMLDialogElement>('.picker-surface')!;
  const press = (node: HTMLElement, key: string) => node.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true}));
  const click = (label: string) => { const node = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label); if (!node) throw new Error('Missing picker action: ' + label); node.click(); };
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const originalTheme = document.documentElement.dataset.theme;
  try {
    const colors = new Set<string>();
    for (const theme of ['light', 'dark', 'gruvbox-light', 'gruvbox-dark', 'nord', 'catppuccin', 'rose-pine']) {
      document.documentElement.dataset.theme = theme; trigger(due).click(); await frame();
      await Promise.all(panel().getAnimations().map(animation => animation.finished.catch(() => {})));
      colors.add(getComputedStyle(panel()).backgroundColor);
      const box = panel().getBoundingClientRect();
      assert(box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1, `picker stays in the viewport in ${theme} (${box.left}, ${box.top}, ${box.right}, ${box.bottom}; ${innerWidth}×${innerHeight})`);
      assert([...panel().querySelectorAll('button')].every(button => button.getBoundingClientRect().height >= 43.99), `picker touch targets are at least 44px in ${theme}`);
      closePicker();
    }
    assert(colors.size === 7, 'all seven picker themes use their own palette');
    assert(select.hidden && due.type === 'hidden' && reminder.type === 'hidden', 'pickers hide all native selectors and calendar inputs');
    assert(trigger(due).getAttribute('aria-label')?.startsWith('Due date:'), 'hidden date fields retain a named accessible trigger');
    trigger(select).click(); await frame(); press(document.activeElement as HTMLElement, 'End'); press(document.activeElement as HTMLElement, ' ');
    // Synthetic Space does not synthesize a click; inspect the actual focused option then activate it.
    assert(document.activeElement?.textContent === 'Work', 'list keyboard navigation skips disabled options');
    (document.activeElement as HTMLButtonElement).click();
    assert(select.value === 'work' && new FormData(host.querySelector('form')!).get('category') === 'work' && !panel(), 'custom selection commits the same form value and closes');
    trigger(select).click(); select.append(new Option('Home office', 'office')); refreshPickers();
    assert(panel().textContent?.includes('Home office'), 'open lists refresh when their options change');
    press(panel(), 'Escape'); assert(host.open && !panel(), 'Escape closes only the picker above an editor');
    trigger(due).click(); await frame(); press(document.activeElement as HTMLElement, 'ArrowRight');
    assert(document.activeElement?.getAttribute('aria-label') === '2026-09-13', 'calendar arrow navigation moves focus without selecting');
    const manual = panel().querySelector<HTMLInputElement>('input')!; manual.value = '2026-02-29'; click('Apply');
    assert(!!panel() && !panel().querySelector<HTMLElement>('[role="alert"]')!.hidden && due.value === '2026-09-12', 'invalid calendar input stays in the picker without changing the draft');
    manual.value = '2028-02-29'; click('Cancel'); assert(due.value === '2026-09-12', 'Cancel discards date-picker changes');
    trigger(due).click(); panel().querySelector('input')!.value = '2028-02-29'; click('Apply');
    assert(due.value === '2028-02-29', 'Apply commits a valid leap date to the editor only');
    trigger(due).click(); click('Clear'); assert(due.value === '', 'Clear removes the editor date');
    trigger(reminder).click(); await frame();
    await Promise.all(panel().getAnimations().map(animation => animation.finished.catch(() => {})));
    const reminderBox = panel().getBoundingClientRect();
    assert(Math.abs(reminderBox.left + reminderBox.width / 2 - innerWidth / 2) < 1 && (innerWidth <= 760 ? Math.abs(reminderBox.bottom - innerHeight) < 1 : Math.abs(reminderBox.top + reminderBox.height / 2 - innerHeight / 2) < 1), 'reminder is centered in the desktop viewport or bottom-aligned on phones');
    const fields = panel().querySelectorAll('input'); fields[0].value = '2026-09-20'; click('Apply');
    assert(!!panel() && reminder.value === '', 'new reminders require an explicit time');
    fields[1].value = '13:07'; click('Apply'); assert(reminder.value === '2026-09-20T13:07', 'reminder picker keeps minute-precision local form values');
    trigger(reminder).click(); await frame();
    assert(!panel().querySelector('[aria-label="Choose time"]') && panel().querySelector('[aria-label="Hour 13"]')?.getAttribute('aria-selected') === 'true' && panel().querySelector('[aria-label="Minute 07"]')?.getAttribute('aria-selected') === 'true', 'combined time chooser preserves the existing time without a redundant clock button');
    panel().querySelector<HTMLButtonElement>('[aria-label="Hour 13"]')!.focus();
    press(document.activeElement as HTMLElement, 'End');
    assert(document.activeElement?.getAttribute('aria-label') === 'Hour 23', 'time list keyboard navigation reaches the last hour');
    (document.activeElement as HTMLButtonElement).click();
    panel().querySelector<HTMLButtonElement>('[aria-label="Minute 59"]')!.click();
    assert(panel().querySelector<HTMLInputElement>('[aria-label="Time (HH:mm)"]')!.value === '23:59' && reminder.value === '2026-09-20T13:07', 'hour and minute selection changes only the reminder draft');
    assert(!panel().querySelector<HTMLElement>('.picker-calendar')!.hidden && !panel().querySelector<HTMLElement>('.picker-time')!.hidden, 'calendar and time remain visible together during time selection');
    panel().querySelector<HTMLButtonElement>('.picker-calendar [aria-label="2026-09-21"]')!.click();
    assert(panel().querySelector<HTMLInputElement>('[aria-label="Date (YYYY-MM-DD)"]')!.value === '2026-09-21' && panel().querySelector<HTMLInputElement>('[aria-label="Time (HH:mm)"]')!.value === '23:59', 'choosing a calendar day preserves the chosen time');
    click('Cancel'); assert(reminder.value === '2026-09-20T13:07', 'Cancel discards the chosen time');
    trigger(reminder).click(); press(panel(), 'Escape');
    assert(!panel() && host.open && reminder.value === '2026-09-20T13:07', 'Escape cancels the combined picker without closing the task editor');
    reminder.value = ''; trigger(reminder).click(); panel().querySelector<HTMLInputElement>('[aria-label="Date (YYYY-MM-DD)"]')!.value = '2026-09-20';
    panel().querySelector<HTMLButtonElement>('[aria-label="Hour 00"]')!.click(); click('Apply');
    assert(!!panel() && reminder.value === '', 'choosing only an hour does not supply an implicit minute');
    panel().querySelector<HTMLButtonElement>('[aria-label="Minute 00"]')!.click(); click('Apply');
    assert(reminder.value === '2026-09-20T00:00', 'time chooser applies midnight with explicit hour and minute');
    let tags: string[] = []; const anchor = host.querySelector<HTMLElement>('#test-tags')!;
    openTagPicker(anchor, () => ['home', 'work'], () => tags, next => {tags = next;});
    const search = panel().querySelector('input')!; search.value = ' ERRANDS '; search.dispatchEvent(new Event('input')); press(search, 'Enter');
    assert(tags.join() === 'errands', 'tag picker creates and normalizes tags with Enter');
    const option = [...panel().querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.dataset.value === 'errands')!; option.click();
    assert(tags.length === 0, 'tag picker toggles selected chips without saving a task');
    anchor.remove(); await Promise.resolve(); assert(!panel(), 'removing the trigger closes and clears its picker');
    trigger(select).click(); host.close(); await frame(); assert(!panel(), 'closing the owner editor clears its picker');
    host.showModal(); trigger(due).click(); window.dispatchEvent(new Event('taskpath-locked'));
    assert(!panel(), 'locking removes picker contents and date drafts');
  } finally { if (originalTheme) document.documentElement.dataset.theme = originalTheme; else delete document.documentElement.dataset.theme; closePicker(false); host.close(); host.remove(); refreshPickers(); }
}
