# Tag management

The workspace offers a Manage tags dialog for creating reusable names, renaming or merging names, and deleting names. Names follow the existing task rules: trimmed, lowercase NFC, no control characters, and 1–32 Unicode characters. The ten-tag limit applies per task, not to the workspace catalog.

Reusable names are stored in an optional `savedTags` field on the encrypted profile. Available tags combine that catalog with names on undeleted tasks, including archived tasks. Removing the last assignment does not remove an explicitly saved name. Profile edits preserve the catalog and nickname. Older profiles default to an empty catalog; older clients that rewrite the profile may discard unused saved names.

Rename updates all undeleted tasks, including archived tasks; renaming to an existing name merges assignments without duplicates. Delete requires confirmation and removes the assignment from the same tasks without deleting tasks. Deleted tasks and previous versions retain their historical names; restoring them can reintroduce a name. Usage counts include active and archived tasks and ignore current filters.

Catalog and task edits commit together to local encrypted storage and can be made offline after the initial download completes. Bulk operations require that download to finish so unseen tasks are not silently omitted. Existing per-record synchronization conflict rules still apply: concurrent edits on another device may restore an older assignment. Tags introduce no server-visible plaintext metadata.
