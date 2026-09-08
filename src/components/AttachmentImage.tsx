import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Attachment } from "../lib/store";

// Renders an attached image from memory, or loads it from disk when only the
// stored copy remains (images are stripped from localStorage on save).
export default function AttachmentImage({
  a,
  className,
  onPreview,
}: {
  a: Attachment;
  className: string;
  onPreview: (dataUrl: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(a.dataUrl ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (a.dataUrl) {
      setSrc(a.dataUrl);
      return;
    }
    if (!a.stored) {
      setFailed(true);
      return;
    }
    let live = true;
    invoke<string>("load_attachment", { id: a.id })
      .then((d) => live && setSrc(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [a.id, a.dataUrl, a.stored]);

  if (src) {
    return <img src={src} alt={a.name} onClick={() => onPreview(src)} className={className} />;
  }
  return (
    <div
      className={`${className} flex items-center justify-center bg-[var(--panel)] text-[10px] text-[var(--txt-faint)] text-center px-1 cursor-default`}
      title={a.name}
    >
      {failed ? "image unavailable" : "…"}
    </div>
  );
}
