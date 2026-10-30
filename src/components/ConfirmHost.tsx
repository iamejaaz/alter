import { useEffect, useRef, useState } from "react";
import { ConfirmOptions, registerConfirm, resolveConfirm } from "../lib/confirm";

export default function ConfirmHost() {
  const [message, setMessage] = useState<string | null>(null);
  const [opts, setOpts] = useState<ConfirmOptions>({});
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerConfirm((m, o) => {
      setOpts(o);
      setMessage(m);
    });
    return () => registerConfirm(null);
  }, []);

  useEffect(() => {
    if (!message) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(e.key === "Enter");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [message]);

  const close = (value: boolean) => {
    resolveConfirm(value);
    setMessage(null);
  };

  if (!message) return null;

  const destructive = opts.destructive ?? /^(delete|remove|forget|discard)\b/i.test(message);
  const label = opts.confirmLabel ?? (destructive ? message.split(/\s/)[0].replace(/^./, (c) => c.toUpperCase()) : "Confirm");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => close(false)}>
      <div
        className="w-[380px] rounded-2xl border border-[var(--bd)] bg-[var(--modal)] p-5 shadow-2xl animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="max-h-[60vh] overflow-y-auto text-sm leading-relaxed text-[var(--txt)] whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => close(false)}
            className="rounded-lg px-4 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)] hover:bg-[var(--panel)] transition-colors"
          >
            Cancel
          </button>
          <button
            ref={okRef}
            onClick={() => close(true)}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
              destructive ? "bg-red-600 hover:bg-red-500" : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {label}
          </button>
        </div>
      </div>
    </div>
  );
}
