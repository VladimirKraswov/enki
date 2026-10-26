import type { CSSProperties } from "react";
const paths: Record<string, string> = {
  connectionLost: "m3 3 18 18M7 7a8 8 0 0 0 0 12m10-2a8 8 0 0 0 0-12M9 9a4 4 0 0 0 0 6m6-2a4 4 0 0 0 0-4M12 19h.01",
  shield: "M12 3 21 7v5c0 5-5 8-9 10-4-2-9-5-9-10V7zM12 7v6M12 17h.01",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  popout: "M3 3h18v18H3zM12 12h6v6h-6z",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
  context: "M4 5h2v2H4zM10 6h10M4 11h2v2H4zM10 12h10M4 17h2v2H4zM10 18h10",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l-3 3",
  arrowDown: "M12 4v16m-6-6 6 6 6-6",
  copy: "M9 3h11v13H9zM5 7H3v14h12v-2",
  edit: "m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15z",
  handoff: "M4 16V9a3 3 0 0 1 3-3h12m-5-5 5 5-5 5M4 20h.01",
  back: "M20 12H4m6-6-6 6 6 6",
  forward: "M4 12h16m-6-6 6 6-6 6",
  expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  browser: "M3 3h18v18H3zM3 8h18M7 5h.01M10 5h.01M13 5h.01",
  monitor: "M3 3h18v13H3zM12 16v5M8 21h8",
  server: "M3 3h18v7H3zM3 14h18v7H3zM7 6h.01M7 17h.01M16 6h2M16 17h2",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8",
  plus: "M12 5v14M5 12h14",
  command: "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3",
  new: "M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l2-6 7-7 5 5-7 7z",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  folder: "M3 7V5h6l2 2h10v13H3z",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  terminal: "m4 6 6 6-6 6M13 18h7",
  panel: "M3 4h18v16H3zM15 4v16",
  sidebar: "M3 4h18v16H3zM9 4v16",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18",
  arrow: "M12 20V4m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6z",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  branch: "M6 3v12a4 4 0 0 0 4 4h4M6 7h8a4 4 0 0 0 4-4M4 3h4M16 3h4M14 17v4",
  close: "m6 6 12 12M6 18 18 6",
  refresh: "M20 7a9 9 0 1 0 1 9M20 3v5h-5",
  check: "m4 12 5 5L20 6",
  archive: "M3 3h18v5H3zM5 8v13h14V8M9 12h6",
  chat: "M3 4h18v14H8l-5 3z",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  file: "M5 2h9l5 5v15H5zM14 2v6h5",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1",
  pin: "m8 3 8 0-1 6 4 4H5l4-4zM12 13v8",
  keyboard: "M2 5h20v14H2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 14h12",
};
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, ...style }}
    >
      <path d={paths[name] ?? paths.code} />
    </svg>
  );
}
