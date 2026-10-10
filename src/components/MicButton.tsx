import { MutableRefObject, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconMic } from "./Icons";

type State = "idle" | "recording" | "working";

interface Props {
  onInterim: (text: string) => void;
  onText: (text: string) => void;
  stopRef: MutableRefObject<(() => void) | null>;
  onStart?: () => void;
}

export default function MicButton({ onInterim, onText, stopRef, onStart }: Props) {
  const [state, setState] = useState<State>("idle");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => {
    try {
      return localStorage.getItem("alter.micDevice") ?? "";
    } catch {
      return "";
    }
  });
  const [menu, setMenu] = useState(false);
  const [problem, setProblem] = useState<{ text: string; pane?: "microphone" | "speech" } | null>(null);
  const audio = useRef<{ stream: MediaStream; ctx: AudioContext } | null>(null);
  const latest = useRef("");
  const settle = useRef<number | null>(null);

  const loadDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput" && d.deviceId !== "default"));
    } catch {
      setDevices([]);
    }
  };
  useEffect(() => {
    void loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", loadDevices);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  const commit = () => {
    if (settle.current) window.clearTimeout(settle.current);
    settle.current = null;
    const text = latest.current.trim();
    latest.current = "";
    onInterim("");
    if (text) onText(text);
    setState("idle");
  };

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    void listen<{ text?: string; final: boolean; error?: string }>("alter://dictation", (e) => {
      const p = e.payload;
      if (p.error) {
        if (latest.current.trim()) commit();
        else {
          onInterim("");
          setState("idle");
          if (!/no speech|canceled|cancelled/i.test(p.error)) setProblem({ text: p.error });
        }
        return;
      }
      latest.current = p.text ?? "";
      if (p.final) commit();
      else onInterim(latest.current);
    }).then((u) => (gone ? u() : (un = u)));
    return () => {
      gone = true;
      un?.();
    };
  }, []);

  const release = () => {
    const a = audio.current;
    audio.current = null;
    a?.stream.getTracks().forEach((t) => t.stop());
    void a?.ctx.close().catch(() => {});
  };

  const start = async () => {
    setProblem(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      setProblem(
        name === "NotAllowedError"
          ? { text: "Alter can't use the microphone.", pane: "microphone" }
          : name === "OverconstrainedError" || name === "NotFoundError"
            ? { text: "That microphone isn't connected. Pick another one." }
            : { text: String((e as Error)?.message || e) }
      );
      return;
    }
    void loadDevices();
    const ctx = new AudioContext();
    try {
      await invoke("dictation_start", { sampleRate: ctx.sampleRate });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      const msg = String(e);
      setProblem(msg.includes("SPEECH_DENIED") ? { text: "Alter needs Speech Recognition to turn your voice into text.", pane: "speech" } : { text: msg });
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      void invoke("dictation_feed", { samples: Array.from(e.inputBuffer.getChannelData(0)) });
    };
    source.connect(proc);
    proc.connect(ctx.destination);
    audio.current = { stream, ctx };
    latest.current = "";
    setState("recording");
    onStart?.();
  };

  const stop = () => {
    if (state !== "recording") return;
    release();
    setState("working");
    void invoke("dictation_stop", { cancel: false });
    settle.current = window.setTimeout(commit, 4000);
  };
  stopRef.current = state === "recording" ? stop : null;
  useEffect(() => {
    if (state !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      stopRef.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state]);

  useEffect(
    () => () => {
      release();
      void invoke("dictation_stop", { cancel: true });
    },
    []
  );

  const toggle = () => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  };

  const choose = (id: string) => {
    setDeviceId(id);
    try {
      localStorage.setItem("alter.micDevice", id);
    } catch {}
    setMenu(false);
  };

  const label = state === "recording" ? "Stop dictation" : state === "working" ? "Finishing" : "Dictate";

  return (
    <div className="relative flex items-center">
      <button
        onClick={toggle}
        disabled={state === "working"}
        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
          state === "recording"
            ? "animate-pulse bg-red-500/15 text-red-400"
            : state === "working"
              ? "text-[var(--txt-faint)] opacity-60"
              : "text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)]"
        }`}
        title={label}
        aria-label={label}
        aria-pressed={state === "recording"}
      >
        <IconMic />
      </button>
      {devices.length > 1 && state === "idle" && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenu((v) => !v);
          }}
          className="flex h-7 w-4 items-center justify-center rounded-md text-[10px] text-[var(--txt-faint)] hover:bg-[var(--panel-2)] hover:text-[var(--txt)]"
          title="Choose microphone"
          aria-label="Choose microphone"
        >
          ▾
        </button>
      )}
      {menu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-9 left-0 z-30 min-w-[220px] rounded-lg border border-[var(--bd)] bg-[var(--modal)] p-1 text-[12px] shadow-xl"
        >
          {[{ deviceId: "", label: "System default" }, ...devices.map((d) => ({ deviceId: d.deviceId, label: d.label }))].map((d) => (
            <button
              key={d.deviceId || "default"}
              onClick={() => choose(d.deviceId)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--txt)] hover:bg-[var(--panel-2)]"
            >
              <span className="w-3 text-[var(--txt-dim)]">{deviceId === d.deviceId ? "✓" : ""}</span>
              <span className="truncate">{d.label || "Microphone"}</span>
            </button>
          ))}
        </div>
      )}
      {problem && (
        <div className="absolute bottom-9 left-0 z-30 flex w-[280px] items-start gap-2 rounded-lg border border-[var(--bd)] bg-[var(--modal)] px-3 py-2 text-[12px] text-[var(--txt-dim)] shadow-xl">
          <span className="flex-1">{problem.text}</span>
          {problem.pane && (
            <button
              onClick={() => {
                void invoke("open_privacy_settings", { pane: problem.pane });
                setProblem(null);
              }}
              className="shrink-0 text-[var(--txt)] underline"
            >
              Open Settings
            </button>
          )}
          <button onClick={() => setProblem(null)} className="shrink-0 text-[var(--txt-faint)] hover:text-[var(--txt)]" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
