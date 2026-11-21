import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { bytes } from "../../lib/format";
import { queryClient } from "../../lib/queries";
import { toast } from "../../lib/toast";
import type { PullInfo } from "../../lib/types";
import { Modal } from "../../components/dialog";
import { Button, Field, Progress } from "../../components/ui";
import { IconCheck, IconPlay, IconWarn } from "../../components/icons";

interface LayerState { status: string; current?: number; total?: number }

export function PullDialog({ onClose, onRun }: { onClose: () => void; onRun: (ref: string) => void }) {
  const [reference, setReference] = useState("");
  const [platform, setPlatform] = useState("");
  const [op, setOp] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<string, LayerState>>({});
  const [messages, setMessages] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "pulling" | "done" | "error" | "canceled">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pulledRef, setPulledRef] = useState("");
  const opRef = useRef<string | null>(null);

  useEffect(() => () => { if (opRef.current && phaseRef.current === "pulling") api.cancelOp(opRef.current); }, []);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const start = async () => {
    const ref = reference.trim();
    if (!ref) return;
    setLayers({});
    setMessages([]);
    setError(null);
    setPhase("pulling");
    setPulledRef(/[:@]/.test(ref.split("/").pop() ?? "") ? ref : `${ref}:latest`);
    try {
      const id = await api.pullImage(ref, platform || null, (e) => {
        if (e.type === "progress") {
          const info = e.info as PullInfo;
          if (info.id && info.status && !/^(Pulling from|Digest|Status)/.test(info.status)) {
            setLayers((l) => ({ ...l, [info.id!]: { status: info.status!, current: info.progressDetail?.current, total: info.progressDetail?.total } }));
          } else if (info.status) {
            setMessages((m) => [...m.slice(-6), info.id ? `${info.id}: ${info.status}` : info.status!]);
          }
        } else if (e.type === "text") {
          setMessages((m) => [...m.slice(-6), e.line]);
        } else {
          queryClient.invalidateQueries({ queryKey: ["images"] });
          if (e.canceled) setPhase("canceled");
          else if (e.error) { setError(e.error); setPhase("error"); }
          else { setPhase("done"); toast(`Pulled ${ref}`, "ok"); }
        }
      });
      setOp(id);
      opRef.current = id;
    } catch (e) {
      setError(errMsg(e));
      setPhase("error");
    }
  };

  const entries = Object.entries(layers);
  const totals = entries.reduce(
    (a, [, l]) => {
      if (l.total && /Download|Extract/.test(l.status)) { a.cur += l.current ?? 0; a.tot += l.total; }
      return a;
    },
    { cur: 0, tot: 0 },
  );
  const doneCount = entries.filter(([, l]) => /Pull complete|Already exists|Download complete/.test(l.status)).length;
  const overall = phase === "done" ? 1 : entries.length ? (doneCount + (totals.tot ? totals.cur / totals.tot : 0)) / (entries.length + 1) : null;

  return (
    <Modal
      title="Pull Image"
      subtitle="Download an image from Docker Hub or another registry."
      onClose={onClose}
      width={560}
      footer={
        phase === "pulling" ? (
          <Button onClick={() => op && api.cancelOp(op)}>Cancel Pull</Button>
        ) : phase === "done" ? (
          <>
            <Button onClick={onClose}>Close</Button>
            <Button kind="primary" onClick={() => onRun(pulledRef)}><IconPlay size={11} /> Run…</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="primary" disabled={!reference.trim()} onClick={start}>Pull</Button>
          </>
        )
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (phase !== "pulling") start(); }} className="flex flex-col gap-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="Image reference" hint="e.g. nginx:alpine, ghcr.io/owner/app:1.2">
              <input autoFocus className="field mono" placeholder="nginx:alpine" value={reference} disabled={phase === "pulling"} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <Field label="Platform">
            <select className="field" value={platform} disabled={phase === "pulling"} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">Default</option>
              <option value="linux/arm64">linux/arm64</option>
              <option value="linux/amd64">linux/amd64</option>
            </select>
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
      {phase !== "idle" && (
        <div className="mt-4 flex flex-col gap-2" data-testid="pull-progress">
          <div className="flex items-center gap-2 text-[12.5px]">
            {phase === "done" && <span className="text-ok inline-flex items-center gap-1"><IconCheck size={13} /> Pulled {pulledRef}</span>}
            {phase === "error" && <span className="text-bad inline-flex items-center gap-1"><IconWarn size={13} /> Pull failed</span>}
            {phase === "canceled" && <span className="text-fg2">Canceled</span>}
            {phase === "pulling" && <span className="text-fg2">Pulling… {entries.length ? `${doneCount}/${entries.length} layers` : ""} {totals.tot ? `· ${bytes(totals.cur)} of ${bytes(totals.tot)}` : ""}</span>}
          </div>
          <Progress value={phase === "error" || phase === "canceled" ? 0 : overall} />
          {error && <div className="text-bad text-[12px] whitespace-pre-wrap break-words selectable">{error}</div>}
          {entries.length > 0 && (
            <div className="max-h-[180px] overflow-auto rounded-[8px] border border-line">
              {entries.map(([id, l]) => (
                <div key={id} className="flex items-center gap-3 px-2.5 h-[24px] border-b border-line/60 last:border-b-0 text-[11.5px]">
                  <span className="mono text-fg2 w-[96px]">{id}</span>
                  <span className="flex-1 truncate">{l.status}</span>
                  {l.total ? <span className="w-[90px]"><Progress value={(l.current ?? 0) / l.total} /></span> : null}
                </div>
              ))}
            </div>
          )}
          {messages.length > 0 && <div className="mono text-[11px] text-fg3 whitespace-pre-wrap break-all">{messages.join("\n")}</div>}
        </div>
      )}
    </Modal>
  );
}
