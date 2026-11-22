import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, errMsg, type EngineInfo, type EngineState, type HullportEngine } from "../../lib/api";
import { useEngineProgress, useStatus } from "../../lib/queries";
import type { ConnStatus } from "../../lib/types";
import { go } from "../../lib/store";
import { toast } from "../../lib/toast";
import { Badge, Button, Dot, ErrorBox, Loading, cx } from "../../components/ui";
import { confirmAction } from "../../components/dialog";

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
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center pl-4 bg-tile border-b border-line">
        <h1 data-tauri-drag-region className="text-headline font-semibold">Engines</h1>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-5 max-w-[880px]">
        <p className="text-body text-fg2 leading-relaxed mb-4">
          The <b className="text-fg">engine</b> is what runs your containers: on a Mac, a small Linux virtual machine with Docker inside. Hullport
          brings its own, built from open source parts, and runs it while the menu bar icon is there. Other engines on this Mac are listed
          below; Hullport can connect to them too.
        </p>
        {q.isLoading && <Loading />}
        {q.error != null && <ErrorBox error={q.error} />}
        {d && <HullportCard e={d.hullport} active={st.context === d.hullport.context || usesSocket(st, d.hullport.socket)} />}
        {d && <TerminalCard />}
        {d && (
          <>
            <div className="text-caption font-semibold text-fg2 mb-2">Other engines</div>
            <div className="card overflow-hidden mb-4">
              {d.others.map((e) => <EngineRow key={e.id} e={e} active={st.context === e.context || usesSocket(st, e.socket)} />)}
            </div>
          </>
        )}
        <div className="text-caption text-fg3 mt-4">
          Docker command line: <span className="mono">{d?.dockerCli ?? "not found"}</span>
        </div>
      </div>
    </div>
  );
}

function HullportCard({ e: polled, active }: { e: HullportEngine; active: boolean }) {
  // Events are fresher than the 4 s poll, and carry the start-up step.
  const live = useEngineProgress();
  const e = { ...polled, state: live.steps.length ? live.state : polled.state };
  const tone = e.state === "running" ? "ok" : e.state === "failed" ? "bad" : e.state === "starting" || e.state === "stopping" ? "warn" : "idle";
  const run = (label: string, fn: () => Promise<void>) => fn().catch((err) => toast(`${label} failed: ${errMsg(err)}`, "error"));
  const size = (v?: string | null) => v?.replace(/([0-9.])([A-Za-z])/, "$1 $2");
  return (
    <div className="card p-4 mb-5" data-testid="hullport-engine">
      <div className="flex items-center gap-3">
        <Dot tone={tone} pulse={e.state === "starting" || e.state === "stopping"} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold flex items-center gap-2">
            Hullport engine
            <Badge tone="strong">open source</Badge>
            {active && <Badge tone="ok">in use</Badge>}
          </div>
          <div className="text-caption text-fg2">
            {e.cpus && e.memory && e.disk ? `${e.cpus} CPUs · ${size(e.memory)} memory · ${size(e.disk)} disk for Docker data` : "Lima VM with Docker Engine"}
          </div>
        </div>
        <div className="text-caption text-fg2 min-w-[110px] text-right" data-testid="hullport-engine-state">
          {e.state === "starting" && live.stepLabel ? `${live.stepLabel}…` : stateLabel[e.state]}
        </div>
        {e.state === "running" && !active && <Button onClick={() => run("Switch engine", () => api.setContext(e.context))}>Use</Button>}
        {e.managed && (e.state === "running" || e.state === "stopping") && (
          <Button busy={e.state === "stopping"} onClick={() => run("Stop engine", api.engineStop)}>Stop</Button>
        )}
        {e.managed && (e.state === "stopped" || e.state === "failed" || e.state === "starting") && (
          <Button kind="primary" busy={e.state === "starting"} onClick={() => run("Start engine", api.engineStart)}>Start</Button>
        )}
      </div>
      {e.state === "failed" && e.error && <div className="mt-3 text-caption text-bad leading-snug selectable">{e.error}</div>}
      {e.state === "notInstalled" && (
        <div className="mt-3 text-caption text-fg2 leading-snug">
          Not set up yet. For now, set it up once from the repository with{" "}
          <span className="mono">scripts/engine.sh install && scripts/engine.sh start</span>; after that Hullport starts and stops it.
        </div>
      )}
      <div className="mt-3 text-caption text-fg3">
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
        <div className="text-caption text-fg2">{e.note}</div>
      </div>
      <div className="text-caption text-fg2 w-[110px] text-right">{!e.installed ? "Not installed" : e.running ? "Running" : "Stopped"}</div>
      {e.id === "orbstack" && e.installed && <Button onClick={() => go("migrate")}>Migrate to Hullport…</Button>}
      {e.running && !active && <Button onClick={() => api.setContext(e.context)}>Use</Button>}
    </div>
  );
}

/** Which engine the terminal's `docker` uses, and the switch to Hullport (the cutover). */
function TerminalCard() {
  const q = useQuery({ queryKey: ["cutover"], queryFn: api.cutoverStatus, staleTime: 0 });
  const [busy, setBusy] = useState(false);
  const s = q.data;
  if (!s) return null;
  const change = async (apply: boolean) => {
    const { ok } = await confirmAction({
      title: apply ? "Use Hullport in the terminal?" : "Put the terminal back as it was?",
      message: apply ? (
        <>
          The <span className="mono">hullport</span> context becomes the current one (<span className="mono">orbstack</span> is kept), and{" "}
          <span className="mono">docker</span>, its compose and buildx plugins, the keychain credential helper and{" "}
          <span className="mono">/var/run/docker.sock</span> point at Hullport's. What's there now is saved first, so this can be undone. macOS
          asks for your administrator password once.
        </>
      ) : (
        <>Every path goes back to what it held before, and the previous context becomes the current one again. macOS asks for your password once.</>
      ),
      confirmLabel: apply ? "Switch" : "Undo",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await (apply ? api.cutoverApply() : api.cutoverRevert());
      toast(apply ? "The terminal now uses Hullport" : "The terminal is back as it was", "ok");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
      q.refetch();
    }
  };
  return (
    <div className="card p-4 mb-5" data-testid="terminal-card">
      <div className="flex items-center gap-3">
        <Dot tone={s.complete ? "ok" : s.applied ? "warn" : "idle"} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Terminal</div>
          <div className="text-caption text-fg2">
            {s.complete ? "docker, docker compose and docker buildx use Hullport" : s.applied ? "Switched, but something was changed since" : `docker uses the ${s.currentContext} context`}
          </div>
        </div>
        {s.applied ? (
          <Button busy={busy} onClick={() => change(false)}>Undo</Button>
        ) : (
          <Button kind="primary" busy={busy} onClick={() => change(true)}>Use Hullport in the Terminal…</Button>
        )}
      </div>
      <div className="mt-3 text-caption leading-[1.7]">
        <div className="flex gap-2"><span className="mono text-fg2 w-[330px] truncate">current context</span><span className={s.currentContext === "hullport" ? "text-ok" : "text-fg3"}>{s.currentContext}</span></div>
        {s.paths.map((p) => (
          <div key={p.path} className="flex gap-2">
            <span className="mono text-fg2 w-[330px] truncate" title={p.path}>{p.path.replace(/^\/Users\/[^/]+/, "~")}</span>
            <span className={cx("mono truncate", p.isHullport ? "text-ok" : "text-fg3")} title={p.pointsTo ?? ""}>
              {p.pointsTo ? `→ ${p.pointsTo.replace(/^\/Users\/[^/]+/, "~")}` : p.exists ? "a regular file" : "not there"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
