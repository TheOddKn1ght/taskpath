import { resolve } from 'node:path';
import { encryptChange } from '../public/crypto.js';
import { encryptFile } from '../public/file-crypto.js';
import { fileQuota } from '../public/file-format.js';
import { calendarAt } from '../public/offline-model.js';
import { FileRepository } from '../src/db/files.js';
import type { Store } from '../src/store.js';
import type { Task } from '../public/types.js';

/** Disposable local QA only. Never imported by the production server. */
export interface QaSeedOptions {
  store: Store;
  userId: string;
  vaultId: string;
  key: CryptoKey;
  now?: () => number;
}

const encoder = new TextEncoder();

export async function seedQaWorkspace({ store, userId, vaultId, key, now = () => Date.now() }: QaSeedOptions) {
  if (process.env.NODE_ENV === 'production') throw new Error('QA seeding cannot run in production mode.');
  const at = now();
  const iso = (offset = 0) => new Date(at + offset).toISOString();
  const { day, week } = calendarAt(at, store.timezone);
  const base = (title: string, status: Task['status'], createdOffset = 0): Task => ({
    id: crypto.randomUUID(), title, notes: '', tags: [], category: 'personal', status, position: 0,
    plannedDay: status === 'today' ? day : null, plannedWeek: ['today', 'week'].includes(status) ? week : null,
    completedAt: status === 'done' ? iso(createdOffset) : null, createdAt: iso(createdOffset), updatedAt: iso(createdOffset),
    deletedAt: null, archivedAt: null, dueDate: null, reminderAt: null,
    reminderDismissedAt: null, reminderNotifiedAt: null, reminderToken: null,
  });

  const today = base('Reply to the email that could have been a Slack', 'today', -600_000);
  today.category = 'work'; today.tags = ['email', 'qa']; today.position = 0;
  today.notes = 'It has been six days. At this point it is a phone call.\n\n- Apologize for the delay\n- Answer the actual question\n- Do **not** write "per my last email"';
  today.reminderAt = iso(3_600_000); today.reminderToken = crypto.randomUUID();

  const todayTwo = base('Water the plant that is definitely still alive', 'today', -540_000);
  todayTwo.tags = ['adulting']; todayTwo.position = 1;
  todayTwo.notes = 'It is either thriving or plastic. Water it either way and hope.';

  const weekOne = base('Refactor the variable I named temp_final_v2', 'week', -480_000);
  weekOne.category = 'work'; weekOne.tags = ['release', 'docs']; weekOne.position = 0;
  weekOne.notes = 'Rename it before it ships and haunts me for the rest of my career.';

  const weekTwo = base('Assemble the IKEA shelf (wish me luck)', 'week', -420_000);
  weekTwo.tags = ['home']; weekTwo.position = 1;
  weekTwo.notes = 'There will be four leftover screws. There are always four leftover screws.';

  const laterOne = base('Finish the book I started in 2019', 'later', -360_000);
  laterOne.tags = ['reading']; laterOne.position = 0; laterOne.dueDate = day;
  laterOne.notes = 'Currently on page 12. The bookmark has not moved in four years.';

  const laterTwo = base('Become a morning person (attempt #412)', 'later', -300_000);
  laterTwo.tags = ['self-improvement']; laterTwo.position = 1;
  laterTwo.notes = 'Snooze button count: 1,204. This time will be different.';

  const doneOne = base('Finally ship the calendar view', 'done', -86_400_000);
  doneOne.category = 'work'; doneOne.tags = ['release']; doneOne.position = 0;
  doneOne.notes = 'It only took three sprints and one small existential crisis.';

  const archivedOne = base('Cancel the streaming service I forgot I pay for', 'later', -172_800_000);
  archivedOne.tags = ['errands']; archivedOne.archivedAt = iso(-3_600_000);
  archivedOne.notes = 'I have watched exactly one show on it. Last year.';

  const tasks = [today, todayTwo, weekOne, weekTwo, laterOne, laterTwo, doneOne, archivedOne];
  const changes = await Promise.all(tasks.map(task => encryptChange(key, vaultId, {
    changeId: crypto.randomUUID(), editedAt: task.updatedAt, task,
  })));
  store.sync(userId, { workspaceKey: vaultId, changes });

  const files = new FileRepository(store.orm, fileQuota(undefined));
  const documents: { name: string; type: string; text: string }[] = [
    { name: 'QA cheat sheet.md', type: 'text/markdown', text: '# QA cheat sheet\n\nThis whole workspace is fake and vanishes when you press Ctrl+C.\n\n- [x] Panic\n- [ ] Drag a task between columns\n- [ ] Open a task and rewrite my notes\n- [ ] Switch themes until one of them feels right\n- [ ] Open **Files** and judge my screenshot\n' },
    { name: 'todo-real.txt', type: 'text/plain', text: '1. Drag a task somewhere new\n2. Import a board, export a board, feel powerful\n3. Search for "shelf" and pretend that is what you meant\n4. Absolutely do not assemble the shelf today\n' },
  ];
  for (const document of documents) {
    const bytes = encoder.encode(document.text);
    const { envelope, ciphertext } = await encryptFile(key, userId, vaultId, bytes, { name: document.name, type: document.type, lastModified: at });
    files.upload(envelope, ciphertext);
  }
  // A real PNG so the Files view can exercise image previews.
  const image = new Uint8Array(await Bun.file(resolve(import.meta.dir, '../public/icon-192.png')).arrayBuffer());
  const { envelope, ciphertext } = await encryptFile(key, userId, vaultId, image, { name: 'definitely-a-cat.png', type: 'image/png', lastModified: at });
  files.upload(envelope, ciphertext);
}
