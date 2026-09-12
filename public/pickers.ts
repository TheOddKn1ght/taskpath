import { localReminderValue, reminderFromInput } from './dates.js';
import { normalizeTags } from './tags.js';
import { matchingOptions, monthDays, shiftDate, shiftMonth, validCalendarDate } from './picker-model.js';
import { errorMessage } from './errors.js';

interface Option { value: string; label: string; disabled?: boolean }
interface Surface { dialog: HTMLDialogElement; content: HTMLElement; close: (restore?: boolean) => void; update?: () => void }
let active: Surface | null = null;
const bindings = new Map<HTMLInputElement | HTMLSelectElement, HTMLButtonElement>();
const button = (text: string, action: () => void, className = '') => {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.className = className;
  node.addEventListener('click', action); return node;
};
export function closePicker(restore = true) { active?.close(restore); }
function openSurface(anchor: HTMLElement, title: string): Surface {
  closePicker(false);
  const dialog = document.createElement('dialog'); dialog.className = 'picker-surface'; dialog.setAttribute('aria-label', title);
  const header = document.createElement('header'); header.className = 'picker-header';
  const heading = document.createElement('h2'); heading.textContent = title; heading.tabIndex = -1;
  const content = document.createElement('div'); content.className = 'picker-content';
  const owner = anchor.closest('dialog');
  let disposed = false;
  const surface: Surface = { dialog, content, close(restore = true) {
    if (disposed) return; disposed = true;
    observer.disconnect(); sizeObserver.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true);
    window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    owner?.removeEventListener('close', ownerClosed);
    if (active === surface) active = null;
    anchor.setAttribute('aria-expanded', 'false'); dialog.close(); dialog.replaceChildren(); dialog.remove();
    if (restore && anchor.isConnected && !document.body.classList.contains('vault-locked')) anchor.focus({preventScroll: true});
  }};
  const ownerClosed = () => surface.close(false);
  const dismiss = button('×', () => surface.close(), 'icon-button'); dismiss.setAttribute('aria-label', 'Close ' + title);
  header.append(heading, dismiss); dialog.append(header, content); document.body.append(dialog);
  anchor.setAttribute('aria-expanded', 'true'); active = surface;
  function place() {
    if (!anchor.isConnected || owner && !owner.open || document.body.classList.contains('vault-locked')) { surface.close(false); return; }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const mobile = matchMedia('(max-width: 760px)').matches;
    dialog.classList.toggle('picker-sheet', mobile);
    dialog.style.width = `${mobile ? width : Math.min(dialog.classList.contains('picker-datetime') ? 600 : 360, width - 16)}px`;
    dialog.style.maxHeight = `${Math.max(100, height - (mobile ? 8 : 16))}px`;
    if (mobile) { dialog.style.left = `${left}px`; dialog.style.top = `${top + height - dialog.getBoundingClientRect().height}px`; }
    else if (dialog.classList.contains('picker-datetime')) {
      // CSS centers this modal, including before first paint and after content resizes.
      dialog.style.removeProperty('left'); dialog.style.removeProperty('top');
    }
    else {
      const rect = anchor.getBoundingClientRect(), box = dialog.getBoundingClientRect();
      dialog.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - box.width - 8))}px`;
      dialog.style.top = `${Math.max(top + 8, Math.min(rect.bottom + 6, top + height - box.height - 8))}px`;
    }
  }
  const observer = new MutationObserver(() => { if (!anchor.isConnected || owner && !owner.open) surface.close(false); });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  owner?.addEventListener('close', ownerClosed);
  dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); surface.close(); });
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); surface.close(); }
    if (event.key === 'Tab') {
      const nodes = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(n => n.getClientRects().length && n.tabIndex >= 0);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) surface.close();
  });
  window.addEventListener('resize', place); document.addEventListener('scroll', place, true);
  window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
  dialog.showModal();
  // Content is filled synchronously by the picker before the next frame.
  requestAnimationFrame(() => {
    if (disposed) return;
    place();
    // Let phone users browse options before choosing to bring up the keyboard.
    const browseFirst = matchMedia('(max-width: 760px)').matches && content.querySelector('input[type="search"]');
    const target = browseFirst ? heading : content.querySelector<HTMLElement>('[autofocus]:not([hidden])') || content.querySelector<HTMLElement>('[tabindex="0"]') || content.querySelector<HTMLElement>('input:not([hidden]), button');
    target?.focus({preventScroll: true});
  });
  const sizeObserver = new ResizeObserver(() => { if (!disposed) place(); }); sizeObserver.observe(content);
  return surface;
}
interface ListOptions {
  title: string; options: () => Option[]; selected: () => string[]; choose: (value: string) => void;
  search?: boolean; multiple?: boolean; create?: (value: string) => void;
}
function openList(anchor: HTMLElement, config: ListOptions) {
  const surface = openSurface(anchor, config.title), list = document.createElement('div');
  list.className = 'picker-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', config.title);
  if (config.multiple) list.setAttribute('aria-multiselectable', 'true');
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search'; search.setAttribute('aria-label', 'Search ' + config.title.toLowerCase()); search.autocomplete = 'off';
  const error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  let options: Option[] = [], current = '', prefix = '', typedAt = 0;
  function choose(value: string) {
    try { config.choose(value); error.hidden = true; if (!config.multiple) surface.close(); else render(); }
    catch (reason) { error.textContent = errorMessage(reason); error.hidden = false; }
  }
  function render() {
    const focused = list.contains(document.activeElement);
    const available = config.options();
    search.hidden = !config.multiple && available.length <= 1 && !search.value;
    options = matchingOptions(available, search.value);
    if (!options.some(o => o.value === current && !o.disabled)) current = options.find(o => config.selected().includes(o.value) && !o.disabled)?.value ?? options.find(o => !o.disabled)?.value ?? '';
    list.replaceChildren();
    for (const option of options) {
      const selected = config.selected().includes(option.value);
      const item = button(option.label, () => choose(option.value), 'picker-option');
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(selected)); item.dataset.value = option.value;
      item.tabIndex = option.value === current ? 0 : -1; item.disabled = !!option.disabled;
      const mark = document.createElement('span'); mark.textContent = selected ? '✓' : ''; mark.setAttribute('aria-hidden', 'true'); item.append(mark);
      item.addEventListener('focus', () => { current = option.value; for (const child of list.querySelectorAll<HTMLElement>('[role="option"]')) child.tabIndex = child === item ? 0 : -1; });
      list.append(item);
    }
    if (!options.length) { const empty = document.createElement('p'); empty.className = 'picker-empty'; empty.textContent = 'No matching options'; list.append(empty); }
    create.hidden = !config.create || !search.value.trim() || config.options().some(o => o.value === search.value.trim().normalize('NFC').toLowerCase());
    create.textContent = `Add “${search.value.trim()}”`;
    if (focused) list.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }
  const create = button('', () => {
    try { config.create?.(search.value); search.value = ''; error.hidden = true; render(); search.focus(); }
    catch (reason) { error.textContent = errorMessage(reason); error.hidden = false; }
  }, 'picker-create');
  function navigate(event: KeyboardEvent) {
    const items = [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    let index = items.findIndex(item => item.dataset.value === current);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    } else if (event.target === search && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault(); if (!create.hidden) create.click(); else items.find(item => item.dataset.value === current)?.click();
    } else if (event.target !== search && event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      prefix = Date.now() - typedAt > 700 ? event.key : prefix + event.key; typedAt = Date.now();
      items.find(item => item.textContent?.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))?.focus();
    }
  }
  list.addEventListener('keydown', navigate); search.addEventListener('keydown', navigate); search.addEventListener('input', render);
  if (config.search) { search.autofocus = !matchMedia('(max-width: 760px)').matches; surface.content.append(search); }
  surface.content.append(list, create, error);
  if (config.multiple) surface.content.append(button('Done', () => surface.close(), 'primary-button picker-done'));
  surface.update = render; render();
}
export function openTagPicker(anchor: HTMLElement, available: () => string[], selected: () => string[], update: (tags: string[]) => void) {
  openList(anchor, { title: 'Tags', search: true, multiple: true,
    options: () => [...new Set([...available(), ...selected()])].sort().map(value => ({value, label: value})), selected,
    choose: value => update(normalizeTags(selected().includes(value) ? selected().filter(tag => tag !== value) : [...selected(), value])),
    create: value => update(normalizeTags([...selected(), value])),
  });
}
function timeChooser(input: HTMLInputElement) {
  const area = document.createElement('div'); area.className = 'picker-time';
  const title = document.createElement('strong'); title.textContent = 'Time';
  const summary = document.createElement('span'); summary.className = 'picker-time-value'; summary.setAttribute('aria-live', 'polite');
  const header = document.createElement('div'); header.className = 'picker-time-header'; header.append(title, summary);
  const columns = document.createElement('div'); columns.className = 'picker-time-columns';
  const lists: HTMLElement[] = [];
  let parts: (number | null)[] = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.value) ? input.value.split(':').map(Number) : [null, null];
  function update() {
    summary.textContent = parts.map(value => value === null ? '––' : String(value).padStart(2, '0')).join(':');
    lists.forEach((list, column) => {
      for (const item of list.querySelectorAll<HTMLButtonElement>('button')) {
        const value = Number(item.dataset.value);
        item.setAttribute('aria-selected', String(value === parts[column]));
        item.tabIndex = value === (parts[column] ?? 0) ? 0 : -1;
      }
    });
  }
  function scrollToSelection() {
    requestAnimationFrame(() => {
      if (!area.isConnected || area.hidden) return;
      for (const list of lists) {
        const selected = list.querySelector<HTMLElement>('[tabindex="0"]')!;
        list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
      }
    });
  }
  for (const [column, count] of [24, 60].entries()) {
    const container = document.createElement('div'), label = document.createElement('p'); label.textContent = column ? 'Minute' : 'Hour';
    const list = document.createElement('div'); list.className = 'picker-time-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label.textContent);
    lists.push(list); let prefix = '', typedAt = 0;
    for (let value = 0; value < count; value++) {
      const text = String(value).padStart(2, '0');
      const item = button(text, () => {
        parts[column] = value; update(); item.tabIndex = 0;
        if (parts.every(part => part !== null)) { input.value = parts.map(part => String(part).padStart(2, '0')).join(':'); input.dispatchEvent(new Event('input', {bubbles:true})); }
      }, 'picker-option');
      item.dataset.value = String(value); item.setAttribute('role', 'option'); item.setAttribute('aria-label', `${column ? 'Minute' : 'Hour'} ${text}`);
      item.addEventListener('focus', () => { for (const option of list.querySelectorAll<HTMLButtonElement>('button')) option.tabIndex = option === item ? 0 : -1; });
      item.addEventListener('keydown', event => {
        let next: number;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') next = (value + (event.key === 'ArrowUp' ? -1 : 1) + count) % count;
        else if (event.key === 'Home' || event.key === 'End') next = event.key === 'Home' ? 0 : count - 1;
        else if (/^\d$/.test(event.key)) { prefix = Date.now() - typedAt > 700 ? event.key : (prefix + event.key).slice(-2); typedAt = Date.now(); next = Number(prefix); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); lists[1 - column].querySelector<HTMLElement>('[tabindex="0"]')?.focus(); return; }
        else return;
        event.preventDefault(); list.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
      });
      list.append(item);
    }
    container.append(label, list); columns.append(container);
  }
  input.addEventListener('input', () => {
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(input.value)) parts = input.value.split(':').map(Number);
    else parts = [null, null];
    update();
  });
  area.append(header, columns); update(); scrollToSelection();
  return {area};
}
function openDate(anchor: HTMLElement, input: HTMLInputElement) {
  const timed = input.id === 'task-reminder', surface = openSurface(anchor, timed ? 'Remind me' : 'Due date');
  surface.dialog.classList.add('picker-date');
  surface.dialog.classList.toggle('picker-datetime', timed);
  const today = localReminderValue(new Date().toISOString()).slice(0, 10);
  const dateInput = document.createElement('input'); dateInput.type = 'text'; dateInput.placeholder = 'YYYY-MM-DD'; dateInput.maxLength = 10; dateInput.value = input.value.slice(0, 10); dateInput.setAttribute('aria-label', 'Date (YYYY-MM-DD)');
  const timeInput = document.createElement('input'); timeInput.type = 'text'; timeInput.inputMode = 'text'; timeInput.placeholder = 'HH:mm'; timeInput.maxLength = 5; timeInput.value = timed ? input.value.slice(11, 16) : ''; timeInput.setAttribute('aria-label', 'Time (HH:mm)');
  let cursor = validCalendarDate(dateInput.value) ? dateInput.value : today;
  const calendar = document.createElement('div'); calendar.className = 'picker-calendar';
  const error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  function render(focus = false) {
    calendar.replaceChildren();
    const navigation = document.createElement('div'); navigation.className = 'picker-month';
    const name = document.createElement('strong'); name.setAttribute('aria-live', 'polite'); name.textContent = new Date(`${cursor}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const prev = button('‹', () => { cursor = shiftMonth(cursor, -1); render(true); }); prev.setAttribute('aria-label', 'Previous month');
    const next = button('›', () => { cursor = shiftMonth(cursor, 1); render(true); }); next.setAttribute('aria-label', 'Next month');
    prev.disabled = cursor.startsWith('0001-01'); next.disabled = cursor.startsWith('9999-12'); navigation.append(prev, name, next); calendar.append(navigation);
    const grid = document.createElement('div'); grid.className = 'picker-days'; grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', name.textContent!);
    const week = document.createElement('div'); week.setAttribute('role', 'row'); week.className = 'picker-week';
    for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) { const day = document.createElement('span'); day.setAttribute('role', 'columnheader'); day.textContent = label; week.append(day); }
    grid.append(week); const days = monthDays(cursor);
    for (let n = 0; n < days.length; n += 7) {
      const row = document.createElement('div'); row.className = 'picker-week'; row.setAttribute('role', 'row');
      for (const value of days.slice(n, n + 7)) {
        const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell');
        if (value) {
          cell.setAttribute('aria-selected', String(value === dateInput.value));
          const day = button(String(Number(value.slice(8))), () => { dateInput.value = value; cursor = value; render(true); });
          day.setAttribute('aria-label', value); day.tabIndex = value === cursor ? 0 : -1;
          if (value === today) day.setAttribute('aria-current', 'date');
          day.addEventListener('keydown', event => {
            const offsets: Record<string, number> = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7};
            if (event.key in offsets) cursor = shiftDate(value, offsets[event.key]);
            else if (event.key === 'Home' || event.key === 'End') { const weekday = (new Date(`${value}T12:00:00Z`).getUTCDay() + 6) % 7; cursor = shiftDate(value, event.key === 'Home' ? -weekday : 6 - weekday); }
            else if (event.key === 'PageUp' || event.key === 'PageDown') cursor = shiftMonth(value, event.key === 'PageUp' ? -1 : 1);
            else return;
            event.preventDefault(); render(true);
          }); cell.append(day);
        }
        row.append(cell);
      }
      grid.append(row);
    }
    calendar.append(grid);
    if (focus) calendar.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }
  dateInput.addEventListener('input', () => { if (validCalendarDate(dateInput.value)) { cursor = dateInput.value; render(); } });
  const fields = document.createElement('div'); fields.className = 'picker-date-fields';
  const dateLabel = document.createElement('label'); dateLabel.textContent = 'Date · YYYY-MM-DD'; dateLabel.append(dateInput); fields.append(dateLabel);
  const todayButton = button('Today', () => { dateInput.value = today; cursor = today; render(true); }, 'subtle-button');
  const time = timed ? timeChooser(timeInput) : null;
  if (time) {
    const label = document.createElement('label'); label.textContent = 'Time · 24-hour'; label.append(timeInput);
    fields.append(label);
  }
  const actions = document.createElement('div'); actions.className = 'picker-actions';
  const commit = (value: string) => { input.value = value; input.dispatchEvent(new Event('change', {bubbles: true})); refreshPickers(); surface.close(); };
  actions.append(button('Clear', () => commit(''), 'subtle-button'), button('Cancel', () => surface.close(), 'secondary-button'), button('Apply', () => {
    try {
      if (!validCalendarDate(dateInput.value)) throw new Error('Enter a valid date as YYYY-MM-DD.');
      const value = dateInput.value + (timed ? 'T' + timeInput.value : '');
      if (timed) reminderFromInput(value);
      commit(value);
    } catch (reason) { error.textContent = errorMessage(reason); error.hidden = false; }
  }, 'primary-button'));
  const dateSection = document.createElement('div'); dateSection.className = 'picker-date-section'; dateSection.append(calendar, todayButton);
  const layout = document.createElement('div'); layout.className = 'picker-datetime-layout'; layout.append(dateSection);
  if (time) layout.append(time.area);
  surface.content.append(layout);
  surface.content.append(fields);
  if (timed) { const zone = document.createElement('p'); zone.className = 'picker-hint'; zone.textContent = `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`; surface.content.append(zone); }
  surface.content.append(error, actions); render();
}
export function refreshPickers() {
  for (const [input, trigger] of bindings) {
    if (!input.isConnected) { bindings.delete(input); continue; }
    trigger.disabled = input.disabled;
    const name = input.getAttribute('aria-label') || input.labels?.[0]?.firstChild?.textContent?.trim() || 'Choose';
    const value = input instanceof HTMLSelectElement ? input.selectedOptions[0]?.textContent || 'Choose' : input.value.replace('T', ' · ') || 'Choose date';
    trigger.textContent = value; trigger.setAttribute('aria-label', `${name}: ${value}`);
  }
  active?.update?.();
}
export function mountPickers(root: ParentNode = document) {
  for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select, #task-due-date, #task-reminder')) {
    if (bindings.has(input)) continue;
    const trigger = button('', () => {
      if (input instanceof HTMLSelectElement) openList(trigger, {
        title: input.id === 'tag-filter' ? 'Tags' : input.id === 'category-filter' ? 'Category' : input.getAttribute('aria-label') || input.labels?.[0]?.firstChild?.textContent?.trim() || 'Choose',
        options: () => [...input.options].map(option => ({value: option.value, label: option.text, disabled: option.disabled})),
        selected: () => [input.value], search: input.id === 'tag-filter',
        choose(value) { input.value = value; input.dispatchEvent(new Event('change', {bubbles: true})); refreshPickers(); },
      });
      else openDate(trigger, input);
    }, input.classList.contains('move-select') ? 'picker-trigger picker-move' : 'picker-trigger');
    trigger.dataset.pickerFor = input.id || 'move'; trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    if (input instanceof HTMLInputElement) { input.setAttribute('aria-label', input.getAttribute('aria-label') || input.labels?.[0]?.firstChild?.textContent?.trim() || 'Date'); input.type = 'hidden'; } else input.hidden = true;
    input.after(trigger); bindings.set(input, trigger);
    input.addEventListener('change', refreshPickers);
  }
  refreshPickers();
}
for (const event of ['taskpath-locked', 'pagehide']) window.addEventListener(event, () => {
  closePicker(false);
  // Release detached card labels and clear mirrored editor values after the app locks.
  for (const [input, trigger] of bindings) { trigger.textContent = ''; trigger.removeAttribute('aria-label'); if (input.classList.contains('move-select')) bindings.delete(input); }
});
document.addEventListener('reset', () => queueMicrotask(refreshPickers));
