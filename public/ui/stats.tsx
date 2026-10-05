import { useMemo, type ReactNode } from "react";
import type { Board, Route } from "../types.js";
import { computeStats, LEAD_WINDOW_DAYS } from "../stats.js";
import { shiftDate } from "../picker-model.js";
import { Icon } from "./icons";
const format = (day: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
const number = (n: number) => n.toLocaleString();
function duration(days: number) {
  if (days < 1) {
    const hours = Math.round(days * 24);
    return hours < 1 ? "< 1 h" : `${hours} h`;
  }
  const rounded = days < 10 ? Math.round(days * 10) / 10 : Math.round(days);
  return `${rounded.toLocaleString()} ${rounded === 1 ? "day" : "days"}`;
}
function Tile({ label, value, note, warning = false }: { label: string; value: ReactNode; note?: string; warning?: boolean }) {
  return (
    <div className={`stat-tile${warning ? " is-warning" : ""}`}>
      <span className="stat-label">{warning && <Icon name="info" />}{label}</span>
      <strong className="stat-value">{value}</strong>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}
interface Point { key: string; label: string; full: string; count: number }
// Single-series columns: one accent hue, selective labels, per-bar tooltip and a table fallback.
function ColumnChart({ id, title, points, unit }: { id: string; title: string; points: Point[]; unit: string }) {
  const max = Math.max(1, ...points.map((p) => p.count)), peak = points.findIndex((p) => p.count === max);
  const step = Math.ceil(points.length / 4);
  return (
    <figure className="stat-chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`}>{title}</figcaption>
      <div className="chart-plot" style={{ gridTemplateColumns: `repeat(${points.length},minmax(0,1fr))` }}>
        {points.map((p, i) => {
          const labelled = p.count > 0 && (i === peak || i === points.length - 1);
          return (
            <div
              key={p.key}
              className={`chart-col${i === points.length - 1 ? " is-current" : ""}`}
              tabIndex={0}
              aria-label={`${p.full}: ${p.count} ${unit}`}
            >
              <span className="chart-track">
                {labelled && <span className="chart-value" style={{ bottom: `${(p.count / max) * 100}%` }}>{p.count}</span>}
                <span className="chart-bar" style={{ height: p.count ? `${(p.count / max) * 100}%` : 0 }} />
              </span>
              <span className="chart-tip" aria-hidden="true"><strong>{p.count}</strong> {unit}<br />{p.full}</span>
              <span className="chart-label" aria-hidden="true">{(points.length - 1 - i) % step === 0 ? p.label : ""}</span>
            </div>
          );
        })}
      </div>
      <details className="chart-table">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th scope="col">Period</th><th scope="col">Completed</th></tr></thead>
          <tbody>{points.map((p) => <tr key={p.key}><td>{p.full}</td><td>{p.count}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
// Meter rows: bar length is the total, the filled part is the completed share.
function Breakdown({ id, title, rows, empty }: { id: string; title: string; rows: { key: string; label: string; open: number; done: number }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.open + r.done));
  return (
    <figure className="stat-breakdown" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`}>{title}</figcaption>
      {rows.length ? (
        <ul>
          {rows.map((r) => {
            const total = r.open + r.done;
            return (
              <li key={r.key}>
                <span className="breakdown-label">{r.label}</span>
                <span className="breakdown-meter" aria-hidden="true">
                  <span className="breakdown-track" style={{ width: `${(total / max) * 100}%` }}>
                    {r.done > 0 && <span className={r.open ? "breakdown-done has-gap" : "breakdown-done"} style={{ width: `${(r.done / total) * 100}%` }} />}
                  </span>
                </span>
                <span className="breakdown-values">{r.done} done · {r.open} open</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="stats-empty">{empty}</p>
      )}
    </figure>
  );
}
export function StatsView({ board, route }: { board: Board; route: Route }) {
  const stats = useMemo(() => computeStats(
    board.tasks.filter((t) => (route.category === "all" || t.category === route.category) && (!route.tag || t.tags.includes(route.tag))),
    { day: board.day, week: board.week, timezone: board.timezone },
  ), [board.tasks, board.day, board.week, board.timezone, route.category, route.tag]);
  const scope = [route.category !== "all" ? (route.category === "work" ? "Work" : "Personal") : "", route.tag ? `#${route.tag}` : ""].filter(Boolean).join(", ");
  const thisWeek = stats.weeks.at(-1)!.count;
  return (
    <section id="stats-view" className="stats-view" tabIndex={-1} aria-labelledby="stats-title">
      <header className="view-heading">
        <h2 id="stats-title">Statistics</h2>
        <p>{scope ? `Showing ${scope} tasks.` : "How your planning is going."}</p>
      </header>
      <section className="stats-group" aria-labelledby="stats-now">
        <h3 id="stats-now">Right now</h3>
        <div className="stat-tiles">
          <Tile label="Today" value={number(stats.open.today)} />
          <Tile label="This Week" value={number(stats.open.week)} />
          <Tile label="Later" value={number(stats.open.later)} />
          <Tile label="Done, not archived" value={number(stats.done)} />
          <Tile label="Overdue" value={number(stats.overdue)} warning={stats.overdue > 0} />
          <Tile label="Due this week" value={number(stats.dueThisWeek)} />
          <Tile label="Reminders set" value={number(stats.reminders)} />
        </div>
      </section>
      <section className="stats-group" aria-labelledby="stats-trends">
        <h3 id="stats-trends">Completed</h3>
        <div className="stat-tiles">
          <Tile label="This week" value={number(thisWeek)} />
          <Tile label="Current streak" value={`${stats.streak} ${stats.streak === 1 ? "day" : "days"}`} note="Days in a row with a completed task" />
          <Tile label="Best streak" value={`${stats.bestStreak} ${stats.bestStreak === 1 ? "day" : "days"}`} />
          <Tile label="All time" value={number(stats.completed)} />
        </div>
        <div className="stat-charts">
          <ColumnChart
            id="stats-weeks"
            title="Tasks completed per week, last 12 weeks"
            unit="completed"
            points={stats.weeks.map((w) => ({
              key: w.week,
              label: format(w.week, { month: "short", day: "numeric" }),
              full: `Week of ${format(w.week, { month: "long", day: "numeric", year: "numeric" })}`,
              count: w.count,
            }))}
          />
          <ColumnChart
            id="stats-days"
            title="Tasks completed per day, last 14 days"
            unit="completed"
            points={stats.days.map((d) => ({
              key: d.day,
              label: format(d.day, { month: "short", day: "numeric" }),
              full: format(d.day, { weekday: "long", month: "long", day: "numeric" }),
              count: d.count,
            }))}
          />
        </div>
      </section>
      <section className="stats-group" aria-labelledby="stats-breakdown">
        <h3 id="stats-breakdown">Categories and tags</h3>
        <p className="breakdown-legend" aria-hidden="true">
          <span><i className="is-done" />Completed</span><span><i />Open</span>
        </p>
        <div className="stat-charts">
          <Breakdown
            id="stats-categories"
            title="By category"
            empty="No tasks yet."
            rows={stats.categories.map((c) => ({ key: c.category, label: c.category === "work" ? "Work" : "Personal", open: c.open, done: c.done }))}
          />
          <Breakdown
            id="stats-tags"
            title="Top tags"
            empty="No tagged tasks yet."
            rows={stats.tags.map((t) => ({ key: t.tag, label: `#${t.tag}`, open: t.open, done: t.done }))}
          />
        </div>
      </section>
      <section className="stats-group" aria-labelledby="stats-lead">
        <h3 id="stats-lead">Time to complete</h3>
        {stats.lead ? (
          <>
            <div className="stat-tiles">
              <Tile label="Median" value={duration(stats.lead.median)} />
              <Tile label="Average" value={duration(stats.lead.average)} />
              <Tile label="75% finished within" value={duration(stats.lead.p75)} />
            </div>
            <p className="stats-caption">
              From creation to completion, for {stats.lead.count} task{stats.lead.count === 1 ? "" : "s"} completed since {format(shiftDate(board.day, -(LEAD_WINDOW_DAYS - 1)), { month: "long", day: "numeric" })}.
            </p>
          </>
        ) : (
          <p className="stats-empty">Complete a few tasks to see how long they take.</p>
        )}
      </section>
      <p className="stats-caption">
        Based on each task's latest completion, including archived tasks. Reopening a task removes it from these numbers.
      </p>
    </section>
  );
}
