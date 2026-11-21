import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, errMsg, type EngineInfo } from "../../lib/api";
import { useStatus } from "../../lib/queries";
import { toast } from "../../lib/toast";
import { confirmAction } from "../../components/dialog";
import { Badge, Button, Dot, ErrorBox, Field, Loading } from "../../components/ui";
import { IconWarn } from "../../components/icons";

/** Engines: Hullport is the app; an engine (a Linux VM running Docker) runs the containers. */
export function EnginesView() {
  const q = useQuery({ queryKey: ["engines"], queryFn: api.engines, refetchInterval: 4000, staleTime: 0 });
  const st = useStatus();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [op, setOp] = useState<string | null>(null);
  const [cpus, setCpus] = useState(4);
  const [mem, setMem] = useState(8);
  const [disk, setDisk] = useState(60);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [log]);

  const run = async (task: "install-colima" | "start-colima" | "stop-colima", label: string) => {
    setBusy(task);
    setLog((l) => [...l, `— ${label} —`]);
    try {
      const id = await api.engineTask(task, { cpus, memoryGb: mem, diskGb: disk }, (e) => {
        if (e.type === "line") setLog((l) => [...l.slice(-800), e.line]);
        else {
          setBusy(null);
          setOp(null);
          q.refetch();
          if (e.ok) toast(`${label}: done`, "ok");
          else toast(`${label} failed: ${e.error}`, "error");
        }
      });
      setOp(id);
    } catch (e) {
      setBusy(null);
      toast(`${label} failed: ${errMsg(e)}`, "error");
    }
  };

  const install = async () => {
    const { ok } = await confirmAction({
      title: "Install Colima with Homebrew?",
      message: (
        <>
          Runs <span className="mono">brew install colima docker docker-buildx docker-compose</span> (a few minutes), then adds Homebrew's
          plugin folder to <span className="mono">~/.docker/config.json</span> so builds and Compose work without OrbStack (a backup is kept).
          Nothing in OrbStack is changed.
        </>
      ),
      confirmLabel: "Install",
    });
    if (ok) run("install-colima", "Install Colima");
  };

  const d = q.data;
  const colima = d?.engines.find((e) => e.id === "colima");
  return (
    <div className="h-full flex flex-col" data-section="engines">
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center pl-4 border-b border-line">
        <h1 data-tauri-drag-region className="text-[15px] font-semibold">Engines</h1>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-5 max-w-[880px]">
        <p className="text-[12.5px] text-fg2 leading-relaxed mb-4">
          Hullport is the app you work in. The <b className="text-fg">engine</b> is what actually runs containers: on a Mac that's a small Linux virtual
          machine with Docker inside. To stop using OrbStack, install and start <b className="text-fg">Colima</b> (free, open source) here; Hullport
          switches to it automatically. Containers, images and volumes stored in OrbStack stay there and are not moved.
        </p>
        {q.isLoading && <Loading />}
        {q.error != null && <ErrorBox error={q.error} />}
        {d?.cliDependsOnOrbstack && (
          <div className="mb-4 p-3 rounded-[9px] border border-warn/35 bg-warn/8 text-[12.5px] flex gap-2">
            <IconWarn size={15} className="text-warn shrink-0 mt-[1px]" />
            <div>
              Your <span className="mono">docker</span> command (and its build/compose plugins) currently come from OrbStack and would stop working if
              OrbStack were removed. Installing Colima below also installs a standalone Docker command line.
            </div>
          </div>
        )}
        <div className="rounded-[10px] border border-line bg-panel overflow-hidden mb-4">
          {d?.engines.map((e) => <EngineRow key={e.id} e={e} active={st.state === "connected" && (st.context === e.context || st.host.includes(e.socket))} />)}
        </div>

        {colima && (
          <div className="rounded-[10px] border border-line bg-panel p-4 mb-4">
            <div className="font-semibold mb-1">Colima</div>
            {!colima.installed ? (
              <div className="flex items-center gap-3">
                <span className="text-[12.5px] text-fg2 flex-1">{d?.brew ? "Not installed. Hullport can install it with Homebrew." : "Install Homebrew from brew.sh first, then come back here."}</span>
                <Button kind="primary" disabled={!d?.brew || !!busy} busy={busy === "install-colima"} onClick={install}>Install Colima</Button>
              </div>
            ) : (
              <div className="flex items-end gap-3 flex-wrap">
                <Field label="CPUs"><input type="number" min={1} max={16} className="field w-[70px]" value={cpus} onChange={(e) => setCpus(+e.target.value)} /></Field>
                <Field label="Memory (GB)"><input type="number" min={2} max={64} className="field w-[90px]" value={mem} onChange={(e) => setMem(+e.target.value)} /></Field>
                <Field label="Disk (GB)"><input type="number" min={20} max={500} className="field w-[90px]" value={disk} onChange={(e) => setDisk(+e.target.value)} /></Field>
                <div className="flex-1" />
                {colima.running ? (
                  <>
                    <Button onClick={() => api.setContext("colima")}>Use in Hullport</Button>
                    <Button disabled={!!busy} busy={busy === "stop-colima"} onClick={() => run("stop-colima", "Stop Colima")}>Stop</Button>
                  </>
                ) : (
                  <Button kind="primary" disabled={!!busy} busy={busy === "start-colima"} onClick={() => run("start-colima", "Start Colima")}>Start Colima</Button>
                )}
              </div>
            )}
            {colima.installed && !colima.running && <div className="text-[11.5px] text-fg3 mt-2">Uses Apple's Virtualization framework with virtiofs file sharing. The first start downloads a small Linux image.</div>}
          </div>
        )}

        {log.length > 0 && (
          <div className="rounded-[10px] border border-line overflow-hidden">
            <div className="flex items-center px-3 h-[30px] border-b border-line text-[12px] text-fg2">
              <span className="flex-1">Output</span>
              {op && <Button kind="ghost" onClick={() => api.cancelOp(op)}>Cancel</Button>}
            </div>
            <pre ref={box} className="mono text-[11px] leading-[1.5] m-0 p-3 max-h-[260px] overflow-auto whitespace-pre-wrap break-all selectable">{log.join("\n")}</pre>
          </div>
        )}
        <div className="text-[11.5px] text-fg3 mt-4">
          Docker command line: <span className="mono">{d?.dockerCli ?? "not found"}</span> · build plugin {d?.buildxAvailable ? "found" : "missing"}
        </div>
      </div>
    </div>
  );
}

function EngineRow({ e, active }: { e: EngineInfo; active: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b border-line last:border-b-0">
      <Dot tone={e.running ? "ok" : e.installed ? "idle" : "idle"} />
      <div className="flex-1 min-w-0">
        <div className="font-medium flex items-center gap-2">
          {e.name}
          {e.openSource && <Badge tone="accent">open source</Badge>}
          {active && <Badge tone="ok">used by Hullport</Badge>}
        </div>
        <div className="text-[11.5px] text-fg2">{e.note}</div>
      </div>
      <div className="text-[12px] text-fg2 w-[110px] text-right">{!e.installed ? "Not installed" : e.running ? "Running" : "Stopped"}</div>
      {e.running && !active && <Button onClick={() => api.setContext(e.context)}>Use</Button>}
    </div>
  );
}
