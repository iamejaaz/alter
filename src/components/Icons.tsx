const s = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const Chevron = () => (
  <svg
    viewBox="0 0 12 12"
    className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-[var(--txt-faint)]"
  >
    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconPaperclip = () => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...s}>
    <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

export const IconMic = () => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...s}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

export const IconFolder = () => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...s}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export const IconArrowUp = () => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" {...s}>
    <line x1="12" y1="19" x2="12" y2="5" />
    <path d="M5 12l7-7 7 7" />
  </svg>
);
