/// <reference types="vite/client" />

declare module "*?url" {
  const src: string;
  export default src;
}

declare module "katex/contrib/auto-render" {
  const renderMathInElement: (element: HTMLElement, options?: unknown) => void;
  export default renderMathInElement;
}
