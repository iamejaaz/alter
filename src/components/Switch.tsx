export default function Switch({ on, onChange, title }: { on: boolean; onChange: () => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      title={title}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors ${on ? "bg-[var(--txt)]" : "bg-zinc-600"}`}
    >
      <span
        className={`absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full transition-transform ${
          on ? "translate-x-[12px] bg-[var(--bg)]" : "bg-white"
        }`}
      />
    </button>
  );
}
