import { sourceRelease, type ClientRelease } from '../src/client-release';

// Only the harness combines source modules with built entry points. Production
// artifacts intentionally do not require the local source tree to match.
export function browserFixtures(
  release: ClientRelease,
  source = sourceRelease(release.assets ? 'built' : 'source'),
) {
  if (source.version !== release.version)
    throw new Error('Browser fixtures do not match the client release. Run bun run build again.');
  return source;
}
