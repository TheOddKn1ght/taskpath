import { normalizeTags } from './tags.js';
import { offlineRequest, sync, syncAfterCurrent, localState, lock, isUnlocked, selectedAccount } from './offline.js';
import { startVault } from './vault-ui.js';
import { createRealtime } from './realtime.js';
import { localReminderValue, reminderFromInput, dueLabel } from './dates.js';

await startVault();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const paths = {
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m6-16v16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18m-13 4h2m4 0h2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  sprout: '<path d="M12 21v-7C5 14 3 10 3 5c6 0 9 3 9 9 0-8 3-11 9-11 0 6-3 10-9 11M7 21h10"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5.8-1.5 1.5-1.5 2m0 3h.01"/>',
  move: '<path d="M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  later: '<path d="M8 9V5a4 4 0 0 1 8 0v4m-4-4v10m-4-4 4 4 4-4M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>',
  inbox: '<path d="m3 13 3-8h12l3 8v6H3zM3 13h5l2 3h4l2-3h5"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15z"/>',
  up: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  down: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.inbox}</svg>`;
$$('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });

const columns = {
  later: { title: 'Later' },
  week: { title: 'This Week' },
  today: { title: 'Today' },
  done: { title: 'Done' },
};
const state = { tasks: [], category: 'all', tag: '', query: '', day: '', week: '', timezone: 'UTC', ready: false, busy: false, loading: false, editing: null };
let dragId = null;
let dropTarget = null;
let toastTimer;
let toastAction;
let touchDrag = null;
let touchScrollFrame;
let contextTaskId = null;
let contextReturnFocus = null;
let importRevision = 0;
let importSource = null;
let importBusy = false;
let reminderTimer;
let notificationBusy = false;
let editingReminder = null;
let notificationsOff = false;
try { notificationsOff = localStorage.getItem('taskpath-notifications') === 'off'; } catch { /* Preferences are optional. */ }

function notificationAvailable() { return 'Notification' in window && window.isSecureContext; }
function notificationsEnabled() { return notificationAvailable() && Notification.permission === 'granted' && !notificationsOff; }
function notificationControls() {
  const enabled = notificationsEnabled();
  $('#notifications-button').textContent = enabled ? 'Turn off desktop notifications' : 'Enable desktop notifications';
  $('#enable-notifications').hidden = enabled || !notificationAvailable();
  $('#notifications-button').disabled = !notificationAvailable();
  $('#notification-status').textContent = enabled ? 'Desktop notifications are on.' : !notificationAvailable() ? 'Desktop notifications are unavailable here. In-app reminders still work.' : Notification.permission === 'denied' ? 'Notifications are blocked in browser settings. In-app reminders still work.' : 'In-app reminders are on.';
}

async function toggleNotifications() {
  try {
    if (notificationsEnabled()) notificationsOff = true;
    else if (notificationAvailable()) {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      notificationsOff = permission !== 'granted';
    }
    try { localStorage.setItem('taskpath-notifications', notificationsOff ? 'off' : 'on'); } catch { /* Continue without preference storage. */ }
    notificationControls();
    notify(notificationsEnabled() ? 'Desktop notifications enabled.' : 'Using in-app reminders.');
    await refresh({ quiet: true });
  } catch { notify('Desktop notifications are unavailable. In-app reminders will still appear.'); }
}

function reminderLabel(iso) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(new Date(iso).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

function taskDates(task) {
  const activeReminder = task.reminderAt && !task.reminderDismissedAt && task.status !== 'done';
  if (!task.dueDate && !activeReminder) return '';
  const overdue = task.dueDate < state.day && task.status !== 'done';
  const label = task.dueDate ? (task.status === 'done' ? dueLabel(task.dueDate, state.day).replace('Overdue · ', '') : dueLabel(task.dueDate, state.day)) : '';
  return `<div class="task-dates">${task.dueDate ? `<span class="task-date ${overdue ? 'overdue' : task.dueDate === state.day ? 'due-today' : ''}" title="Due ${escape(task.dueDate)}">${icon('calendar')}<time datetime="${escape(task.dueDate)}">${escape(label)}</time></span>` : ''}${activeReminder ? `<span class="task-reminder" title="Reminder: ${escape(reminderLabel(task.reminderAt))}" aria-label="Reminder: ${escape(reminderLabel(task.reminderAt))}">${icon('bell')}${task.dueDate ? '' : `<time datetime="${escape(task.reminderAt)}">${escape(reminderLabel(task.reminderAt))}</time>`}</span>` : ''}</div>`;
}

function renderReminders(board) {
  const panel = $('#reminder-panel');
  const html = (board.reminders || []).map(task => `<div class="reminder-row" data-reminder-id="${task.id}">${icon('bell')}<button class="reminder-open" data-reminder-action="open"><strong>${escape(task.title)}</strong><span>${escape(reminderLabel(task.reminderAt))}</span></button><button class="subtle-button" data-reminder-action="snooze">Snooze 10m</button><button class="subtle-button" data-reminder-action="dismiss">Dismiss</button></div>`).join('');
  if (panel.innerHTML !== html) {
    const previous = panel.querySelectorAll('.reminder-row').length;
    panel.innerHTML = html;
    if (board.reminders?.length > previous) announce(`${board.reminders.length} ${board.reminders.length === 1 ? 'reminder is' : 'reminders are'} due.`);
  }
  panel.hidden = !html;
  clearTimeout(reminderTimer);
  const upcoming = board.tasks.filter(t => t.reminderAt && !t.reminderDismissedAt && t.status !== 'done' && t.reminderAt > board.serverTime);
  if (upcoming.length) {
    const next = Math.min(...upcoming.map(t => Date.parse(t.reminderAt)));
    reminderTimer = setTimeout(() => refresh({ quiet: true }), Math.max(500, Math.min(60000, next - Date.parse(board.serverTime) + 100)));
  }
  if (board.reminders?.length) void deliverNotifications();
}

async function deliverNotifications() {
  if (!isUnlocked() || !notificationsEnabled() || notificationBusy) return;
  notificationBusy = true;
  try {
    const { tasks } = await request('/api/reminders/claim', 'POST', {});
    if (!isUnlocked() || !tasks.length) return;
    const single = tasks.length === 1 ? tasks[0] : null;
    const notification = new Notification(single ? 'Taskpath reminder' : `${tasks.length} Taskpath reminders`, {
      body: tasks.slice(0, 3).map(t => t.title).join('\n'), tag: single ? `taskpath-${single.id}-${single.reminderAt}` : 'taskpath-reminders', icon: document.querySelector('link[rel="apple-touch-icon"]').href,
    });
    notification.onclick = () => {
      window.focus(); notification.close();
      const current = single && state.tasks.find(t => t.id === single.id);
      if (current && !$('dialog[open]')) openTask(current.status, current);
      else $('#reminder-panel').scrollIntoView({ block: 'nearest' });
    };
  } catch { /* The persistent in-app reminder remains available if notifications fail. */ }
  finally { notificationBusy = false; }
}

// Task content is always escaped before it is inserted into markup.
function escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]); }
function announce(message) { if (isUnlocked()) $('#announcer').textContent = message; }
function connection(text, offline = false) {
  $('#save-status').innerHTML = `<span class="status-dot"></span>${escape(text)}`;
  $('#save-status').classList.toggle('offline', offline);
}
function notify(message, action, label = 'Undo') {
  if (!isUnlocked()) return;
  clearTimeout(toastTimer);
  $('#toast-message').textContent = message;
  $('#toast-action').hidden = !action;
  $('#toast-action').textContent = label;
  toastAction = action;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, action ? 15000 : 5000);
}
function showError(error) {
  if (!isUnlocked()) return;
  $('#error-text').textContent = error.message || 'Could not reach your workspace. Please try again.';
  $('#error-banner').hidden = false;
  connection('Connection interrupted', true);
}
async function request(path, method = 'GET', body, format = 'json') {
  return offlineRequest(path, method, body);
}
async function syncStatus() {
  const local = await localState();
  if (!isUnlocked()) return;
  const count = local.pending.length;
  const text = local.authRequired ? `Sign in to sync · ${count} pending` : local.error ? `Sync paused · ${count} pending` : count ? `${count} ${count === 1 ? 'change' : 'changes'} saved on this device` : local.online ? 'All changes synced' : 'Offline · Saved on this device';
  connection(text, !local.online || Boolean(local.authRequired || local.error));
  $('#sign-in-again').hidden = !local.authRequired;
  if (local.error) { $('#error-text').textContent = local.error; $('#error-banner').hidden = false; }
}

async function refresh({ quiet = false } = {}) {
  if (!isUnlocked() || state.loading || state.busy || dragId) return;
  state.loading = true;
  try {
    const board = await request('/api/board');
    applyBoard(board);
    $('#error-banner').hidden = true;
    await syncStatus();
  } catch (error) {
    if (!isUnlocked()) return;
    showError(error);
    if (!quiet && !state.ready) $('#board').innerHTML = '<p class="loading-message">Your workspace couldn’t be opened. Try reconnecting above.</p>';
  } finally { state.loading = false; $('#board').setAttribute('aria-busy', 'false'); }
}

const GREETINGS = {
  "general": [
    "Welcome back",
    "Good to see you",
    "Hello again",
    "Hey there",
    "Glad you stopped by",
    "Welcome to your little corner",
    "Make yourself at home",
    "Back for another chapter",
    "Your space is ready",
    "Pick up where you left off",
    "One thing at a time",
    "No rush",
    "Small steps count",
    "Start wherever you like",
    "A little progress goes a long way",
    "Room for a fresh idea",
    "Make a little room to think",
    "Take it at your pace",
    "Here for the next small step",
    "Your plans have a home",
    "A fresh look never hurts",
    "Choose your own pace",
    "A little focus, a little breathing room",
    "Time for a tiny victory",
    "Welcome to the drawing board",
    "A good place to begin",
    "Settle in",
    "Hello from your task board",
    "Nice to have you here",
    "Ready when you are",
    "Keep it simple",
    "Leave room for the unexpected",
    "Big plans, small steps",
    "A little less scattered",
    "Find your next little win",
    "Give your thoughts a place to land",
    "Let the ideas settle",
    "A moment to get your bearings",
    "You bring the ideas",
    "Your next chapter starts here"
  ],
  "morning": [
    "Good morning",
    "Morning",
    "Rise and shine",
    "Hello, early bird",
    "A fresh day awaits",
    "New day, clean page",
    "Ease into the morning",
    "Start the day your way",
    "A little morning clarity",
    "Welcome to the early hours",
    "Morning plans, gently made",
    "First things first",
    "Take the morning slowly",
    "A new day to make your own",
    "A fresh start looks good on you",
    "The day is just getting started",
    "Hello to a new day",
    "A little planning before the bustle",
    "Bring your morning ideas",
    "Find your morning rhythm"
  ],
  "afternoon": [
    "Good afternoon",
    "Hello from the afternoon",
    "Hope your day is going well",
    "A little afternoon reset",
    "Welcome to the second half",
    "Time to regroup",
    "An afternoon breather",
    "Check in with your plans",
    "A fresh page for the afternoon",
    "Find your afternoon rhythm",
    "Make room for a midday pause",
    "The day still has room",
    "A little focus for the afternoon",
    "Pick a small afternoon win",
    "Reset at your own pace",
    "An easy start to the next thing",
    "Afternoon ideas welcome",
    "A moment between things",
    "Give the rest of the day some room",
    "Take stock, then take your time"
  ],
  "evening": [
    "Good evening",
    "Evening",
    "Welcome to the quieter hours",
    "A little evening clarity",
    "Let the day settle",
    "An evening check-in",
    "Time to tie a loose end",
    "Make a little room for tomorrow",
    "Ease into the evening",
    "Your evening, your pace",
    "A quiet moment with your plans",
    "Gather the loose thoughts",
    "Keep the evening light",
    "A softer pace feels right",
    "Leave a little space for rest",
    "Tomorrow can wait a moment",
    "Put a bookmark in the day",
    "A gentle finish to the day",
    "Evening ideas have a home",
    "Welcome to the winding-down hours"
  ],
  "night": [
    "Welcome to the night shift",
    "Hello, night owl",
    "Burning the midnight oil",
    "Welcome to the after-hours club",
    "Hello from the quiet hours",
    "Keep the late shift gentle",
    "The night has room for a thought",
    "Late-night ideas welcome",
    "A quiet corner after dark",
    "Welcome to the moonlight hours",
    "Your thoughts can rest here",
    "Leave a note for tomorrow",
    "Keep it cozy",
    "The small hours say hello",
    "A little clarity after dark",
    "Welcome to the hush",
    "Catch that late-night thought",
    "A soft landing for your ideas",
    "Tomorrow’s thoughts can wait here",
    "Make yourself a quiet moment"
  ]
};

let greetingChoice = null;
function nicknameGreeting(nickname, userId, now = new Date()) {
  if (!nickname) return '';
  const hour = now.getHours();
  const period = hour >= 5 && hour < 12 ? 'morning' : hour < 17 && hour >= 12 ? 'afternoon' : hour >= 17 && hour < 22 ? 'evening' : 'night';
  const key = `${userId}:${now.toDateString()}:${period}`;
  if (greetingChoice?.key !== key) {
    const choices = [...GREETINGS.general, ...GREETINGS[period]];
    greetingChoice = { key, phrase: choices[Math.floor(Math.random() * choices.length)] };
  }
  return `${greetingChoice.phrase}, ${nickname}`;
}

function applyBoard(board) {
  if (!isUnlocked() || board.userId !== selectedAccount()) return;
  $('#greeting').textContent = nicknameGreeting(board.nickname, board.userId);
  const changed = JSON.stringify(state.tasks) !== JSON.stringify(board.tasks) || state.day !== board.day;
  const previousDay = state.day;
  Object.assign(state, board, { ready: true });
  if (changed || !$('#board .column')) render();
  renderReminders(board);
  if (previousDay && previousDay !== board.day) notify('Your tasks have rolled over to the new day.');
}

// Show edits only after the device transaction commits. Sync runs independently.
async function mutate(path, method, body, message) {
  if (state.busy || state.loading) throw new Error('Your workspace is syncing. Please try again in a moment.');
  state.busy = true;
  connection('Saving…');
  try {
    const result = await request(path, method, body);
    // A failed redraw must not disguise an already-committed local write as a failed save.
    try { applyBoard(await request('/api/board')); $('#error-banner').hidden = true; await syncStatus(); }
    catch (error) { showError(new Error('Your change was saved on this device, but the board could not refresh.')); }
    if (!isUnlocked()) throw new Error('Workspace locked. Encrypted changes remain saved.');
    if (message) notify(message);
    return result;
  } catch (error) {
    connection('Change not saved', true);
    throw error;
  } finally { state.busy = false; }
}

let editingTags = [];
function knownTags() { return [...new Set(state.tasks.flatMap(task => task.tags || []))].sort(); }
function renderTagSuggestions() {
  const query = $('#task-tag-input').value.trim().normalize('NFC').toLowerCase();
  const matches = query ? knownTags().filter(tag => !editingTags.includes(tag) && tag.includes(query)).slice(0, 6) : [];
  $('#tag-suggestions').innerHTML = matches.map(tag => `<button type="button" class="tag-chip" data-suggest-tag="${escape(tag)}" aria-label="Add tag ${escape(tag)}">${escape(tag)}</button>`).join('');
  $('#tag-suggestions').hidden = !matches.length;
}
function renderTagEditor() {
  $('#task-tags').innerHTML = editingTags.map((tag, index) => `<button type="button" class="tag-chip" data-remove-tag="${index}" aria-label="Remove tag ${escape(tag)}">${escape(tag)}<span aria-hidden="true">×</span></button>`).join('');
  renderTagSuggestions();
}
function addEditorTag() {
  const input = $('#task-tag-input');
  if (!input.value.trim()) return;
  editingTags = normalizeTags([...editingTags, input.value]);
  input.value = '';
  $('#form-error').hidden = true;
  renderTagEditor();
}
function addTagFromControl() {
  try { addEditorTag(); }
  catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
  $('#task-tag-input').focus();
}
$('#add-tag').addEventListener('click', addTagFromControl);
$('#task-tag-input').addEventListener('input', renderTagSuggestions);
$('#tag-suggestions').addEventListener('click', event => {
  const button = event.target.closest('[data-suggest-tag]');
  if (!button) return;
  $('#task-tag-input').value = button.dataset.suggestTag;
  addTagFromControl();
});
$('#task-tag-input').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' && !$('#tag-suggestions').hidden) {
    event.preventDefault(); $('#tag-suggestions button')?.focus();
  }
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addTagFromControl(); }
});
$('#task-tags').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-tag]');
  if (!button) return;
  editingTags.splice(Number(button.dataset.removeTag), 1);
  renderTagEditor();
  $('#task-tag-input').focus();
});
function renderTagFilter() {
  const tags = knownTags();
  // Keep a selected tag available when its last task is deleted or edited away.
  if (state.tag && !tags.includes(state.tag)) tags.push(state.tag);
  const options = '<option value="">All tags</option>' + tags.sort().map(tag => `<option value="${escape(tag)}">${escape(tag)}</option>`).join('');
  if ($('#tag-filter').innerHTML !== options) $('#tag-filter').innerHTML = options;
  $('#tag-filter').value = state.tag;
  if (document.activeElement === $('#task-tag-input')) renderTagSuggestions();
}

function taskMarkup(task, index, total) {
  const title = escape(task.title);
  const options = Object.entries(columns).map(([key, value]) => `<option value="${key}" ${task.status === key ? 'selected' : ''}>${value.title}</option>`).join('');
  return `<article class="task-card ${task.status === 'done' ? 'is-done' : ''}" data-id="${task.id}" draggable="true" tabindex="0" aria-label="${title}. ${columns[task.status].title}.">
    <div class="task-main"><button class="complete-button" data-action="complete" aria-label="${task.status === 'done' ? 'Reopen' : 'Complete'} ${title}" title="${task.status === 'done' ? 'Move back to Today' : 'Mark as done'}">${task.status === 'done' ? icon('check') : ''}</button><button class="task-title" data-action="edit">${title}</button></div>
    ${task.notes ? `<p class="task-notes">${escape(task.notes)}</p>` : ''}
    ${taskDates(task)}
    ${task.tags?.length ? `<div class="card-tags">${task.tags.slice(0, 2).map(tag => `<button type="button" class="tag-chip" data-action="tag" data-tag="${escape(tag)}" aria-label="Filter by tag ${escape(tag)}">${escape(tag)}</button>`).join('')}${task.tags.length > 2 ? `<button type="button" class="tag-chip" data-action="edit" aria-label="View all ${task.tags.length} tags">+${task.tags.length - 2}</button>` : ''}</div>` : ''}
    <div class="task-bottom"><div class="task-actions">
      <span class="move-control icon-button" title="Move task"><span>${icon('move')}</span><select class="move-select" aria-label="Move ${title} to a column">${options}</select></span>
      <button class="icon-button drag-handle" title="Drag to move; use the adjacent move control for keyboard movement" aria-label="Drag ${title}" tabindex="-1">${icon('grip')}</button>
      <details class="task-menu"><summary class="icon-button" aria-label="More options for ${title}">${icon('more')}</summary><div class="menu-content"><button data-action="edit">${icon('edit')}Edit task</button><button data-action="up" ${index === 0 ? 'disabled' : ''}>${icon('up')}Move up</button><button data-action="down" ${index === total - 1 ? 'disabled' : ''}>${icon('down')}Move down</button><button class="danger" data-action="delete">${icon('trash')}Delete task</button></div></details>
    </div></div>
  </article>`;
}

function render() {
  closeTaskContextMenu(true);
  const focus = document.activeElement;
  const focusedId = focus?.id;
  const focusedTask = focus?.closest('[data-id]')?.dataset.id;
  const focusedAction = focus?.dataset.action;
  const focusedTag = focus?.dataset.tag;
  const quickStatus = focus?.closest('.quick-add')?.dataset.status;
  const quickValues = new Map($$('.quick-add').map(form => [form.dataset.status, $('input', form).value]));
  const selection = focus instanceof HTMLInputElement ? [focus.selectionStart, focus.selectionEnd] : null;
  renderTagFilter();
  const query = state.query.trim().normalize('NFC').toLocaleLowerCase();
  const filtered = state.tasks.filter(task => (state.category === 'all' || task.category === state.category) && (!state.tag || task.tags?.includes(state.tag)) && (!query || `${task.title} ${task.notes} ${(task.tags || []).join(' ')}`.normalize('NFC').toLocaleLowerCase().includes(query)));
  const board = $('#board');
  board.innerHTML = Object.keys(columns).map(status => {
    const column = columns[status];
    const tasks = filtered.filter(t => t.status === status);
    const isFiltered = !!query || state.category !== 'all' || !!state.tag;
    return `<section class="column ${status}" data-status="${status}" aria-labelledby="column-${status}"><header class="column-header"><div class="column-title"><h2 id="column-${status}">${column.title}</h2><span class="column-count">${tasks.length}</span></div></header><div class="task-list">${tasks.length ? tasks.map((task, index) => taskMarkup(task, index, tasks.length)).join('') : `<div class="empty-state">${isFiltered ? 'No matching tasks' : 'Drop tasks here'}</div>`}</div><form class="quick-add" data-status="${status}">${icon('plus')}<input aria-label="Quick add task to ${column.title}" placeholder="Add task" required maxlength="240" autocomplete="off"><button type="submit" aria-label="Save task to ${column.title}" title="Add task">${icon('arrow-right')}</button></form></section>`;
  }).join('');
  $$('.quick-add').forEach(form => { $('input', form).value = quickValues.get(form.dataset.status) || ''; });
  const monday = new Date(`${state.week}T12:00:00Z`);
  const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
  const format = d => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  $('#week-label').textContent = `${format(monday)} – ${format(sunday)}`;
  $('#guide-timezone').textContent = `Your planning timezone: ${state.timezone}. Weeks begin on Monday.`;
  if (quickStatus) {
    const input = $(`.quick-add[data-status="${quickStatus}"] input`);
    input?.focus({ preventScroll: true });
    if (input && selection && selection[0] !== null) input.setSelectionRange(...selection);
  } else if (focusedTask) {
    const card = $(`[data-id="${focusedTask}"]`);
    (focusedTag ? $$('[data-tag]', card || board).find(button => button.dataset.tag === focusedTag) : focusedAction ? $(`[data-action="${focusedAction}"]`, card || board) : card)?.focus({ preventScroll: true });
  } else if (focusedId && document.activeElement !== focus) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

function openTask(status = 'later', task = null) {
  if (!isUnlocked()) return;
  closeTaskContextMenu();
  state.editing = task?.id || null;
  $('#task-form').reset();
  $('#form-error').hidden = true;
  $('#task-title').value = task?.title || '';
  $('#task-notes').value = task?.notes || '';
  editingTags = [...(task ? task.tags || [] : state.tag ? [state.tag] : [])];
  renderTagEditor();
  $('#task-status').value = task?.status || status;
  $('#task-category').value = task?.category || (state.category === 'work' ? 'work' : 'personal');
  $('#task-due-date').value = task?.dueDate || '';
  editingReminder = task?.reminderAt || null;
  $('#task-reminder').value = localReminderValue(editingReminder);
  $('#task-schedule').open = !!(task?.dueDate || task?.reminderAt);
  $('#reminder-timezone').textContent = `Reminder times use your device timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`;
  notificationControls();
  $('#dialog-title').textContent = task ? 'Edit task' : 'New task';
  $('#save-task').innerHTML = `${task ? 'Save changes' : 'Add task'}${icon('arrow-right')}`;
  $('#delete-task').hidden = !task;
  $('#task-dialog').showModal();
  $('#task-title').focus();
}

async function moveTask(id, status, beforeId) {
  const data = { status };
  if (beforeId !== undefined) data.beforeId = beforeId;
  await mutate(`/api/tasks/${id}`, 'PATCH', data);
  announce(`Task moved to ${columns[status].title}.`);
}

async function deleteTask(id) {
  await mutate(`/api/tasks/${id}`, 'DELETE');
  notify('Task deleted.', async () => {
    try { await mutate(`/api/tasks/${id}/restore`, 'POST', {}, 'Task restored.'); }
    catch (error) { notify(error.message); }
  });
}

$('#new-task').addEventListener('click', () => openTask());
$('#clear-task-dates').addEventListener('click', () => { $('#task-due-date').value = ''; $('#task-reminder').value = ''; });
$('#enable-notifications').addEventListener('click', toggleNotifications);
$('#notifications-button').addEventListener('click', () => { $('.app-menu').open = false; void toggleNotifications(); });
$('#reminder-panel').addEventListener('click', async event => {
  const button = event.target.closest('[data-reminder-action]');
  if (!button) return;
  const id = button.closest('[data-reminder-id]').dataset.reminderId;
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  const action = button.dataset.reminderAction;
  if (action === 'open') { openTask(task.status, task); return; }
  button.disabled = true;
  try { await mutate(`/api/tasks/${id}/reminder`, 'POST', { action, reminderAt: task.reminderAt }, action === 'snooze' ? 'Reminder snoozed for 10 minutes.' : 'Reminder dismissed.'); }
  catch (error) { notify(error.message); await refresh({ quiet: true }); }
  finally { button.disabled = false; }
});
$$('[data-close]').forEach(button => button.addEventListener('click', () => { if (button.dataset.close !== 'import-dialog' || !importBusy) $(`#${button.dataset.close}`).close(); }));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog && !(dialog.id === 'import-dialog' && importBusy)) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#show-guide').addEventListener('click', () => { $('.app-menu').open = false; $('#guide-dialog').showModal(); });
$('#logout').addEventListener('click', async () => {
  $('.app-menu').open = false;
  $('#logout').disabled = true;
  try {
    await lock();
  } catch (error) { notify(error.message); }
  finally { $('#logout').disabled = false; }
});
async function downloadTasks(markdown = false) {
  $('.app-menu').open = false;
  try {
    const data = await request(markdown ? '/api/export?format=markdown' : '/api/export', 'GET', undefined, markdown ? 'text' : 'json');
    const url = URL.createObjectURL(new Blob([markdown ? data : JSON.stringify(data, null, 2)], { type: markdown ? 'text/markdown;charset=utf-8' : 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `taskpath-${state.day || 'export'}.${markdown ? 'md' : 'json'}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { notify(error.message); }
}
$('#export').addEventListener('click', () => downloadTasks());
$('#export-markdown').addEventListener('click', () => downloadTasks(true));

function resetImportPreview() {
  importRevision++;
  importSource = null;
  $('#import-preview').hidden = true;
  $('#confirm-import').hidden = true;
  $('#import-error').hidden = true;
}
function importError(error) { $('#import-error').textContent = error.message; $('#import-error').hidden = false; }
$('#import-markdown').addEventListener('click', () => {
  if (importBusy) return;
  $('.app-menu').open = false;
  resetImportPreview();
  $('#markdown-file').value = '';
  $('#markdown-text').value = '';
  $('#import-dialog').showModal();
});
$('#markdown-text').addEventListener('input', resetImportPreview);
$('#import-dialog').addEventListener('close', resetImportPreview);
$('#import-dialog').addEventListener('cancel', event => { if (importBusy) event.preventDefault(); });
$('#markdown-file').addEventListener('change', async event => {
  resetImportPreview();
  const revision = importRevision;
  const file = event.target.files[0];
  if (!file) return;
  $('#markdown-text').value = '';
  try {
    if (file.size > 256 * 1024) throw new Error('Markdown must be 256 KB or smaller.');
    const text = await file.text();
    if (revision === importRevision) $('#markdown-text').value = text;
  } catch (error) { if (revision === importRevision) importError(error); }
});
$('#preview-markdown').addEventListener('click', async () => {
  resetImportPreview();
  const revision = importRevision;
  const source = $('#markdown-text').value;
  $('#preview-markdown').disabled = true;
  try {
    if (new TextEncoder().encode(source).length > 256 * 1024) throw new Error('Markdown must be 256 KB or smaller.');
    const result = await request('/api/import/preview', 'POST', { markdown: source });
    if (revision !== importRevision) return;
    importSource = result.tasks;
    $('#import-summary').textContent = `${result.tasks.length} tasks to add · ${result.skipped} duplicates skipped`;
    const warnings = [];
    if (result.ignoredBlocks) warnings.push(`${result.ignoredBlocks} blocks outside task lists were ignored.`);
    if (result.tasks.some(task => task.reminderAt && !task.reminderDismissedAt && task.status !== 'done' && Date.parse(task.reminderAt) <= Date.now())) warnings.push('Past reminders will appear immediately.');
    $('#import-warning').textContent = warnings.join(' ');
    $('#import-warning').hidden = !warnings.length;
    $('#import-tasks').innerHTML = result.tasks.map(task => `<li><strong>${escape(task.title)}</strong><small>${escape(columns[task.status].title)} · ${escape(task.category)}${task.tags?.length ? ` · Tags: ${escape(task.tags.join(', '))}` : ''}${task.dueDate ? ` · Due ${escape(task.dueDate)}` : ''}${task.reminderAt ? ` · Reminder ${escape(reminderLabel(task.reminderAt))}${task.reminderDismissedAt ? ' (dismissed)' : ''}` : ''}</small>${task.notes ? `<small>${escape(task.notes)}</small>` : ''}</li>`).join('');
    $('#import-preview').hidden = false;
    $('#confirm-import').textContent = `Import ${result.tasks.length} tasks`;
    $('#confirm-import').hidden = !result.tasks.length;
  } catch (error) { if (revision === importRevision) importError(error); }
  finally { $('#preview-markdown').disabled = false; }
});
$('#confirm-import').addEventListener('click', async () => {
  if (importSource === null || importBusy) return;
  importBusy = true;
  const controls = $$('button,input,textarea', $('#import-dialog'));
  controls.forEach(control => { control.disabled = true; });
  try {
    const result = await mutate('/api/import/markdown', 'POST', { tasks: importSource });
    $('#import-dialog').close();
    notify(`${result.imported} tasks imported${result.skipped ? ` · ${result.skipped} duplicates skipped` : ''}.`);
  } catch (error) { importError(error); }
  finally { importBusy = false; controls.forEach(control => { control.disabled = false; }); }
});
$('#sign-in-again').addEventListener('click', event => { event.preventDefault(); void lock(); });
$('#retry').addEventListener('click', () => { void sync().catch(() => {}); void refresh(); });
$('#toast-close').addEventListener('click', () => { $('#toast').hidden = true; clearTimeout(toastTimer); });
$('#toast-action').addEventListener('click', () => { $('#toast').hidden = true; clearTimeout(toastTimer); toastAction?.(); });
$('#tag-filter').addEventListener('change', event => { state.tag = event.target.value; if (state.ready) render(); });
$('#category-filter').addEventListener('change', event => { state.category = event.target.value; if (state.ready) render(); });
$('#search').addEventListener('input', event => { state.query = event.target.value; if (state.ready) render(); });

$('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#save-task');
  submit.disabled = true;
  $('#form-error').hidden = true;
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    addEditorTag();
    input.tags = [...editingTags];
    input.dueDate = input.dueDate || null;
    const reminderValue = $('#task-reminder').value;
    // Preserve seconds and an ambiguous DST instant when only other fields change.
    input.reminderAt = reminderValue === localReminderValue(editingReminder) ? editingReminder : reminderFromInput(reminderValue);
    await mutate(state.editing ? `/api/tasks/${state.editing}` : '/api/tasks', state.editing ? 'PATCH' : 'POST', input);
    $('#task-dialog').close();
    notify(state.editing ? 'Changes saved.' : `Task added to ${columns[input.status].title}.`);
  } catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
  finally { submit.disabled = false; }
});
$('#delete-task').addEventListener('click', async () => {
  if (!state.editing) return;
  try { await deleteTask(state.editing); $('#task-dialog').close(); }
  catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
});

$('#board').addEventListener('submit', async event => {
  const form = event.target.closest('.quick-add');
  if (!form) return;
  event.preventDefault();
  const input = $('input', form);
  const title = input.value.trim();
  if (!title) { input.focus(); return; }
  const status = form.dataset.status;
  input.disabled = true;
  try {
    await mutate('/api/tasks', 'POST', { title, status, category: state.category === 'work' ? 'work' : 'personal', tags: state.tag ? [state.tag] : [] });
    const current = $(`.quick-add[data-status="${status}"] input`);
    if (current) { current.value = ''; current.focus(); }
    announce(`Task added to ${columns[status].title}.`);
  } catch (error) { notify(error.message); }
  finally { input.disabled = false; }
});

async function runTaskAction(id, action) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) throw new Error('That task is no longer on the board.');
  if (action === 'edit' || action === 'schedule') {
    openTask(task.status, task);
    if (action === 'schedule') { $('#task-schedule').open = true; $('#task-due-date').focus(); }
    return;
  }
  if (action.startsWith('move:')) {
    const status = action.slice(5);
    if (Object.hasOwn(columns, status)) await moveTask(id, status);
    return;
  }
  if (action === 'delete') await deleteTask(task.id);
  if (action === 'complete') {
    const previous = task.status;
    const next = previous === 'done' ? 'today' : 'done';
    await moveTask(task.id, next);
    notify(next === 'done' ? 'Task completed.' : 'Task moved to Today.', async () => {
      try { await moveTask(task.id, previous); } catch (error) { notify(error.message); }
    });
  }
  if (action === 'up' || action === 'down') {
    // Reorder against visible neighbors; hidden tasks retain their relative order.
    const card = $(`[data-id="${id}"]`);
    if (!card) return;
    const cards = $$('.task-card', card.closest('.column'));
    const index = cards.findIndex(card => card.dataset.id === task.id);
    if ((action === 'up' && index === 0) || (action === 'down' && index === cards.length - 1)) return;
    const before = action === 'up' ? cards[index - 1]?.dataset.id : cards[index + 2]?.dataset.id || null;
    if (before !== undefined) await moveTask(task.id, task.status, before);
  }
}

$('#board').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'tag') { state.tag = button.dataset.tag; render(); return; }
  const id = button.closest('[data-id]').dataset.id;
  button.disabled = true;
  try { await runTaskAction(id, button.dataset.action); }
  catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});

function closeTaskContextMenu(restoreFocus = false) {
  const menu = $('#task-context-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  if (restoreFocus && contextReturnFocus?.isConnected) contextReturnFocus.focus({ preventScroll: true });
  contextTaskId = null;
  contextReturnFocus = null;
}

function openTaskContextMenu(card, x, y) {
  const task = state.tasks.find(t => t.id === card.dataset.id);
  if (!task || dragId) return;
  closeTaskContextMenu();
  $$('.task-menu[open], .app-menu[open]').forEach(menu => { menu.open = false; });
  contextTaskId = task.id;
  contextReturnFocus = card;
  const menu = $('#task-context-menu');
  const cards = $$('.task-card', card.closest('.column'));
  const index = cards.indexOf(card);
  const item = (action, label, symbol, disabled = false, danger = false) => `<button type="button" role="menuitem" tabindex="-1" data-context-action="${action}" ${disabled ? 'disabled aria-disabled="true"' : ''} ${danger ? 'class="danger"' : ''}>${icon(symbol)}${label}</button>`;
  const separator = '<div role="separator"></div>';
  menu.innerHTML = item('edit', 'Edit task', 'edit') + item('schedule', 'Date & reminder…', 'calendar') +
    item('complete', task.status === 'done' ? 'Reopen in Today' : 'Mark as done', 'check') + separator +
    Object.entries(columns).filter(([status]) => status !== task.status && status !== 'done' && !(task.status === 'done' && status === 'today')).map(([status, column]) => item(`move:${status}`, `Move to ${column.title}`, 'arrow-right')).join('') + separator +
    item('up', 'Move up', 'up', index === 0) + item('down', 'Move down', 'down', index === cards.length - 1) + separator + item('delete', 'Delete task', 'trash', false, true);
  menu.setAttribute('aria-label', `Actions for ${task.title}`);
  menu.hidden = false;
  // Fixed positioning keeps the menu at the pointer and inside the viewport.
  menu.style.left = `${Math.max(8, Math.min(x, document.documentElement.clientWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  $('button:not(:disabled)', menu)?.focus({ preventScroll: true });
}

$('#board').addEventListener('contextmenu', event => {
  const card = event.target.closest('.task-card');
  // Preserve the browser's text, link, and input context menus.
  if (!card || event.target.closest('input,textarea,select,a,[contenteditable="true"]')) return;
  if (window.getSelection()?.toString() && card.contains(window.getSelection().anchorNode)) return;
  event.preventDefault();
  const rect = card.getBoundingClientRect();
  openTaskContextMenu(card, event.clientX || rect.left + 20, event.clientY || rect.top + 20);
});
$('#board').addEventListener('keydown', event => {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  const card = event.target.closest('.task-card');
  if (!card || event.target.closest('input,textarea,select')) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = card.getBoundingClientRect();
  openTaskContextMenu(card, rect.left + 20, rect.top + 20);
});
$('#task-context-menu').addEventListener('click', async event => {
  const button = event.target.closest('[data-context-action]');
  if (!button || button.disabled || !contextTaskId) return;
  const id = contextTaskId;
  closeTaskContextMenu(true);
  try { await runTaskAction(id, button.dataset.contextAction); }
  catch (error) { notify(error.message); }
});
$('#task-context-menu').addEventListener('contextmenu', event => event.preventDefault());
$('#task-context-menu').addEventListener('keydown', event => {
  const items = $$('button:not(:disabled)', event.currentTarget);
  const index = items.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  } else if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault();
    event.stopPropagation();
    closeTaskContextMenu(true);
  }
});
document.addEventListener('pointerdown', event => { if (!$('#task-context-menu').contains(event.target)) closeTaskContextMenu(); });
document.addEventListener('contextmenu', event => { if (!event.target.closest('.task-card, #task-context-menu')) closeTaskContextMenu(); });
document.addEventListener('scroll', event => { if (!$('#task-context-menu').contains(event.target)) closeTaskContextMenu(); }, true);
window.addEventListener('resize', () => closeTaskContextMenu());
window.addEventListener('blur', () => closeTaskContextMenu());

$('#board').addEventListener('change', async event => {
  if (!event.target.matches('.move-select')) return;
  const id = event.target.closest('[data-id]').dataset.id;
  const previous = state.tasks.find(t => t.id === id)?.status;
  try { await moveTask(id, event.target.value); }
  catch (error) { event.target.value = previous; notify(error.message); }
});

document.addEventListener('click', event => { $$('.task-menu[open], .app-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }); });
document.addEventListener('keydown', event => {
  if (!isUnlocked()) return;
  if (!$('#task-context-menu').hidden) return;
  if (event.key === 'Escape') { $$('.task-menu[open], .app-menu[open]').forEach(menu => { menu.open = false; $('summary', menu).focus(); }); clearDrag(); }
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,textarea,select,[contenteditable="true"]') || $('dialog[open]')) return;
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); openTask(); }
  if (event.key === '/') { event.preventDefault(); $('#search').focus(); }
  if (event.key === 'Enter' && event.target.matches('.task-card')) {
    const task = state.tasks.find(t => t.id === event.target.dataset.id);
    if (task) openTask(task.status, task);
  }
});

function clearDrop() {
  $$('.drag-over, .drop-before, .drop-after').forEach(node => node.classList.remove('drag-over', 'drop-before', 'drop-after'));
  dropTarget = null;
}
function clearDrag() {
  clearDrop();
  $$('.dragging').forEach(node => node.classList.remove('dragging'));
  dragId = null;
  touchDrag = null;
  cancelAnimationFrame(touchScrollFrame);
}
function markDrop(element, y) {
  clearDrop();
  const column = element?.closest('.column');
  if (!column) return;
  column.classList.add('drag-over');
  const card = element.closest('.task-card');
  if (card?.dataset.id === dragId) return;
  const status = column.dataset.status;
  let beforeId = null;
  if (card) {
    const before = y < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2;
    card.classList.add(before ? 'drop-before' : 'drop-after');
    beforeId = before ? card.dataset.id : card.nextElementSibling?.dataset.id || null;
    if (beforeId === dragId) beforeId = card.nextElementSibling?.nextElementSibling?.dataset.id || null;
  }
  dropTarget = { status, beforeId };
}
async function finishDrop() {
  const id = dragId;
  const target = dropTarget;
  clearDrag();
  if (id && target) {
    try { await moveTask(id, target.status, target.beforeId); }
    catch (error) { notify(error.message); }
  }
}
$('#board').addEventListener('dragstart', event => {
  closeTaskContextMenu();
  const card = event.target.closest('.task-card');
  if (!card || state.busy || state.loading || touchDrag) { event.preventDefault(); return; }
  dragId = card.dataset.id;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', dragId);
  requestAnimationFrame(() => { if (dragId) card.classList.add('dragging'); });
  $$('.task-menu[open]').forEach(menu => { menu.open = false; });
});
$('#board').addEventListener('dragover', event => { if (!dragId) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; markDrop(event.target, event.clientY); });
$('#board').addEventListener('dragleave', event => { if (!$('#board').contains(event.relatedTarget)) clearDrop(); });
$('#board').addEventListener('drop', event => { if (!dragId) return; event.preventDefault(); markDrop(event.target, event.clientY); finishDrop(); });
$('#board').addEventListener('dragend', clearDrag);

// Touch dragging begins only on the handle, leaving normal page scrolling intact.
$('#board').addEventListener('pointerdown', event => {
  const handle = event.target.closest('.drag-handle');
  if (!handle || event.pointerType === 'mouse' || state.busy || state.loading) return;
  handle.setPointerCapture(event.pointerId);
  touchDrag = { id: handle.closest('[data-id]').dataset.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, currentX: event.clientX, currentY: event.clientY, started: false };
});
function touchScroll() {
  if (!touchDrag?.started) return;
  const { currentX: x, currentY: y } = touchDrag;
  const scroll = y < 75 ? -9 : y > innerHeight - 75 ? 9 : 0;
  if (scroll) { window.scrollBy(0, scroll); markDrop(document.elementFromPoint(x, y), y); }
  touchScrollFrame = requestAnimationFrame(touchScroll);
}
$('#board').addEventListener('pointermove', event => {
  if (!touchDrag || event.pointerId !== touchDrag.pointer) return;
  touchDrag.currentX = event.clientX; touchDrag.currentY = event.clientY;
  if (!touchDrag.started && Math.hypot(event.clientX - touchDrag.x, event.clientY - touchDrag.y) > 7) {
    touchDrag.started = true;
    dragId = touchDrag.id;
    $(`[data-id="${dragId}"]`).classList.add('dragging');
    touchScrollFrame = requestAnimationFrame(touchScroll);
  }
  if (touchDrag.started) { event.preventDefault(); markDrop(document.elementFromPoint(event.clientX, event.clientY), event.clientY); }
});
$('#board').addEventListener('pointerup', event => { if (touchDrag && event.pointerId === touchDrag.pointer) finishDrop(); });
// Native HTML drag starts by cancelling the pointer stream. Only cancel our
// custom touch gesture here; clearing native drag state would discard the drop.
$('#board').addEventListener('pointercancel', event => {
  if (touchDrag && event.pointerId === touchDrag.pointer) clearDrag();
});

// Optional agent controls share the exact same persistence path as the interface.
const context = document.modelContext;
let toolsLifecycle;
function registerTools() {
if (context?.registerTool && isUnlocked()) {
  toolsLifecycle?.abort();
  const lifecycle = toolsLifecycle = new AbortController();
  const register = tool => { try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Unsupported experimental API. */ } };
  register({ name: 'list_tasks', description: 'Read the tasks in this Taskpath workspace.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: async () => { const board = await request('/api/board'); if (!state.busy && !state.loading && !dragId) applyBoard(board); return { tasks: board.tasks }; } });
  register({ name: 'create_task', description: 'Create a task and save it to the selected Taskpath column.', inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 240 }, status: { type: 'string', enum: Object.keys(columns) } }, required: ['title', 'status'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async input => { const result = await mutate('/api/tasks', 'POST', input); return { task: result.task }; } });
  register({ name: 'move_task', description: 'Move a saved Taskpath task into Later, This Week, Today, or Done.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: Object.keys(columns) } }, required: ['id', 'status'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async input => { if (!input || typeof input.id !== 'string' || !/^[\w-]+$/.test(input.id) || !Object.hasOwn(columns, input.status)) throw new Error('Invalid task or column.'); await moveTask(input.id, input.status); return { id: input.id, status: input.status }; } });
}
}
registerTools();

const realtime = createRealtime({ sync: syncAfterCurrent, localState, url: location.href });
notificationControls();

window.addEventListener('taskpath-password-changed', () => notify('Password changed. Other devices must sign in to sync again.'));
window.addEventListener('taskpath-locked', () => {
  toolsLifecycle?.abort();
  for (const name of ['list_tasks', 'create_task', 'move_task']) { try { context?.unregisterTool?.(name); } catch {} }
  $('#greeting').textContent = ''; state.nickname = ''; greetingChoice = null;
  realtime.pause(); clearTimeout(reminderTimer); clearTimeout(toastTimer); clearDrag();
  for (const key of Object.keys(state)) { if (Array.isArray(state[key])) state[key] = []; }
  Object.assign(state, { tasks: [], rows: [], reminders: [], editing: null, ready: false, query: '', tag: '', loading: false });
  editingTags = []; editingReminder = null; importSource = null; importRevision++; toastAction = null; contextTaskId = null; contextReturnFocus = null;
  for (const selector of ['#board', '#reminder-panel', '#task-context-menu', '#task-tags', '#tag-suggestions', '#import-tasks']) $(selector).replaceChildren();
  for (const input of $$('input, textarea')) if (input.id !== 'unlock-user' && !['checkbox', 'file'].includes(input.type)) input.value = '';
  $('#task-form').reset(); $('#password-form').reset();
  for (const selector of ['#toast-message', '#announcer', '#error-text', '#form-error', '#import-error', '#import-summary', '#import-warning']) $(selector).textContent = '';
  $('#error-banner').hidden = true; $('#toast').hidden = true;
  $('#tag-filter').innerHTML = '<option value="">All tags</option>';
});
window.addEventListener('taskpath-unlocked', () => { registerTools(); void refresh(); realtime.resume(); });
window.addEventListener('taskpath-storage', () => { void refresh({ quiet: true }); void realtime.reconcile(); });
window.addEventListener('online', () => realtime.resume());
window.addEventListener('offline', () => { realtime.pause(); void localState(r => { r.online = false; }).then(() => syncStatus()).catch(() => {}); });
await refresh();
realtime.resume();
window.addEventListener('focus', () => { void refresh({ quiet: true }); realtime.resume(); });
window.addEventListener('pagehide', () => realtime.pause());
window.addEventListener('pageshow', event => { if (event.persisted) { void refresh({ quiet: true }); realtime.resume(); } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) realtime.pause();
  else { void refresh({ quiet: true }); realtime.resume(); }
});
// iOS resumes syncing here when reopened; supporting browsers also use Background Sync.
setInterval(() => {
  void refresh({ quiet: true });
  // Retry pending writes even when the notification socket is healthy.
  void localState().then(record => {
    if (!realtime.connected || record.pending.length) void sync().catch(() => {});
  }).catch(() => {});
}, 15000);
