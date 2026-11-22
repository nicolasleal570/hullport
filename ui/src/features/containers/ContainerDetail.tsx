import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { ago, composeProject, containerName, dateTime, publishedPorts, shortId, stateTone } from "../../lib/format";
import { go, setTab, useUi } from "../../lib/store";
import type { ContainerSummary } from "../../lib/types";
import { DetailHeader, JsonView } from "../../components/layout";
import { Badge, CopyButton, Dot, ErrorBox, IconButton, Loading, Row, Section, Tabs } from "../../components/ui";
import {
  IconCode, IconContainers, IconExternal, IconInfo, IconLogs, IconMore, IconPause, IconPlay, IconRestart, IconStats, IconStop, IconTerminal, IconTrash,
} from "../../components/icons";
import { openMenuAt } from "../../components/menu";
import { act, containerMenu, deleteContainers, openPort } from "./actions";
import { LogsView } from "./LogsView";
import { TerminalView } from "./TerminalView";
import { StatsView } from "./StatsView";

type Tab = "info" | "logs" | "terminal" | "stats" | "inspect";

export function ContainerDetail({ c }: { c: ContainerSummary }) {
  const tab = (useUi((s) => s.detailTab.containers) ?? "info") as Tab;
  const [termOpened, setTermOpened] = useState(tab === "terminal");
  if (tab === "terminal" && !termOpened) setTermOpened(true);
  const running = c.State === "running";
  const paused = c.State === "paused";
  const ports = publishedPorts(c);

  return (
    <div className="h-full flex flex-col" data-testid="container-detail">
      <DetailHeader
        icon={<IconContainers />}
        title={<span className="flex items-center gap-2"><Dot tone={stateTone(c.State)} />{containerName(c)}</span>}
        subtitle={`${c.Image} · ${c.State === "paused" ? "Paused" : c.Status}`}
        actions={
          <>
            {running || paused ? (
              <IconButton title="Stop" onClick={() => act(c, "stop")}><IconStop size={12} /></IconButton>
            ) : (
              <IconButton title="Start" onClick={() => act(c, "start")}><IconPlay size={12} /></IconButton>
            )}
            <IconButton title="Restart" disabled={!running} onClick={() => act(c, "restart")}><IconRestart size={14} /></IconButton>
            <IconButton title={paused ? "Resume" : "Pause"} disabled={!running && !paused} onClick={() => act(c, paused ? "unpause" : "pause")}>
              {paused ? <IconPlay size={12} /> : <IconPause size={12} />}
            </IconButton>
            {ports[0] && <IconButton title={`Open localhost:${ports[0].host}`} onClick={() => openPort(ports[0].host)}><IconExternal size={14} /></IconButton>}
            <IconButton title="Delete" tone="bad" onClick={() => deleteContainers([c])}><IconTrash size={14} /></IconButton>
            <IconButton title="More" onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, containerMenu(c))}><IconMore size={14} /></IconButton>
          </>
        }
        tabs={
          <Tabs<Tab>
            value={tab}
            onChange={(t) => setTab("containers", t)}
            tabs={[
              { id: "info", label: "Info", icon: <IconInfo size={12} /> },
              { id: "logs", label: "Logs", icon: <IconLogs size={12} /> },
              { id: "terminal", label: "Terminal", icon: <IconTerminal size={12} /> },
              { id: "stats", label: "Stats", icon: <IconStats size={12} /> },
              { id: "inspect", label: "Inspect", icon: <IconCode size={12} /> },
            ]}
          />
        }
      />
      <div className="flex-1 min-h-0 relative">
        {tab === "info" && <InfoTab c={c} />}
        {tab === "logs" && <LogsView id={c.Id} running={running} />}
        {termOpened && (
          <div className={tab === "terminal" ? "absolute inset-0" : "hidden"}>
            <TerminalView id={c.Id} running={running} visible={tab === "terminal"} />
          </div>
        )}
        {tab === "stats" && <StatsView id={c.Id} running={running} />}
        {tab === "inspect" && <InspectTab id={c.Id} />}
      </div>
    </div>
  );
}

function useInspect(id: string) {
  return useQuery({ queryKey: ["container", id], queryFn: () => api.inspectContainer(id) });
}

function InspectTab({ id }: { id: string }) {
  const q = useInspect(id);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return <div className="h-full overflow-auto"><JsonView value={q.data} /></div>;
}

