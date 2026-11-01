export type RouteMatch<Name extends string> = {
  name: Name;
  params: Record<string, string>;
};

// Runtime-neutral: pages, workers, and the server share path matching, not handlers or auth.
export function createRouter<const Routes extends Record<string, string>>(routes: Routes) {
  type Name = Extract<keyof Routes, string>;
  const exact = new Map<string, Name>();
  const dynamic: { name: Name; segments: string[] }[] = [];
  for (const name of Object.keys(routes) as Name[]) {
    const pattern = routes[name]!;
    const segments = pattern.split('/');
    if (!pattern.startsWith('/')) throw new Error('Route paths must start with /.');
    const parameters = new Set<string>();
    for (const [index, segment] of segments.entries()) {
      if (!segment.startsWith(':') && !segment.startsWith('*')) continue;
      const key = segment.slice(1);
      if (!key || parameters.has(key) || (segment.startsWith('*') && index !== segments.length - 1))
        throw new Error('Invalid route parameter.');
      parameters.add(key);
    }
    if (parameters.size) dynamic.push({ name, segments });
    else {
      if (exact.has(pattern)) throw new Error('Duplicate route path.');
      exact.set(pattern, name);
    }
  }
  return {
    match(path: string): RouteMatch<Name> | null {
      const name = exact.get(path);
      if (name !== undefined) return { name, params: {} };
      if (!path.startsWith('/') || path.includes('?') || path.includes('#')) return null;
      const parts = path.split('/');
      for (const route of dynamic) {
        const params: Record<string, string> = {};
        let matched = true;
        for (let i = 0; i < route.segments.length; i++) {
          const segment = route.segments[i]!;
          if (segment.startsWith('*')) {
            if (parts.length < route.segments.length) {
              matched = false;
              break;
            }
            params[segment.slice(1)] = parts.slice(i).join('/');
            break;
          }
          if (parts[i] === undefined || (segment.startsWith(':') && !parts[i])) {
            matched = false;
            break;
          }
          if (segment.startsWith(':')) params[segment.slice(1)] = parts[i]!;
          else if (segment !== parts[i]) {
            matched = false;
            break;
          }
          if (i === route.segments.length - 1 && parts.length !== route.segments.length)
            matched = false;
        }
        if (matched) return { name: route.name, params };
      }
      return null;
    },
  };
}

export const workspaceViews = {
  board: 'Board',
  calendar: 'Calendar',
  time: 'Time tracking',
  stats: 'Stats',
  archive: 'Archive',
  files: 'Files',
} as const;
export type WorkspaceView = keyof typeof workspaceViews;

export function parseWorkspaceHash(hash: string) {
  if (!hash.startsWith('#')) return null;
  const at = hash.indexOf('?');
  const name = hash.slice(1, at < 0 ? undefined : at);
  if (!Object.hasOwn(workspaceViews, name)) return null;
  return {
    view: name as keyof typeof workspaceViews,
    params: new URLSearchParams(at < 0 ? '' : hash.slice(at + 1)),
  };
}

export const offlineRoutes = createRouter({
  board: '/api/board',
  export: '/api/export',
  importPreview: '/api/import/preview',
  importMarkdown: '/api/import/markdown',
  claimReminders: '/api/reminders/claim',
  profile: '/api/profile',
  archiveCompleted: '/api/tasks/archive-completed',
  archiveUndo: '/api/tasks/archive-undo',
  tasks: '/api/tasks',
  task: '/api/tasks/:taskId',
  restore: '/api/tasks/:taskId/restore',
  reminder: '/api/tasks/:taskId/reminder',
  archive: '/api/tasks/:taskId/archive',
  unarchive: '/api/tasks/:taskId/unarchive',
  timer: '/api/tasks/:taskId/timer',
});
