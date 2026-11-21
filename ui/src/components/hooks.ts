import { useEffect, useRef } from "react";

/** ⌘+key shortcut while the component is mounted. */
export function useShortcut(key: string, fn: () => void, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const k = (e: KeyboardEvent) => {
      if (e.metaKey && !e.altKey && e.key.toLowerCase() === key) {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [key, enabled]);
}
