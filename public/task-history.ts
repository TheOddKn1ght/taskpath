import type { Envelope } from './types.js';
// Ciphertext only; bounded by count and bytes. Never sent to the server.
export function retainVersions(existing: Envelope[] = [], additions: Envelope[] = []) {
  const unique = new Map<string, Envelope>();
  for (const version of [...existing, ...additions]) {
    if (version.taskId !== '_profile') unique.set(version.changeId, version);
  }
  const perTask = new Map<string, number>();
  let bytes = 0;
  return [...unique.values()].sort((a, b) => b.editedAt.localeCompare(a.editedAt) || b.changeId.localeCompare(a.changeId)).filter(version => {
    const count = perTask.get(version.taskId) || 0;
    const size = version.ciphertext.length;
    if (count >= 5 || bytes + size > 2_000_000) return false;
    perTask.set(version.taskId, count + 1); bytes += size;
    return true;
  }).slice(0, 200);
}
