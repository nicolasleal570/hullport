import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { api, errMsg, type EngineInfo, type EngineState, type HullportEngine } from "../../lib/api";
import { useStatus } from "../../lib/queries";
import type { ConnStatus } from "../../lib/types";
import { toast } from "../../lib/toast";
import { Badge, Button, Dot, ErrorBox, Loading } from "../../components/ui";

const stateLabel: Record<EngineState, string> = {
  notInstalled: "Not installed", stopped: "Stopped", starting: "Starting…", running: "Running", stopping: "Stopping…", failed: "Failed",
};

const usesSocket = (st: ConnStatus, socket: string) => st.state === "connected" && st.host.replace(/^unix:\/\//, "") === socket;

/** Engines: Hullport's own engine first, then other engines on this Mac it can connect to. */
export function EnginesView() {
  const q = useQuery({ queryKey: ["engines"], queryFn: api.engines, refetchInterval: 4000, staleTime: 0 });
  const st = useStatus();
  useEffect(() => {
    const off = listen("engine-state", () => q.refetch());
    return () => { off.then((u) => u()); };
  }, []);

  const d = q.data;
  return (
    <div className="h-full flex flex-col" data-section="engines">
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center pl-4 border-b border-line">
        <h1 data-tauri-drag-region className="text-[15px] font-semibold">Engines</h1>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-5 max-w-[880px]">
        <p className="text-[12.5px] text-fg2 leading-relaxed mb-4">
          The <b className="text-fg">engine</b> is what runs your containers: on a Mac, a small Linux virtual machine with Docker inside. Hullport
          brings its own, built from open source parts, and runs it while the menu bar icon is there. Other engines on this Mac are listed
          below; Hullport can connect to them too.
        </p>
        {q.isLoading && <Loading />}
        {q.error != null && <ErrorBox error={q.error} />}
        {d && <HullportCard e={d.hullport} active={st.context === d.hullport.context || usesSocket(st, d.hullport.socket)} />}
        {d && (
          <>
            <div className="text-[12px] font-semibold text-fg2 mb-2">Other engines</div>
            <div className="rounded-[10px] border border-line bg-panel overflow-hidden mb-4">
              {d.others.map((e) => <EngineRow key={e.id} e={e} active={st.context === e.context || usesSocket(st, e.socket)} />)}
            </div>
          </>
        )}
        <div className="text-[11.5px] text-fg3 mt-4">
          Docker command line: <span className="mono">{d?.dockerCli ?? "not found"}</span>
        </div>
      </div>
    </div>
  );
}

function HullportCard({ e, active }: { e: HullportEngine; active: boolean }) {
  const tone = e.state === "running" ? "ok" : e.state === "failed" ? "bad" : e.state === "starting" || e.state === "stopping" ? "warn" : "idle";
  const run = (label: string, fn: () => Promise<void>) => fn().catch((err) => toast(`${label} failed: ${errMsg(err)}`, "error"));
  const size = (v?: string | null) => v?.replace(/([0-9.])([A-Za-z])/, "$1 $2");
  return (
    <div className="rounded-[10px] border border-line bg-panel p-4 mb-5" data-testid="hullport-engine">
      <div className="flex items-center gap-3">
        <Dot tone={tone} pulse={e.state === "starting" || e.state === "stopping"} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold flex items-center gap-2">
            Hullport engine
            <Badge tone="accent">open source</Badge>
            {active && <Badge tone="ok">in use</Badge>}
          </div>
          <div className="text-[11.5px] text-fg2">
            {e.cpus && e.memory && e.disk ? `${e.cpus} CPUs · ${size(e.memory)} memory · ${size(e.disk)} disk for Docker data` : "Lima VM with Docker Engine"}
          </div>
        </div>
        <div className="text-[12px] text-fg2 w-[110px] text-right" data-testid="hullport-engine-state">{stateLabel[e.state]}</div>
        {e.state === "running" && !active && <Button onClick={() => run("Switch engine", () => api.setContext(e.context))}>Use</Button>}
        {e.managed && (e.state === "running" || e.state === "stopping") && (
          <Button busy={e.state === "stopping"} onClick={() => run("Stop engine", api.engineStop)}>Stop</Button>
        )}
        {e.managed && (e.state === "stopped" || e.state === "failed" || e.state === "starting") && (
          <Button kind="primary" busy={e.state === "starting"} onClick={() => run("Start engine", api.engineStart)}>Start</Button>
        )}
      </div>
      {e.state === "failed" && e.error && <div className="mt-3 text-[12px] text-bad leading-snug selectable">{e.error}</div>}
      {e.state === "notInstalled" && (
        <div className="mt-3 text-[12px] text-fg2 leading-snug">
          Not set up yet. For now, set it up once from the repository with{" "}
          <span className="mono">scripts/engine.sh install && scripts/engine.sh start</span>; after that Hullport starts and stops it.
        </div>
      )}
      <div className="mt-3 text-[11.5px] text-fg3">
        Socket <span className="mono">{e.socket}</span>. Closing the window keeps it running; Quit Hullport from the menu bar icon stops it.
      </div>
    </div>
  );
}

function EngineRow({ e, active }: { e: EngineInfo; active: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b border-line last:border-b-0">
      <Dot tone={e.running ? "ok" : "idle"} />
      <div className="flex-1 min-w-0">
        <div className="font-medium flex items-center gap-2">
          {e.name}
          {active && <Badge tone="ok">in use</Badge>}
        </div>
        <div className="text-[11.5px] text-fg2">{e.note}</div>
      </div>
      <div className="text-[12px] text-fg2 w-[110px] text-right">{!e.installed ? "Not installed" : e.running ? "Running" : "Stopped"}</div>
      {e.running && !active && <Button onClick={() => api.setContext(e.context)}>Use</Button>}
    </div>
  );
}
