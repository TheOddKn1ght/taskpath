import { useState } from 'react';
import type { Board } from '../types.js';
import { availableTags } from '../tags.js';
import { Dialog } from './dialog';
import { message, mutate, navigate, getSnapshot } from './store';

export function TagManager({
  board,
  close,
  syncComplete,
}: {
  board: Board;
  close: () => void;
  syncComplete: boolean;
}) {
  const [name, setName] = useState(''),
    [query, setQuery] = useState(''),
    [editing, setEditing] = useState<string | null>(null),
    [replacement, setReplacement] = useState(''),
    [deleting, setDeleting] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const tags = availableTags(board);
  async function save(action: 'add' | 'rename' | 'delete', tag: string) {
    setBusy(true);
    setError('');
    try {
      await mutate('/api/tags', 'POST', { action, name: tag, replacement });
      const route = getSnapshot().route;
      if (route.tag === tag && action !== 'add')
        navigate(
          {
            tag:
              action === 'rename'
                ? replacement.trim().normalize('NFC').toLowerCase().normalize('NFC')
                : '',
          },
          true,
        );
      setName('');
      setEditing(null);
      setDeleting(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog id="tags-dialog" title="Manage tags" onClose={close} busy={busy}>
      <p>Create reusable tags or update them across active and archived tasks.</p>
      {!syncComplete && <p role="status">Wait for the initial download before managing tags.</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <fieldset disabled={busy || !syncComplete} className="tag-manager-controls">
        <form
          className="tag-entry"
          onSubmit={(e) => {
            e.preventDefault();
            void save('add', name);
          }}
        >
          <input
            aria-label="New tag name"
            placeholder="New tag name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="primary-button" disabled={!name.trim()}>
            Add tag
          </button>
        </form>
        <input
          type="search"
          aria-label="Find tags"
          placeholder="Find tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="tag-manager-list">
          {tags
            .filter((t) => t.includes(query.trim().normalize('NFC').toLowerCase()))
            .map((tag) => {
              const count = board.tasks.filter((t) => t.tags.includes(tag)).length;
              return (
                <section className="tag-manager-row" key={tag} aria-label={'Tag ' + tag}>
                  <div className="tag-manager-heading">
                    <strong>#{tag}</strong>
                    <span>
                      {count} {count === 1 ? 'task' : 'tasks'}
                    </span>
                  </div>
                  {editing === tag ? (
                    <form
                      className="tag-entry"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save('rename', tag);
                      }}
                    >
                      <input
                        aria-label={'New name for ' + tag}
                        value={replacement}
                        onChange={(e) => setReplacement(e.target.value)}
                      />
                      <button className="primary-button" disabled={!replacement.trim()}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="subtle-button"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                      {tags.includes(replacement.trim().toLowerCase()) &&
                        replacement.trim().toLowerCase() !== tag && (
                          <p>Assignments will merge into the existing tag.</p>
                        )}
                    </form>
                  ) : deleting === tag ? (
                    <div>
                      <p>
                        Delete #{tag} and remove it from {count} {count === 1 ? 'task' : 'tasks'}?
                        Tasks will be kept.
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void save('delete', tag)}
                      >
                        Confirm delete
                      </button>{' '}
                      <button
                        type="button"
                        className="subtle-button"
                        onClick={() => setDeleting(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="tag-entry">
                      <button
                        type="button"
                        className="secondary-button"
                        aria-label={'Rename ' + tag}
                        onClick={() => {
                          setEditing(tag);
                          setReplacement(tag);
                          setDeleting(null);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="subtle-button"
                        aria-label={'Delete ' + tag}
                        onClick={() => {
                          setDeleting(tag);
                          setEditing(null);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </section>
              );
            })}
          {!tags.length && <p>No tags yet. Add your first tag above.</p>}
          {!!tags.length &&
            !tags.some((t) => t.includes(query.trim().normalize('NFC').toLowerCase())) && (
              <p>No matching tags.</p>
            )}
        </div>
      </fieldset>
    </Dialog>
  );
}
