const columns = { later: 'Later', week: 'This Week', today: 'Today', done: 'Done' };
const escapeText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*~_{}\[\]()#+.!|\-]/g, '\\$&').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
export function exportMarkdown(tasks) {
  const lines = ['# Taskpath', ''];
  for (const [status, heading] of Object.entries(columns)) {
    lines.push(`## ${heading}`, '');
    for (const task of tasks.filter(t => t.status === status)) {
      lines.push(`- [${status === 'done' ? 'x' : ' '}] ${escapeText(task.title)}`);
      lines.push(`  - Category: ${task.category === 'work' ? 'Work' : 'Personal'}`);
      if (task.tags?.length) lines.push(`  - Tags: ${escapeText(JSON.stringify(task.tags))}`);
      if (task.dueDate) lines.push(`  - Due: ${task.dueDate}`);
      if (task.reminderAt) lines.push(`  - Reminder: ${task.reminderAt}`);
      if (task.reminderDismissedAt) lines.push(`  - Reminder dismissed: ${task.reminderDismissedAt}`);
      if (task.notes) {
        const fence = '`'.repeat(Math.max(3, ...[...task.notes.matchAll(/`+/g)].map(match => match[0].length + 1)));
        lines.push(`  ${fence}text`, ...task.notes.split('\n').map(line => `  ${line}`), `  ${fence}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
