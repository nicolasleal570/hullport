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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[9vh] bg-black/35 fadein" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[82vh] flex flex-col rounded-[12px] border border-line-strong bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
        style={{ width }}
      >
        <div className="px-5 pt-4 pb-3">
          <div className="text-[14px] font-semibold">{title}</div>
          {subtitle && <div className="text-fg2 text-[12px] mt-0.5">{subtitle}</div>}
        </div>
        <div className="px-5 pb-4 overflow-auto min-h-0">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-line flex justify-end gap-2">{footer}</div>}
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
            className={cx("h-[24px] px-3 rounded-[6px] text-[12.5px] font-medium text-white", r.danger ? "bg-bad" : "bg-accent")}
          >
            {r.confirmLabel ?? "OK"}
          </button>
        </>
      }
    >
      <div className="flex gap-3">
        {r.danger && <div className="text-bad mt-0.5"><IconWarn size={20} /></div>}
        <div className="text-[12.5px] text-fg2 leading-relaxed flex-1 min-w-0 break-words">
          {r.message}
          {r.option && <div className="mt-3 text-fg"><Checkbox checked={opt} onChange={setOpt} label={r.option.label} hint={r.option.hint} /></div>}
        </div>
      </div>
    </Modal>
  );
}
