export function localReminderValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function reminderFromInput(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a valid reminder date and time.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localReminderValue(date.toISOString()) !== value) {
    throw new Error('That local time does not exist. Choose another time (check the daylight-saving transition).');
  }
  return date.toISOString();
}

export function dueLabel(dueDate, today) {
  const delta = Math.round((Date.parse(`${dueDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  const date = new Date(`${dueDate}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', ...(dueDate.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  });
  return `${delta < 0 ? 'Overdue · ' : ''}${date}`;
}
