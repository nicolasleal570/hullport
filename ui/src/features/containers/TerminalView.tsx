import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, errMsg } from "../../lib/api";
import { Button, Empty } from "../../components/ui";
import { IconTerminal } from "../../components/icons";

function theme() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return dark
    ? { background: "#161618", foreground: "#e6e6e8", cursor: "#e6e6e8", selectionBackground: "#3a5f9a88" }
    : { background: "#ffffff", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#b3d4ff" };
}

export function TerminalView({ id, running, visible }: { id: string; running: boolean; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [exit, setExit] = useState<string | null>(null);
  const [gen, setGen] = useState(0);

  useEffect(() => {
    if (!running || !host.current) return;
    setExit(null);
    const term = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: theme(),
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch { /* not visible yet */ }

    let session: string | null = null;
    let closed = false;
    const decoder = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    api
      .execOpen(id, term.cols, term.rows, (e) => {
        if (e.type === "data") term.write(decoder(e.data));
        else if (!closed) setExit(e.error ? `Session ended: ${e.error}` : `Process exited${e.code != null ? ` with code ${e.code}` : ""}`);
      })
      .then((s) => { session = s; if (closed) api.execClose(s); else term.focus(); })
      .catch((e) => setExit(errMsg(e)));

    const sub = term.onData((data) => { if (session) api.execWrite(session, data).catch(() => {}); });
    const resize = term.onResize(({ cols, rows }) => { if (session) api.execResize(session, cols, rows).catch(() => {}); });
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
    ro.observe(host.current);
    return () => {
      closed = true;
      ro.disconnect();
      sub.dispose();
      resize.dispose();
      if (session) api.execClose(session);
      term.dispose();
      termRef.current = null;
    };
  }, [id, running, gen]);

  useEffect(() => {
    if (visible) setTimeout(() => { try { fitRef.current?.fit(); } catch { /* */ } termRef.current?.focus(); }, 0);
  }, [visible]);

  if (!running) {
    return <Empty icon={<IconTerminal />} title="Container isn't running">Start the container to open a terminal inside it.</Empty>;
  }
  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: theme().background }}>
      <div ref={host} className="flex-1 min-h-0" data-testid="terminal" />
      {exit && (
        <div className="shrink-0 flex items-center gap-3 px-3 h-[36px] border-t border-line bg-panel text-[12px]">
          <span className="text-fg2 flex-1">{exit}</span>
          <Button kind="primary" onClick={() => setGen((g) => g + 1)}>Reconnect</Button>
        </div>
      )}
    </div>
  );
}
