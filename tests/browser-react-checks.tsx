// Isolated, disposable accounts only. Runs the complete React tree and services.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
const output = document.querySelector<HTMLElement>("#result")!,
  results: string[] = [];
const originalFetch = window.fetch.bind(window),
  requests: string[] = [];
let offline = false,
  configGate: Promise<void> | null = null;
window.fetch = async (input, init) => {
  requests.push(String(input));
  if (init?.body) requests.push(String(init.body));
  if (offline && String(input).startsWith("/api/"))
    throw new TypeError("Offline fixture");
  if (configGate && String(input).startsWith("/api/auth/config"))
    await configGate;
  return originalFetch(input, init);
};
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
  results.push("PASS " + message);
  output.textContent = results.join("\n");
}
async function until(check: () => unknown, label: string) {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error(
        "Timed out: " +
          label +
          " " +
          document.querySelector('[role="alert"]')?.textContent,
      );
    await new Promise((r) => setTimeout(r, 30));
  }
}
const node = <T extends HTMLElement = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error("Missing " + selector);
  return element;
};
const click = (selector: string) => flushSync(() => node(selector).click());
const textButton = (text: string, scope: ParentNode = document) => {
  const button = [
    ...scope.querySelectorAll<HTMLElement>("button,summary"),
  ].find(
    (b) =>
      b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
  );
  if (!button) throw new Error("Missing button " + text);
  flushSync(() => button.click());
};
const input = (selector: string, value: string) =>
  flushSync(() => {
    const el = node<HTMLInputElement | HTMLTextAreaElement>(selector);
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = (selector: string) =>
  flushSync(() => node<HTMLFormElement>(selector).requestSubmit());
const key = (target: HTMLElement, value: string, options: KeyboardEventInit = {}) =>
  flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })));
