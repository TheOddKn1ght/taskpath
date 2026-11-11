# Workspace presentation

The workspace should stay quiet and readable across the existing themes. Use theme tokens for surfaces, borders, shadows, and interaction states; avoid new fixed colors or external font dependencies.

On desktop, separate identity and date information from the task toolbar so controls have a predictable row. Allow the toolbar to wrap on narrower screens. Keep the existing phone header, bottom navigation, floating task button, safe-area spacing, and touch targets.

The desktop sidebar divider spans the full page height, including the space below a short board and the bottom padding of long content. Keep that padding inside the content column so it cannot leave a gap beneath the divider. This also applies when the sidebar is collapsed.

Show synchronization status in the workspace header, beside the heading on desktop and on its own row below the heading on phones. Keep the full status text and its live announcement, including offline and pending local changes. Put the sign-in-to-sync action beside that status when authentication is required.

Board columns group tasks with restrained borders and rounded surfaces. Today keeps its existing accent treatment. Counts should read as small badges, task titles should lead their metadata, and the full-width Add task control should remain easy to discover even in an empty column. Keep archived card layout independent from board card refinements.

Keyboard focus must remain visible on search and other controls. Hover effects must not move cards or change their hit targets. Preserve reduced-motion preferences and keep task actions available on touch devices.

These are presentation changes only; task ordering, editing, navigation, and offline persistence retain their existing behavior.

The disposable QA workspace should exercise populated columns and secondary views: mixed categories and tags, short and long notes, overdue and future dates relative to launch time, reminder-only tasks, running and paused timers, completion history, archived tasks, and previewable files. Keep fixture data encrypted through the normal storage formats and confined to the QA launcher.
