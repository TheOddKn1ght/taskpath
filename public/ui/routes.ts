import type { Route } from "../types.js";
import { normalizeTags } from "../tags.js";
export const emptyRoute: Route = {
  view: "board",
  query: "",
  category: "all",
  tag: "",
};
export function readRoute(hash: string): Route {
  const match = hash.match(/^#(board|archive|files)(?:\?(.*))?$/);
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
  };
}
export function routeHash(route: Route) {
  if (route.view === "files") return "#files";
  const p = new URLSearchParams();
  if (route.query) p.set("q", route.query);
  if (route.category !== "all") p.set("category", route.category);
  if (route.tag) p.set("tag", route.tag);
  return p.size
    ? `#${route.view}?${p}`
    : route.view === "archive"
      ? "#archive"
      : "";
}
