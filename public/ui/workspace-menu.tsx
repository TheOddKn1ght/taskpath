import { ActionMenu } from './action-menu.tsx';
export interface WorkspaceOption { label:string; disabled?:boolean; fn:()=>void }
export function WorkspaceMenu({options}:{options:WorkspaceOption[]}) {
  return <ActionMenu label="Workspace options" triggerClassName="app-menu" popupClassName="app-menu-popover">
    {options.map(option => <button type="button" role="menuitem" key={option.label} disabled={option.disabled} onClick={option.fn}>{option.label}</button>)}
  </ActionMenu>;
}
