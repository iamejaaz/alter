// Best-known context windows per model family, in tokens. Unknown → null (hidden in the UI).
const WINDOWS: [RegExp, number][] = [
  [/haiku|claude-3/i, 200_000],
  [/claude|opus|sonnet/i, 1_000_000],
  [/gemini/i, 1_048_576],
  [/gpt-4\.1/i, 1_047_576],
  [/gpt-5/i, 400_000],
  [/^o[1-4]\b/i, 200_000],
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/deepseek/i, 128_000],
  [/kimi|moonshot/i, 128_000],
  [/qwen|llama|mistral|mixtral|glm|grok/i, 128_000],
];

export function contextWindowFor(model: string | undefined, claudeCode: boolean): number | null {
  const id = (model || "").trim();
  if (claudeCode && (!id || id === "claude-code")) return 1_000_000;
  for (const [re, n] of WINDOWS) if (re.test(id)) return n;
  return null;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 100_000 ? 0 : 1) + "k";
  return String(n);
}
