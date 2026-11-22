import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Checkbox, cx } from "./ui";
import { IconWarn } from "./icons";

export function Modal({
  title, children, footer, onClose, width = 520, subtitle,
}: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[9vh] bg-scrim fadein" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[82vh] flex flex-col rounded-panel border border-edge bg-tile shadow-floating"
        style={{ width }}
      >
        <div className="px-5 pt-5 pb-3">
          <div className="text-headline font-semibold">{title}</div>
          {subtitle && <div className="text-fg2 text-caption mt-0.5">{subtitle}</div>}
        </div>
        <div className="px-5 pb-4 overflow-auto min-h-0">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-line flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmReq {
  title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean;
  option?: { label: string; hint?: string; default?: boolean };
  resolve: (r: { ok: boolean; option: boolean }) => void;
}
let req: ConfirmReq | null = null;
const ls = new Set<() => void>();
const set = (r: ConfirmReq | null) => { req = r; ls.forEach((l) => l()); };

/** Ask before a destructive action. Resolves to { ok, option }. */
export function confirmAction(o: Omit<ConfirmReq, "resolve">) {
  return new Promise<{ ok: boolean; option: boolean }>((resolve) => set({ ...o, resolve }));
}

export function ConfirmHost() {
  const r = useSyncExternalStore((cb) => { ls.add(cb); return () => ls.delete(cb); }, () => req);
  const [opt, setOpt] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpt(!!r?.option?.default); }, [r]);
  if (!r) return null;
  const done = (ok: boolean) => { set(null); r.resolve({ ok, option: opt }); };
  return (
    <Modal
      title={r.title}
      onClose={() => done(false)}
      width={420}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <button
            ref={btn}
            autoFocus
            onClick={() => done(true)}
            // Confirming a destructive action is the one place Ember fills a button (white text passes 4.5:1).
            className={cx(
              "inline-flex items-center h-[28px] px-3.5 rounded-full text-body font-semibold transition-[background-color,transform] hover:duration-100 active:scale-[.97] motion-reduce:active:scale-100",
              r.danger ? "bg-danger-fill hover:bg-danger-fill-hover text-on-danger" : "bg-primary hover:bg-primary-hover text-on-primary",
            )}
          >
            {r.confirmLabel ?? "OK"}
          </button>
        </>
      }
    >
      <div className="flex gap-3">
        {r.danger && <div className="text-bad mt-0.5"><IconWarn size={20} /></div>}
        <div className="text-body text-fg2 leading-relaxed flex-1 min-w-0 break-words">
          {r.message}
          {r.option && <div className="mt-3 text-fg"><Checkbox checked={opt} onChange={setOpt} label={r.option.label} hint={r.option.hint} /></div>}
        </div>
      </div>
    </Modal>
  );
}
