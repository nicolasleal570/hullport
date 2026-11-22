import { useEffect, useRef, useState, type ReactNode } from "react";
import { getUi, setSearch, setUi, useUi, type Section } from "../lib/store";
import { IconSearch, IconX } from "./icons";
import { cx } from "./ui";

/** Top bar of a section: title, count, search, actions. Draggable like a macOS toolbar. */
export function Toolbar({ section, title, count, children, filters }: {
  section: Section; title: string; count?: number; children?: ReactNode; filters?: ReactNode;
}) {
  const q = useUi((s) => s.search[section] ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "f" && getUi().section === section) { e.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [section]);
  return (
    <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-2 pl-4 pr-3 bg-tile border-b border-line">
      <div data-tauri-drag-region className="flex items-baseline gap-2 min-w-0">
        <h1 data-tauri-drag-region className="text-headline font-semibold">{title}</h1>
        {count != null && <span data-tauri-drag-region className="text-fg3 text-caption font-medium tabular-nums">{count}</span>}
      </div>
      {filters && <div className="ml-2">{filters}</div>}
      <div data-tauri-drag-region className="flex-1 h-full" />
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3 pointer-events-none"><IconSearch size={13} /></span>
        <input
          ref={input}
          value={q}
          onChange={(e) => setSearch(section, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setSearch(section, ""); input.current?.blur(); } }}
          placeholder="Search"
          aria-label={`Search ${title}`}
          className="field w-[200px] pl-8 pr-7"
        />
        {q && (
          <button onClick={() => setSearch(section, "")} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg3 hover:text-fg" aria-label="Clear search">
            <IconX size={12} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

/** List on the left, inspector on the right, with a draggable divider. */
export function MasterDetail({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  const width = useUi((s) => s.listWidth);
  const [drag, setDrag] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      setUi({ listWidth: Math.round(Math.min(Math.max(e.clientX - r.left, 360), r.width - 340)) });
    };
    const up = () => setDrag(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [drag]);
  return (
    <div ref={box} className={cx("flex-1 min-h-0 flex", drag && "cursor-col-resize select-none")}>
      <div className="min-w-0 h-full bg-tile" style={{ width, flex: "none" }}>{list}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(e) => { e.preventDefault(); setDrag(true); }}
        className="w-[5px] -mx-[2px] z-10 cursor-col-resize group flex justify-center shrink-0"
      >
        <div className={cx("h-full", drag ? "w-[2px] bg-fg3" : "w-px bg-line group-hover:bg-line-strong")} />
      </div>
      <div className="flex-1 min-w-0 h-full bg-bg">{detail}</div>
    </div>
  );
}

/** Header of the inspector: icon, title, subtitle, actions, tabs. A tile strip over the window background. */
export function DetailHeader({ icon, title, subtitle, actions, tabs }: {
  icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; tabs?: ReactNode;
}) {
  return (
    <div className="shrink-0 bg-tile border-b border-line px-4 pt-3 pb-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && <div className="w-8 h-8 rounded-control bg-well flex items-center justify-center text-fg2 shrink-0">{icon}</div>}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-body truncate selectable">{title}</div>
          {subtitle && <div className="text-fg2 text-caption truncate">{subtitle}</div>}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">{actions}</div>
      </div>
      {tabs && <div className="mt-2.5">{tabs}</div>}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <pre className="mono text-caption leading-[1.5] p-3 m-0 whitespace-pre-wrap break-all selectable text-fg">
      {text}
    </pre>
  );
}
