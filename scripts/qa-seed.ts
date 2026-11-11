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

export async function seedQaWorkspace({
  store,
  userId,
  vaultId,
  key,
  now = () => Date.now(),
}: QaSeedOptions) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('QA seeding cannot run in production mode.');
  const at = now();
  const iso = (offset = 0) => new Date(at + offset).toISOString();
  const { day, week } = calendarAt(at, store.timezone);
  const base = (title: string, status: Task['status'], createdOffset = 0): Task => ({
    id: crypto.randomUUID(),
    title,
    notes: '',
    tags: [],
    category: 'personal',
    status,
    position: 0,
    plannedDay: status === 'today' ? day : null,
    plannedWeek: ['today', 'week'].includes(status) ? week : null,
    completedAt: status === 'done' ? iso(createdOffset) : null,
    createdAt: iso(createdOffset),
    updatedAt: iso(createdOffset),
    deletedAt: null,
    archivedAt: null,
    dueDate: null,
    reminderAt: null,
    reminderDismissedAt: null,
    reminderNotifiedAt: null,
    reminderToken: null,
  });

  const today = base('Reply to the email that could have been a Slack', 'today', -600_000);
  today.category = 'work';
  today.tags = ['email', 'qa'];
  today.position = 0;
  today.notes =
    'It has been six days. At this point it is a phone call.\n\n- Apologize for the delay\n- Answer the actual question\n- Do **not** write "per my last email"';
  today.reminderAt = iso(3_600_000);
  today.reminderToken = crypto.randomUUID();

  const todayTwo = base('Water the plant that is definitely still alive', 'today', -540_000);
  todayTwo.tags = ['adulting'];
  todayTwo.position = 1;
  todayTwo.notes = 'It is either thriving or plastic. Water it either way and hope.';

  const weekOne = base('Refactor the variable I named temp_final_v2', 'week', -480_000);
  weekOne.category = 'work';
  weekOne.tags = ['release', 'docs'];
  weekOne.position = 0;
  weekOne.notes = 'Rename it before it ships and haunts me for the rest of my career.';

  const weekTwo = base('Assemble the IKEA shelf (wish me luck)', 'week', -420_000);
  weekTwo.tags = ['home'];
  weekTwo.position = 1;
  weekTwo.notes = 'There will be four leftover screws. There are always four leftover screws.';

  const laterOne = base('Finish the book I started in 2019', 'later', -360_000);
  laterOne.tags = ['reading'];
  laterOne.position = 0;
  laterOne.dueDate = day;
  laterOne.notes = 'Currently on page 12. The bookmark has not moved in four years.';

  const laterTwo = base('Become a morning person (attempt #412)', 'later', -300_000);
  laterTwo.tags = ['self-improvement'];
  laterTwo.position = 1;
  laterTwo.notes = 'Snooze button count: 1,204. This time will be different.';

  const doneOne = base('Finally ship the calendar view', 'done', -86_400_000);
  doneOne.category = 'work';
  doneOne.tags = ['release'];
  doneOne.position = 0;
  doneOne.notes = 'It only took three sprints and one small existential crisis.';

  const archivedOne = base(
    'Cancel the streaming service I forgot I pay for',
    'later',
    -172_800_000,
  );
  archivedOne.tags = ['errands'];
  archivedOne.archivedAt = iso(-3_600_000);
  archivedOne.notes = 'I have watched exactly one show on it. Last year.';

  const tasks = [today, todayTwo, weekOne, weekTwo, laterOne, laterTwo, doneOne, archivedOne];
  const dayMs = 86_400_000;
  const date = (days: number) => calendarAt(at + days * dayMs, store.timezone).day;
  const add = (title: string, status: Task['status'], details: Partial<Task> = {}) => {
    const task = base(title, status, -10 * dayMs);
    task.updatedAt = iso();
    task.position = tasks.filter((item) => item.status === status && !item.archivedAt).length;
    Object.assign(task, details);
    tasks.push(task);
    return task;
  };

  add('Review the pull request with only 47 changed files', 'today', {
    category: 'work',
    tags: ['release', 'qa', 'review'],
    dueDate: day,
    notes:
      'Start with the migration. Then reward yourself with the CSS.\n\n- [ ] Check offline edits\n- [ ] Try keyboard navigation\n- [ ] Leave one useful comment',
    timeTracking: { elapsedMs: 25 * 60_000, startedAt: iso(-12 * 60_000) },
  });
  add('Pay the electricity bill before the lights provide a reminder', 'today', {
    tags: ['adulting', 'errands'],
    dueDate: date(-2),
    notes: 'The account number is in the last invoice. Probably.',
  });
  add('Take a proper lunch break', 'today', {
    tags: ['self-improvement'],
    timeTracking: { elapsedMs: 0, startedAt: null },
  });
  add('Write the tiny release note that explains the surprisingly large change', 'today', {
    category: 'work',
    tags: ['release', 'docs'],
    dueDate: day,
    timeTracking: { elapsedMs: 40 * 60_000, startedAt: null },
    notes:
      'Explain what changed for a person who has never seen the issue tracker.\n\n## Draft\nThe board now stays useful when the connection disappears. Your edits are saved locally and sync when you reconnect.\n\n## Check before publishing\n- Keep the example short\n- Link the migration guide\n- Mention the keyboard shortcut\n\nNo sentence may contain the phrase “various improvements”.',
  });

  add('Book the dentist appointment I keep moving to next week', 'week', {
    tags: ['adulting'],
    dueDate: date(2),
    reminderAt: iso(2 * dayMs),
    reminderToken: crypto.randomUUID(),
  });
  add('Try the backup restore instead of just admiring the backups', 'week', {
    category: 'work',
    tags: ['qa', 'review'],
    dueDate: date(3),
    notes: 'A backup is a theory until a restore works. Use a disposable database.',
    timeTracking: { elapsedMs: 75 * 60_000, startedAt: null },
  });
  add('Plan dinner with friends and negotiate seven calendars', 'week', {
    tags: ['home', 'errands'],
    dueDate: date(5),
    notes: 'Current leading option: Thursday. Current confirmed attendees: the group chat bot.',
  });
  add('Sketch a calmer empty state', 'week', {
    category: 'work',
    tags: ['design'],
    timeTracking: { elapsedMs: 15 * 60_000, startedAt: null },
    notes: 'One useful sentence and one clear action. The illustration can have a day off.',
  });
  add('Read the documentation before inventing a new configuration format', 'week', {
    category: 'work',
    tags: ['docs', 'reading'],
    dueDate: date(6),
  });

  add('Replace the chair that now has its own sound effects', 'later', {
    tags: ['home'],
    dueDate: date(14),
    notes: 'Requirements: comfortable, adjustable, does not announce every meeting exit.',
  });
  add('Prototype the idea from the notebook labeled definitely useful ideas', 'later', {
    category: 'work',
    tags: ['design', 'qa'],
    dueDate: date(21),
    notes: 'Build the smallest version first. The notebook is not a product specification.',
  });
  add('Sort the photos from the holiday two phones ago', 'later', {
    tags: ['home'],
    dueDate: date(35),
  });
  add('Learn to bake bread without turning the kitchen into a flour biome', 'later', {
    tags: ['self-improvement', 'home'],
    notes:
      'Recipe notes:\n\n1. Measure ingredients before mixing.\n2. Give the dough time to rise.\n3. Stop checking it every forty seconds.',
  });
  add('Clean up the bookmarks folder called read soon', 'later', {
    tags: ['reading', 'docs'],
    dueDate: date(-1),
  });

  const completed = [
    ['Fix the button that moved away when hovered', 'work', 1, 35],
    ['Buy groceries using an actual list', 'personal', 2, 45],
    ['Test the release with the Wi-Fi turned off', 'work', 4, 90],
    ['Find the missing shelf screws', 'personal', 7, 20],
    ['Remove the TODO that had become a permanent resident', 'work', 10, 50],
    ['Return the library books before they become antiques', 'personal', 14, 30],
    ['Document the deployment while I still remember it', 'work', 21, 65],
    ['Organize the drawer of mysterious charging cables', 'personal', 28, 55],
  ] as const;
  for (const [title, category, daysAgo, minutes] of completed) {
    add(title, 'done', {
      category,
      tags: category === 'work' ? ['release', 'qa'] : ['adulting'],
      createdAt: iso(-(daysAgo + 3) * dayMs),
      completedAt: iso(-daysAgo * dayMs),
      updatedAt: iso(-daysAgo * dayMs),
      dueDate: date(-daysAgo),
      timeTracking: { elapsedMs: minutes * 60_000, startedAt: null },
    });
  }
  add('Retire the old onboarding checklist', 'done', {
    category: 'work',
    tags: ['docs'],
    completedAt: iso(-4 * dayMs),
    archivedAt: iso(-2 * dayMs),
    updatedAt: iso(-2 * dayMs),
    timeTracking: { elapsedMs: 55 * 60_000, startedAt: null },
    notes:
      'Replaced by the shorter guide. Keep this for reference, especially the troubleshooting steps.',
  });
  add('Research a standing desk, then stand up occasionally', 'later', {
    tags: ['home', 'self-improvement'],
    archivedAt: iso(-dayMs),
    updatedAt: iso(-dayMs),
    notes: 'Decided to try walking breaks first. Restore if the current desk finally gives up.',
  });

  const changes = await Promise.all(
    tasks.map((task) =>
      encryptChange(key, vaultId, {
        changeId: crypto.randomUUID(),
        editedAt: task.updatedAt,
        task,
      }),
    ),
  );
  store.sync(userId, { workspaceKey: vaultId, changes });

  const files = new FileRepository(store.orm, fileQuota(undefined));
  const documents: { name: string; type: string; text: string }[] = [
    {
      name: 'QA cheat sheet.md',
      type: 'text/markdown',
      text: '# QA cheat sheet\n\nThis whole workspace is fake and vanishes when you press Ctrl+C.\n\n- [x] Panic\n- [ ] Drag a task between columns\n- [ ] Open a task and rewrite my notes\n- [ ] Switch themes until one of them feels right\n- [ ] Open **Files** and judge my screenshot\n',
    },
    {
      name: 'todo-real.txt',
      type: 'text/plain',
      text: '1. Drag a task somewhere new\n2. Import a board, export a board, feel powerful\n3. Search for "shelf" and pretend that is what you meant\n4. Absolutely do not assemble the shelf today\n',
    },
    {
      name: 'Release planning notes.md',
      type: 'text/markdown',
      text: '# A very small release\n\n## Before shipping\n\n- [x] Review the task editor\n- [ ] Test airplane mode\n- [ ] Check the calendar on a phone\n\n## Decisions\n\nKeep the interface quiet. Make saved changes easy to trust.\n\n> The best release note is one someone actually reads.\n\n## Follow-up\n\nTry filters with **work**, **personal**, and shared tags. Check archived timers in Stats.\n',
    },
    {
      name: 'Desk improvement budget.csv',
      type: 'text/csv',
      text: 'Item,Estimated cost,Priority\nChair,180,High\nDesk lamp,35,Medium\nCable organizer,12,Low\nPlant that is actually alive,15,Essential\n',
    },
  ];
  for (const document of documents) {
    const bytes = encoder.encode(document.text);
    const { envelope, ciphertext } = await encryptFile(key, userId, vaultId, bytes, {
      name: document.name,
      type: document.type,
      lastModified: at,
    });
    files.upload(envelope, ciphertext);
  }
  // A real PNG so the Files view can exercise image previews.
  const image = new Uint8Array(
    await Bun.file(resolve(import.meta.dir, '../public/icon-192.png')).arrayBuffer(),
  );
  const { envelope, ciphertext } = await encryptFile(key, userId, vaultId, image, {
    name: 'definitely-a-cat.png',
    type: 'image/png',
    lastModified: at,
  });
  files.upload(envelope, ciphertext);
}
