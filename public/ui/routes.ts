import type { Route } from "../types.js";
import { normalizeTags } from "../tags.js";
import { emptyRoute } from '../url-state.js';
export { emptyRoute } from '../url-state.js';
export function readRoute(hash: string): Route {
  const match = hash.match(/^#(board|calendar|stats|archive|files)(?:\?(.*))?$/);
  if (!match) return { ...emptyRoute };
  const params = new URLSearchParams(match[2] || "");
  let tag = "";
  try {
    if (params.get("tag")) tag = normalizeTags([params.get("tag")])[0];
  } catch {}
  return {
    view: match[1] as Route["view"],
    query: params.get("q") || "",
    category:
      params.get("category") === "work"
        ? "work"
        : params.get("category") === "personal"
          ? "personal"
          : "all",
    tag,
    ...(match[1] === "board" && params.get("focus") === "today" ? { focus: "today" as const } : {}),
  };
}
export function routeHash(route: Route) {
  if (route.view === "files") return "#files";
  const p = new URLSearchParams();
  if (route.view === "board" && route.focus === "today") p.set("focus", "today");
  return p.size
    ? `#${route.view}?${p}`
    : route.view === "board"
      ? ""
      : `#${route.view}`;
}
