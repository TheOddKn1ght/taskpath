import { InputError, type Task, type Status } from './store';

export const markdownLimit = 256 * 1024;
const columns: Record<Status, string> = { later: 'Later', week: 'This Week', today: 'Today', done: 'Done' };
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*~_{}\[\]()#+.!|\-]/g, '\\$&').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
export function exportMarkdown(tasks: Task[]) {
  const lines = ['# Taskpath', ''];
  for (const [status, heading] of Object.entries(columns)) {
    lines.push(`## ${heading}`, '');
    for (const task of tasks.filter(t => t.status === status)) {
      lines.push(`- [${status === 'done' ? 'x' : ' '}] ${escapeText(task.title)}`);
      lines.push(`  - Category: ${task.category === 'work' ? 'Work' : 'Personal'}`);
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

type MarkdownNode = { type: string; text?: string; children?: MarkdownNode[]; meta?: Record<string, unknown> };

// Bun parses Markdown syntax; callbacks retain a small tree without generating HTML.
function markdownTree(source: string) {
  const nodes: MarkdownNode[] = [];
  const children = (value: string): MarkdownNode[] => value.split(/(\d+,)/).filter(Boolean).map(part =>
    /^\d+,$/.test(part) ? nodes[Number(part.slice(0, -1))]! : { type: 'text', text: part });
  const add = (node: MarkdownNode) => `${nodes.push(node) - 1},`;
  const callbacks = Object.fromEntries(['heading', 'paragraph', 'blockquote', 'code', 'list', 'listItem', 'hr', 'table', 'html', 'link', 'image'].map(type =>
    [type, (value: string, meta?: Record<string, unknown>) => add({ type, children: children(value), meta })]));
  callbacks.text = (value: string) => add({ type: 'text', text: value });
  return children(Bun.markdown.render(source, callbacks));
}

function plain(node: MarkdownNode): string {
  if (node.type === 'text') return node.text || '';
  const text = (node.children || []).map(plain).join('');
  if (node.type === 'link') return `${text} (${node.meta?.href || ''})`;
  if (node.type === 'image') return `${text} (${node.meta?.src || ''})`;
  return text + (node.type === 'paragraph' ? '\n\n' : node.type === 'listItem' ? '\n' : '');
}

export function parseMarkdown(markdown: unknown) {
  if (typeof markdown !== 'string') throw new InputError('Choose a Markdown file or paste Markdown text.');
  if (Buffer.byteLength(markdown) > markdownLimit) throw new InputError('Markdown must be 256 KB or smaller.', 413);
  const tasks: Record<string, unknown>[] = [];
  let section: Status = 'later';
  let ignoredBlocks = 0;
  function addTask(node: MarkdownNode) {
    const parts = [...node.children || []];
    const title: MarkdownNode[] = [];
    if (parts[0]?.type === 'paragraph') title.push(parts.shift()!);
    else while (parts.length && !['list', 'blockquote', 'code', 'paragraph', 'heading', 'table'].includes(parts[0]!.type)) title.push(parts.shift()!);
    const task: Record<string, unknown> = { title: title.map(plain).join('').trim(), status: node.meta?.checked ? 'done' : section };
    const notes: string[] = [];
    const nested: MarkdownNode[] = [];
    for (const part of parts) {
      if (part.type !== 'list') { notes.push(plain(part)); continue; }
      for (const item of part.children || []) {
        if (typeof item.meta?.checked === 'boolean') { nested.push(item); continue; }
        const text = plain(item).trim();
        const metadata = text.match(/^(Category|Due|Reminder|Reminder dismissed):\s*([^\n]*)$/i);
        if (!metadata) { notes.push(text + '\n'); continue; }
        const key = ({ category: 'category', due: 'dueDate', reminder: 'reminderAt', 'reminder dismissed': 'reminderDismissedAt' })[metadata[1]!.toLowerCase()]!;
        if (key in task) throw new InputError(`Task ${tasks.length + 1}: duplicate ${metadata[1]} field.`);
        task[key] = key === 'category' ? metadata[2]!.trim().toLowerCase() : metadata[2]!.trim();
      }
    }
    task.notes = notes.join('').trim();
    tasks.push(task);
    if (tasks.length > 500) throw new InputError('Import up to 500 tasks at a time.');
    nested.forEach(addTask);
  }
  function visit(node: MarkdownNode) {
    if (node.type === 'heading') {
      section = (Object.entries(columns).find(([, name]) => name.toLowerCase() === plain(node).trim().toLowerCase())?.[0] || 'later') as Status;
    } else if (node.type === 'list') (node.children || []).forEach(visit);
    else if (node.type === 'listItem' && typeof node.meta?.checked === 'boolean') addTask(node);
    else if (node.type === 'listItem') {
      ignoredBlocks++;
      (node.children || []).filter(child => child.type === 'list').forEach(visit);
    } else if (plain(node).trim()) ignoredBlocks++;
  }
  markdownTree(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).forEach(visit);
  if (!tasks.length) throw new InputError('No tasks found. Use checklist lines such as - [ ] My task.');
  return { tasks, ignoredBlocks };
}
