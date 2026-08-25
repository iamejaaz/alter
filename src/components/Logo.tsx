export default function Logo({ size = 20 }: { size?: number }) {
  const r = size * 0.34;
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <span
        className="absolute rounded-full bg-indigo-500"
        style={{ width: r * 2, height: r * 2, left: size / 2 - r * 1.35, top: size / 2 - r }}
      />
      <span
        className="absolute rounded-full bg-indigo-300/80 mix-blend-screen"
        style={{ width: r * 2, height: r * 2, left: size / 2 - r * 0.65, top: size / 2 - r }}
      />
    </span>
  );
}
