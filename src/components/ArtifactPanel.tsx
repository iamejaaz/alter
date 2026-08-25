import { useState } from "react";

export interface Artifact {
  lang: string;
  code: string;
}

export default function ArtifactPanel({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [view, setView] = useState<"preview" | "code">("preview");

  const srcDoc =
    artifact.lang === "svg"
      ? `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#fff">${artifact.code}</body></html>`
      : artifact.code;

  return (
    <aside className="w-[45%] min-w-[360px] shrink-0 flex flex-col border-l border-[var(--bd-soft)] bg-[var(--bg)]">
      <div className="flex items-center gap-2 h-12 px-4 shrink-0 border-b border-[var(--bd-soft)]">
        <span className="flex-1 text-sm font-medium text-[var(--txt)]">Preview</span>
        <div className="flex rounded-lg bg-[var(--panel)] p-0.5">
          {(["preview", "code"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-2.5 py-1 text-xs capitalize transition-colors ${
                view === v ? "bg-[var(--panel-2)] text-[var(--txt)]" : "text-[var(--txt-dim)] hover:text-[var(--txt)]"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(artifact.code)}
          className="rounded-lg hover:bg-[var(--panel-2)] px-2.5 py-1.5 text-xs text-[var(--txt-dim)] transition-colors"
        >
          Copy
        </button>
        <button
          onClick={onClose}
          className="rounded-lg hover:bg-[var(--panel-2)] px-2 py-1.5 text-[var(--txt-dim)] transition-colors"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-white">
        {view === "preview" ? (
          <iframe
            title="artifact"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <pre className="h-full overflow-auto bg-zinc-950 p-4 text-xs font-mono text-[var(--txt)] whitespace-pre-wrap">
            {artifact.code}
          </pre>
        )}
      </div>
    </aside>
  );
}
