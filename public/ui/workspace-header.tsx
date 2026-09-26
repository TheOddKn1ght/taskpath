import type { Route } from '../types.d.ts';
import { Icon } from './icons.tsx';
import { ThemeIcon } from './theme.tsx';
import { Select } from './pickers.tsx';
import { navigate } from './store.ts';
import { WorkspaceMenu, type WorkspaceOption } from './workspace-menu.tsx';
export function WorkspaceHeader({route,tags,greeting,week,theme,createTask,options}:{
  route:Route;tags:string[];greeting:string;week:string;theme:()=>void;createTask:()=>void;options:WorkspaceOption[];
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
        <label className="search">
          <Icon name="search" />
          <input
            id="search"
            type="search"
            aria-label="Search tasks"
            placeholder="Search"
            value={route.query}
            onChange={(e) => navigate({ query: e.target.value }, true)}
          />
        </label>
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
