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
    <aside className="w-[45%] min-w-[360px] shrink-0 flex flex-col border-l border-white/[0.06] bg-[#0c0c0e]">
      <div className="flex items-center gap-2 h-12 px-4 shrink-0 border-b border-white/[0.06]">
        <span className="flex-1 text-sm font-medium text-zinc-300">Preview</span>
        <div className="flex rounded-lg bg-white/[0.04] p-0.5">
          {(["preview", "code"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-2.5 py-1 text-xs capitalize transition-colors ${
                view === v ? "bg-white/[0.08] text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(artifact.code)}
          className="rounded-lg hover:bg-white/[0.06] px-2.5 py-1.5 text-xs text-zinc-400 transition-colors"
        >
          Copy
        </button>
        <button
          onClick={onClose}
          className="rounded-lg hover:bg-white/[0.06] px-2 py-1.5 text-zinc-400 transition-colors"
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
          <pre className="h-full overflow-auto bg-zinc-950 p-4 text-xs font-mono text-zinc-200 whitespace-pre-wrap">
            {artifact.code}
          </pre>
        )}
      </div>
    </aside>
  );
}
