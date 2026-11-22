import { useMemo, useRef, useState, type ReactNode } from "react";
import { IconChevron, IconChevronDown } from "./icons";
import { cx } from "./ui";

export interface Column<T> {
  id: string;
  header: string;
  /** CSS grid track, e.g. "1fr" or "90px". */
  width: string;
  cell: (row: T) => ReactNode;
  sort?: (a: T, b: T) => number;
  align?: "right";
}

export interface Group<T> { key: string; rows: T[] }

interface Props<T> {
  rows: T[];
  rowKey: (r: T) => string;
  columns: Column<T>[];
  selected?: string | null;
  onSelect: (key: string) => void;
  onOpen?: (key: string) => void;
  onDelete?: (key: string) => void;
  onContextMenu?: (e: React.MouseEvent, row: T) => void;
  rowActions?: (row: T) => ReactNode;
  defaultSort?: { id: string; desc?: boolean };
  groupBy?: (r: T) => string | undefined;
  renderGroup?: (g: Group<T>, collapsed: boolean, toggle: () => void) => ReactNode;
  collapsed?: Record<string, boolean>;
  onToggleGroup?: (key: string) => void;
  dim?: (r: T) => boolean;
  label: string;
  /** Controlled sort (e.g. from the toolbar's Sort menu). */
  sort?: { id: string; desc?: boolean };
  onSortChange?: (s: { id: string; desc?: boolean }) => void;
  /** Sorts that have no visible column (e.g. "Number of Containers"). */
  extraSorts?: Record<string, (a: T, b: T) => number>;
}

export function Table<T>(p: Props<T>) {
  const [ownSort, setOwnSort] = useState(p.defaultSort ?? { id: p.columns[0].id, desc: false });
  const sort = p.sort ?? ownSort;
  const setSort = (f: (s: { id: string; desc?: boolean }) => { id: string; desc?: boolean }) => {
    const next = f(sort);
    if (p.onSortChange) p.onSortChange(next); else setOwnSort(next);
  };
  const ref = useRef<HTMLDivElement>(null);
  const grid = { gridTemplateColumns: p.columns.map((c) => c.width).join(" ") };

  const sorted = useMemo(() => {
    const fn = p.columns.find((c) => c.id === sort.id)?.sort ?? p.extraSorts?.[sort.id];
    const rows = [...p.rows];
    if (fn) rows.sort((a, b) => (sort.desc ? -1 : 1) * fn(a, b));
    return rows;
  }, [p.rows, p.columns, p.extraSorts, sort.id, sort.desc]);

  const layout = useMemo(() => {
    if (!p.groupBy) return { groups: [] as Group<T>[], loose: sorted };
    const map = new Map<string, T[]>();
    const loose: T[] = [];
    for (const r of sorted) {
      const g = p.groupBy(r);
      if (g) { if (!map.has(g)) map.set(g, []); map.get(g)!.push(r); } else loose.push(r);
    }
    const groups = [...map.entries()].map(([key, rows]) => ({ key, rows })).sort((a, b) => a.key.localeCompare(b.key));
    return { groups, loose };
  }, [sorted, p.groupBy]);

  const visible = useMemo(() => {
    const out: T[] = [];
    for (const g of layout.groups) if (!p.collapsed?.[g.key]) out.push(...g.rows);
    out.push(...layout.loose);
    return out;
  }, [layout, p.collapsed]);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const idx = visible.findIndex((r) => p.rowKey(r) === p.selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx - 1);
      const row = visible[next];
      if (row) {
        p.onSelect(p.rowKey(row));
        ref.current?.querySelector(`[data-key="${CSS.escape(p.rowKey(row))}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter" && p.selected) {
      p.onOpen?.(p.selected);
    } else if ((e.key === "Backspace" || e.key === "Delete") && e.metaKey && p.selected) {
      e.preventDefault();
      p.onDelete?.(p.selected);
    }
  };

  const renderRow = (r: T, indent: boolean) => {
    const key = p.rowKey(r);
    const sel = key === p.selected;
    const actions = p.rowActions?.(r);
    return (
      <div
        key={key}
        data-key={key}
        role="row"
        aria-selected={sel}
        onMouseDown={() => p.onSelect(key)}
        onDoubleClick={() => p.onOpen?.(key)}
        onContextMenu={(e) => { p.onSelect(key); p.onContextMenu?.(e, r); }}
        // Inset rounded rows; the selected one takes the selected fill and re-points its contents (`.on-sel`).
        className={cx(
          "group relative grid items-center gap-x-3 mx-1 px-3 min-h-[34px] rounded-control",
          sel ? "bg-sel on-sel" : "hover:bg-hover",
          p.dim?.(r) && !sel && "opacity-60",
        )}
        style={grid}
      >
        {p.columns.map((c, i) => (
          <div key={c.id} role="cell" className={cx("min-w-0 truncate", c.align === "right" && "text-right", i === 0 && indent && "pl-5")}>
            {c.cell(r)}
          </div>
        ))}
        {/* The actions float over the row's right end, only on the selected or hovered row, so the columns keep
            the full width. The hover fill is translucent: an opaque tile under it hides the cells beneath. */}
        {actions && (
          <div className={cx("absolute inset-y-0 right-0 rounded-r-control", sel ? "bg-sel" : "invisible group-hover:visible bg-tile")}>
            <div className={cx("h-full flex items-center gap-0.5 px-2 rounded-r-control", !sel && "bg-hover")}>{actions}</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={onKey}
      role="table"
      aria-label={p.label}
      className="h-full overflow-y-auto overflow-x-hidden pb-1 outline-none focus-visible:outline-none focus-visible:shadow-none"
    >
      <div
        role="row"
        className="sticky top-0 z-10 grid items-center gap-x-3 px-4 h-[28px] mb-1 border-b border-line bg-tile text-caption text-fg2 font-medium"
        style={grid}
      >
        {p.columns.map((c, i) => (
          <button
            key={c.id}
            role="columnheader"
            disabled={!c.sort}
            onClick={() => setSort((s) => ({ id: c.id, desc: s.id === c.id ? !s.desc : false }))}
            className={cx("flex items-center gap-1 min-w-0 text-left hover:text-fg disabled:hover:text-fg2", c.align === "right" && "justify-end", i === 0 && p.groupBy && "pl-0")}
          >
            <span className="truncate">{c.header}</span>
            {sort.id === c.id && c.sort && (sort.desc ? <IconChevronDown size={10} /> : <IconChevronDown size={10} className="rotate-180" />)}
          </button>
        ))}
      </div>
      {layout.groups.map((g) => {
        const collapsed = !!p.collapsed?.[g.key];
        const toggle = () => p.onToggleGroup?.(g.key);
        return (
          <div key={"g:" + g.key} role="rowgroup">
            <div
              onClick={toggle}
              className="flex items-center gap-1.5 mx-1 px-3 h-[32px] rounded-control hover:bg-hover"
            >
              <span className="text-fg3 w-3">{collapsed ? <IconChevron size={12} /> : <IconChevronDown size={12} />}</span>
              {p.renderGroup ? p.renderGroup(g, collapsed, toggle) : <span className="font-medium">{g.key}</span>}
            </div>
            {!collapsed && g.rows.map((r) => renderRow(r, true))}
          </div>
        );
      })}
      {layout.loose.map((r) => renderRow(r, false))}
    </div>
  );
}
