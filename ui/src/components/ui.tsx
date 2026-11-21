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
        "inline-flex items-center gap-1.5 h-[24px] px-2.5 rounded-[6px] text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:opacity-45",
        kind === "primary" && "bg-accent text-white hover:brightness-110",
        kind === "danger" && "bg-bad text-white hover:brightness-110",
        kind === "default" && "bg-raised border border-line-strong hover:bg-hover",
        kind === "ghost" && "hover:bg-hover text-fg2 hover:text-fg",
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
        "inline-flex items-center justify-center w-[26px] h-[24px] rounded-[6px] text-fg2 hover:text-fg hover:bg-hover disabled:opacity-35 disabled:hover:bg-transparent transition-colors",
        active && "bg-hover text-fg",
        tone === "bad" && "hover:text-bad",
        className,
      )}
    >
      {children}
    </button>
  );
}

const toneColor: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-fg3" };
export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={cx("inline-block w-[7px] h-[7px] rounded-full shrink-0", toneColor[tone], pulse && "pulse")} />;
}

export function Badge({ children, tone = "idle", title, plain }: { children: ReactNode; tone?: Tone | "accent"; title?: string; plain?: boolean }) {
  const c = {
    ok: "text-ok bg-ok/12", warn: "text-warn bg-warn/14", bad: "text-bad bg-bad/12",
    idle: "text-fg2 bg-fg3/15", accent: "text-accent bg-accent-soft",
  }[tone];
  return <span title={title} className={cx("inline-flex items-center h-[17px] px-1.5 rounded-[4px] whitespace-nowrap", plain ? "text-[11px] font-medium mono" : "text-[10.5px] font-semibold tracking-wide uppercase", c)}>{children}</span>;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-10 gap-2 fadein">
      {icon && <div className="text-fg3 mb-1 [&>svg]:w-9 [&>svg]:h-9">{icon}</div>}
      <div className="text-[14px] font-semibold text-fg">{title}</div>
      {children && <div className="text-fg2 max-w-[380px] text-[12.5px] leading-relaxed">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="h-full flex items-center justify-center gap-2 text-fg2 text-[12.5px]">
      <IconSpinner /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="m-3 p-3 rounded-lg border border-bad/30 bg-bad/8 text-[12.5px] selectable">
      <div className="font-semibold text-bad mb-1">Something went wrong</div>
      <div className="text-fg2 whitespace-pre-wrap break-words">{String((error as any)?.message ?? error)}</div>
      {onRetry && <div className="mt-2"><Button onClick={onRetry}>Try again</Button></div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; icon?: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex items-center gap-0.5 p-[2px] rounded-[7px] bg-field" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "h-[22px] px-2.5 rounded-[5px] text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors",
            value === t.id ? "bg-raised text-fg shadow-[0_0.5px_2px_rgba(0,0,0,0.25)]" : "text-fg2 hover:text-fg",
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
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg3">{title}</h3>
        {right}
      </div>
      <div className="rounded-[9px] border border-line bg-panel overflow-hidden">{children}</div>
    </section>
  );
}

export function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-3 py-[6px] border-b border-line last:border-b-0 min-h-[28px]">
      <div className="w-[118px] shrink-0 text-fg2 text-[12px] pt-[1px] truncate" title={label}>{label}</div>
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
      className="w-[20px] h-[20px]"
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </IconButton>
  );
}

export function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-[12.5px] py-0.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-[2px] accent-[var(--c-accent)]" />
      <span>{label}{hint && <span className="block text-fg3 text-[11.5px]">{hint}</span>}</span>
    </label>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11.5px] text-fg2 font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-fg3">{hint}</span>}
    </label>
  );
}

export function Progress({ value }: { value: number | null }) {
  return (
    <div className="h-[4px] rounded-full bg-field overflow-hidden">
      <div
        className={cx("h-full bg-accent transition-[width] duration-200", value == null && "w-1/3 pulse")}
        style={value != null ? { width: `${Math.min(100, Math.max(0, value * 100))}%` } : undefined}
      />
    </div>
  );
}
