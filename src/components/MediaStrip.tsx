import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const PATH = /(?:^|[\s`'"(<\[])((?:~\/|\/|\.\/)[^\s`'"()<>\[\]]+?\.(?:png|jpe?g|gif|webp|svg|mp4|mov|webm|m4v))(?=$|[\s`'"),.:;!?>\]])/gim;

export function mediaPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH)) if (!out.includes(m[1])) out.push(m[1]);
  return out.slice(0, 12);
}

interface Item {
  kind: "image" | "video";
  path: string;
}

export default function MediaStrip({ text, base, onPreview }: { text: string; base?: string | null; onPreview: (src: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const key = mediaPaths(text).join("\n");
  useEffect(() => {
    let gone = false;
    const paths = key ? key.split("\n") : [];
    if (!paths.length) return setItems([]);
    void Promise.all(paths.map((path) => invoke<Item | null>("media_allow", { path, base: base ?? null }).catch(() => null))).then((r) => {
      if (gone) return;
      const seen = new Set<string>();
      setItems(r.filter((x): x is Item => !!x && !seen.has(x.path) && !!seen.add(x.path)));
    });
    return () => {
      gone = true;
    };
  }, [key, base]);
  if (!items.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((it) => {
        const src = convertFileSrc(it.path);
        const name = it.path.split("/").pop();
        return (
          <figure key={it.path} className="group/m relative overflow-hidden rounded-lg border border-[var(--bd-soft)] bg-[var(--panel)]">
            {it.kind === "image" ? (
              <img src={src} alt={name} onClick={() => onPreview(src)} className="block max-h-64 max-w-[320px] cursor-zoom-in object-contain" />
            ) : (
              <video src={src} controls preload="metadata" className="block max-h-72 max-w-[420px]" />
            )}
            <figcaption className="flex items-center gap-2 px-2 py-1 text-[11px] text-[var(--txt-faint)]">
              <span className="min-w-0 flex-1 truncate" title={it.path}>
                {name}
              </span>
              <button onClick={() => void invoke("media_reveal", { path: it.path })} className="shrink-0 hover:text-[var(--txt)]">
                Show in Finder
              </button>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
