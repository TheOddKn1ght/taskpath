import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

// Keep actions out of the draggable card's DOM subtree. In particular, do not
// dismiss on blur: pointer activation need not focus a button before its click.
export function TaskMenu({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = false) => {
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const popup = menu.current!, anchor = trigger.current!;
    const position = () => {
      const rect = anchor.getBoundingClientRect(), bounds = popup.getBoundingClientRect();
      popup.style.left = Math.max(8, Math.min(rect.right - bounds.width, innerWidth - bounds.width - 8)) + 'px';
      popup.style.top = Math.max(8, Math.min(rect.bottom + 6, innerHeight - bounds.height - 8)) + 'px';
    };
    position();
    popup.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!popup.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => { if (!popup.contains(event.target as Node)) close(); };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  return <>
    <button
      type="button"
      ref={trigger}
      className="icon-button task-menu-trigger"
      aria-label={'More options for ' + title}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
        }
      }}
    ><Icon name="more" /></button>
    {open && createPortal(<div
      ref={menu}
      className="menu-content task-menu-popover"
      role="menu"
      aria-label={'More options for ' + title}
      onPointerDown={event => event.stopPropagation()}
      onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onClick={event => {
        event.stopPropagation();
        const button = (event.target as Element).closest('button');
        if (button && !button.disabled) close(true);
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault(); close(true); return;
        }
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >{children}</div>, document.body)}
  </>;
}
