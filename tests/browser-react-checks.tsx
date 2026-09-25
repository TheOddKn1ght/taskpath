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
  flushSync(()=>node("#search").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true})));
  assert(!document.querySelector(".app-menu-popover"),"workspace outside pointer dismisses the menu");
  key(document.body, "/");
  assert(document.activeElement === node("#search"), "slash focuses search");
  key(node("#search"), "n");
  assert(!document.querySelector("#task-dialog"), "new-task shortcut does not interrupt typing");
  key(document.body, "n", { ctrlKey: true });
  key(document.body, "n", { metaKey: true });
  key(document.body, "n", { isComposing: true });
  assert(!document.querySelector("#task-dialog"), "shortcuts preserve browser modifiers and composition");
  key(document.body, "N");
  assert(!!document.querySelector("#task-dialog"), "N opens a new task");
  key(node("#task-title"), "/");
  assert(document.activeElement === node("#task-title"), "slash does not steal editor focus");
  textButton("Cancel", node("#task-dialog"));
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
  submit("#task-form");
  await until(() => !document.querySelector("#task-dialog"), "task saved");
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
  flushSync(() => node("#search").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  assert(!document.querySelector(".task-menu-popover"), "outside pointer closes the task menu");
  click(".task-card .task-menu-trigger");
  key(node(".task-menu-popover button"), "End");
  assert(document.activeElement?.textContent === "Delete task", "End focuses the last menu action");
  key(node(".task-menu-popover button"), "Escape");
  assert(!document.querySelector(".task-menu-popover") && document.activeElement === taskTrigger, "Escape closes the menu and restores focus");
  const menuTask = (title: string) => [...document.querySelectorAll<HTMLElement>(".task-card")].find(card => card.querySelector(".task-title")?.textContent === title)!;
  const action = (title: string, label: string) => {
    flushSync(() => menuTask(title).querySelector<HTMLButtonElement>(".task-menu-trigger")!.click());
    const popup = node(".task-menu-popover");
    flushSync(() => popup.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })));
    textButton(label, popup);
  };
  for (const title of ["MENU_A", "MENU_B"]) {
    input('.column[data-status="later"] .quick-add input', title);
    submit('.column[data-status="later"] .quick-add');
    await until(() => menuTask(title), "menu fixture created");
  }
  const laterTitles = () => getSnapshot().board!.tasks.filter(task => task.status === "later" && !task.archivedAt).map(task => task.title);
  action("MENU_B", "Move up");
  await until(() => laterTitles().indexOf("MENU_B") < laterTitles().indexOf("MENU_A"), "menu move up");
  action("MENU_B", "Move down");
  await until(() => laterTitles().indexOf("MENU_B") > laterTitles().indexOf("MENU_A"), "menu move down");
  assert(true, "both reorder menu actions work after pointer blur");
  action("MENU_A", "Archive task");
  await until(() => getSnapshot().board!.tasks.some(task => task.title === "MENU_A" && task.archivedAt), "menu archive");
  assert(!menuTask("MENU_A"), "Archive menu action removes the task from the board");
  click("#toast-action");
  await until(() => menuTask("MENU_A"), "archive undo");
  for (const title of ["MENU_A", "MENU_B"]) {
    action(title, "Delete task");
    await until(() => !menuTask(title), "menu delete");
  }
  assert(true, "Delete menu action removes tasks after pointer blur");
  input("#search", "PRIVATE_EDIT");
  assert(
    location.hash.includes("q=PRIVATE_EDIT") &&
      !location.search.includes("PRIVATE_EDIT"),
    "search is stored only in fragment",
  );
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
    getSnapshot().route.query === "PRIVATE_EDIT" &&
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
  click("#toast-action");
  await until(
    () => getSnapshot().board?.tasks.some((t) => t.id === taskId),
    "delete undo",
  );
  assert(true, "delete Undo preserves content");
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
  textButton("Rename", node(".file-row"));
  input('[aria-label="Filename"]', "renamed-private.txt");
  textButton("Save", node("#file-action"));
  await until(() => !document.querySelector("#file-action"), "file rename");
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
  textButton("Delete", node(".file-row"));
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
  cleanup();
  flushSync(() => root.unmount());
  output.textContent += "\nALL " + results.length + " REACT CHECKS PASSED";
} catch (error) {
  output.textContent +=
    "\nFAIL " + (error instanceof Error ? error.stack : String(error));
}
