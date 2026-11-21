import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { run, useContainers, useImages, useNetworks, useStatus, useVolumes } from "../lib/queries";
import { go, useUi, type Section } from "../lib/store";
import { IconBuilds, IconCheck, IconPlug, IconChevronDown, IconContainers, IconImages, IconNetworks, IconRefresh, IconVolumes } from "./icons";
import { openMenuAt, type MenuItem } from "./menu";
import { cx, Dot } from "./ui";

export const SECTIONS: { id: Section; label: string; icon: ReactNode; key: string }[] = [
  { id: "containers", label: "Containers", icon: <IconContainers />, key: "1" },
  { id: "images", label: "Images", icon: <IconImages />, key: "2" },
  { id: "volumes", label: "Volumes", icon: <IconVolumes />, key: "3" },
  { id: "builds", label: "Builds", icon: <IconBuilds />, key: "4" },
  { id: "networks", label: "Networks", icon: <IconNetworks />, key: "5" },
];

function useCounts(): Partial<Record<Section, string>> {
  const c = useContainers().data;
  const i = useImages().data;
  const v = useVolumes().data;
  const n = useNetworks().data;
  const running = c?.filter((x) => x.State === "running").length;
  return {
    containers: c ? (running ? `${running}` : "") : "",
    images: i ? `${i.length}` : "",
    volumes: v ? `${v.length}` : "",
    networks: n ? `${n.length}` : "",
  };
}

export function Sidebar() {
  const section = useUi((s) => s.section);
  const counts = useCounts();
  return (
    <aside className="w-[210px] shrink-0 h-full flex flex-col bg-sidebar border-r border-line" aria-label="Sidebar">
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="px-3 pb-1 text-[11px] font-semibold text-fg3 tracking-[0.02em]">Docker</div>
      <nav className="px-2 flex flex-col gap-[1px]" aria-label="Sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            data-nav={s.id}
            onClick={() => go(s.id)}
            title={`${s.label} (⌘${s.key})`}
            aria-current={section === s.id ? "page" : undefined}
            className={cx(
              "flex items-center gap-2.5 h-[28px] px-2 rounded-[6px] text-[13px] transition-colors",
              section === s.id ? "bg-fg/10 text-fg font-medium" : "text-fg/85 hover:bg-hover",
            )}
          >
            <span className={cx("w-4 flex justify-center", section === s.id ? "text-accent" : "text-fg2")}>{s.icon}</span>
            <span className="flex-1 text-left">{s.label}</span>
            {counts[s.id] && (
              <span className={cx("text-[11px] tabular-nums", s.id === "containers" ? "text-ok font-semibold" : "text-fg3")}>{counts[s.id]}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="flex-1" />
      <nav className="px-2 mb-1" aria-label="Settings">
        <button
          data-nav-settings="engines"
          onClick={() => go("engines")}
          aria-current={section === "engines" ? "page" : undefined}
          className={cx("w-full flex items-center gap-2.5 h-[28px] px-2 rounded-[6px] text-[13px]", section === "engines" ? "bg-fg/10 text-fg font-medium" : "text-fg/85 hover:bg-hover")}
        >
          <span className={cx("w-4 flex justify-center", section === "engines" ? "text-accent" : "text-fg2")}><IconPlug size={15} /></span>
          <span className="flex-1 text-left">Engines</span>
        </button>
      </nav>
      <EngineStatus />
    </aside>
  );
}

function EngineStatus() {
  const st = useStatus();
  const ctx = useQuery({ queryKey: ["contexts", st.state], queryFn: api.contexts });
  const tone = st.state === "connected" ? "ok" : st.state === "connecting" ? "warn" : "bad";
  const label = st.state === "connected" ? "Connected" : st.state === "connecting" ? "Connecting…" : "Disconnected";

  const openContexts = (el: HTMLElement) => {
    const list = ctx.data;
    const items: MenuItem[] = [];
    items.push({
      label: "Automatic (Hullport engine first)",
      icon: !list?.selected ? <IconCheck size={13} /> : undefined,
      onClick: () => run("Switch context", () => api.setContext(null)),
    });
    items.push("sep");
    for (const c of list?.contexts ?? []) {
      items.push({
        label: `${c.name}${c.available ? "" : " (unavailable)"}`,
        icon: list?.selected === c.name ? <IconCheck size={13} /> : undefined,
        onClick: () => run("Switch context", () => api.setContext(c.name)),
      });
    }
    items.push("sep");
    items.push({ label: "Reconnect", icon: <IconRefresh size={13} />, onClick: () => api.reconnect() });
    items.push({ label: "Manage Engines…", icon: <IconPlug size={13} />, onClick: () => go("engines") });
    openMenuAt(el, items);
  };

  return (
    <div className="m-2 p-2 rounded-[9px] border border-line bg-fg/[0.03]" data-testid="engine-status">
      <div className="flex items-center gap-2">
        <Dot tone={tone} pulse={st.state === "connecting"} />
        <span className="text-[12px] font-medium" data-testid="engine-state">{label}</span>
        {st.serverVersion && <span className="text-[11px] text-fg3 ml-auto tabular-nums">v{st.serverVersion}</span>}
      </div>
      <button
        onClick={(e) => openContexts(e.currentTarget)}
        className="mt-1.5 w-full flex items-center gap-1 h-[22px] px-1.5 -mx-0.5 rounded-[5px] hover:bg-hover text-left"
        title={st.host || "Docker context"}
        aria-label="Docker context"
      >
        <span className="text-[11.5px] text-fg2 truncate flex-1" data-testid="engine-context">{st.context || "—"}</span>
        <IconChevronDown size={11} className="text-fg3" />
      </button>
      {st.state === "connected" && st.fallbackFrom && (
        <div className="mt-1 text-[11px] text-warn leading-snug" data-testid="engine-fallback">
          {st.fallbackFrom} isn't answering; using {st.context} for now.
        </div>
      )}
      {st.state === "disconnected" && st.error && (
        <div className="mt-1 text-[11px] text-bad/90 leading-snug line-clamp-3" title={st.error}>{st.error}</div>
      )}
    </div>
  );
}
