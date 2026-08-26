type Opener = (message: string) => void;

let opener: Opener | null = null;
let resolver: ((v: boolean) => void) | null = null;

export function registerConfirm(fn: Opener | null) {
  opener = fn;
}

export function resolveConfirm(value: boolean) {
  const r = resolver;
  resolver = null;
  r?.(value);
}

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!opener) {
      resolve(typeof window !== "undefined" ? window.confirm(message) : true);
      return;
    }
    resolver = resolve;
    opener(message);
  });
}
