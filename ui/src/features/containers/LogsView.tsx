import { useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../../lib/api";
import type { LogLine } from "../../lib/types";
import { IconButton, cx } from "../../components/ui";
import { IconChevronDown, IconCopy, IconSearch, IconTrash } from "../../components/icons";
import { writeText } from "../../components/clipboard";
import { onEngineEvent } from "../../lib/queries";
import { setUi, useUi } from "../../lib/store";

const MAX_LINES = 20000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function LogsView({ id, running }: { id: string; running: boolean }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [ended, setEnded] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Search mode, line wrapping and font size are remembered between sessions.
  const onlyMatches = useUi((s) => s.logsSearchMode) === "filter";
  const wrap = useUi((s) => s.logsWrapLines);
  const fontSize = useUi((s) => s.logsFontSize);
  const setOnlyMatches = (v: boolean) => setUi({ logsSearchMode: v ? "filter" : "highlight" });
  const setWrap = (v: boolean) => setUi({ logsWrapLines: v });
  const [timestamps, setTimestamps] = useState(true);
  const lastTs = useRef<string>("");
  const [follow, setFollow] = useState(true);
  const [gen, setGen] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // Attach the log stream. On restart, resume from the last line seen instead of reloading,
  // by passing `--since=<last timestamp>`.
  useEffect(() => {
    let op: string | null = null;
    let cancelled = false;
    const resumeFrom = gen > 0 ? lastTs.current : "";
    if (!resumeFrom) { setLines([]); lastTs.current = ""; }
    setEnded(null);
    api
      .streamLogs(id, 2000, (e) => {
        if (cancelled) return;
        if (e.type === "lines") {
          const fresh = resumeFrom ? e.lines.filter((l) => !l.ts || l.ts > resumeFrom) : e.lines;
          if (!fresh.length) return;
          const tail = fresh[fresh.length - 1].ts;
          if (tail) lastTs.current = tail;
          setLines((prev) => {
            const next = prev.concat(fresh.map((l) => ({ ...l, text: l.text.replace(ANSI, "") })));
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        } else setEnded(e.error ?? "Log stream ended");
      }, resumeFrom || undefined)
      .then((o) => { op = o; if (cancelled) api.cancelOp(o); })
      .catch((e) => setEnded(errMsg(e)));
    return () => { cancelled = true; if (op) api.cancelOp(op); };
  }, [id, gen]);

  // ⌘+ / ⌘- / ⌘0 change the log font size (default 12.5).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); setUi({ logsFontSize: Math.min(24, fontSize + 1) }); }
      else if (e.key === "-") { e.preventDefault(); setUi({ logsFontSize: Math.max(9, fontSize - 1) }); }
      else if (e.key === "0") { e.preventDefault(); setUi({ logsFontSize: 12.5 }); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [fontSize]);

  useEffect(() => onEngineEvent((e) => {
    if (e.kind === "container" && e.id === id && (e.action === "start" || e.action === "restart")) setGen((g) => g + 1);
  }), [id]);

  const shown = useMemo(() => {
    if (!q || !onlyMatches) return lines;
    const n = q.toLowerCase();
    return lines.filter((l) => l.text.toLowerCase().includes(n));
  }, [lines, q, onlyMatches]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const highlight = (text: string) => {
    if (!q) return text;
    const parts: React.ReactNode[] = [];
    const lower = text.toLowerCase();
    const n = q.toLowerCase();
    let i = 0;
    let k = 0;
    while (true) {
      const j = lower.indexOf(n, i);
      if (j < 0) break;
      parts.push(text.slice(i, j), <mark key={k++} className="bg-warn-fill/45 text-fg rounded-[3px]">{text.slice(j, j + n.length)}</mark>);
      i = j + n.length;
    }
    parts.push(text.slice(i));
    return parts;
  };

  return (
    <div className="h-full flex flex-col bg-tile">
      <div className="h-[40px] shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3 pointer-events-none"><IconSearch size={12} /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter logs" aria-label="Filter logs" className="field w-[180px] pl-7 text-caption" />
        </div>
        <select className="field text-caption" value={onlyMatches ? "only" : "all"} onChange={(e) => setOnlyMatches(e.target.value === "only")} aria-label="Search mode">
          <option value="only">Show only matching lines</option>
          <option value="all">Show all lines (highlight)</option>
        </select>
        <label className="flex items-center gap-1 text-caption text-fg2"><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />Timestamps</label>
        <label className="flex items-center gap-1 text-caption text-fg2"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />Wrap</label>
        <div className="flex-1" />
        <span className="text-badge text-fg3 tabular-nums">{shown.length.toLocaleString()} lines</span>
        <IconButton title="Copy visible logs" onClick={() => writeText(shown.map((l) => (timestamps && l.ts ? l.ts + " " : "") + l.text).join("\n"))}><IconCopy size={13} /></IconButton>
        <IconButton title="Clear view" onClick={() => setLines([])}><IconTrash size={13} /></IconButton>
      </div>
      <div ref={box} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto mono leading-[1.55] py-1.5 selectable" style={{ fontSize }} data-testid="logs">
        {shown.length === 0 && (
          <div className="px-4 py-3 text-fg3 font-sans text-body">
            {q ? "No matching lines." : ended ? "No logs." : running ? "Waiting for output…" : "No logs yet."}
          </div>
        )}
        {shown.map((l, i) => (
          <div key={i} className={cx("px-3 flex gap-3 hover:bg-hover [content-visibility:auto]", l.stream === "err" && "text-bad/95")}>
            {timestamps && <span className="text-fg3 shrink-0 tabular-nums">{fmtTs(l.ts)}</span>}
            <span className={wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}>{highlight(l.text)}</span>
          </div>
        ))}
        {ended && shown.length > 0 && <div className="px-3 pt-2 text-fg3 font-sans text-caption">— {ended}{running ? "" : " (container stopped)"} —</div>}
      </div>
      {!follow && (
        <button
          onClick={() => setFollow(true)}
          className="absolute bottom-4 right-5 h-[28px] px-3 rounded-full bg-primary hover:bg-primary-hover text-on-primary text-caption font-semibold shadow-floating inline-flex items-center gap-1 transition-colors hover:duration-100 fadein"
        >
          <IconChevronDown size={12} /> Jump to latest
        </button>
      )}
    </div>
  );
}

function fmtTs(ts: string) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.slice(0, 19);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
