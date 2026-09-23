export function PrivacyCopy() {
  return (
    <div className="privacy-copy">
      <p>
        Taskpath is a private, invite-only task manager and file vault. This
        notice describes the app; the person operating this instance controls
        its hosting, logs and backups.
      </p>
      <h3>What stays encrypted</h3>
      <p>
        Your browser encrypts task contents, tags, dates, nickname, file
        contents, filenames, file types and original modification dates before
        sending them to the server. Your vault password unlocks this data. The
        server stores ciphertext and wrapped keys, with no administrator
        decryption key.
      </p>
      <h3>What the operator can see</h3>
      <p>
        The server handles user IDs, invitations, authentication verifiers,
        sessions, opaque record IDs, file sizes, storage usage, sync timestamps
        and deletion markers. The hosting server or reverse proxy may log IP
        addresses, request paths, browser information and access times.
        Encryption does not hide this metadata or traffic patterns.
      </p>
      <h3>Signing in and this browser</h3>
      <p>
        The browser sends a password-derived login credential over HTTPS, not
        your vault password. The server stores a hash of that credential and
        uses an essential session cookie for sign-in. That cookie does not
        contain your password or decryption key.
      </p>
      <p>
        Taskpath keeps encrypted tasks, files and pending changes in browser
        storage for offline use, and caches app assets. Appearance preferences
        are stored locally. With <strong>Remember this device</strong> enabled,
        a decryption key is also saved in this browser profile; anyone using it
        may be able to open your workspace.
      </p>
      <p>
        <strong>Lock</strong> removes decrypted content and remembered keys from
        this browser's Taskpath tabs, while keeping encrypted offline data and
        pending changes. Browser storage can be evicted. Downloaded files and
        readable exports are outside Taskpath's control.
      </p>
      <h3>Optional notifications</h3>
      <p>
        Background reminders share scheduled reminder times, random identifiers
        and this device's push subscription with the server. Delivery uses your
        browser's push provider. Background notification text is generic and
        contains no task title or notes. Disable background reminders in
        workspace options when you no longer want them.
      </p>
      <h3>Deletion, backups and recovery</h3>
      <p>
        Data remains on the server and your devices until removed. Deleted tasks
        may remain as encrypted sync records. Permanently deleting a file
        removes its live server copy after sync; deletion markers, backups and
        copies on devices that have not synced may remain. The operator controls
        backup and log retention. Old plaintext backups from earlier versions
        remain plaintext.
      </p>
      <p>
        There is no password reset or recovery key. If you forget your password,
        an already unlocked or remembered device may still let you export data;
        otherwise it cannot be recovered by the server. Changing a password
        cannot revoke decryption keys someone has already copied.
      </p>
      <h3>Limits of encryption</h3>
      <p>
        An administrator cannot read your tasks or files from the database
        alone. Someone controlling the server could, however, serve malicious
        JavaScript that captures an entered password or unlocked data. A
        compromised device or browser extension can also expose it. Only use an
        instance and devices you trust.
      </p>
      <h3>Tracking and questions</h3>
      <p>
        Taskpath itself includes no advertising or analytics trackers. Hosting
        infrastructure and optional push providers have their own data
        practices. Contact the person who invited you or operates this instance
        for questions about hosting, logs, retention or account deletion.
      </p>
    </div>
  );
}
export function GuideCopy() {
  return (
    <div className="guide-copy">
      <p>
        Collect tasks in <strong>Later</strong>. Each week, drag a few into{" "}
        <strong>This Week</strong>. Each morning, move your priorities into{" "}
        <strong>Today</strong>.
      </p>
      <p>
        Check off a task to send it to <strong>Done</strong>. Drag within a
        column to reorder, or use the task’s move control.
      </p>
      <p>
        At midnight, unfinished Today tasks return to This Week. On Monday,
        unfinished weekly tasks return to Later. Done stays done.
      </p>
      <p>
        Keyboard: <kbd>N</kbd> creates a task, <kbd>/</kbd> focuses search,
        and <kbd>Enter</kbd> opens a focused task. <kbd>Escape</kbd> closes
        the current dialog or menu. Shortcuts stay inactive while typing.
      </p>
    </div>
  );
}
