import { useEffect, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { bytes } from "../../lib/format";
import type { StatsSample } from "../../lib/types";
import { Button, Empty, Section } from "../../components/ui";
import { IconStats } from "../../components/icons";

const N = 60;

function Spark({ values, max }: { values: number[]; max: number }) {
  const w = 240, h = 44;
  const m = Math.max(max, 1e-9);
  const pts = values.map((v, i) => `${(i / (N - 1)) * w},${h - (Math.min(v, m) / m) * (h - 3) - 1.5}`).join(" ");
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block">
      <polyline points={`0,${h} ${pts} ${((values.length - 1) / (N - 1)) * w},${h}`} fill="var(--c-accent-soft)" stroke="none" />
      <polyline points={pts} fill="none" stroke="var(--c-accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StatsView({ id, running }: { id: string; running: boolean }) {
  const [samples, setSamples] = useState<StatsSample[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [top, setTop] = useState<{ Titles?: string[]; Processes?: string[][] } | null>(null);

  useEffect(() => {
    if (!running) return;
    let op: string | null = null;
    let cancelled = false;
    setSamples([]);
    api
      .streamStats(id, (e) => {
        if (cancelled) return;
        if (e.type === "sample") setSamples((s) => [...s.slice(-(N - 1)), e.sample]);
        else if (e.error) setErr(e.error);
      })
      .then((o) => { op = o; if (cancelled) api.cancelOp(o); })
      .catch((e) => setErr(errMsg(e)));
    const loadTop = () => api.top(id).then(setTop).catch(() => {});
    loadTop();
    const t = setInterval(loadTop, 5000);
    return () => { cancelled = true; clearInterval(t); if (op) api.cancelOp(op); };
  }, [id, running]);

  if (!running) return <Empty icon={<IconStats />} title="Container isn't running">Live CPU and memory usage appear while it runs.</Empty>;
  const last = samples[samples.length - 1];
  const cpuMax = Math.max(100, ...samples.map((s) => s.cpuPercent));
  return (
    <div className="h-full overflow-auto p-4 fadein" data-testid="stats">
      {err && <div className="text-bad text-[12px] mb-2">{err}</div>}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <Card title="CPU" value={last ? `${last.cpuPercent.toFixed(1)}%` : "…"} sub={last ? `${last.onlineCpus} CPUs available` : ""}>
          <Spark values={samples.map((s) => s.cpuPercent)} max={cpuMax} />
        </Card>
        <Card title="Memory" value={last ? bytes(last.memUsed) : "…"} sub={last ? `of ${bytes(last.memLimit)} limit` : ""}>
          <Spark values={samples.map((s) => s.memUsed)} max={Math.max(...samples.map((s) => s.memUsed), 1) * 1.15} />
        </Card>
        <Card title="Network I/O" value={last ? `↓ ${bytes(last.netRx)}  ↑ ${bytes(last.netTx)}` : "…"} sub="since start" />
        <Card title="Disk I/O" value={last ? `R ${bytes(last.blkRead)}  W ${bytes(last.blkWrite)}` : "…"} sub={last ? `${last.pids} processes` : ""} />
      </div>
      <Section title="Processes" right={<Button kind="ghost" onClick={() => api.top(id).then(setTop)}>Refresh</Button>}>
        {!top?.Processes?.length ? (
          <div className="px-3 py-2 text-fg3 text-[12px]">No processes reported</div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full mono text-[11px]">
              <thead><tr>{top.Titles?.map((t) => <th key={t} className="text-left font-medium text-fg2 px-2.5 py-1.5 border-b border-line whitespace-nowrap">{t}</th>)}</tr></thead>
              <tbody>
                {top.Processes.map((p, i) => (
                  <tr key={i} className="hover:bg-hover">{p.map((c, j) => <td key={j} className="px-2.5 py-1 border-b border-line/60 whitespace-nowrap max-w-[420px] truncate selectable">{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function Card({ title, value, sub, children }: { title: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-line bg-panel p-3 overflow-hidden">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg3">{title}</div>
      <div className="text-[18px] font-semibold tabular-nums mt-0.5 whitespace-pre">{value}</div>
      <div className="text-[11.5px] text-fg2 h-[16px]">{sub}</div>
      {children && <div className="mt-1.5 -mx-3 -mb-3">{children}</div>}
    </div>
  );
}
