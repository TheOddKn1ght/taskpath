import type { Route } from '../types.js';
import { Icon } from './icons';
import { navigate } from './store';
export function WorkspaceNav({collapsed,view,toggleCollapsed}:{collapsed:boolean;view:Route['view'];toggleCollapsed:()=>void}) {
  return (
    <aside id="sidebar">
      <button
        id="sidebar-toggle"
        className="icon-button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={toggleCollapsed}
      >
        <Icon name="sidebar" />
      </button>
      <nav aria-label="Workspace">
        {(["board", "archive", "files"] as const).map((target) => (
          <button
            key={target}
            data-view={target}
            aria-label={target[0].toUpperCase() + target.slice(1)}
            aria-current={view === target ? "page" : undefined}
            onClick={() => {
              navigate({ view:target });
              if (
                view !== target &&
                matchMedia("(max-width:760px)").matches
              )
                window.scrollTo({ top: 0, behavior: "instant" });
            }}
          >
            <Icon name={target} />
            <span className="nav-label">
              {target[0].toUpperCase() + target.slice(1)}
            </span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
