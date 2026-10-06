import { useState } from "react";
import { ToolAsk } from "../lib/api";

type Answer = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function describe(ask: ToolAsk): { title: string; detail: string; mono: boolean } {
  const i = ask.input;
  switch (ask.tool) {
    case "Bash":
      return { title: "Run this command?", detail: str(i.command), mono: true };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { title: ask.tool === "Write" ? "Write this file?" : "Edit this file?", detail: str(i.file_path) || str(i.notebook_path), mono: true };
    case "WebFetch":
      return { title: "Fetch this page?", detail: str(i.url), mono: true };
    case "WebSearch":
      return { title: "Search the web?", detail: str(i.query), mono: false };
    case "ExitPlanMode":
      return { title: "Go ahead with this plan?", detail: str(i.plan), mono: false };
    default:
      return { title: `Use ${ask.tool}?`, detail: ask.description || clip(JSON.stringify(i, null, 2), 600), mono: true };
  }
}

const RULE_LABEL: Record<string, string> = {
  addRules: "Always allow in this chat",
  setMode: "Allow all edits",
  addDirectories: "Allow this folder",
};

const primary = "rounded-md bg-[var(--txt)] px-2.5 py-1 text-[12px] font-medium text-[var(--bg)] disabled:opacity-50";
const plain = "rounded-md border border-[var(--bd)] px-2.5 py-1 text-[12px] text-[var(--txt)] hover:bg-[var(--panel-2)]";

function Permission({ ask, onAnswer }: { ask: ToolAsk; onAnswer: (a: Answer) => void }) {
  const d = describe(ask);
  const edits = ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(ask.tool);
  const rules = ask.suggestions.filter((s) => RULE_LABEL[str(s.type)] && (edits || s.type !== "setMode")).slice(0, 2);
  return (
    <>
      <p className="text-[13px] text-[var(--txt)]">{d.title}</p>
      {d.detail && (
        <pre
          className={`mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--bg)] px-2 py-1.5 text-[12px] text-[var(--txt-dim)] ${
            d.mono ? "font-mono" : "font-sans"
          }`}
        >
          {d.detail}
        </pre>
      )}
      {(ask.tool === "Bash" || ask.engine === "local") && ask.description && <p className="mt-1 text-[11px] text-[var(--txt-faint)]">{ask.description}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button className={primary} onClick={() => onAnswer({ behavior: "allow", updatedInput: ask.input })}>
          Allow once
        </button>
        {rules.map((s, k) => (
          <button
            key={k}
            className={plain}
            title="Stops asking for this until the chat's session restarts"
            onClick={() => onAnswer({ behavior: "allow", updatedInput: ask.input, updatedPermissions: [{ ...s, destination: "session" }] })}
          >
            {RULE_LABEL[str(s.type)]}
          </button>
        ))}
        <button className={plain} onClick={() => onAnswer({ behavior: "deny", message: "The user denied this action." })}>
          Deny
        </button>
      </div>
    </>
  );
}

const SKIPPED = "Skipped. Use your best judgment and say what you assumed.";

function Questions({ ask, onAnswer }: { ask: ToolAsk; onAnswer: (a: Answer) => void }) {
  const qs = ask.questions ?? [];
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const q = qs[at];
  const last = at === qs.length - 1;
  const value = (key: string, p = picked, o = other) => [...(p[key] ?? []), ...(o[key]?.trim() ? [o[key].trim()] : [])].join(", ");
  const finish = (p: Record<string, string[]>, o: Record<string, string>) => {
    if (!last) return setAt(at + 1);
    const answers: Record<string, string> = {};
    for (const x of qs) answers[x.question] = value(x.question, p, o) || SKIPPED;
    if (qs.every((x) => answers[x.question] === SKIPPED)) return onAnswer({ behavior: "deny", message: "The user skipped every question. Use your best judgment and say what you assumed." });
    onAnswer({ behavior: "allow", updatedInput: { ...ask.input, answers } });
  };
  const advance = (p = picked, o = other) => {
    if (value(q.question, p, o)) finish(p, o);
  };
  const skip = () => {
    const p = { ...picked, [q.question]: [] };
    const o = { ...other, [q.question]: "" };
    setPicked(p);
    setOther(o);
    finish(p, o);
  };
  if (!q) return null;
  return (
    <>
      {qs.length > 1 && (
        <p className="mb-1 text-[11px] text-[var(--txt-faint)]">
          Question {at + 1} of {qs.length}
        </p>
      )}
      <p className="text-[13px] text-[var(--txt)]">{q.question}</p>
      <div className="mt-1.5 flex flex-col gap-1">
        {q.options.map((o) => {
          const on = (picked[q.question] ?? []).includes(o.label);
          return (
            <button
              key={o.label}
              onClick={() => {
                const cur = picked[q.question] ?? [];
                const next = { ...picked, [q.question]: q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label] };
                setPicked(next);
                if (q.multiSelect) return;
                const typed = { ...other, [q.question]: "" };
                setOther(typed);
                advance(next, typed);
              }}
              className={`rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                on ? "border-[var(--txt-dim)] bg-[var(--panel-2)] text-[var(--txt)]" : "border-[var(--bd-soft)] text-[var(--txt)] hover:bg-[var(--panel-2)]"
              }`}
            >
              {o.label}
              {o.description && <span className="block text-[11px] text-[var(--txt-faint)]">{o.description}</span>}
            </button>
          );
        })}
        <input
          key={q.question}
          autoFocus={at > 0}
          value={other[q.question] ?? ""}
          onChange={(e) => {
            setOther((x) => ({ ...x, [q.question]: e.target.value }));
            if (!q.multiSelect) setPicked((p) => ({ ...p, [q.question]: [] }));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") advance();
          }}
          placeholder="Something else…"
          className="rounded-md border border-[var(--bd-soft)] bg-transparent px-2.5 py-1.5 text-[12px] text-[var(--txt)] placeholder:text-[var(--txt-faint)] focus:border-[var(--bd)] focus:outline-none"
        />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button className={primary} disabled={!value(q.question)} onClick={() => advance()}>
          {last ? "Send answer" : "Next"}
        </button>
        {at > 0 && (
          <button className={plain} onClick={() => setAt(at - 1)}>
            Back
          </button>
        )}
        <button className={plain} onClick={skip}>
          Skip
        </button>
      </div>
    </>
  );
}

export default function AskCard({ ask, onAnswer }: { ask: ToolAsk; onAnswer: (a: Answer) => void }) {
  return (
    <div className="mb-2 rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-2.5">
      {ask.questions?.length ? <Questions ask={ask} onAnswer={onAnswer} /> : <Permission ask={ask} onAnswer={onAnswer} />}
    </div>
  );
}
