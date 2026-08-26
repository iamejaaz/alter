import { useEffect, useState } from "react";
import { registerConfirm, resolveConfirm } from "../lib/confirm";

export default function ConfirmHost() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    registerConfirm((m) => setMessage(m));
    return () => registerConfirm(null);
  }, []);

  useEffect(() => {
    if (!message) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [message]);

  const close = (value: boolean) => {
    resolveConfirm(value);
    setMessage(null);
  };

  if (!message) return null;

  const destructive = /delete|remove|forget|discard/i.test(message);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => close(false)}>
      <div
        className="w-[380px] rounded-2xl border border-[var(--bd)] bg-[var(--modal)] p-5 shadow-2xl animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm leading-relaxed text-[var(--txt)] whitespace-pre-wrap">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => close(false)}
            className="rounded-lg px-4 py-2 text-sm text-[var(--txt-dim)] hover:text-[var(--txt)] hover:bg-[var(--panel)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => close(true)}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
              destructive ? "bg-red-600 hover:bg-red-500" : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {destructive ? "Delete" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
