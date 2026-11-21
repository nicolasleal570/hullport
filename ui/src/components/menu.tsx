import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cx } from "./ui";

export type MenuItem =
  | { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; shortcut?: string }
  | "sep";

let menu: { x: number; y: number; items: MenuItem[] } | null = null;
const ls = new Set<() => void>();
const set = (m: typeof menu) => { menu = m; ls.forEach((l) => l()); };

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  set({ x: e.clientX, y: e.clientY, items });
}
export function openMenuAt(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  set({ x: r.left, y: r.bottom + 4, items });
}

export function MenuHost() {
  const m = useSyncExternalStore((cb) => { ls.add(cb); return () => ls.delete(cb); }, () => menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    if (!m || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(m.x, window.innerWidth - r.width - 6),
      y: m.y + r.height > window.innerHeight - 6 ? Math.max(6, m.y - r.height) : m.y,
    });
    setActive(-1);
  }, [m]);

  useEffect(() => {
    if (!m) return;
    const close = () => set(null);
    const key = (e: KeyboardEvent) => {
      const items = m.items.map((it, i) => [it, i] as const).filter(([it]) => it !== "sep" && !it.disabled).map(([, i]) => i);
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => items.find((i) => i > a) ?? items[0]); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => [...items].reverse().find((i) => i < a) ?? items[items.length - 1]); }
      else if (e.key === "Enter") {
        const it = m.items[active];
        if (it && it !== "sep") { e.preventDefault(); close(); it.onClick(); }
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key, true);
    };
  }, [m, active]);

  if (!m) return null;
  return (
    <div
      ref={ref}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[100] min-w-[190px] py-[5px] px-[5px] rounded-[9px] border border-line-strong bg-raised/95 backdrop-blur-xl shadow-[0_10px_30px_rgba(0,0,0,0.35)] text-[13px]"
      style={{ left: pos?.x ?? m.x, top: pos?.y ?? m.y, visibility: pos ? "visible" : "hidden" }}
    >
      {m.items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="h-px my-[4px] mx-1.5 bg-line-strong" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => { set(null); it.onClick(); }}
            className={cx(
              "w-full flex items-center gap-2 h-[24px] px-2 rounded-[5px] text-left disabled:opacity-40",
              active === i && !it.disabled && "bg-accent text-white",
              it.danger && active !== i && "text-bad",
            )}
          >
            <span className="w-4 flex justify-center opacity-90">{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className={cx("text-[11.5px]", active === i ? "text-white/80" : "text-fg3")}>{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
