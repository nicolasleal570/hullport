import { useMemo, useState } from "react";
import { useShortcut } from "../../components/hooks";
import { SortButton, useListSort } from "../../components/sort";
import { Toolbar, MasterDetail } from "../../components/layout";
import { Table, type Column } from "../../components/table";
import { Badge, Button, Dot, Empty, ErrorBox, IconButton, Loading } from "../../components/ui";
import { IconContainers, IconExternal, IconPlay, IconPlus, IconRefresh, IconStop, IconTerminal, IconTrash } from "../../components/icons";
import { openMenu } from "../../components/menu";
import { ago, composeProject, containerName, containerTitle, matches, publishedPorts, stateTone } from "../../lib/format";
import { refreshAll, useContainers } from "../../lib/queries";
import { go, select, setUi, useUi } from "../../lib/store";
import type { ContainerSummary } from "../../lib/types";
import { act, containerMenu, deleteContainers, openPort } from "./actions";
import { ContainerDetail } from "./ContainerDetail";
import { CreateContainerDialog } from "./CreateContainerDialog";

export function ContainersView() {
  const q = useContainers();
  const search = useUi((s) => s.search.containers ?? "");
  const selected = useUi((s) => s.selected.containers ?? null);
  const showStopped = useUi((s) => s.showStopped);
  const collapsed = useUi((s) => s.collapsedGroups);
  const [creating, setCreating] = useState(false);
  useShortcut("n", () => setCreating(true));
  const listSort = useListSort("containers", "status", false);

  const rows = useMemo(
    () =>
      (q.data ?? []).filter(
        (c) =>
          (showStopped || c.State === "running" || c.State === "paused" || c.State === "restarting") &&
          matches(search, containerName(c), c.Image, c.Id, composeProject(c), c.Status),
      ),
    [q.data, search, showStopped],
  );

  const columns: Column<ContainerSummary>[] = [
    {
      id: "name", header: "Name", width: "minmax(180px, 1.6fr)",
      sort: (a, b) => containerName(a).localeCompare(containerName(b)),
      cell: (c) => (
        <div className="flex items-center gap-2.5 min-w-0 py-[3px]">
          <Dot tone={stateTone(c.State)} pulse={c.State === "restarting"} />
          <div className="min-w-0">
            <div className="truncate font-medium leading-tight">{containerTitle(c)}</div>
            <div className="truncate text-caption text-fg2 leading-tight">{c.Image}</div>
          </div>
        </div>
      ),
    },
    {
      id: "status", header: "Status", width: "minmax(90px, 0.9fr)",
      sort: (a, b) => stateRank(a.State) - stateRank(b.State) || containerName(a).localeCompare(containerName(b)),
      cell: (c) => {
        const health = /\((healthy|unhealthy|health: starting)\)/.exec(c.Status ?? "")?.[1];
        const text = (c.State === "paused" ? "Paused" : c.Status ?? "").replace(/\s*\((healthy|unhealthy|health: starting)\)/, "");
        return (
          <span className="text-fg2 text-caption inline-flex items-center gap-1.5" title={c.Status}>
            {text}
            {health && <span className={health === "healthy" ? "text-ok" : health === "unhealthy" ? "text-bad" : "text-warn"} title={health}>●</span>}
          </span>
        );
      },
    },
    {
      id: "ports", header: "Ports", width: "minmax(70px, 0.8fr)",
      cell: (c) => {
        const ports = publishedPorts(c);
        if (!ports.length) return <span className="text-fg3">—</span>;
        return (
          <div className="flex gap-1 overflow-hidden">
            {ports.slice(0, 3).map((p) => (
              <button
                key={`${p.host}/${p.proto}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => openPort(p.host)}
                title={`Open http://localhost:${p.host} (→ ${p.container}/${p.proto})`}
                className="mono text-badge px-1.5 h-[18px] rounded-label bg-well text-fg hover:bg-well-hover inline-flex items-center gap-0.5 transition-colors hover:duration-100"
              >
                {p.host}<IconExternal size={9} />
              </button>
            ))}
            {ports.length > 3 && <span className="text-fg3 text-badge">+{ports.length - 3}</span>}
          </div>
        );
      },
    },
    {
      id: "created", header: "Created", width: "78px", align: "right",
      sort: (a, b) => (a.Created ?? 0) - (b.Created ?? 0),
      cell: (c) => <span className="text-fg2 text-caption tabular-nums">{ago(c.Created)}</span>,
    },
  ];

  const sel = q.data?.find((c) => c.Id === selected);

  let list;
  if (q.isLoading) list = <Loading />;
  else if (q.error) list = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (!q.data?.length)
    list = (
      <Empty icon={<IconContainers />} title="No containers yet" action={<Button onClick={() => setCreating(true)}>Create a Container</Button>}>
        Containers run your apps in isolation. Start one here, from an image, or with <span className="mono">docker run</span>.
      </Empty>
    );
  else if (!rows.length) list = <Empty title="No matching containers">{!showStopped ? "Stopped containers are hidden." : "Try another search."}</Empty>;
  else
    list = (
      <Table
        label="Containers"
        rows={rows}
        rowKey={(c) => c.Id}
        columns={columns}
        selected={selected}
        onSelect={(id) => select("containers", id)}
        onOpen={(id) => go("containers", id, "logs")}
        onDelete={(id) => { const c = q.data?.find((x) => x.Id === id); if (c) deleteContainers([c]); }}
        onContextMenu={(e, c) => openMenu(e, containerMenu(c))}
        {...listSort}
        dim={(c) => c.State !== "running"}
        groupBy={composeProject}
        collapsed={collapsed}
        onToggleGroup={(k) => setUi((s) => ({ collapsedGroups: { ...s.collapsedGroups, [k]: !s.collapsedGroups[k] } }))}
        renderGroup={(g) => {
          const running = g.rows.filter((c) => c.State === "running").length;
          return (
            <div className="flex items-center gap-2 flex-1 min-w-0" onContextMenu={(e) => openMenu(e, [
              { label: "Start All", onClick: () => g.rows.filter((c) => c.State !== "running").forEach((c) => act(c, "start")) },
              { label: "Stop All", onClick: () => g.rows.filter((c) => c.State === "running").forEach((c) => act(c, "stop")) },
              { label: "Restart All", onClick: () => g.rows.forEach((c) => act(c, "restart")) },
              "sep",
              { label: "Delete Project Containers", danger: true, onClick: () => deleteContainers(g.rows) },
            ])}>
              <Dot tone={running === g.rows.length ? "ok" : running ? "warn" : "idle"} />
              <span className="font-semibold truncate">{g.key}</span>
              <Badge tone="idle">Compose</Badge>
              <span className="text-fg3 text-caption">{running}/{g.rows.length} running</span>
              <div className="flex-1" />
              {running < g.rows.length && (
                <IconButton title="Start all" onClick={() => g.rows.filter((c) => c.State !== "running").forEach((c) => act(c, "start"))}><IconPlay size={12} /></IconButton>
              )}
              {running > 0 && (
                <IconButton title="Stop all" onClick={() => g.rows.filter((c) => c.State === "running").forEach((c) => act(c, "stop"))}><IconStop size={12} /></IconButton>
              )}
              <IconButton title="Delete all" tone="bad" onClick={() => deleteContainers(g.rows)}><IconTrash size={13} /></IconButton>
            </div>
          );
        }}
        rowActions={(c) => (
          <>
            {c.State === "running" ? (
              <IconButton title="Stop" onClick={() => act(c, "stop")}><IconStop size={12} /></IconButton>
            ) : (
              <IconButton title="Start" onClick={() => act(c, c.State === "paused" ? "unpause" : "start")}><IconPlay size={12} /></IconButton>
            )}
            <IconButton title="Open terminal" disabled={c.State !== "running"} onClick={() => go("containers", c.Id, "terminal")}><IconTerminal size={13} /></IconButton>
            <IconButton title="Delete" tone="bad" onClick={() => deleteContainers([c])}><IconTrash size={13} /></IconButton>
          </>
        )}
      />
    );

  const running = q.data?.filter((c) => c.State === "running").length ?? 0;
  return (
    <div className="h-full flex flex-col" data-section="containers">
      <Toolbar
        section="containers"
        title="Containers"
        count={q.data?.length}
        filters={
          <label className="flex items-center gap-1.5 text-caption text-fg2" title="Show Stopped Containers">
            <input type="checkbox" checked={showStopped} onChange={(e) => setUi({ showStopped: e.target.checked })} />
            Show stopped
            <span className="text-fg3">· {running} running</span>
          </label>
        }
      >
        <SortButton section="containers" special="Status" />
        <IconButton title="Refresh (⌘R)" onClick={refreshAll}><IconRefresh size={14} /></IconButton>
        <IconButton title="New container (⌘N)" onClick={() => setCreating(true)}><IconPlus size={15} /></IconButton>
      </Toolbar>
      <MasterDetail
        list={list}
        detail={sel ? <ContainerDetail key={sel.Id} c={sel} /> : <Empty icon={<IconContainers />} title="No container selected">Select a container to see its details, logs and terminal.</Empty>}
      />
      {creating && <CreateContainerDialog onClose={() => setCreating(false)} />}
    </div>
  );
}


const RANK: Record<string, number> = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 };
const stateRank = (s?: string) => RANK[s ?? ""] ?? 6;
