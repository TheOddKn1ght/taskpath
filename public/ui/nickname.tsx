import {useEffect,useRef,useState} from 'react';
import {Dialog} from './dialog.tsx';
import {mutate,message} from './store.ts';
export function Nickname({ initial, close }: { initial: string; close: () => void }) {
  const [error, setError] = useState(""),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  return (
    <Dialog id="nickname-dialog" title="Your nickname" onClose={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await mutate("/api/profile", "POST", {
              nickname: new FormData(e.currentTarget).get("nickname"),
            });
            if (alive.current) close();
          } catch (e) {
            if (alive.current) setError(message(e));
          }
        }}
      >
        <label className="field">
          Nickname (optional)
          <input name="nickname" defaultValue={initial} maxLength={80} />
        </label>
        <p className="schedule-hint">
          Only used for your greeting. Sign in with your user ID. Stored
          encrypted in your vault.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button">Save</button>
      </form>
    </Dialog>
  );
}
