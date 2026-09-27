import type { Route } from '../types.js';
import { Icon } from './icons';
import { ThemeIcon } from './theme';
import { Select } from './pickers';
import { navigate } from './store';
import { WorkspaceMenu, type WorkspaceOption } from './workspace-menu';
export function WorkspaceHeader({route,tags,greeting,week,theme,createTask,options,openSearch}:{
  openSearch:()=>void;route:Route;tags:string[];greeting:string;week:string;theme:()=>void;createTask:()=>void;options:WorkspaceOption[];
}) { return (
    <header className="app-header">
      <div className="app-heading">
        <h1>
          taskpath<span>.</span>
        </h1>
        <span id="greeting" className="week-label text-[12px] text-muted whitespace-nowrap">
          {greeting}
        </span>
        <span id="week-label" className="week-label text-[12px] text-muted whitespace-nowrap">
          {week}
        </span>
      </div>
      <div className="toolbar">
        <button id="open-search" type="button" className="search" aria-label="Search all tasks" onClick={openSearch} hidden={route.view === "files"}>
          <Icon name="search" /><span>Search tasks…</span><kbd>/</kbd>
        </button>
        <div className="task-filters">
        <Select
          id="category-filter"
          label="Filter tasks by category"
          value={route.category}
          options={[
            { value: "all", label: "All tasks" },
            { value: "work", label: "Work" },
            { value: "personal", label: "Personal" },
          ]}
          onChange={(v) =>
            navigate({ category: v as typeof route.category }, true)
          }
        />
        <Select
          id="tag-filter"
          label="Filter tasks by tag"
          value={route.tag}
          search
          options={[
            { value: "", label: "All tags" },
            ...tags.map((value) => ({ value, label: value })),
          ]}
          onChange={(tag) => navigate({ tag }, true)}
        />
        {route.view === "board" && (
          <button
            id="focus-today"
            className="secondary-button"
            aria-label="Focus Today"
            title="Focus Today"
            aria-pressed={route.focus === "today"}
            onClick={() => navigate({ focus: route.focus === "today" ? undefined : "today" })}
          >
            <Icon name="focus" />
            <span>Focus Today</span>
          </button>
        )}
        </div>
        <button
          id="new-task"
          className="primary-button"
          aria-label="New task"
          hidden={route.view === "archive"}
          onClick={createTask}
        >
          <Icon name="plus" />
          New task
        </button>
        <button
          id="theme-toggle"
          className="icon-button theme-toggle"
          aria-label="Choose theme"
          onClick={theme}
        >
          <ThemeIcon />
        </button>
        <WorkspaceMenu options={options} />
      </div>
    </header>
  );
}
