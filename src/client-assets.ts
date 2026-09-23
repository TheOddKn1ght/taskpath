import { realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  sourceRelease,
  stampRelease,
  type ClientRelease,
} from "./client-release";
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
const bundles = new Map<string, Promise<string>>();
export async function bundleClient(
  entry: string,
  release: ClientRelease,
  minify = false,
) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify,
    env: "disable",
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        minify ? "production" : "development",
      ),
    },
    plugins: [
      {
        name: "source-snapshot",
        setup(build) {
          build.onResolve(
            { filter: /^\/assets\/__TASKPATH_RELEASE__\/offline\.js$/ },
            () => ({ path: resolve(release.directory!, "offline.ts") }),
          );
          build.onLoad({ filter: /\.[tj]sx?$/ }, (args) => {
            const root = release.directory
              ? realpathSync(release.directory)
              : undefined;
            if (!root || !release.sources || !args.path.startsWith(root + "/"))
              return;
            const name = args.path.slice(root.length + 1),
              bytes = release.sources.get(name);
            if (!bytes)
              throw new Error("Source not in release snapshot: " + name);
            return {
              contents: new TextDecoder().decode(bytes),
              loader: name.endsWith(".tsx")
                ? "tsx"
                : name.endsWith(".ts")
                  ? "ts"
                  : "js",
              resolveDir: dirname(args.path),
            };
          });
        },
      },
    ],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Could not bundle client");
  if (result.outputs.length !== 1)
    throw new Error("Expected one client bundle");
  return stampRelease(await result.outputs[0].text(), release);
}
// Only explicit HTTP asset routes call this function. TSX components are bundled,
// never exposed as arbitrary source URLs or separate React runtimes.
export async function clientAsset(
  directory: string,
  name: string,
  release: ClientRelease = sourceRelease(),
) {
  if (release.assets && resolve(directory) === release.directory) {
    const bytes = release.assets.get(name);
    if (!bytes) throw new Error("Asset missing from build manifest.");
    return new Uint8Array(bytes);
  }
  const sourceName =
    name.endsWith(".js") && !name.startsWith("vendor/")
      ? name.replace(/\.js$/, ".ts")
      : name;
  if (
    (name === "app.js" || name === "sw.js") &&
    resolve(directory) === release.directory
  ) {
    const key = release.version + ":" + name;
    let cached = bundles.get(key);
    if (!cached) {
      cached = bundleClient(
        resolve(directory, name === "app.js" ? "app.tsx" : "sw.ts"),
        release,
      );
      for (const old of bundles.keys())
        if (!old.startsWith(release.version + ":")) bundles.delete(old);
      bundles.set(key, cached);
      cached.catch(() => bundles.delete(key));
    }
    return cached;
  }
  const snapshot =
    resolve(directory) === release.directory
      ? release.sources?.get(sourceName)
      : undefined;
  if (snapshot) {
    const text = new TextDecoder().decode(snapshot);
    if (sourceName.endsWith(".ts"))
      return stampRelease(transpiler.transformSync(text), release);
    if (/\.(html|js|css|webmanifest|json|svg)$/.test(name))
      return stampRelease(text, release);
    return new Uint8Array(snapshot);
  }
  const tsx = resolve(directory, name.replace(/\.js$/, ".tsx"));
  if (name.endsWith(".js") && (await Bun.file(tsx).exists()))
    return bundleClient(tsx, release, !!release.assets);
  const file = Bun.file(resolve(directory, name));
  if (
    name.endsWith(".js") &&
    !name.startsWith("vendor/") &&
    !(await file.exists())
  )
    return stampRelease(
      transpiler.transformSync(
        await Bun.file(resolve(directory, sourceName)).text(),
      ),
      release,
    );
  return file;
}
