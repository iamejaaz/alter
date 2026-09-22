// The mark is two overlapping lobes. `busy` makes them drift apart and back
// through each other, so the logo itself is the thinking indicator.
export default function Logo({ size = 20, busy = false }: { size?: number; busy?: boolean }) {
  const r = size * 0.34;
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size, ["--alter-drift" as string]: `${r * 0.55}px` }}
    >
      <span
        className={`absolute rounded-full bg-indigo-500${busy ? " alter-lobe-a" : ""}`}
        style={{ width: r * 2, height: r * 2, left: size / 2 - r * 1.35, top: size / 2 - r }}
      />
      <span
        className={`absolute rounded-full bg-indigo-300/80 mix-blend-screen${busy ? " alter-lobe-b" : ""}`}
        style={{ width: r * 2, height: r * 2, left: size / 2 - r * 0.65, top: size / 2 - r }}
      />
    </span>
  );
}
