import { useEffect, useRef, useState } from "react";
import { IconClock } from "./Icons";
import { whenLabel } from "../lib/store";

interface Props {
  disabled?: boolean;
  title?: string;
  onPick: (at: number) => void;
}

const dayStart = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
};
const dayName = (offset: number) =>
  offset === 0
    ? "Today"
    : offset === 1
      ? "Tomorrow"
      : dayStart(offset).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const pad = (n: number) => String(n).padStart(2, "0");

export default function SendLater({ disabled, title, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState("");
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
  const [h, m] = time.split(":").map(Number);
  const customAt = time ? dayStart(day).setHours(h, m, 0, 0) : NaN;
  const valid = customAt > now;
  const pick = (at: number) => {
    setOpen(false);
    onPick(at);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          const d = new Date(Date.now() + 60 * 60_000);
          setDay(d.getDate() === new Date().getDate() ? 0 : 1);
          setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
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
        <div className="absolute bottom-9 right-0 z-30 w-72 overflow-hidden rounded-xl border border-[var(--bd)] bg-[var(--modal)] text-[13px] shadow-xl">
          <p className="px-3 pt-2.5 pb-1 text-[11px] text-[var(--txt-faint)]">Send later</p>
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => pick(p.at)}
              className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[var(--txt)] hover:bg-[var(--panel-2)]"
            >
              <span className="whitespace-nowrap">{p.label}</span>
              <span className="shrink-0 whitespace-nowrap text-[11px] text-[var(--txt-faint)]">{whenLabel(p.at)}</span>
            </button>
          ))}
          <div className="border-t border-[var(--bd-soft)] px-3 py-2">
            <div className="flex items-center gap-2">
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                aria-label="Day"
                className="min-w-0 flex-1 rounded-lg border border-[var(--bd)] bg-[var(--input)] px-2 py-1 text-[12px]"
              >
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <option key={d} value={d}>
                    {dayName(d)}
                  </option>
                ))}
              </select>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid) {
                    e.preventDefault();
                    pick(customAt);
                  }
                }}
                aria-label="Time"
                className="rounded-lg border border-[var(--bd)] bg-[var(--input)] px-2 py-1 text-[12px]"
              />
            </div>
            <button
              onClick={() => pick(customAt)}
              disabled={!valid}
              className="mt-2 w-full rounded-lg border border-[var(--bd)] px-2.5 py-1 text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-40"
            >
              {valid ? `Send ${whenLabel(customAt)}` : "Pick a time in the future"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