function InfoTab({ c }: { c: ContainerSummary }) {
  const q = useInspect(c.Id);
  const d = q.data;
  const project = composeProject(c);
  const env: string[] = d?.Config?.Env ?? [];
  const labels: Record<string, string> = d?.Config?.Labels ?? {};
  const networks: Record<string, any> = d?.NetworkSettings?.Networks ?? {};
  const portMap: Record<string, { HostIp: string; HostPort: string }[] | null> = d?.NetworkSettings?.Ports ?? {};
  const restart = d?.HostConfig?.RestartPolicy?.Name;
  const cmd = [...(d?.Config?.Entrypoint ?? []), ...(d?.Config?.Cmd ?? [])].join(" ");

  return (
    <div className="h-full overflow-auto p-4 fadein">
      {q.error != null && <ErrorBox error={q.error} />}
      <Section title="General">
        <Row label="Status">
          <span className="inline-flex items-center gap-2">
            <Dot tone={stateTone(c.State)} /> {d?.State?.Status ?? c.State}
            {d?.State?.Health?.Status && <Badge tone={d.State.Health.Status === "healthy" ? "ok" : "warn"}>{d.State.Health.Status}</Badge>}
            {d?.State?.ExitCode ? <span className="text-fg3">exit {d.State.ExitCode}</span> : null}
          </span>
        </Row>
        <Row label="ID" mono><span className="inline-flex items-center gap-1">{shortId(c.Id)}<CopyButton text={c.Id} title="Copy ID" /></span></Row>
        <Row label="Image" mono>
          <button className="link text-left" onClick={() => c.ImageID && go("images", c.ImageID, "info")}>{c.Image}</button>
        </Row>
        <Row label="Command" mono>{cmd || null}</Row>
        <Row label="Created">{dateTime(c.Created)} <span className="text-fg3">({ago(c.Created)})</span></Row>
        {d?.State?.StartedAt && !d.State.StartedAt.startsWith("0001") && <Row label="Started">{dateTime(d.State.StartedAt)}</Row>}
        <Row label="Restart policy">{restart || "no"}</Row>
        {project && <Row label="Compose project">{project} · {c.Labels?.["com.docker.compose.service"]}</Row>}
        {d?.Config?.WorkingDir && <Row label="Working dir" mono>{d.Config.WorkingDir}</Row>}
      </Section>

      <Section title="Ports">
        {Object.keys(portMap).length === 0 ? (
          <div className="px-3 py-2 text-fg3 text-caption">No exposed ports</div>
        ) : (
          Object.entries(portMap).map(([cp, binds]) => (
            <Row key={cp} label={cp} mono>
              {binds?.length ? (
                <span className="flex flex-wrap gap-2">
                  {binds.filter((b, i, a) => a.findIndex((x) => x.HostPort === b.HostPort) === i).map((b) => (
                    <button key={b.HostIp + b.HostPort} className="link inline-flex items-center gap-1" onClick={() => openPort(Number(b.HostPort))}>
                      localhost:{b.HostPort} <IconExternal size={10} />
                    </button>
                  ))}
                </span>
              ) : <span className="text-fg3">not published</span>}
            </Row>
          ))
        )}
      </Section>

      <Section title="Mounts">
        {!(d?.Mounts ?? c.Mounts)?.length ? (
          <div className="px-3 py-2 text-fg3 text-caption">No mounts</div>
        ) : (
          (d?.Mounts ?? c.Mounts ?? []).map((m: any, i: number) => (
            <div key={i} className="flex items-start gap-3 px-3 py-[6px] border-b border-line last:border-b-0">
              <div className="w-[118px] shrink-0 flex gap-1 pt-[1px]">
                <Badge tone={m.Type === "volume" ? "strong" : "idle"}>{m.Type}</Badge>
                {m.RW === false && <Badge>ro</Badge>}
              </div>
              <div className="flex-1 min-w-0 selectable">
                <div className="mono break-all">{m.Destination}</div>
                <div className="text-caption text-fg2 break-all">
                  {m.Type === "volume" ? (
                    <button className="link text-left break-all" onClick={() => go("volumes", m.Name, "info")}>{m.Name}</button>
                  ) : m.Source}
                </div>
              </div>
            </div>
          ))
        )}
      </Section>

      <Section title="Networks">
        {Object.keys(networks).length === 0 ? (
          <div className="px-3 py-2 text-fg3 text-caption">{d?.HostConfig?.NetworkMode ?? "None"}</div>
        ) : (
          Object.entries(networks).map(([name, n]) => (
            <Row key={name} label={name}>
              <span className="inline-flex items-center gap-3 flex-wrap mono">
                <button className="link font-sans" onClick={() => go("networks", n.NetworkID, "containers")}>open</button>
                {n.IPAddress && <span>{n.IPAddress}{n.IPPrefixLen ? `/${n.IPPrefixLen}` : ""}</span>}
                {n.Gateway && <span className="text-fg3">gw {n.Gateway}</span>}
                {n.Aliases?.length ? <span className="text-fg3">aliases {n.Aliases.join(", ")}</span> : null}
              </span>
            </Row>
          ))
        )}
      </Section>

      <Section title={`Environment (${env.length})`}>
        {env.length === 0 ? <div className="px-3 py-2 text-fg3 text-caption">No variables</div> : env.map((e, i) => {
          const k = e.indexOf("=");
          return <Row key={i} label={e.slice(0, k)} mono>{e.slice(k + 1)}</Row>;
        })}
      </Section>

      <Section title={`Labels (${Object.keys(labels).length})`}>
        {Object.keys(labels).length === 0 ? <div className="px-3 py-2 text-fg3 text-caption">No labels</div> : Object.entries(labels).map(([k, v]) => (
          <div key={k} className="px-3 py-[5px] border-b border-line last:border-b-0 mono text-caption selectable break-all"><span className="text-fg2">{k}</span> = {v}</div>
        ))}
      </Section>
    </div>
  );
}