const menu = (label: string) => {
  click(".app-menu");
  const popup = node(".app-menu-popover");
  flushSync(() => popup.dispatchEvent(new FocusEvent("focusout", {bubbles:true, relatedTarget:null})));
  if (!popup.isConnected) throw new Error("Workspace menu dismissed before action");
  textButton(label, popup);
};
try {
  const invitation = await (await originalFetch("/test-invitation")).text(),
    link = new DOMParser()
      .parseFromString(invitation, "text/html")
      .querySelector("a")!
      .getAttribute("href")!;
  history.replaceState(null, "", link);
  const [
    { App },
    { initializeAuth },
    { startRuntime, refresh, getSnapshot, navigate },
    {
      localState,
      syncAfterCurrent,
      clearMemory,
      restoreRemembered,
      isUnlocked,
      offlineRequest,
    },
    { rememberedKey },
  ] = await Promise.all([
    import("../public/ui/app"),
    import("../public/ui/auth"),
    import("../public/ui/store"),
    import("../public/offline.js"),
    import("../public/persistence.js"),
  ]);
  const idle = () => until(() => !getSnapshot().busy, "idle");
  const cleanup = startRuntime(flushSync),
    root = createRoot(node("#root"));
  flushSync(() => root.render(<App />));
  await initializeAuth();
  await until(() => document.querySelector("#unlock-form"), "setup");
  assert(
    node("#unlock-title").textContent === "Your private vault",
    "invitation opens React setup",
  );
  assert(!location.hash.includes("setup"), "setup token removed from location");
  const user = node<HTMLInputElement>("#unlock-user").value,
    password = "React test vault password 2026";
  input('[name="password"]', password);
  input('[name="confirm"]', password);
  input('[name="nickname"]', "React Friend");
  click('[name="remember"]');
  submit("#unlock-form");
  await until(
    () => getSnapshot().board?.nickname === "React Friend",
    "setup and encrypted nickname",
  );
  assert(
    !!(await rememberedKey()),
    "setup can remember a non-extractable device key",
  );
  assert(
    document.querySelectorAll("#root #main").length === 1,
    "one React workspace mounts",
  );
  click(".app-menu");
  const workspaceTrigger=node(".app-menu"), workspacePopup=node(".app-menu-popover");
  assert(workspacePopup.parentElement===document.body,"workspace menu uses the shared portal");
  for (const relatedTarget of [null,document.body,workspaceTrigger]) {
    flushSync(()=>workspacePopup.dispatchEvent(new FocusEvent("focusout",{bubbles:true,relatedTarget})));
    assert(workspacePopup.isConnected,"workspace menu survives pointer blur");
  }
  key(workspacePopup,"End");
  const enabledItems=[...workspacePopup.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  assert(document.activeElement===enabledItems.at(-1),"workspace End focuses last enabled action");
  key(workspacePopup,"Home");
  assert(document.activeElement===enabledItems[0],"workspace Home focuses first enabled action");
  key(workspacePopup,"Escape");
  assert(!document.querySelector(".app-menu-popover") && document.activeElement===workspaceTrigger,"workspace Escape closes and restores focus");
  click(".app-menu");
  key(node(".app-menu-popover"),"Tab");
  assert(!document.querySelector(".app-menu-popover") && document.activeElement===workspaceTrigger,"workspace Tab closes and restores focus");
  click(".app-menu");
  flushSync(()=>node("#open-search").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true})));
  assert(!document.querySelector(".app-menu-popover"),"workspace outside pointer dismisses the menu");
  const spacer = document.body.appendChild(document.createElement("div"));
  spacer.style.height = "3000px";
  click(".app-menu");
  flushSync(()=>document.dispatchEvent(new Event("scroll")));
  assert(document.querySelector(".app-menu-popover"),"a late scroll event without movement keeps the menu open");
  window.scrollTo(0, 200);
  await until(()=>!document.querySelector(".app-menu-popover"),"scrolling the page dismisses the menu");
  assert(true,"scrolling the page dismisses the menu");
  window.scrollTo(0, 0);
  spacer.remove();
  key(document.body, "/");
  assert(document.activeElement === node("#search"), "slash focuses search");
  key(node("#search"), "n");
  assert(!document.querySelector("#task-dialog"), "new-task shortcut does not interrupt typing");
  key(document.body, "n", { ctrlKey: true });
  key(document.body, "n", { metaKey: true });
  key(document.body, "n", { isComposing: true });
  assert(!document.querySelector("#task-dialog"), "shortcuts preserve browser modifiers and composition");
  textButton("Close Search tasks");
  key(document.body, "N");
  assert(!!document.querySelector("#task-dialog"), "N opens a new task");
  key(node("#task-title"), "/");
  assert(document.activeElement === node("#task-title"), "slash does not steal editor focus");
  input('#task-title', 'UNSAVED_DRAFT');
  textButton('Cancel', node('#task-dialog'));
  assert(!!document.querySelector('#task-dialog') && node('#task-dialog').textContent?.includes('Discard your unsaved changes?'), 'dirty editor asks before discarding');
  textButton('Keep editing', node('#task-dialog'));
  assert(node<HTMLInputElement>('#task-title').value === 'UNSAVED_DRAFT', 'keep editing preserves draft');
  flushSync(() => node('#task-dialog').dispatchEvent(new Event('cancel', {cancelable: true})));
  assert(node('#task-dialog').textContent?.includes('Discard your unsaved changes?'), 'Escape protects changed drafts');
  textButton('Discard changes', node('#task-dialog'));
  assert(!document.querySelector('#task-dialog') && !getSnapshot().board?.tasks.some(t => t.title === 'UNSAVED_DRAFT'), 'confirmed discard leaves stored tasks unchanged');
  assert(
    [...document.querySelectorAll(".column")]
      .map((e) => (e as HTMLElement).dataset.status)
      .join() === "today,week,later,done",
    "board DOM order is Today, Week, Later, Done",
  );
  assert(
    node("#greeting").textContent?.includes("React Friend"),
    "encrypted nickname appears in greeting",
  );
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await Promise.all(
    document
      .getAnimations()
      .map((animation) => animation.finished.catch(() => {})),
  );
  const boxes = [...document.querySelectorAll(".column")].map((el) =>
    el.getBoundingClientRect(),
  );
  assert(
    innerWidth <= 760
      ? boxes.every(
          (b, i) =>
            Math.abs(b.left - boxes[0].left) < 1 &&
            (!i || b.top > boxes[i - 1].top),
        )
      : innerWidth <= 800
        ? Math.abs(boxes[0].top - boxes[1].top) < 1 &&
          boxes[2].top > boxes[0].top
        : boxes.every((b, i) => !i || b.left > boxes[i - 1].left),
    "board responsive column order at " +
      innerWidth +
      "px " +
      JSON.stringify(boxes.map((b) => [b.left, b.top])),
  );
  if (innerWidth <= 760) {
    const nav = node("#sidebar").getBoundingClientRect(),
      fab = node("#new-task").getBoundingClientRect();
    assert(
      Math.abs(nav.bottom - innerHeight) < 2 && fab.bottom <= nav.top,
      "phone tabs stay at the bottom with floating add above",
    );
    const category = node("#category-filter").getBoundingClientRect(),
      tag = node("#tag-filter").getBoundingClientRect();
    assert(
      Math.abs(category.top - tag.top) < 2 &&
        category.width > 100 &&
        tag.width > 100,
      "phone filters share a balanced row",
    );
  }
  for (const theme of [
    "Light",
    "Dark",
    "Gruvbox Light",
    "Gruvbox Dark",
    "Nord",
    "Catppuccin Mocha",
    "Rosé Pine Dawn",
    "Midnight",
    "Plum",
    "Ocean",
    "Sand",
    "Lavender",
    "Ice",
  ]) {
    click("#theme-toggle");
    textButton(theme, node("#theme-dialog"));
    assert(
      node("#theme-dialog")
        .querySelector('[aria-pressed="true"]')
        ?.textContent?.trim() === theme,
      "theme selection " + theme,
    );
    const colorProbe = document.createElement("span");
    colorProbe.style.color = "var(--muted)";
    document.body.append(colorProbe);
    assert(getComputedStyle(node("#greeting")).color === getComputedStyle(colorProbe).color,
      "Tailwind greeting color follows " + theme);
    colorProbe.remove();
    textButton("Close Choose theme");
  }
  click("#new-task");
  input("#task-title", "REACT_PRIVATE_TASK");
  input("#task-notes", "Draft survives external refresh");
  input("#task-tag-input", " HOME ");
  textButton("Add", node("#task-dialog"));
  const title = node<HTMLInputElement>("#task-title");
  title.focus();
  title.setSelectionRange(2, 5);
  const dialog = node("#task-dialog");
  dialog.scrollTop = 40;
  const scroll = dialog.scrollTop;
  await refresh();
  await new Promise((r) => setTimeout(r, 30));
  assert(
    node("#task-title") === title &&
      title.value === "REACT_PRIVATE_TASK" &&
      title.selectionStart === 2 &&
      title.selectionEnd === 5 &&
      document.activeElement === title &&
      dialog.scrollTop === scroll,
    "external refresh preserves editor draft, DOM, focus, selection and scroll",
  );
  await idle();
  submit("#task-form");
  await until(() => !document.querySelector("#task-dialog"), "task saved");
  await until(() => getSnapshot().board?.tasks.some(
      (t) => t.title === "REACT_PRIVATE_TASK" && t.tags[0] === "home",
    ), "React create preserves normalized tags");
  assert(
    getSnapshot().board?.tasks.some(
      (t) => t.title === "REACT_PRIVATE_TASK" && t.tags[0] === "home",
    ),
    "React create preserves normalized tags",
  );
  const toastStyle = getComputedStyle(node("#toast"));
  assert(toastStyle.position === "fixed" && toastStyle.display === "flex" && toastStyle.gap === "16px",
    "extracted toast uses compiled Tailwind layout");
  const taskTrigger = node<HTMLButtonElement>(".task-card .task-menu-trigger");
  click(".task-card .task-menu-trigger");
  const taskMenu = node(".task-menu-popover");
  assert(taskMenu.parentElement === document.body && !taskMenu.closest('[draggable="true"]'), "task actions render outside draggable cards");
  for (const relatedTarget of [null, document.body, taskTrigger.closest("article")]) {
    flushSync(() => taskMenu.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget })));
    assert(taskMenu.isConnected, "menu survives pointer blur without relying on Safari button focus");
  }
  const drag = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
  flushSync(() => taskMenu.querySelector("button")!.dispatchEvent(drag));
  assert(drag.defaultPrevented && !document.querySelector(".task-card.dragging"), "menu actions cannot start a card drag");
  textButton("Edit task", taskMenu);
  assert(!!document.querySelector("#task-dialog"), "task menu Edit opens the editor after pointer blur");
  input("#task-title", "REACT_PRIVATE_EDIT");
  click("#save-task");
  await until(() => !document.querySelector("#task-dialog"), "edit saved");
  await until(() => !!getSnapshot().board?.tasks.some((t) => t.title === "REACT_PRIVATE_EDIT"), "edited title reaches the board");
  assert(getSnapshot().board?.tasks.some((t) => t.title === "REACT_PRIVATE_EDIT"), "task edit persists");
  click(".task-card .task-menu-trigger");
  key(node(".task-menu-popover button"), "Tab");
  assert(!document.querySelector(".task-menu-popover") && document.activeElement === taskTrigger, "Tab dismisses task actions and returns focus to their trigger");
  click(".task-card .task-menu-trigger");
  flushSync(() => node("#open-search").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  assert(!document.querySelector(".task-menu-popover"), "outside pointer closes the task menu");
  click(".task-card .task-menu-trigger");
  key(node(".task-menu-popover button"), "End");
  assert(document.activeElement?.textContent === "Delete task", "End focuses the last menu action");
  key(node(".task-menu-popover button"), "Escape");
  assert(!document.querySelector(".task-menu-popover") && document.activeElement === taskTrigger, "Escape closes the menu and restores focus");
  const menuTask = (title: string) => [...document.querySelectorAll<HTMLElement>(".task-card")].find(card => card.querySelector(".task-title")?.textContent === title)!;
  const action = async (title: string, label: string) => {
    await idle();
    flushSync(() => menuTask(title).querySelector<HTMLButtonElement>(".task-menu-trigger")!.click());
    const popup = node(".task-menu-popover");
    flushSync(() => popup.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })));
    textButton(label, popup);
  };
  // Everyday-speed features run against real encrypted mutations and the React UI.
  click('#focus-today');
  assert(document.querySelectorAll('.column').length === 1 && location.hash.includes('focus=today'), 'focus shows only Today and persists in URL');
  assert(node('.empty-state').textContent?.includes('No tasks for Today'), 'focus distinguishes a genuinely empty Today');
  click('#new-task');
  input('#task-title', 'QOL_FOCUS');
  input('#task-notes', 'Notes to copy');
  click('#save-task');
  await until(() => !document.querySelector('#task-dialog') && !getSnapshot().busy, 'focus editor save');
  await until(() => getSnapshot().board!.tasks.some(t => t.title === 'QOL_FOCUS'), 'focus task appears');
  const sourceId = getSnapshot().board!.tasks.find(t => t.title === 'QOL_FOCUS')!.id;
  await idle();
  await offlineRequest(`/api/tasks/${sourceId}`, 'PATCH', { category: 'work', tags: ['qol'], dueDate: '2099-01-01', reminderAt: '2099-01-01T09:00:00.000Z' });
  await refresh();
  await until(() => {
    const t = getSnapshot().board!.tasks.find(t => t.id === sourceId);
    return t && t.category === 'work' && t.tags.includes('qol');
  }, 'patched source appears');
  const source = getSnapshot().board!.tasks.find(t => t.id === sourceId)!;
  const focusedBoard = node('#board').getBoundingClientRect();
  const focusedColumn = node('.column.today').getBoundingClientRect();
  const focusToggle = node('#focus-today').getBoundingClientRect();
  assert(focusedColumn.width <= 641 && Math.abs((focusedColumn.left + focusedColumn.right) / 2 - (focusedBoard.left + focusedBoard.right) / 2) < 2 && focusToggle.right <= innerWidth, 'focused column is centered and toggle fits viewport');
  assert(source.status === 'today', 'New task defaults to Today in focus');
  await action('QOL_FOCUS', 'Duplicate task');
  assert(node<HTMLInputElement>('#task-title').value === source.title && node<HTMLTextAreaElement>('#task-notes').value === source.notes, 'duplicate prefills title and notes');
  textButton('Cancel', node('#task-dialog'));
  assert(getSnapshot().board!.tasks.filter(t => t.title === 'QOL_FOCUS').length === 1, 'cancel duplicate creates nothing');
  await action('QOL_FOCUS', 'Duplicate task');
  input('#task-title', 'QOL_COPY');
  click('#save-task');
  await until(() => !document.querySelector('#task-dialog') && !getSnapshot().busy, 'duplicate saved');
  await until(() => getSnapshot().board!.tasks.some(t => t.title === 'QOL_COPY'), 'duplicate appears');
  const copy = getSnapshot().board!.tasks.find(t => t.title === 'QOL_COPY')!;
  assert(copy.id !== source.id && copy.status === 'today' && copy.notes === source.notes && copy.category === source.category && copy.tags.join() === source.tags.join() && !copy.dueDate && !copy.reminderAt, 'duplicate creates a fresh unscheduled task');
  assert(getSnapshot().board!.tasks.find(t => t.id === source.id)?.title === 'QOL_FOCUS', 'duplicate preserves original');
  flushSync(() => menuTask('QOL_COPY').querySelector<HTMLButtonElement>('.complete-button')!.click());
  await until(() => !menuTask('QOL_COPY') && !getSnapshot().busy, 'completion leaves focus');
  assert(getSnapshot().board!.tasks.find(t => t.id === copy.id)?.status === 'done', 'completion leaves focus task in Done');
  flushSync(() => navigate({tag:'no-qol-match'}));
  assert(node('.empty-state').textContent?.includes('match your filters'), 'focus distinguishes filtered empty state');
  flushSync(() => navigate({tag:''}));
  click('#focus-today');
  assert(!document.querySelector('.column.done .quick-add-trigger'), 'Done has no quick add');
  flushSync(() => menuTask('QOL_COPY').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  textButton('Duplicate task', node('#task-context-menu'));
  input('#task-title', 'QOL_REOPEN');
  click('#save-task');
  await until(() => !document.querySelector('#task-dialog') && !getSnapshot().busy, 'Done copy saved');
  await until(() => getSnapshot().board!.tasks.some(t => t.title === 'QOL_REOPEN'), 'Done copy appears');
  assert(getSnapshot().board!.tasks.find(t => t.title === 'QOL_REOPEN')?.status === 'later', 'Done context-menu duplicate defaults to Later');
  flushSync(() => navigate({ category: 'work', tag: 'qol' }));
  click('.column.today .quick-add-trigger');
  const quick = '.quick-add[data-status="today"]';
  input(quick + ' input', '   ');
  submit(quick);
  await until(() => document.querySelector('#quick-add-error-today') && !getSnapshot().busy, 'quick add rejects whitespace');
  assert(node<HTMLInputElement>(quick + ' input').value === '   ', 'quick add retains invalid draft');
  input(quick + ' input', 'QOL_QUICK');
  submit(quick); submit(quick);
  await until(() => !getSnapshot().busy && getSnapshot().board!.tasks.some(t => t.title === 'QOL_QUICK'), 'quick add saved');
  await until(() => document.activeElement === node(quick + ' input'), 'quick add refocused');
  assert(getSnapshot().board!.tasks.filter(t => t.title === 'QOL_QUICK').length === 1 && node<HTMLInputElement>(quick + ' input').value === '', 'rapid quick submit creates once and clears input');
  const quickTask = getSnapshot().board!.tasks.find(t => t.title === 'QOL_QUICK')!;
  assert(quickTask.category === 'work' && quickTask.tags.includes('qol') && !!menuTask('QOL_QUICK'), 'quick add inherits filters');
  flushSync(() => navigate({ category: 'all', tag: '', query: '' }));
  input(quick + ' input', 'Discard this draft');
  key(node(quick + ' input'), 'Escape');
  assert(!document.querySelector(quick), 'Escape closes quick add');
  click('.column.today .quick-add-trigger');
  assert(node<HTMLInputElement>(quick + ' input').value === '', 'Escape discards quick draft');
  key(node(quick + ' input'), 'Escape');
  click('#focus-today');
  await idle();
  key(document.body, 'n');
  input('#task-title', 'QOL_SHORTCUT');
  click('#save-task');
  await until(() => !document.querySelector('#task-dialog') && !getSnapshot().busy, 'focus shortcut saved');
  await until(() => getSnapshot().board!.tasks.some(t => t.title === 'QOL_SHORTCUT'), 'shortcut task appears');
  assert(getSnapshot().board!.tasks.find(t => t.title === 'QOL_SHORTCUT')?.status === 'today', 'N defaults to Today while focused');
  click('[data-view="archive"]');
  assert(!getSnapshot().route.focus && !location.hash.includes('focus'), 'leaving Board clears focus');
  history.back();
  await until(() => getSnapshot().route.focus === 'today', 'Back restores focus');
  assert(document.querySelectorAll('.column').length === 1, 'history restores focused board');
  click('#focus-today');
  for (const title of ['QOL_FOCUS', 'QOL_COPY', 'QOL_REOPEN', 'QOL_QUICK', 'QOL_SHORTCUT']) {
    await action(title, 'Delete task');
    await until(() => !menuTask(title) && !getSnapshot().busy, 'clean QoL fixture');
  }
  click('.column[data-status="later"] .quick-add-trigger');
  for (const title of ["MENU_A", "MENU_B"]) {
    await until(() => {
      const el = document.querySelector<HTMLInputElement>('.column[data-status="later"] .quick-add input');
      return el && !el.disabled && !getSnapshot().busy;
    }, "quick add ready");
    input('.column[data-status="later"] .quick-add input', title);
    submit('.column[data-status="later"] .quick-add');
    await until(() => menuTask(title) && !getSnapshot().busy, "menu fixture created");
    await until(() => {
      const el = document.querySelector<HTMLInputElement>('.column[data-status="later"] .quick-add input');
      return el && !el.disabled && el.value === "" && !getSnapshot().busy;
    }, "quick add settled");
  }
  const laterTitles = () => getSnapshot().board!.tasks.filter(task => task.status === "later" && !task.archivedAt).map(task => task.title);
  await action("MENU_B", "Move up");
  try {
    await until(() => laterTitles().indexOf("MENU_B") < laterTitles().indexOf("MENU_A"), "menu move up");
  } catch {
    await idle();
    await action("MENU_B", "Move up");
    await until(() => laterTitles().indexOf("MENU_B") < laterTitles().indexOf("MENU_A"), "menu move up");
  }
  await action("MENU_B", "Move down");
  try {
    await until(() => laterTitles().indexOf("MENU_B") > laterTitles().indexOf("MENU_A"), "menu move down");
  } catch {
    await idle();
    await action("MENU_B", "Move down");
    await until(() => laterTitles().indexOf("MENU_B") > laterTitles().indexOf("MENU_A"), "menu move down");
  }
  assert(true, "both reorder menu actions work after pointer blur");
  await action("MENU_A", "Archive task");
  await until(() => getSnapshot().board!.tasks.some(task => task.title === "MENU_A" && task.archivedAt), "menu archive");
  assert(!menuTask("MENU_A"), "Archive menu action removes the task from the board");
  await until(() => document.querySelector("#toast-action"), "archive undo toast");
  click("#toast-action");
  await until(() => menuTask("MENU_A"), "archive undo");
  for (const title of ["MENU_A", "MENU_B"]) {
    await action(title, "Delete task");
    await until(() => !menuTask(title), "menu delete");
  }
  assert(true, "Delete menu action removes tasks after pointer blur");
  click("#open-search");
  input("#search", "PRIVATE_EDIT");
  assert(
    !location.hash.includes("PRIVATE_EDIT") &&
      !location.search.includes("PRIVATE_EDIT"),
    "search is absent from URL",
  );
  textButton("Close Search tasks");
  textButton("Filter by tag home");
  assert(getSnapshot().route.tag === "home", "card tag updates active filter");
  const wasCollapsed =
    localStorage.getItem("taskpath-sidebar-collapsed") === "true";
  click("#sidebar-toggle");
  assert(
    localStorage.getItem("taskpath-sidebar-collapsed") ===
      String(!wasCollapsed),
    "sidebar collapse persists in this browser",
  );
  click('[data-view="archive"]');
  await new Promise((r) => setTimeout(r, 40));
  history.back();
  await until(() => getSnapshot().route.view === "board", "Back");
  assert(
    getSnapshot().route.query === "" &&
      getSnapshot().route.tag === "home",
    "Back restores view and combined filters",
  );
  history.forward();
  await until(() => getSnapshot().route.view === "archive", "Forward");
  assert(
    node('[data-view="archive"]').getAttribute("aria-current") === "page",
    "Forward restores selected navigation tab",
  );
  click('[data-view="board"]');
  const before = getSnapshot().board!.tasks.length;
  click('.column[data-status="today"] .quick-add-trigger');
  input('[aria-label="Quick add task to Today"]', "Inherited tag task");
  submit('.quick-add[data-status="today"]');
  await until(
    () => getSnapshot().board!.tasks.length === before + 1,
    "quick add",
  );
  assert(
    getSnapshot()
      .board!.tasks.find((t) => t.title === "Inherited tag task")
      ?.tags.includes("home"),
    "quick add inherits tag",
  );
  flushSync(() => navigate({ query: "", tag: "" }, true));
  const card = () =>
    [...document.querySelectorAll<HTMLElement>(".task-card")].find((e) =>
      e.textContent?.includes("REACT_PRIVATE_EDIT"),
    )!;
  const taskId = card().dataset.id!;
  // Actual browser drag events drive the component handlers.
  flushSync(() => {
    const data = new DataTransfer();
    card().dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer: data }),
    );
    const target = node('.column[data-status="week"]');
    target.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      }),
    );
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      }),
    );
  });
  await until(
    () =>
      getSnapshot().board?.tasks.find((t) => t.id === taskId)?.status ===
      "week",
    "drag to week",
  );
  assert(true, "HTML drag handlers move task between columns");
  textButton("Complete REACT_PRIVATE_EDIT");
  await until(
    () =>
      getSnapshot().board?.tasks.find((t) => t.id === taskId)?.status ===
      "done",
    "complete",
  );
  menu("Archive all completed (1)");
  await until(
    () => !!getSnapshot().board?.tasks.find((t) => t.id === taskId)?.archivedAt,
    "archive",
  );
  click('[data-view="archive"]');
  assert(location.hash === "#archive", "Archive navigation writes fragment");
  assert(
    document.querySelectorAll(".archived-card").length === 1,
    "Archive contains completed task",
  );
  await until(() => document.querySelector("#toast-action"), "archive undo toast");
  click("#toast-action");
  await until(
    () => !getSnapshot().board?.tasks.find((t) => t.id === taskId)?.archivedAt,
    "archive undo",
  );
  assert(true, "archive Undo restores the task");
  click('[data-view="board"]');
  textButton("REACT_PRIVATE_EDIT");
  textButton("Delete task", node("#task-dialog"));
  await until(
    () => !getSnapshot().board?.tasks.find((t) => t.id === taskId),
    "delete",
  );
  await until(() => document.querySelector("#toast-action"), "delete undo toast");
  click("#toast-action");
  await until(
    () => getSnapshot().board?.tasks.some((t) => t.id === taskId),
    "delete undo",
  );
  assert(true, "delete Undo preserves content");
  // Calendar and statistics are derived views over the same decrypted board.
  localStorage.removeItem("taskpath-calendar-mode");
  click('[data-view="calendar"]');
  assert(String(location.hash) === "#calendar", "Calendar navigation writes fragment");
  await until(() => document.querySelector("#calendar-view"), "calendar view");
  const today = getSnapshot().board!.day;
  assert(node(".month-cell.is-today .month-day").getAttribute("aria-current") === "date", "calendar marks the workspace day");
  textButton("Add task", node(".calendar-agenda"));
  assert(node<HTMLDetailsElement>("#task-schedule").open, "adding from a calendar day opens the schedule");
  input("#task-title", "REACT_DATED_TASK");
  click("#save-task");
  await until(() => getSnapshot().board?.tasks.find((t) => t.title === "REACT_DATED_TASK"), "calendar task saves");
  const dated = getSnapshot().board!.tasks.find((t) => t.title === "REACT_DATED_TASK")!;
  assert(dated.dueDate === today && dated.status === "today", "calendar day pre-fills due date and column");
  await until(() => document.querySelector(".calendar-agenda .calendar-task"), "agenda lists task");
  assert(node(".month-cell.is-today .month-chips").textContent?.includes("REACT_DATED_TASK"), "month cell shows the task chip");
  textButton("Week", node("#calendar-view"));
  assert(document.querySelector(".week-day h3[aria-current=date]") && localStorage.getItem("taskpath-calendar-mode") === "week", "week layout includes today and is remembered");
  const weekTask = [...document.querySelectorAll<HTMLElement>(".week-day .calendar-task")].find((b) => b.textContent?.includes("REACT_DATED_TASK"));
  assert(weekTask, "week layout lists the dated task");
  flushSync(() => weekTask.click());
  assert(node<HTMLInputElement>("#task-title").value === "REACT_DATED_TASK", "calendar task opens the editor");
  textButton("Close Edit task");
  await until(() => !document.querySelector("#task-dialog"), "calendar editor closes");
  textButton("Next week", node("#calendar-view"));
  assert(!document.querySelector(".week-day h3[aria-current=date]"), "week navigation moves forward");
  textButton("Today", node("#calendar-view"));
  textButton("Month", node("#calendar-view"));
  click('[data-view="stats"]');
  assert(String(location.hash) === "#stats", "Stats navigation writes fragment");
  await until(() => document.querySelector("#stats-view"), "stats view");
  const tile = (label: string) => [...document.querySelectorAll(".stat-tile")].find((t) => t.querySelector(".stat-label")?.textContent === label)?.querySelector(".stat-value")?.textContent;
  const open = getSnapshot().board!.tasks.filter((t) => !t.archivedAt && t.status === "today").length;
  assert(tile("Today") === String(open), "stats snapshot counts Today tasks");
  assert(document.querySelectorAll("#stats-weeks-title, #stats-days-title").length === 2 && document.querySelectorAll(".chart-col").length === 26, "stats renders weekly and daily completion charts");
  assert(node(".chart-col").getAttribute("aria-label")?.includes("completed"), "chart columns have accessible values");
  click('[data-view="board"]');
  menu("Import Markdown…");
  input(
    "#markdown-text",
    '## Today\n- [ ] React imported\n  - Tags: ["imported"]',
  );
  click("#preview-markdown");
  await until(() => document.querySelector("#confirm-import"), "preview");
  assert(
    node("#import-preview").textContent?.includes("imported"),
    "Markdown preview renders tags",
  );
  click("#confirm-import");
  await until(() => !document.querySelector("#import-dialog"), "import");
  await until(() => getSnapshot().board?.tasks.some((t) => t.title === "React imported"), "Markdown import saves");
  assert(
    getSnapshot().board?.tasks.some((t) => t.title === "React imported"),
    "Markdown import saves encrypted tasks",
  );
  const downloads: string[] = [];
  const oldClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      downloads.push(this.download);
      return;
    }
    oldClick.call(this);
  };
  menu("Export Markdown");
  await until(
    () => downloads.some((n) => n.endsWith(".md")),
    "markdown export",
  );
  menu("Export JSON");
  await until(() => downloads.some((n) => n.endsWith(".json")), "json export");
  assert(true, "both readable export actions download files");
  click('[data-view="files"]');
  await until(() => document.querySelector("#files-view"), "files");
  const upload = node<HTMLInputElement>('#files-view input[type="file"]');
  const transfer = new DataTransfer();
  transfer.items.add(
    new File(["React encrypted file"], "react-private.txt", {
      type: "text/plain",
    }),
  );
  flushSync(() => {
    upload.files = transfer.files;
    upload.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => document.querySelector(".file-row"), "file upload");
  assert(
    node(".file-row").textContent?.includes("react-private.txt"),
    "React file upload renders encrypted file metadata",
  );
  click(".file-row .file-menu-trigger");
  textButton("Rename", node(".file-menu-popover"));
  input('[aria-label="Filename"]', "renamed-private.txt");
  textButton("Save", node("#file-action"));
  await until(() => !document.querySelector("#file-action") && node(".file-row").textContent?.includes("renamed-private.txt"), "file rename");
  assert(
    node(".file-row").textContent?.includes("renamed-private.txt"),
    "file rename updates metadata",
  );
  textButton("Download", node(".file-row"));
  await until(() => downloads.includes("renamed-private.txt"), "file download");
  assert(true, "file download uses decrypted filename");
  await syncAfterCurrent();
  await until(
    () => node(".file-row").textContent?.includes("Available offline"),
    "file synced",
  );
  click(".file-row .file-menu-trigger");
  textButton("Delete", node(".file-menu-popover"));
  assert(
    node("#file-action").textContent?.includes("cannot be undone"),
    "file deletion requires a permanent-delete confirmation",
  );
  textButton("Delete permanently", node("#file-action"));
  await until(() => !document.querySelector(".file-row"), "file removed");
  assert(true, "permanent deletion removes file from React list");
  const pixels = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lWQAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    ),
    images = new DataTransfer();
  images.items.add(new File([pixels], "pixel.png", { type: "image/png" }));
  flushSync(() => {
    upload.files = images.files;
    upload.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => document.querySelector(".file-row"), "image upload");
  textButton("Preview", node(".file-row"));
  await until(
    () => document.querySelector("#file-preview img"),
    "image preview",
  );
  await until(
    () => node<HTMLImageElement>("#file-preview img").naturalWidth > 0,
    "decoded image preview",
  );
  const imageUrl = node<HTMLImageElement>("#file-preview img").src;
  assert(imageUrl.startsWith("blob:"), "image preview uses a local Blob URL");
  textButton("Close pixel.png");
  await fetch(imageUrl).then(
    () => {
      throw new Error("Preview URL not revoked");
    },
    () => {},
  );
  assert(true, "closing preview revokes Blob URL");
  HTMLAnchorElement.prototype.click = oldClick;
  await syncAfterCurrent();
  offline = true;
  click('[data-view="board"]');
  click('.column[data-status="today"] .quick-add-trigger');
  input('[aria-label="Quick add task to Today"]', "React offline task");
  submit('.quick-add[data-status="today"]');
  await until(
    () =>
      getSnapshot().board?.tasks.some((t) => t.title === "React offline task"),
    "offline edit",
  );
  const pending = JSON.stringify((await localState()).pending);
  await syncAfterCurrent().catch(() => {});
  assert(
    JSON.stringify((await localState()).pending) === pending,
    "React offline edits preserve immutable retry ciphertext",
  );
  // Search runs entirely against the unlocked offline workspace.
  const searchIds: string[] = [];
  for (let i = 0; i < 55; i++) {
    const result = await offlineRequest('/api/tasks', 'POST', { title: `Search calendar ${String(i).padStart(2,'0')}`, notes: 'Secret meeting notes', tags: ['search-fixture'], category: 'work', status: 'later' });
    searchIds.push(result.task.id);
  }
  await offlineRequest(`/api/tasks/${searchIds[0]}/archive`, 'POST');
  await refresh();
  const lastSearchCard = node(`[data-id="${searchIds[54]}"]`);
  lastSearchCard.scrollIntoView({block:'center'});lastSearchCard.focus();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  assert(getComputedStyle(lastSearchCard).contentVisibility === 'visible' && lastSearchCard.getBoundingClientRect().height > 0, 'off-screen cards reveal fully when keyboard focused');
  key(lastSearchCard,'Enter');
  assert(node<HTMLInputElement>('#task-title').value === 'Search calendar 54', 'off-screen task opens with keyboard');
  textButton('Cancel',node('#task-dialog'));
  flushSync(() => navigate({category:'personal',tag:'missing',focus:'today'}));
  click('#open-search');
  input('#search', 'calnedar');
  assert(document.querySelectorAll('.task-search-result').length === 50 && node('.task-search-tools').textContent?.includes('55 results'), 'offline fuzzy search covers active and archived tasks independently of Board filters');
  assert(!!document.querySelector('.task-search-result mark'), 'search highlights matching text safely');
  await Promise.all(node('#task-search-dialog').getAnimations().map(animation => animation.finished.catch(() => {})));
  const searchRect = node('#task-search-dialog').getBoundingClientRect();
  assert(searchRect.left >= 0 && searchRect.right <= innerWidth + 1 && searchRect.top >= 0 && searchRect.bottom <= innerHeight + 1 && node('#task-search-dialog').scrollWidth <= searchRect.width, 'search dialog fits desktop/mobile viewport');
  if (innerWidth <= 760) assert(Math.abs(searchRect.width-innerWidth)<2 && Math.abs(searchRect.height-innerHeight)<2, 'mobile search fills viewport');
  const savedTheme = document.documentElement.dataset.theme;
  for (const theme of ['light','dark','high-contrast-light','high-contrast-dark']) {
    document.documentElement.dataset.theme = theme;
    const mark = getComputedStyle(node('.task-search-result mark'));
    assert(mark.color !== mark.backgroundColor && getComputedStyle(node('.task-search-result')).color !== getComputedStyle(node('.task-search-result')).backgroundColor, 'search text and highlights visible in '+theme);
  }
  if (savedTheme) document.documentElement.dataset.theme = savedTheme; else delete document.documentElement.dataset.theme;

  textButton('Show more');
  assert(document.querySelectorAll('.task-search-result').length === 55, 'Show more reveals remaining matches');
  const scrollArea = node('.task-search-scroll');
  scrollArea.scrollTop = 200;
  scrollArea.dispatchEvent(new Event('scroll', {bubbles:true}));
  const savedScroll = scrollArea.scrollTop;
  click('#search-result-' + searchIds[54]);
  await until(() => !!document.querySelector('#task-dialog'), 'search opens active editor');
  input('#task-notes', 'Live notes updated from search');
  click('#save-task');
  await until(() => !!document.querySelector('#task-search-dialog') && !getSnapshot().busy, 'save returns to search');
  assert(node<HTMLInputElement>('#search').value === 'calnedar' && node('.task-search-scroll').scrollTop === savedScroll && document.querySelectorAll('.task-search-result').length === 55, 'editor return preserves query, pagination, and scroll');
  textButton('Close Search tasks');
  click('#open-search');
  assert(node('.task-search-scroll').scrollTop === savedScroll, 'closing and reopening preserves search scroll');
  textButton('Filters');
  click('#search-filter-scope');
  flushSync(() => node('dialog.picker-surface').dispatchEvent(new Event('cancel',{cancelable:true})));
  assert(!!document.querySelector('#task-search-dialog') && !document.querySelector('dialog.picker-surface'), 'Escape dismisses only the top picker');
  click('#search-filter-scope');
  textButton('Archived', node('dialog.picker-surface'));
  assert(document.querySelectorAll('.task-search-result').length === 1 && node('.task-search-result').textContent?.includes('Archived'), 'archive scope and badge');
  key(node('#search'),'Enter',{isComposing:true});
  assert(!document.querySelector('#archive-details-dialog'), 'composition does not open search result');
  key(node('#search'),'ArrowDown'); key(node('#search'),'Enter');
  assert(!!document.querySelector('#archive-details-dialog'), 'keyboard opens archived details');
  textButton('Close Archived task');
  assert(node('#search-filter-scope').textContent === 'Archived', 'details return preserves filters');
  textButton('Remove filter Archived');
  assert(node('.task-search-tools').textContent?.includes('55 results'), 'filter chip removes its filter');
  textButton('Clear all');
  input('#search','Live notes updated');
  await until(() => document.querySelectorAll('.task-search-result').length === 1, 'edited note search');
  assert(node('.task-search-result').textContent?.includes('Live notes updated'), 'results include newly edited unsynced notes');
  input('#search','SEARCH_ONLY_PRIVATE_927');
  assert(node('.task-search-empty').textContent?.includes('No matching tasks'), 'search distinguishes no matches');
  assert(!location.href.includes('SEARCH_ONLY_PRIVATE_927') && !requests.join().includes('SEARCH_ONLY_PRIVATE_927') && !JSON.stringify(localStorage).includes('SEARCH_ONLY_PRIVATE_927') && !JSON.stringify(sessionStorage).includes('SEARCH_ONLY_PRIVATE_927') && !JSON.stringify(await localState()).includes('SEARCH_ONLY_PRIVATE_927'), 'search text never enters URLs, requests, or browser storage');
  textButton('Close Search tasks');
  history.replaceState(null,'','#archive?q=calendar&category=work&tag=search-fixture');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await until(() => !!document.querySelector('#search'), 'legacy link opens search');
  assert(node<HTMLInputElement>('#search').value === 'calendar' && node('#search-filter-scope').textContent === 'Archived' && !location.hash.includes('q='), 'legacy query consumed once with scope and filters and removed from URL');
  textButton('Clear all');
  input('#search','SEARCH_ONLY_PRIVATE_927');
  textButton('Close Search tasks');
  for (const id of searchIds) await offlineRequest(`/api/tasks/${id}`,'DELETE');
  await refresh();
  flushSync(() => navigate({view:'board',category:'all',tag:'',focus:undefined}));
  offline = false;
  await syncAfterCurrent();
  await refresh();
  assert(
    !(await localState()).pending.length,
    "React offline edits reconnect and acknowledge",
  );
  assert(
    !JSON.stringify(await localState()).includes("REACT_PRIVATE_EDIT") &&
      !requests.join().includes("REACT_PRIVATE_EDIT") &&
      !requests.join().includes(password),
    "React requests and workspace storage contain no test plaintext or password",
  );
  if (!document.querySelector('[aria-label="Quick add task to Today"]')) click('.column.today .quick-add-trigger');
  input('[aria-label="Quick add task to Today"]', "LOCK_QUICK_DRAFT");
  click("#new-task");
  input("#task-title", "LOCK_PRIVATE_DRAFT");
  flushSync(() => clearMemory());
  assert(
    !document.body.textContent?.includes("LOCK_PRIVATE_DRAFT") &&
      !document.querySelector("#main") &&
      !document.querySelector("dialog"),
    "lock immediately unmounts workspace, dialogs and drafts",
  );
  assert(
    await restoreRemembered(),
    "remembered device restores after memory-only close",
  );
  window.dispatchEvent(new Event("taskpath-unlocked"));
  await until(() => document.querySelector("#main"), "remembered UI");
  await until(() => getSnapshot().board, "board after remembered unlock");
  assert(!document.querySelector(".quick-add input"), "lock clears inline quick-add drafts");
  click("#open-search");
  await until(() => document.querySelector("#search"), "search opens after unlock");
  assert(node<HTMLInputElement>("#search").value === "" && !node(".task-search-tools").textContent?.includes("Clear all"), "lock clears query and filters");
  textButton("Close Search tasks");
  menu("Lock");
  await until(() => document.querySelector("#unlock-form"), "explicit lock");
  assert(!(await rememberedKey()), "explicit Lock removes remembered key");
  let release!: () => void;
  configGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  input("#unlock-password", "wrong password for React test");
  submit("#unlock-form");
  await until(
    () => node<HTMLButtonElement>("#unlock-submit").disabled,
    "login progress",
  );
  submit("#unlock-form");
  assert(
    node("#unlock-submit").getAttribute("aria-busy") === "true",
    "login disables repeat submissions and announces progress",
  );
  configGate = null;
  release();
  await until(
    () => !node<HTMLButtonElement>("#unlock-submit").disabled,
    "login failure",
  );
  assert(
    node("#unlock-error").textContent?.includes("incorrect") &&
      node<HTMLInputElement>("#unlock-password").value === "",
    "failed login clears password and recovers form",
  );
  input("#unlock-password", password);
  submit("#unlock-form");
  await until(() => document.querySelector("#main"), "login");
  assert(true, "same password signs in after locking");
  menu("Change password…");
  input('[name="current"]', password);
  input('[name="new"]', "Changed React password 2026");
  input('[name="confirm"]', "Changed React password 2026");
  submit("#password-dialog form");
  await until(
    () => !document.querySelector("#password-dialog"),
    "password changed",
  );
  assert(!document.querySelector(".quick-add input"), "lock clears inline quick-add drafts");
  menu("Lock");
  await until(() => document.querySelector("#unlock-password"), "relogin");
  input("#unlock-password", "Changed React password 2026");
  submit("#unlock-form");
  await until(() => document.querySelector("#main"), "changed password login");
  await until(() => !!getSnapshot().board?.tasks.some((t) => t.id === taskId), "restored board after password change");
  assert(
    getSnapshot().board?.tasks.some((t) => t.id === taskId),
    "password change retains encrypted tasks",
  );
  menu("Switch account");
  await until(
    () =>
      document.querySelector("#unlock-form") &&
      !node<HTMLInputElement>("#unlock-user").value,
    "switch account",
  );
  assert(
    !node<HTMLInputElement>("#unlock-user").value &&
      !document.body.textContent?.includes("REACT_PRIVATE_EDIT"),
    "account switching clears private UI and selected ID",
  );
  const accounts = (await (await originalFetch("/test-account")).json()) as {
    secondUserId: string;
  };
  input("#unlock-user", accounts.secondUserId);
  input("#unlock-password", "browser second password 2026");
  submit("#unlock-form");
  await until(() => getSnapshot().board !== null, "second account");
  assert(
    !getSnapshot().board!.tasks.some((task) => task.id === taskId),
    "second account opens its own workspace without first-account tasks",
  );
  click("#open-search");
  assert(node<HTMLInputElement>("#search").value === "", "account switch clears search state");
  textButton("Close Search tasks");
  const original = (await offlineRequest('/api/tasks', 'POST', {title: 'VERSION_ORIGINAL', notes: 'RECOVERABLE_NOTES', tags: ['recover']})).task;
  await offlineRequest(`/api/tasks/${original.id}`, 'PATCH', {title: 'VERSION_CURRENT', notes: 'Current notes'});
  await syncAfterCurrent(); await refresh();
  menu('Previous task versions…');
  await until(() => node('#history-dialog').textContent?.includes('VERSION_ORIGINAL'), 'version history decrypted while unlocked');
  const version = [...node('#history-dialog').querySelectorAll('details')].find(e => e.textContent?.includes('VERSION_ORIGINAL'))!;
  click('#history-dialog details summary');
  textButton('Restore as new task', version);
  await until(() => !document.querySelector('#history-dialog'), 'version restoration');
  await until(() => getSnapshot().board!.tasks.some(t => t.id === original.id && t.title === 'VERSION_CURRENT'), 'restoration preserves current task');
  assert(getSnapshot().board!.tasks.some(t => t.id === original.id && t.title === 'VERSION_CURRENT'), 'restoration preserves current task');
  await until(() => getSnapshot().board!.tasks.some(t => t.id !== original.id && t.title === 'VERSION_ORIGINAL'), 'restored version appears');
  assert(getSnapshot().board!.tasks.some(t => t.id !== original.id && t.title === 'VERSION_ORIGINAL' && t.notes === 'RECOVERABLE_NOTES' && t.tags.includes('recover') && !t.reminderAt), 'previous version becomes a separate unscheduled task');
  const rolloverTask = (await offlineRequest('/api/tasks', 'POST', {title: 'ROLLOVER_REVIEW', status: 'today'})).task;
  const { withFileKey } = await import('../public/offline.js');
  const { encryptChange, decryptEnvelope } = await import('../public/crypto.js');
  await syncAfterCurrent();
  await withFileKey(async (key, _account, vaultId) => {
    const record = await localState();
    const envelope = record.board!.rows.find(e => e.taskId === rolloverTask.id)!;
    const task = await decryptEnvelope(key, vaultId, envelope);
    const replacement = await encryptChange(key, vaultId, {task: {...task, plannedDay: '2000-01-01'}, editedAt: envelope.editedAt, changeId: envelope.changeId});
    await localState(current => {current.board!.rows = current.board!.rows.map(e => e.taskId === replacement.taskId ? replacement : e);});
  });
  await refresh();
  assert(!!document.querySelector('.rollover-notice'), 'rollover shows a planning review');
  textButton('Review and replan');
  assert(node('#rollover-dialog').textContent?.includes('ROLLOVER_REVIEW'), 'review lists tasks that moved back');
  textButton('Plan for Today', node('#rollover-dialog'));
  await until(() => getSnapshot().board!.tasks.find(t => t.id === rolloverTask.id)?.status === 'today' && !getSnapshot().busy, 'replan rollover');
  assert(!getSnapshot().board!.rollover?.some(t => t.id === rolloverTask.id), 'fresh plan clears rollover marker');
  textButton('Finish review', node('#rollover-dialog'));
  menu('Automatic locking…');
  assert(node<HTMLSelectElement>('#auto-lock-interval').value === '0', 'automatic locking defaults to disabled');
  flushSync(() => { const select = node<HTMLSelectElement>('#auto-lock-interval'); select.value = '5'; select.dispatchEvent(new Event('change', {bubbles:true})); });
  textButton('Save locking preference');
  assert(localStorage.getItem('taskpath-auto-lock-minutes') === '5', 'lock interval is saved on this browser');
  const {setLockMinutes} = await import('../public/auto-lock.js');
  setLockMinutes(0);
  cleanup();
  flushSync(() => root.unmount());
  output.textContent += "\nALL " + results.length + " REACT CHECKS PASSED";
} catch (error) {
  output.textContent +=
    "\nFAIL " + (error instanceof Error ? error.stack : String(error));
}
