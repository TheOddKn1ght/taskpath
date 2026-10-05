import { useLayoutEffect, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
export function Dialog({
  id,
  title,
  children,
  onClose,
  className = "",
  busy = false,
  animateClose = true,
}: {
  id: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  busy?: boolean;
  animateClose?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    close = useRef(onClose),
    closing = useRef(false);
  close.current = onClose;
  useLayoutEffect(() => {
    const d = ref.current!,
      opener = document.activeElement as HTMLElement | null;
    d.showModal();
    d.querySelector<HTMLElement>(
      '[autofocus],input:not([type="hidden"]),textarea',
    )?.focus();
    return () => {
      d.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  // Plays the exit animation on the live dialog, then lets the owner unmount it.
  // Programmatic closes (save, lock) bypass this and stay immediate.
  function dismiss() {
    const d = ref.current;
    if (busy || closing.current || !d) return;
    if (!animateClose) return close.current();
    // Start from the current frame in case the enter animation is still running.
    const now = getComputedStyle(d);
    d.style.setProperty("--exit-opacity", now.opacity);
    d.style.setProperty("--exit-translate", now.translate === "none" ? "0 0" : now.translate);
    d.style.setProperty("--exit-backdrop", getComputedStyle(d, "::backdrop").opacity);
    d.classList.add("closing");
    const exit = d.getAnimations();
    // Reduced motion disables the animation, so close synchronously as before.
    if (!exit.length) {
      d.classList.remove("closing");
      return close.current();
    }
    closing.current = true;
    d.inert = true;
    const reset = () => {
      closing.current = false;
      d.inert = false;
      d.classList.remove("closing");
    };
    // Background tabs may never finish the animation; don't leave the dialog stuck.
    const fallback = setTimeout(() => exit.forEach((a) => a.finish()), 400);
    void Promise.all(exit.map((a) => a.finished)).then(
      () => {
        clearTimeout(fallback);
        if (!d.isConnected) return;
        // Unmount in this frame: removing the class first would replay the enter animation.
        flushSync(() => close.current());
        // The owner may keep the dialog open, e.g. to confirm discarding changes.
        if (d.isConnected) reset();
      },
      () => {
        clearTimeout(fallback);
        reset();
      },
    );
  }
  return (
    <dialog
      id={id}
      ref={ref}
      className={className}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      }}
      onClick={(e) => {
        if ((e.target as Element).closest("[data-dialog-close]")) {
          dismiss();
          return;
        }
        if (e.target !== e.currentTarget || busy) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          dismiss();
      }}
    >
      <div className="dialog-top">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={"Close " + title}
          disabled={busy}
          data-dialog-close
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
