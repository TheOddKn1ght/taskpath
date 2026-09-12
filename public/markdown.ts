import type { TaskInput, Status } from './types.js';
import type { Token } from './vendor/marked.js';
import { lexer } from './vendor/marked.js';
import { normalizeTags } from './tags.js';
export { exportMarkdown } from './export-markdown.js';
export const markdownLimit = 256 * 1024;
// Decode text, never insert imported markup in DOM or invoke Marked's renderer.
function entities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, name) => {
    if (name[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' } as Record<string,string>)[name.toLowerCase()] || all;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
  });
}
function plain(token: Token): string {
  if (token.type === 'space' || token.type === 'checkbox' || token.type === 'html') return '';
  if (token.type === 'code' || token.type === 'codespan' || token.type === 'escape') return token.text || '';
  if (token.type === 'br') return '\n';
  const value = token.tokens ? token.tokens.map(plain).join('') : token.items ? token.items.map(plain).join('\n') : entities(token.text || '');
  return value + (['link', 'image'].includes(token.type) ? ` (${token.href || ''})` : token.type === 'paragraph' ? '\n\n' : '');
}
export function parseMarkdown(markdown: unknown) {
  if (typeof markdown !== 'string') throw new Error('Choose a Markdown file or paste a checklist.');
  if (new TextEncoder().encode(markdown).length > markdownLimit) throw new Error('Markdown must be 256 KB or smaller.');
  const tasks: TaskInput[] = []; let section: Status = 'later', ignoredBlocks = 0;
  function addTask(node: Token) {
    const parts = (node.tokens || []).filter(t => t.type !== 'checkbox');
    const first = parts.shift();
    const task: TaskInput = { title: first ? plain(first).trim() : '', status: node.checked ? 'done' : section };
    const notes: string[] = [], nested: Token[] = [];
    for (const part of parts) {
      if (part.type !== 'list') { notes.push(plain(part)); continue; }
      for (const item of part.items || []) {
        if (item.task) { nested.push(item); continue; }
        const text = plain(item).trim();
        const match = text.match(/^(Category|Tags|Due|Reminder|Reminder dismissed|Archived):\s*([^\n]*)$/i);
        if (!match) { notes.push(text + '\n'); continue; }
        const key = ({ category: 'category', tags: 'tags', archived: 'archivedAt', due: 'dueDate', reminder: 'reminderAt', 'reminder dismissed': 'reminderDismissedAt' } as Record<string,string>)[match[1].toLowerCase()];
        if (key in task) throw new Error(`Task ${tasks.length + 1}: duplicate ${match[1]} field.`);
        if (key === 'tags') {
          try { task.tags = normalizeTags(JSON.parse(match[2].trim())); }
          catch { throw new Error(`Task ${tasks.length + 1}: Tags must be a JSON array of up to 10 valid names.`); }
        } else Object.assign(task, { [key]: key === 'category' ? match[2].trim().toLowerCase() : match[2].trim() });
      }
    }
    task.notes = notes.join('').trim(); tasks.push(task);
    if (tasks.length > 500) throw new Error('Import up to 500 tasks at a time.');
    nested.forEach(addTask);
  }
  function visit(node: Token) {
    if (node.type === 'heading') section = ({ later: 'later', 'this week': 'week', today: 'today', done: 'done' } as Record<string,Status>)[plain(node).trim().toLowerCase()] || 'later';
    else if (node.type === 'list') node.items?.forEach(visit);
    else if (node.type === 'list_item' && node.task) addTask(node);
    else if (node.type === 'list_item') { ignoredBlocks++; (node.tokens || []).filter(t => t.type === 'list').forEach(visit); }
    else if (node.type !== 'space') ignoredBlocks++;
  }
  lexer(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).forEach(visit);
  if (!tasks.length) throw new Error('No tasks found. Use checklist lines such as - [ ] My task.');
  return { tasks, ignoredBlocks };
}
