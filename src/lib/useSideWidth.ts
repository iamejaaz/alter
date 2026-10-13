import { useEffect, useRef, useState } from "react";

export function useSideWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return saved >= min && saved <= max ? saved : initial;
  });
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(max, Math.max(min, window.innerWidth - e.clientX)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(key, String(width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [width, key, min, max]);
  const startDrag = () => {
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return { width, startDrag };
}
