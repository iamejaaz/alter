import { useEffect, useRef, useState } from "react";
import { IconClock } from "./Icons";
import { whenLabel } from "../lib/store";

interface Props {
  disabled?: boolean;
  title?: string;
  onPick: (at: number) => void;
}

const localValue = (at: number) => {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export default function SendLater({ disabled, title, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const now = Date.now();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const presets = [
    { label: "In 30 minutes", at: now + 30 * 60_000 },
    { label: "In 1 hour", at: now + 60 * 60_000 },
    { label: "Tomorrow morning", at: tomorrow.getTime() },
  ];
  const customAt = custom ? new Date(custom).getTime() : NaN;
  const pick = (at: number) => {
    setOpen(false);
    setCustom("");
    onPick(at);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          setCustom(localValue(Date.now() + 60 * 60_000));
          setOpen((v) => !v);
        }}
        disabled={disabled}
        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--panel-2)] disabled:opacity-25 disabled:hover:bg-transparent text-[var(--txt-faint)] hover:text-[var(--txt)] transition-colors"
        title={title ?? "Send later"}
        aria-label="Send later"
        aria-expanded={open}
      >
        <IconClock />
      </button>
      {open && (
        <div className="absolute bottom-9 right-0 z-30 w-64 overflow-hidden rounded-xl border border-[var(--bd)] bg-[var(--modal)] text-[13px] shadow-xl">
          <p className="px-3 pt-2.5 pb-1 text-[11px] text-[var(--txt-faint)]">Send later</p>
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => pick(p.at)}
              className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[var(--txt)] hover:bg-[var(--panel-2)]"
            >
              <span>{p.label}</span>
              <span className="text-[11px] text-[var(--txt-faint)]">{whenLabel(p.at)}</span>
            </button>
          ))}
          <div className="flex items-center gap-2 border-t border-[var(--bd-soft)] px-3 py-2">
            <input
              type="datetime-local"
              value={custom}
              min={localValue(now)}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Pick a date and time"
              className="min-w-0 flex-1 rounded-lg border border-[var(--bd)] bg-[var(--input)] px-2 py-1 text-[12px]"
            />
            <button
              onClick={() => pick(customAt)}
              disabled={!(customAt > Date.now())}
              className="shrink-0 rounded-lg border border-[var(--bd)] px-2.5 py-1 text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-40"
            >
              Set
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
