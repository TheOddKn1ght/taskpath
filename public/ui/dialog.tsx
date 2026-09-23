import { useLayoutEffect, useRef, type ReactNode } from "react";
export function Dialog({
  id,
  title,
  children,
  onClose,
  className = "",
  busy = false,
}: {
  id: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    close = useRef(onClose);
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
  return (
    <dialog
      id={id}
      ref={ref}
      className={className}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) close.current();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || busy) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          close.current();
      }}
    >
      <div className="dialog-top">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={"Close " + title}
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
