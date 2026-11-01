# Optional task time tracking

Time tracking is opt-in through its own Time tracking sidebar view. Show task timers and start, pause, and resume controls together; do not require opening a task menu or dialog. Tasks without tracking data keep their current behavior. Starting or resuming stores a start timestamp; pausing adds the elapsed interval to a saved duration. Breaks do not count. Repeated start or pause requests must not reset or double-count time.

Show only tasks explicitly added to tracking. The Add task to track picker offers open, non-archived tasks not yet added, within the current category and tag filters. Adding a task saves zero elapsed time with no running timer; starting remains a separate action. Repeated adds must preserve existing time and running state. Previously timed tasks remain selected. Completed and archived tracked tasks retain their totals but must be reopened or restored before tracking can resume. The view respects category and tag filters and provides task search. Put running timers first. On phones, expose the view as a compact Time tab in the bottom navigation, keep all six tabs visible with usable touch targets, and stack the picker and timer controls within narrow screens without horizontal page scroll.

Timers continue across reloads, offline use, and closed tabs until paused. Closing or locking the app does not stop a timer. Completing, archiving, or deleting a task pauses it; reopening or restoring does not resume it. Multiple tasks may run at once. Duplication creates an untracked task.

Open tracked tasks have a Complete button beside the timer controls. Completion uses the normal task mutation so it works offline, stops a running timer, and preserves elapsed time in the list and Stats. Completed or archived tasks do not show this button. Keep the controls usable on narrow mobile screens.

Open tasks not yet selected also offer Add to time tracking in the right-click menu and the task's More options menu for touch use. This uses the same add operation as the picker, keeps the user on the board, confirms success, and leaves the timer stopped. Hide the action for tasks already selected, completed, or archived.

If an older client completes or archives a task while preserving an unknown running timer field, normalize that timer as paused at the task's edit timestamp when reading it.

Store the accumulated milliseconds and optional active start timestamp inside the encrypted task, using the existing whole-task conflict rules. Do not send timing metadata to the server in plaintext. Simultaneous edits on different devices are not additive: the latest task edit wins, as with other task fields. Derive live elapsed time for display without writing every second. Use the workspace's server-time offset and clamp negative elapsed intervals if the clock moves backward.

Stats respect the current category and tag filters. Include archived tasks and exclude deleted tasks. Show all-time tracked duration, the number of tracked tasks and running timers, average duration per tracked task, and a per-task breakdown. Include running intervals. These durations measure explicitly tracked work, separately from creation-to-completion lead time. Do not imply daily or weekly attribution from an accumulated total.

Key sources: `public/time-tracking.ts`, `public/offline-model.ts`, `public/ui/time-tracking.tsx`, and `public/stats.ts`.
