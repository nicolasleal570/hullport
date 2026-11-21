import { useEffect, useState } from "react";
import { Sidebar, SECTIONS } from "./components/Sidebar";
import { MenuHost } from "./components/menu";
import { ConfirmHost } from "./components/dialog";
import { Button, Empty, cx } from "./components/ui";
import { IconCheck, IconPlug, IconSpinner, IconX } from "./components/icons";
import { api, type EngineProgress } from "./lib/api";
import { refreshAll, useEngineBridge, useEngineProgress, useStatus } from "./lib/queries";
import { getUi, go, useUi } from "./lib/store";
import { dismiss, useToasts } from "./lib/toast";
import { ContainersView } from "./features/containers/ContainersView";
import { ImagesView } from "./features/images/ImagesView";
import { VolumesView } from "./features/volumes/VolumesView";
import { NetworksView } from "./features/networks/NetworksView";
import { BuildsView } from "./features/builds/BuildsView";
import { EnginesView } from "./features/engines/EnginesView";
import { MigrationView } from "./features/migration/MigrationView";
import { runLaunchMode } from "./launch";

export default function App() {
  useEngineBridge();
  const section = useUi((s) => s.section);
  const st = useStatus();

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey) return;
      const s = SECTIONS.find((x) => x.key === e.key);
      if (s) { e.preventDefault(); go(s.id); }
      else if (e.key.toLowerCase() === "r") { e.preventDefault(); refreshAll(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  useEffect(() => { runLaunchMode(); }, []);

  const needsEngine = section !== "builds" && section !== "engines" && section !== "migrate" && st.state !== "connected";
  return (
    <div className="h-full flex">
      <Sidebar />
      <main className="flex-1 min-w-0 h-full flex flex-col bg-bg">
        {needsEngine ? <EngineDown section={getUi().section} /> : (
          <>
            {section === "containers" && <ContainersView />}
            {section === "images" && <ImagesView />}
            {section === "volumes" && <VolumesView />}
            {section === "builds" && <BuildsView />}
            {section === "networks" && <NetworksView />}
            {section === "engines" && <EnginesView />}
            {section === "migrate" && <MigrationView />}
          </>
        )}
      </main>
      <MenuHost />
      <ConfirmHost />
      <Toasts />
    </div>
  );
}

/** Hullport's engine is booting: show its steps instead of a connection error. */
function EngineStarting({ engine }: { engine: EngineProgress }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = engine.startedAt ? Math.max(0, Math.round((now - engine.startedAt) / 1000)) : null;
  const current = engine.step ?? 0;
  return (
    <Empty icon={<IconSpinner size={30} />} title="Starting the Hullport engine…">
      <div className="inline-flex flex-col gap-1.5 text-left mt-1" data-testid="engine-starting">
        {engine.steps.map((label, i) => (
          <div key={label} className={cx("flex items-center gap-2", i > current && "text-fg3")}>
            <span className="w-4 flex justify-center">
              {i < current ? <IconCheck size={13} className="text-ok" /> : i === current ? <IconSpinner size={12} /> : <span className="w-1.5 h-1.5 rounded-full bg-fg3" />}
            </span>
            {label}
          </div>
        ))}
      </div>
      {secs != null && <div className="mt-3 text-fg3 tabular-nums">{secs} s · usually about 10 s</div>}
    </Empty>
  );
}

function EngineDown({ section }: { section: string }) {
  const st = useStatus();
  const engine = useEngineProgress();
  const title = SECTIONS.find((s) => s.id === section)?.label ?? "";
  return (
    <div className="h-full flex flex-col" data-section={section}>
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center pl-4 border-b border-line">
        <h1 data-tauri-drag-region className="text-[15px] font-semibold">{title}</h1>
      </div>
      {engine.state === "starting" ? (
        <EngineStarting engine={engine} />
      ) : st.state === "connecting" ? (
        <Empty icon={<IconSpinner size={30} />} title="Connecting to Docker…">{st.host || "Looking for the engine"}</Empty>
      ) : (
        <Empty
          icon={<IconPlug />}
          title="Docker engine unavailable"
          action={<div className="flex gap-2 justify-center"><Button kind="primary" onClick={() => api.reconnect()}>Try Again</Button><Button onClick={() => go("engines")}>Set Up an Engine…</Button></div>}
        >
          <div className="selectable">{st.error ?? "Could not reach the engine."}</div>
          <div className="mt-2 text-fg3">Context <b>{st.context}</b> · <span className="mono">{st.host}</span>. Start the Hullport engine from the menu bar icon or the Engines page, or pick another context in the sidebar. Hullport reconnects automatically.</div>
        </Empty>
      )}
    </div>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="fixed bottom-3 right-3 z-[90] flex flex-col gap-2 items-end pointer-events-none" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto fadein max-w-[420px] flex items-start gap-2 pl-3 pr-1.5 py-2 rounded-[9px] border shadow-[0_8px_24px_rgba(0,0,0,0.3)] backdrop-blur-xl text-[12.5px]",
            t.kind === "error" ? "border-bad/40 bg-raised/95" : "border-line-strong bg-raised/95",
          )}
        >
          <span className={cx("w-[7px] h-[7px] rounded-full mt-[5px] shrink-0", t.kind === "error" ? "bg-bad" : t.kind === "ok" ? "bg-ok" : "bg-accent")} />
          <span className="flex-1 break-words selectable">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-fg3 hover:text-fg p-0.5" aria-label="Dismiss"><IconX size={11} /></button>
        </div>
      ))}
    </div>
  );
}
