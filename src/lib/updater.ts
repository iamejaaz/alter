import { useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateState {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "error";
  current: string;
  version?: string;
  notes?: string;
  progress?: number;
  error?: string;
}

let state: UpdateState = { phase: "idle", current: "" };
let pending: Update | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}

export async function checkForUpdate(quiet = false): Promise<void> {
  if (state.phase === "checking" || state.phase === "downloading") return;
  if (!state.current) set({ current: await getVersion().catch(() => "") });
  if (!quiet) set({ phase: "checking", error: undefined });
  try {
    pending = await check();
    if (pending) set({ phase: "available", version: pending.version, notes: pending.body ?? "" });
    else if (!quiet) set({ phase: "current" });
  } catch (e) {
    if (!quiet) set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export async function installUpdate(): Promise<void> {
  if (!pending) return;
  let total = 0;
  let got = 0;
  set({ phase: "downloading", progress: 0 });
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        if (total) set({ progress: Math.min(99, Math.round((got / total) * 100)) });
      }
    });
    await relaunch();
  } catch (e) {
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}
