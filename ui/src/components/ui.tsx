import { writeText } from "./clipboard";
import { useState, type ReactNode } from "react";
import { IconCheck, IconCopy, IconSpinner } from "./icons";
import type { Tone } from "../lib/format";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Button({
  children, onClick, kind = "default", disabled, title, type = "button", className, busy,
}: {
  children: ReactNode; onClick?: () => void; kind?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean; title?: string; type?: "button" | "submit"; className?: string; busy?: boolean;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled || busy}
      onClick={onClick}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 h-[28px] px-3.5 rounded-full text-body font-semibold whitespace-nowrap",
        "transition-[background-color,color,transform] hover:duration-100 active:scale-[.97] motion-reduce:active:scale-100",
        "disabled:opacity-40 disabled:active:scale-100",
        // Primary: graphite on light, white on dark. One per view: the action that finishes it.
        kind === "primary" && "bg-primary text-on-primary hover:bg-primary-hover disabled:hover:bg-primary",
        // Default and danger: a tile pill with an edge; danger only changes the text.
        (kind === "default" || kind === "danger") && "bg-tile border border-line-strong hover:bg-well-hover disabled:hover:bg-tile",
        kind === "danger" && "text-bad",
        kind === "ghost" && "px-3 text-fg2 hover:text-fg hover:bg-hover disabled:hover:bg-transparent",
        className,
      )}
    >
      {busy && <IconSpinner size={12} />}
      {children}
    </button>
  );
}

export function IconButton({
  children, onClick, title, disabled, active, className, tone,
}: {
  children: ReactNode; onClick?: (e: React.MouseEvent) => void; title: string; disabled?: boolean;
  active?: boolean; className?: string; tone?: "bad";
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      className={cx(
        "inline-flex items-center justify-center w-[28px] h-[28px] rounded-control text-fg2 hover:text-fg hover:bg-hover hover:duration-100",
        "transition-[background-color,color,transform] active:scale-[.97] motion-reduce:active:scale-100",
        "disabled:opacity-35 disabled:hover:bg-transparent disabled:active:scale-100",
        active && "bg-well text-fg",
        tone === "bad" && "hover:text-bad",
        className,
      )}
    >
      {children}
    </button>
  );
}

// Volt and amber dots get a darker edge where the surface is light (`--c-*-edge`).
const toneColor: Record<Tone, string> = {
  ok: "bg-ok-fill ring-1 ring-inset ring-ok-edge", warn: "bg-warn-fill ring-1 ring-inset ring-warn-edge", bad: "bg-bad", idle: "bg-fg3",
};
export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={cx("inline-block w-[7px] h-[7px] rounded-full shrink-0", toneColor[tone], pulse && "pulse")} />;
}

/** `strong` is the neutral tone that stands out from `idle`: no hue, more ink. */
export function Badge({ children, tone = "idle", title, plain }: { children: ReactNode; tone?: Tone | "strong"; title?: string; plain?: boolean }) {
  const c = {
    ok: "text-ok bg-ok-fill/25", warn: "text-warn bg-warn-fill/22", bad: "text-bad bg-bad/10",
    idle: "text-fg2 bg-fg3/15", strong: "text-fg bg-fg/10",
  }[tone];
  return <span title={title} className={cx("inline-flex items-center h-[18px] px-1.5 rounded-label whitespace-nowrap text-badge tabular-nums", plain ? "font-medium mono" : "font-semibold", c)}>{children}</span>;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-10 gap-2 fadein">
      {icon && <div className="text-fg3 mb-1 [&>svg]:w-9 [&>svg]:h-9">{icon}</div>}
      <div className="text-headline font-semibold text-fg">{title}</div>
      {children && <div className="text-fg2 max-w-[380px] text-body leading-relaxed">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="h-full flex items-center justify-center gap-2 text-fg2 text-body">
      <IconSpinner /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="m-3 p-3 rounded-card border border-bad/30 bg-bad/8 text-body selectable">
      <div className="font-semibold text-bad mb-1">Something went wrong</div>
      <div className="text-fg2 whitespace-pre-wrap break-words">{String((error as any)?.message ?? error)}</div>
      {onRetry && <div className="mt-2"><Button onClick={onRetry}>Try again</Button></div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; icon?: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 p-[3px] rounded-well bg-well" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "h-[24px] px-2.5 rounded-control text-caption font-medium inline-flex items-center gap-1.5 transition-colors hover:duration-100",
            // The selected segment takes the selected fill: graphite in light mode, Volt in dark mode.
            value === t.id ? "bg-sel on-sel" : "text-fg2 hover:text-fg hover:bg-well-hover",
          )}
        >
          {t.icon}{t.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mb-4">
      <div className="flex items-center justify-between mb-1.5 px-1 min-h-[20px]">
        <h3 className="text-caption font-semibold text-fg2">{title}</h3>
        {right}
      </div>
      <div className="card overflow-hidden">{children}</div>
    </section>
  );
}

export function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-3 py-[6px] border-b border-line last:border-b-0 min-h-[28px]">
      <div className="w-[118px] shrink-0 text-fg2 text-caption pt-[1px] truncate" title={label}>{label}</div>
      <div className={cx("flex-1 min-w-0 break-words selectable", mono && "mono")}>{children ?? <span className="text-fg3">—</span>}</div>
    </div>
  );
}

export function CopyButton({ text, title = "Copy" }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      title={title}
      onClick={async () => { await writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }}
      className="w-[22px] h-[22px] rounded-label"
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </IconButton>
  );
}

export function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-body py-0.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-[2px]" />
      <span>{label}{hint && <span className="block text-fg3 text-caption">{hint}</span>}</span>
    </label>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-caption text-fg2 font-medium">{label}</span>
      {children}
      {hint && <span className="text-badge text-fg3">{hint}</span>}
    </label>
  );
}

export function Progress({ value }: { value: number | null }) {
  return (
    <div className="h-[4px] rounded-full bg-well overflow-hidden">
      <div
        className={cx("h-full bg-fg rounded-full transition-[width] duration-200", value == null && "w-1/3 pulse")}
        style={value != null ? { width: `${Math.min(100, Math.max(0, value * 100))}%` } : undefined}
      />
    </div>
  );
}
