import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";

marked.setOptions({ breaks: true, gfm: true });

export default function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const expanded = useRef<Set<number>>(new Set());

  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    try {
      renderMathInElement(root, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    } catch {
      /* ignore math errors */
    }
    root.querySelectorAll("pre code").forEach((block, idx) => {
      const el = block as HTMLElement;
      if (el.dataset.highlighted) return;
      const given = el.className.match(/language-(\S+)/)?.[1] ?? "";
      hljs.highlightElement(el);
      const pre = el.parentElement;
      if (!pre || pre.parentElement?.classList.contains("code-box")) return;
      const box = document.createElement("div");
      box.className = "code-box my-2 overflow-hidden rounded-lg bg-[var(--code-bg)]";
      const head = document.createElement("div");
      head.className = "flex items-center justify-between px-3 pt-1.5 text-[11px] text-[var(--txt-faint)]";
      const lang = document.createElement("span");
      lang.textContent = given.replace(/^plaintext$/, "");
      const btn = document.createElement("button");
      btn.textContent = "Copy";
      btn.className = "copy-code rounded px-1.5 py-0.5 hover:bg-[var(--panel-2)] hover:text-[var(--txt)]";
      btn.onclick = () => {
        navigator.clipboard.writeText(el.innerText);
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 1200);
      };
      head.append(lang, btn);
      pre.replaceWith(box);
      box.append(head, pre);
      const isOpen = expanded.current.has(idx);
      pre.className = `!my-0 !rounded-none !bg-transparent !pt-1 whitespace-pre-wrap [overflow-wrap:anywhere] !overflow-hidden ${isOpen ? "" : "max-h-80"}`;
      const more = document.createElement("button");
      more.className = "w-full border-t border-[var(--bd)] py-1 text-[11px] text-[var(--txt-dim)] hover:text-[var(--txt)]";
      more.textContent = isOpen ? "Show less" : "Show more";
      more.onclick = () => {
        const collapsed = pre.classList.toggle("max-h-80");
        if (collapsed) expanded.current.delete(idx);
        else expanded.current.add(idx);
        more.textContent = collapsed ? "Show more" : "Show less";
      };
      if (isOpen || pre.scrollHeight > pre.clientHeight + 4) box.append(more);
      else pre.classList.remove("max-h-80");
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className="prose-alter text-sm leading-[1.5] break-words [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--code-bg)] [&_pre]:p-3 [&_code]:font-mono [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-[var(--input)] [&_:not(pre)>code]:text-[var(--txt)] [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em] [&_a]:text-indigo-400 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_p]:my-2 [&_li]:my-0.5 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:border-[var(--bd)] [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-[var(--bd)] [&_td]:px-2 [&_td]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--bd)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--txt-dim)] [&_details]:my-2 [&_details]:rounded-lg [&_details]:border [&_details]:border-[var(--bd)] [&_details]:bg-[var(--panel)] [&_summary]:cursor-pointer [&_summary]:select-none [&_summary]:px-3 [&_summary]:py-1.5 [&_summary]:text-[13px] [&_summary]:text-[var(--txt-dim)] [&_summary]:marker:text-[var(--txt-faint)] [&_details[open]>summary]:border-b [&_details[open]>summary]:border-[var(--bd)] [&_details[open]>summary]:text-[var(--txt)] [&_details>*:not(summary)]:px-3 [&_details>*:not(summary)]:py-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
