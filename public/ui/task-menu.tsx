import type { ReactNode } from 'react';
import { ActionMenu } from './action-menu.tsx';

export function TaskMenu({ title, children }: { title:string; children:ReactNode }) {
  return <ActionMenu label={'More options for ' + title} triggerClassName="task-menu-trigger" popupClassName="task-menu-popover">{children}</ActionMenu>;
}
