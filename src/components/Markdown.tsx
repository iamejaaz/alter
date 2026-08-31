import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";

marked.setOptions({ breaks: true, gfm: true });

export default function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);

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
    root.querySelectorAll("pre code").forEach((block) => {
      const el = block as HTMLElement;
      if (el.dataset.highlighted) return;
      hljs.highlightElement(el);
      const pre = el.parentElement;
      if (pre && !pre.querySelector(".copy-code")) {
        const btn = document.createElement("button");
        btn.textContent = "Copy";
        btn.className =
          "copy-code absolute top-2 right-2 rounded bg-zinc-800/80 px-2 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-100";
        btn.onclick = () => {
          navigator.clipboard.writeText(el.innerText);
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        };
        pre.style.position = "relative";
        pre.appendChild(btn);
      }
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className="prose-alter text-sm leading-relaxed [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_code]:font-mono [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-zinc-800 [&_:not(pre)>code]:text-zinc-100 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em] [&_a]:text-indigo-400 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_p]:my-1.5 [&_li]:my-0.5 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:border-zinc-700 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-zinc-800 [&_td]:px-2 [&_td]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-400 [&_details]:my-2 [&_details]:rounded-lg [&_details]:border [&_details]:border-zinc-700 [&_details]:bg-zinc-900/50 [&_summary]:cursor-pointer [&_summary]:select-none [&_summary]:px-3 [&_summary]:py-1.5 [&_summary]:text-[13px] [&_summary]:text-zinc-400 [&_summary]:marker:text-zinc-600 [&_details[open]>summary]:border-b [&_details[open]>summary]:border-zinc-700 [&_details[open]>summary]:text-zinc-200 [&_details>*:not(summary)]:px-3 [&_details>*:not(summary)]:py-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
