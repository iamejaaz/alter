import { Chevron } from "./Icons";

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  title?: string;
}

// A native <select> that is only as wide as its selected label: the invisible
// span sets the grid cell's width and the select stretches over it.
export default function ComposerSelect({ value, onChange, options, title }: Props) {
  const label = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? "";
  return (
    <div className="relative inline-block max-w-[220px]">
      <span className="invisible block truncate whitespace-nowrap pl-1.5 pr-5 py-1 font-medium">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={title}
        className="absolute inset-0 h-full w-full min-w-0 appearance-none truncate bg-transparent rounded-md hover:bg-[var(--panel-2)] pl-1.5 pr-5 py-1 font-medium text-[var(--txt-dim)] hover:text-[var(--txt)] focus:outline-none cursor-pointer transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[var(--modal)]">
            {o.label}
          </option>
        ))}
      </select>
      <Chevron />
    </div>
  );
}
