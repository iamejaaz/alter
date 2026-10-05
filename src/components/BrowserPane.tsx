import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Shot {
  url: string;
  title: string;
  image: string;
  width: number;
  height: number;
}

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "PageUp", "PageDown", "Home", "End"]);

export default function BrowserPane({ onClose }: { onClose: () => void }) {
  const [shot, setShot] = useState<Shot | null>(null);
  const [state, setState] = useState<"loading" | "live" | "off" | "error">("loading");
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [starting, setStarting] = useState(false);
  const busy = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const refresh = useCallback(async () => {
    if (busy.current || document.hidden) return;
    busy.current = true;
    try {
      const s = await invoke<Shot>("pane_snapshot");
      setShot(s);
      setState("live");
      setError("");
    } catch (e) {
      const msg = String(e);
      if (msg.includes("not_running")) setState("off");
      else {
        setState("error");
        setError(msg);
      }
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!editing && shot) setAddress(shot.url === "about:blank" ? "" : shot.url);
  }, [shot, editing]);

  const act = async (cmd: string, args: Record<string, unknown> = {}) => {
    try {
      await invoke(cmd, args);
    } catch (e) {
      setError(String(e));
    }
    setTimeout(() => void refresh(), 150);
  };

  const point = (e: { clientX: number; clientY: number }) => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || !shot?.width) return null;
    return { x: ((e.clientX - r.left) / r.width) * shot.width, y: ((e.clientY - r.top) / r.height) * shot.height };
  };

  const onKey = async (e: React.KeyboardEvent) => {
    if (e.metaKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      const text = await navigator.clipboard.readText().catch(() => "");
      if (text) void act("pane_type", { text });
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    if (KEYS.has(e.key)) {
      e.preventDefault();
      void act("pane_key", { key: e.key });
    } else if (e.key.length === 1) {
      e.preventDefault();
      void act("pane_type", { text: e.key });
    }
  };

  const nav = "flex h-7 w-7 items-center justify-center rounded-md text-[var(--txt-dim)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)] disabled:opacity-30";

  return (
    <aside className="flex w-[45%] min-w-[380px] shrink-0 flex-col border-l border-[var(--bd-soft)] bg-[var(--bg)]">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--bd-soft)] px-2">
        <button className={nav} disabled={state !== "live"} onClick={() => void act("pane_navigate", { action: "back" })} title="Back" aria-label="Back">
          ‹
        </button>
        <button className={nav} disabled={state !== "live"} onClick={() => void act("pane_navigate", { action: "forward" })} title="Forward" aria-label="Forward">
          ›
        </button>
        <button className={nav} disabled={state !== "live"} onClick={() => void act("pane_navigate", { action: "reload" })} title="Reload" aria-label="Reload">
          ↻
        </button>
        <input
          value={address}
          disabled={state !== "live"}
          onFocus={(e) => {
            setEditing(true);
            e.target.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && address.trim()) {
              void act("pane_navigate", { action: "open", url: address });
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Search or enter address"
          className="mx-1 h-7 min-w-0 flex-1 rounded-md border border-[var(--bd)] bg-[var(--input)] px-2 text-[12px] text-[var(--txt)] focus:border-[var(--txt-faint)] focus:outline-none"
        />
        <button
          onClick={() => void act("agent_browser_open")}
          className="rounded-md px-2 py-1 text-[12px] text-[var(--txt-dim)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)]"
          title="Bring the browser window to the front"
        >
          Window
        </button>
        <button onClick={onClose} className={nav} title="Close" aria-label="Close browser pane">
          ×
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto bg-[var(--panel)]">
        {state === "live" && shot && (
          <div
            tabIndex={0}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => void onKey(e)}
            onWheel={(e) => {
              const p = point(e);
              if (p) void act("pane_scroll", { x: p.x, y: p.y, dy: e.deltaY });
            }}
            className={`outline-none ${focused ? "ring-1 ring-inset ring-[var(--txt-faint)]" : ""}`}
          >
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${shot.image}`}
              alt={shot.title || "Agent browser"}
              draggable={false}
              onClick={(e) => {
                const p = point(e);
                if (p) void act("pane_click", p);
              }}
              className="block w-full cursor-default select-none"
            />
          </div>
        )}
        {state === "loading" && <p className="p-6 text-center text-[13px] text-[var(--txt-faint)]">Connecting to the agent browser…</p>}
        {state === "off" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-[14px] text-[var(--txt)]">The agent browser is not running</p>
            <p className="max-w-xs text-[13px] text-[var(--txt-faint)]">It starts on its own when a chat needs it. Start it now to sign in to a site first.</p>
            <button
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                await act("agent_browser_open");
                setStarting(false);
              }}
              className="rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-1.5 text-[13px] text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-40"
            >
              {starting ? "Starting…" : "Start browser"}
            </button>
          </div>
        )}
        {state === "error" && <p className="p-6 text-center text-[13px] text-red-400">{error}</p>}
      </div>
      <p className="shrink-0 border-t border-[var(--bd-soft)] px-3 py-1.5 text-[11px] text-[var(--txt-faint)]">
        {state === "live" ? "Click to interact. Click the page first, then type. Sign in here yourself; agents never type passwords." : "Live view of the agent browser."}
      </p>
    </aside>
  );
}
