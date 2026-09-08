import { normalizeTags } from './tags.js';
// Pure projections shared by the page and service worker. Pending edits stay immutable.
export function calendarAt(time, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time));
  const part = name => parts.find(p => p.type === name).value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  const monday = new Date(`${day}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return { day, week: monday.toISOString().slice(0, 10) };
}
export function project(record, time = Date.now() + (record?.offset || 0)) {
  if (!record?.board) return null;
  const rows = new Map(record.board.rows.map(task => [task.id, { ...task }]));
  for (const change of record.pending) {
    const previous = rows.get(change.task.id);
    rows.set(change.task.id, { ...change.task, tags: change.task.tags ?? previous?.tags ?? [] });
  }
  for (const task of rows.values()) task.tags = [...(task.tags ?? [])];
  const { day, week } = calendarAt(time, record.board.timezone);
  for (const task of rows.values()) {
    if (task.deletedAt || !['today', 'week'].includes(task.status)) continue;
    if (task.plannedWeek !== week) { task.status = 'later'; task.plannedDay = null; task.plannedWeek = null; }
    else if (task.status === 'today' && task.plannedDay !== day) { task.status = 'week'; task.plannedDay = null; }
  }
  const tasks = [...rows.values()].filter(t => !t.deletedAt).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const serverTime = new Date(time).toISOString();
  return { ...record.board, rows: [...rows.values()], tasks, day, week, serverTime,
    reminders: tasks.filter(t => t.status !== 'done' && t.reminderAt && !t.reminderDismissedAt && t.reminderAt <= serverTime) };
}
function validate(task) {
  if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 240) throw new Error('Task must be between 1 and 240 characters.');
  if (typeof task.notes !== 'string' || task.notes.length > 10000) throw new Error('Notes must be at most 10000 characters.');
  if (!['later', 'week', 'today', 'done'].includes(task.status) || !['work', 'personal'].includes(task.category)) throw new Error('Invalid column or category.');
  if (task.dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) || !Number.isFinite(Date.parse(task.dueDate)) || new Date(task.dueDate).toISOString().slice(0, 10) !== task.dueDate)) throw new Error('Choose a valid due date.');
  if (task.reminderAt && !Number.isFinite(Date.parse(task.reminderAt))) throw new Error('Choose a valid reminder time.');
  task.tags = normalizeTags(task.tags ?? []);
  task.title = task.title.trim(); task.notes = task.notes.trim();
}
export function queueChange(record, path, method, input = {}, now = Date.now()) {
  if (!record?.board || record.locked) throw new Error('Open your workspace online before making offline changes.');
  const time = Math.max(now + record.offset, (record.lastEdit || 0) + 1);
  const editedAt = new Date(time).toISOString();
  const board = project(record, time);
  const match = path.match(/^\/api\/tasks\/([\w-]+)(?:\/(restore|reminder))?$/);
  const creating = path === '/api/tasks' && method === 'POST';
  let task = creating ? { id: crypto.randomUUID(), title: '', notes: '', tags: [], category: 'personal', status: 'later', position: 0,
    plannedDay: null, plannedWeek: null, completedAt: null, createdAt: editedAt, updatedAt: editedAt, deletedAt: null,
    dueDate: null, reminderAt: null, reminderDismissedAt: null, reminderNotifiedAt: null } : board.rows.find(t => t.id === match?.[1]);
  if (!task) throw new Error('That task no longer exists.');
  task = { ...task };
  const oldStatus = task.status;
  if (method === 'DELETE') task.deletedAt = editedAt;
  else if (match?.[2] === 'restore') task.deletedAt = null;
  else if (match?.[2] === 'reminder') {
    if (task.reminderAt !== input.reminderAt || task.reminderDismissedAt || task.status === 'done') throw new Error('This reminder has changed.');
    if (input.action === 'dismiss') task.reminderDismissedAt = editedAt;
    else if (input.action === 'snooze') { task.reminderAt = new Date(time + 600000).toISOString(); task.reminderDismissedAt = null; task.reminderNotifiedAt = null; }
    else throw new Error('Choose Dismiss or Snooze.');
  } else {
    if (task.deletedAt) throw new Error('That task was deleted.');
    for (const key of ['title', 'notes', 'category', 'status', 'dueDate', 'reminderAt', 'tags']) if (key in input) task[key] = input[key];
    if ('reminderAt' in input && task.reminderAt !== board.rows.find(t => t.id === task.id)?.reminderAt) { task.reminderDismissedAt = null; task.reminderNotifiedAt = null; }
    if (creating && input.reminderDismissedAt) task.reminderDismissedAt = input.reminderDismissedAt;
    task.plannedDay = task.status === 'today' ? board.day : null;
    task.plannedWeek = ['week', 'today'].includes(task.status) ? board.week : null;
    task.completedAt = task.status === 'done' ? task.completedAt || editedAt : null;
  }
  if (creating || oldStatus !== task.status || 'beforeId' in input || match?.[2] === 'restore') {
    const peers = board.tasks.filter(t => t.status === task.status && t.id !== task.id);
    let index = peers.findIndex(t => t.id === input.beforeId);
    if (index < 0) index = peers.length;
    let left = peers[index - 1]?.position;
    let right = peers[index]?.position;
    if (left !== undefined && right !== undefined && !((left + right) / 2 > left && (left + right) / 2 < right)) {
      // Concurrent offline inserts can share a rank. Re-space the column only
      // when no representable midpoint remains, keeping the requested drop order.
      peers.forEach((peer, i) => {
        peer.position = i * 1024;
        peer.updatedAt = editedAt;
        record.pending.push({ changeId: crypto.randomUUID(), editedAt, task: { ...peer } });
      });
      left = peers[index - 1]?.position; right = peers[index]?.position;
    }
    task.position = left === undefined ? (right ?? 0) - 1 : right === undefined ? left + 1 : (left + right) / 2;
  }
  validate(task);
  task.updatedAt = editedAt;
  const change = { changeId: crypto.randomUUID(), editedAt, task };
  record.pending.push(change);
  record.lastEdit = time;
  return { task, ok: true };
}
export function acceptSync(record, response, time = Date.now()) {
  if (record.board && record.board.workspaceKey !== response.workspaceKey) {
    const error = new Error('This server has a different workspace. Export your pending changes before switching.');
    error.status = 409;
    throw error;
  }
  const acknowledged = new Set(response.acknowledged || []);
  record.pending = record.pending.filter(change => !acknowledged.has(change.changeId));
  record.board = response;
  record.offset = Date.parse(response.serverTime) - time;
  record.lastEdit = Math.max(record.lastEdit || 0, ...response.rows.map(t => Date.parse(t.updatedAt)));
  record.authRequired = false;
  return record;
}
