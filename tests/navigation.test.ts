import { test } from "node:test";
import { expect } from "@std/expect";
import { readRoute, routeHash, emptyRoute } from "../public/ui/routes.ts";
import { sleep } from "./test-utils.ts";
test("all views round-trip through refresh and history fragments", () => {
  for (const view of ["board", "archive", "files"] as const) {
    const route = { ...emptyRoute, view };
    expect(readRoute(routeHash(route))).toEqual(route);
  }
});
test("Unicode and reserved search text stay inside the fragment", async () => {
  const route = {
    view: "archive" as const,
    query:
      "Private café & plans? #today + 50% / 日本語 <script> &setup=not-a-token",
    category: "work" as const,
    tag: "home office",
  };
  const url = new URL(
    "/login?source=saved" + routeHash(route),
    "https://test.example",
  );
  expect(url.search).toBe("?source=saved");
  expect(readRoute(url.hash)).toEqual(route);
  expect(new URLSearchParams(url.hash.slice(1)).has("setup")).toBe(false);
});
test("invalid links fall back and tags normalize", () => {
  expect(readRoute("#board?category=unknown&tag=%00")).toEqual(emptyRoute);
  expect(readRoute("#archive?tag=%20HOME%20").tag).toBe("home");
  expect(readRoute("#board?q=%ZZ").query).toBe("%ZZ");
  expect(readRoute("#main")).toEqual(emptyRoute);
});
test("view changes preserve filters while clearing filters restores the bare anchor", () => {
  const route = readRoute("#archive?q=first&category=work");
  expect(routeHash({ ...route, view: "board" })).toBe(
    "#board?q=first&category=work",
  );
  expect(routeHash({ ...emptyRoute, view: "archive" })).toBe("#archive");
  expect(routeHash(emptyRoute)).toBe("");
});
test("fragment search is absent from actual HTTP requests", async () => {
  const requests: string[] = [];
  let origin = "";
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: (addr) => {
      origin = `http://127.0.0.1:${addr.port}`;
    },
    handler(request) {
      requests.push(request.url);
      return new Response("ok");
    },
  });
  try {
    while (!origin) await sleep(10);
    const url = new URL(
      "/login?source=saved" +
        routeHash({
          ...emptyRoute,
          query: "PRIVATE_SEARCH_8284",
          tag: "private-tag",
        }),
      origin,
    );
    await fetch(url);
    await fetch(url);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new URL(request).search).toBe("?source=saved");
      expect(request).not.toContain("PRIVATE_SEARCH_8284");
      expect(request).not.toContain("private-tag");
    }
  } finally {
    await server.shutdown();
  }
});
