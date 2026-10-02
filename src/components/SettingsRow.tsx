import React from "react";

export const field =
  "w-full rounded-lg bg-[var(--input)] border border-[var(--bd)] px-2.5 py-1.5 text-[13px] focus:outline-none focus:border-[var(--txt-faint)]";
export const action =
  "shrink-0 rounded-lg border border-[var(--bd)] bg-[var(--panel)] px-3 py-1.5 text-[13px] text-[var(--txt)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition-colors";

export default function Row({
  title,
  desc,
  control,
  children,
}: {
  title: string;
  desc?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--bd-soft)] py-4 last:border-b-0">
      <div className="flex items-center gap-6">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-[var(--txt)]">{title}</p>
          {desc && <p className="mt-0.5 text-[13px] leading-snug text-[var(--txt-faint)]">{desc}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
