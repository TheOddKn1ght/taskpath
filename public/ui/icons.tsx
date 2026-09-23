import type { ReactNode } from "react";
const paths: Record<string, ReactNode> = {
  files: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v12h14V8M10 12h4" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16m6-16v16" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  check: (
    <>
      <path d="m5 12 4 4L19 6" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M16 3v4M8 3v4M3 11h18m-13 4h2m4 0h2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" />
    </>
  ),
  sprout: (
    <>
      <path d="M12 21v-7C5 14 3 10 3 5c6 0 9 3 9 9 0-8 3-11 9-11 0 6-3 10-9 11M7 21h10" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5.8-1.5 1.5-1.5 2m0 3h.01" />
    </>
  ),
  move: (
    <>
      <path d="M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4" />
    </>
  ),
  "arrow-up-right": (
    <>
      <path d="M6 18 18 6M6 6h12v12" />
    </>
  ),
  "arrow-right": (
    <>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </>
  ),
  later: (
    <>
      <path d="M8 9V5a4 4 0 0 1 8 0v4m-4-4v10m-4-4 4 4 4-4M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
    </>
  ),
  inbox: (
    <>
      <path d="m3 13 3-8h12l3 8v6H3zM3 13h5l2 3h4l2-3h5" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12M6 18 18 6" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  grip: (
    <>
      <path
        d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"
        strokeWidth="3"
      />
    </>
  ),
  more: (
    <>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
    </>
  ),
  edit: (
    <>
      <path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15z" />
    </>
  ),
  up: (
    <>
      <path d="M12 20V4m-6 6 6-6 6 6" />
    </>
  ),
  down: (
    <>
      <path d="M12 4v16m-6-6 6 6 6-6" />
    </>
  ),
};
export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name] || paths.inbox}
    </svg>
  );
}
