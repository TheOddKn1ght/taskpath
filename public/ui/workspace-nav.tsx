import { workspaceViews as views } from '../router.js';
import type { Route } from '../types.js';
import { Icon } from './icons';
import { navigate } from './store';
export function WorkspaceNav({
  collapsed,
  view,
  toggleCollapsed,
}: {
  collapsed: boolean;
  view: Route['view'];
  toggleCollapsed: () => void;
}) {
  return (
    <aside id="sidebar">
      <button
        id="sidebar-toggle"
        className="icon-button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={toggleCollapsed}
      >
        <Icon name="sidebar" />
      </button>
      <nav aria-label="Workspace">
        {(Object.keys(views) as (keyof typeof views)[]).map((target) => (
          <button
            key={target}
            data-view={target}
            aria-label={views[target]}
            aria-current={view === target ? 'page' : undefined}
            onClick={() => {
              navigate({ view: target });
              if (view !== target && matchMedia('(max-width:760px)').matches)
                window.scrollTo({ top: 0, behavior: 'instant' });
            }}
          >
            <Icon name={target === 'time' ? 'clock' : target} />
            <span className="nav-label">
              {target === 'time' ? (
                <>
                  <span className="time-label-desktop">Time tracking</span>
                  <span className="time-label-mobile">Time</span>
                </>
              ) : (
                views[target]
              )}
            </span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
