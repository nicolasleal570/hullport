import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { ago, dateTime, duration, matches, shortId } from "../../lib/format";
import { queryClient, run, useConnected } from "../../lib/queries";
import { go, select, setTab, setUi, useUi } from "../../lib/store";
import { toast } from "../../lib/toast";
import type { BuildConfig, BuildkitHistoryItem, BuildRecord } from "../../lib/types";
import { confirmAction } from "../../components/dialog";
import { useShortcut } from "../../components/hooks";
import { DetailHeader, JsonView, MasterDetail, Toolbar } from "../../components/layout";
import { openMenu, openMenuAt, type MenuItem } from "../../components/menu";
import { Table, type Column } from "../../components/table";
import { Badge, Button, Checkbox, Empty, ErrorBox, IconButton, Loading, Row, Section, Tabs, cx } from "../../components/ui";
import { IconBuilds, IconCheck, IconChevron, IconChevronDown, IconCode, IconCopy, IconLogs, IconPlay, IconPlus, IconRefresh, IconSave, IconSpinner, IconStop, IconTrash, IconWarn, IconX } from "../../components/icons";
import { writeText } from "../../components/clipboard";
import { CreateContainerDialog } from "../containers/CreateContainerDialog";
import { emptyConfig, NewBuildDialog } from "./NewBuildDialog";
import { sortedVertices, startBuild, useLiveBuilds, type LiveBuild, type Vertex } from "./session";

type Status = BuildRecord["status"] | "completed" | "error" | string;
interface BuildRow {
  key: string; kind: "app" | "buildkit"; name: string; status: Status; started: string;
  durationMs?: number | null; steps?: string; error?: string | null;
  live?: LiveBuild; record?: BuildRecord; hist?: BuildkitHistoryItem;
}

function statusTone(s: Status) {
  const x = s.toLowerCase();
  if (x === "running") return "accent" as const;
  if (x === "succeeded" || x === "completed") return "ok" as const;
  if (x === "canceled" || x === "interrupted") return "idle" as const;
  return "bad" as const;
}
/** Build status labels: Running, Completed, Failed, Canceled. */
const statusLabel = (s: Status) => {
  const x = s.toLowerCase();
  if (x === "running") return "Running";
  if (x === "succeeded" || x === "completed") return "Completed";
  if (x === "canceled" || x === "interrupted") return "Canceled";
  return "Failed";
};
const statusGroup = (s: Status) => (statusLabel(s) === "Running" ? "running" : statusLabel(s) === "Failed" ? "failed" : "other");

export function StatusPill({ s }: { s: Status }) {
  const tone = statusTone(s);
  return (
    <span className="inline-flex items-center gap-1">
      {tone === "accent" && <IconSpinner size={11} className="text-accent" />}
      <Badge tone={tone}>{statusLabel(s)}</Badge>
    </span>
  );
}

export function BuildsView() {
  const connected = useConnected();
  const liveMap = useLiveBuilds();
  const records = useQuery({ queryKey: ["build-records"], queryFn: api.buildRecords });
  const hist = useQuery({ queryKey: ["buildkit-history"], queryFn: api.buildkitHistory, enabled: connected, retry: false });
  const configs = useQuery({ queryKey: ["build-configs"], queryFn: api.buildConfigs });
  const search = useUi((s) => s.search.builds ?? "");
  const filter = useUi((s) => s.buildsFilter);
  const selected = useUi((s) => s.selected.builds ?? null);
  const [dialog, setDialog] = useState<BuildConfig | null | "new">(null);
  useShortcut("n", () => setDialog("new"));
  const anyRunning = [...liveMap.values()].some((l) => l.status === "running");
  const [, tick] = useState(0);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  // Recomputed every render: live builds mutate in place.
  const rows = (() => {
    const out: BuildRow[] = [];
    const refs = new Set<string>();
    const seen = new Set<string>();
    for (const r of records.data ?? []) {
      const l = liveMap.get(r.id);
      if (r.buildRef) refs.add(r.buildRef);
      const status = l && l.status === "running" ? "running" : r.status;
      seen.add(r.id);
      out.push({
        key: r.id, kind: "app", name: `${r.config.image}:${r.config.tag || "latest"}`, status, started: r.startedAt,
        durationMs: l?.status === "running" ? Date.now() - l.startedAt : r.durationMs,
        steps: r.steps.length ? `${r.steps.length} steps · ${r.steps.filter((s) => s.cached).length} cached` : l ? `${l.vertices.size} steps` : undefined,
        error: r.error, live: l, record: l?.record ?? r,
      });
    }
    for (const [id, l] of liveMap) {
      if (seen.has(id)) continue;
      out.push({ key: id, kind: "app", name: `${l.config.image}:${l.config.tag || "latest"}`, status: l.status, started: new Date(l.startedAt).toISOString(), durationMs: Date.now() - l.startedAt, steps: `${l.vertices.size} steps`, live: l, record: l.record });
    }
    for (const h of hist.data ?? []) {
      const ref = h.ref.split("/").pop() ?? h.ref;
      if (refs.has(ref)) continue;
      out.push({
        key: "bk:" + ref, kind: "buildkit", name: h.name, status: h.status, started: h.created_at,
        durationMs: h.completed_at ? Date.parse(h.completed_at) - Date.parse(h.created_at) : null,
        steps: h.total_steps != null ? `${h.completed_steps ?? 0}/${h.total_steps} steps · ${h.cached_steps ?? 0} cached` : undefined,
        error: h.error, hist: { ...h, ref },
      });
    }
    return out.filter((r) => (filter === "all" || statusGroup(r.status) === filter) && matches(search, r.name, r.status, r.error));
  })();

  const columns: Column<BuildRow>[] = [
    {
      id: "name", header: "Build", width: "minmax(170px, 1.8fr)", sort: (a, b) => a.name.localeCompare(b.name),
      cell: (r) => (
        <div className="min-w-0 py-[3px]">
          <div className="truncate font-medium leading-tight">{r.name}</div>
          <div className="truncate text-[11.5px] text-fg2 leading-tight">{r.kind === "app" ? r.steps ?? "Started here" : `BuildKit history${r.steps ? " · " + r.steps : ""}`}</div>
        </div>
      ),
    },
    { id: "status", header: "Status", width: "96px", sort: (a, b) => a.status.localeCompare(b.status), cell: (r) => <StatusPill s={r.status} /> },
    { id: "duration", header: "Duration", width: "70px", align: "right", sort: (a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0), cell: (r) => <span className="text-fg2 text-[12px] tabular-nums">{duration(r.durationMs)}</span> },
    { id: "started", header: "Started", width: "80px", align: "right", sort: (a, b) => Date.parse(a.started) - Date.parse(b.started), cell: (r) => <span className="text-fg2 text-[12px] tabular-nums">{ago(r.started)}</span> },
  ];

  const menu = (r: BuildRow): MenuItem[] => {
    const items: MenuItem[] = [];
    if (r.kind === "app" && r.record) {
      items.push({ label: "Rebuild", icon: <IconRefresh size={13} />, onClick: () => rebuild(r.record!.config) });
      items.push({ label: "Edit & Rebuild…", icon: <IconBuilds size={13} />, onClick: () => setDialog(r.record!.config) });
    }
    if (r.status === "running" && r.live) items.push({ label: "Cancel Build", icon: <IconStop size={12} />, onClick: () => api.buildCancel(r.key) });
    items.push("sep");
    items.push({ label: "Delete Build Record", icon: <IconTrash size={13} />, danger: true, disabled: r.status === "running", onClick: () => deleteRows([r]) });
    return items;
  };

  const sel = rows.find((r) => r.key === selected);
  const loading = records.isLoading;
  let list;
  if (loading || (hist.isLoading && !rows.length)) list = <Loading label="Loading build history…" />;
  else if (!rows.length && !search)
    list = (
      <Empty icon={<IconBuilds />} title="No builds yet" action={<Button kind="primary" onClick={() => setDialog("new")}>New Build</Button>}>
        Images built with docker build or docker buildx show up here, along with builds you start from this app.
        {hist.error != null && <div className="mt-2 text-warn">BuildKit history unavailable: {String(hist.error)}</div>}
      </Empty>
    );
  else if (!rows.length) list = <Empty title="No Matching Builds">{filter !== "all" ? "Try the All filter." : null}</Empty>;
  else
    list = (
      <Table
        label="Builds"
        rows={rows}
        rowKey={(r) => r.key}
        columns={columns}
        selected={selected}
        onSelect={(id) => select("builds", id)}
        onDelete={(id) => { const r = rows.find((x) => x.key === id); if (r && r.status !== "running") deleteRows([r]); }}
        onContextMenu={(e, r) => openMenu(e, menu(r))}
        defaultSort={{ id: "started", desc: true }}
        rowActions={(r) => r.status === "running" && r.live
          ? <IconButton title="Cancel build" onClick={() => api.buildCancel(r.key)}><IconStop size={12} /></IconButton>
          : r.record ? <IconButton title="Rebuild" onClick={() => rebuild(r.record!.config)}><IconRefresh size={13} /></IconButton> : null}
      />
    );

  return (
    <div className="h-full flex flex-col" data-section="builds">
      <Toolbar
        section="builds"
        title="Builds"
        count={rows.length}
        filters={
          <Tabs<"all" | "running" | "failed">
            value={filter}
            onChange={(f) => setUi({ buildsFilter: f })}
            tabs={[{ id: "all", label: "All" }, { id: "running", label: "Running" }, { id: "failed", label: "Failed" }]}
          />
        }
      >
        <IconButton title="Refresh" onClick={() => { records.refetch(); hist.refetch(); configs.refetch(); }}><IconRefresh size={14} /></IconButton>
        <IconButton
          title="Saved configurations"
          onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, configMenu(configs.data ?? [], setDialog, () => configs.refetch()))}
        >
          <IconSave size={14} />
        </IconButton>
        <IconButton title="New build (⌘N)" onClick={() => setDialog("new")}><IconPlus size={15} /></IconButton>
      </Toolbar>
      <MasterDetail
        list={list}
        detail={sel ? (sel.kind === "app" ? <AppBuildDetail key={sel.key} row={sel} onEdit={(c) => setDialog(c)} /> : <HistoryDetail key={sel.key} row={sel} />) : <Empty icon={<IconBuilds />} title="No build selected">Select a build to follow its steps and logs, or start a new one.</Empty>}
      />
      {dialog && <NewBuildDialog initial={dialog === "new" ? emptyConfig() : dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

function configMenu(list: BuildConfig[], edit: (c: BuildConfig) => void, refresh: () => void): MenuItem[] {
  if (!list.length) return [{ label: "No saved configurations", disabled: true, onClick: () => {} }];
  const items: MenuItem[] = list.map((c) => ({ label: `Build ${c.name || c.image}`, icon: <IconPlay size={11} />, onClick: () => rebuild(c) }));
  items.push("sep");
  for (const c of list) items.push({ label: `Edit ${c.name || c.image}…`, onClick: () => edit(c) });
  items.push("sep");
  for (const c of list) items.push({ label: `Forget ${c.name || c.image}`, danger: true, onClick: () => { api.deleteBuildConfig(c.id).then(refresh); } });
  return items;
}

async function rebuild(c: BuildConfig) {
  const id = await startBuild(c);
  if (id) go("builds", id, "steps");
}

async function deleteRows(rows: BuildRow[]) {
  const { ok } = await confirmAction({
    title: rows.length > 1 ? "Delete build records?" : "Delete build record?",
    message: "Build records and their logs will be permanently deleted. Images that were built are kept.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const app = rows.filter((r) => r.kind === "app").map((r) => r.key);
  const bk = rows.filter((r) => r.kind === "buildkit").map((r) => r.hist!.ref);
  const refs = rows.filter((r) => r.kind === "app" && r.record?.buildRef).map((r) => r.record!.buildRef!);
  if (app.length) await run("Delete failed", () => api.deleteBuildRecords(app));
  if (bk.length || refs.length) await run("Delete failed", () => api.buildkitRemove([...bk, ...refs]));
  select("builds", null);
  queryClient.invalidateQueries({ queryKey: ["build-records"] });
  queryClient.invalidateQueries({ queryKey: ["buildkit-history"] });
  toast("Build record deleted", "ok");
}

type BTab = "steps" | "logs" | "config";

function stepVisible(name: string, showInternal: boolean) {
  return showInternal || !/^\[(internal|auth)\]/.test(name);
}

function AppBuildDetail({ row, onEdit }: { row: BuildRow; onEdit: (c: BuildConfig) => void }) {
  const tab = (useUi((s) => s.detailTab.builds) ?? "steps") as BTab;
  const showInternal = useUi((s) => s.showInternalSteps);
  const setShowInternal = (v: boolean) => setUi({ showInternalSteps: v });
  const stepFilter = useUi((s) => s.stepFilter);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const l = row.live;
  const rec = l?.record ?? row.record;
  const config = l?.config ?? rec!.config;
  const status = l && l.status === "running" ? "running" : rec?.status ?? l?.status ?? "running";
  const verts: Vertex[] = l ? sortedVertices(l) : (rec?.steps ?? []).map((s, i) => ({ digest: String(i), name: s.name, order: i, cached: s.cached, error: s.error ?? undefined, logs: [], durMs: s.durationMs } as any));
  const stepMs = (v: Vertex) => (v.started && v.completed ? Date.parse(v.completed) - Date.parse(v.started) : (v as any).durMs ?? 0);
  // Step filter: all, failed, slowest.
  let shown = verts.filter((v) => stepVisible(v.name, showInternal));
  if (stepFilter === "failed") shown = shown.filter((v) => v.error);
  if (stepFilter === "slowest") shown = [...shown].filter((v) => !v.cached).sort((a, b) => stepMs(b) - stepMs(a)).slice(0, 10);
  const maxStep = Math.max(1, ...verts.map(stepMs));
  const failed = verts.find((v) => v.error && !/context canceled/.test(v.error));
  const imageRef = `${config.image}:${config.tag || "latest"}`;
  const elapsed = l && status === "running" ? Date.now() - l.startedAt : rec?.durationMs;
  const logText = l ? [...verts.flatMap((v) => v.logs.filter(Boolean).map((x) => `#${v.order} ${x}`)), ...l.text].join("\n") : rec?.logTail ?? "";

  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        icon={<IconBuilds />}
        title={<span className="flex items-center gap-2">{imageRef}<StatusPill s={status} /></span>}
        subtitle={`${config.contextDir} · ${duration(elapsed)}${rec?.startedAt ? ` · ${dateTime(rec.startedAt)}` : ""}`}
        actions={
          <>
            {status === "running" ? (
              <Button onClick={() => api.buildCancel(row.key)}><IconStop size={10} /> Cancel</Button>
            ) : (
              <>
                {status === "succeeded" && <Button kind="primary" onClick={() => setRunning(true)}><IconPlay size={11} /> Run</Button>}
                <Button onClick={() => rebuild(config)}><IconRefresh size={12} /> Rebuild</Button>
                <IconButton title="Edit configuration" onClick={() => onEdit(config)}><IconBuilds size={14} /></IconButton>
                <IconButton title="Save configuration" onClick={() => run("Save failed", () => api.saveBuildConfig({ ...config, name: config.name || config.image }), "Configuration saved").then(() => queryClient.invalidateQueries({ queryKey: ["build-configs"] }))}><IconSave size={14} /></IconButton>
                <IconButton title="Delete record" tone="bad" onClick={() => deleteRows([row])}><IconTrash size={14} /></IconButton>
              </>
            )}
          </>
        }
        tabs={<Tabs<BTab> value={tab} onChange={(t) => setTab("builds", t)} tabs={[
          { id: "steps", label: `Steps ${shown.length}`, icon: <IconBuilds size={12} /> },
          { id: "logs", label: "Logs", icon: <IconLogs size={12} /> },
          { id: "config", label: "Result & Config", icon: <IconCode size={12} /> },
        ]} />}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {(status === "failed" && (rec?.error || failed?.error)) && (
          <div className="m-3 mb-0 p-2.5 rounded-[8px] border border-bad/30 bg-bad/8 text-[12px] flex gap-2 items-start">
            <IconWarn size={14} className="text-bad shrink-0 mt-[1px]" />
            <div className="flex-1 min-w-0 selectable whitespace-pre-wrap break-words">{rec?.error ?? failed?.error}</div>
            {failed && <Button kind="ghost" onClick={() => { setTab("builds", "steps"); setUi({ stepFilter: "all" }); setShowInternal(true); setOpen((o) => ({ ...o, [failed.digest]: true })); document.querySelector(`[data-step="${CSS.escape(failed.digest)}"]`)?.scrollIntoView({ block: "center" }); }}>Show Failed Step</Button>}
          </div>
        )}
        {l?.warnings.length ? <div className="mx-3 mt-3 p-2 rounded-[8px] border border-warn/30 bg-warn/8 text-[12px] text-warn">{l.warnings.length} warning{l.warnings.length > 1 ? "s" : ""}: {l.warnings.slice(0, 3).join(" · ")}</div> : null}
        {tab === "steps" && (
          <div className="p-3" data-testid="build-steps">
            <div className="flex items-center gap-3 mb-2 px-1">
              <Tabs<"all" | "failed" | "slowest">
                value={stepFilter}
                onChange={(f) => setUi({ stepFilter: f })}
                tabs={[{ id: "all", label: "All" }, { id: "failed", label: "Failed" }, { id: "slowest", label: "Slowest" }]}
              />
              <Checkbox checked={showInternal} onChange={setShowInternal} label="Show [internal] and [auth] steps" />
            </div>
            <div className="rounded-[9px] border border-line bg-panel overflow-hidden">
              {shown.length === 0 && <div className="px-3 py-3 text-fg3 text-[12px]">{stepFilter === "failed" ? "No failed steps." : status === "running" ? "Waiting for BuildKit…" : "No steps were recorded."}</div>}
              {shown.map((v) => {
                const done = !!v.completed || !!(v as any).durMs || (!l && !v.error);
                const isRunning = l && status === "running" && v.started && !v.completed;
                const dur = v.started && v.completed ? Date.parse(v.completed) - Date.parse(v.started) : (v as any).durMs;
                const expanded = open[v.digest];
                return (
                  <div key={v.digest} data-step={v.digest} className="border-b border-line last:border-b-0">
                    <div onClick={() => setOpen((o) => ({ ...o, [v.digest]: !o[v.digest] }))} className="flex items-center gap-2 px-3 min-h-[30px] hover:bg-hover">
                      <span className="w-3 text-fg3">{v.logs.length > 1 || v.logs[0] ? (expanded ? <IconChevronDown size={11} /> : <IconChevron size={11} />) : null}</span>
                      <span className="w-4 flex justify-center">
                        {v.error ? <IconX size={12} className="text-bad" /> : isRunning ? <IconSpinner size={12} className="text-accent" /> : done ? <IconCheck size={13} className="text-ok" /> : <span className="w-[6px] h-[6px] rounded-full bg-fg3" />}
                      </span>
                      <span className={cx("flex-1 min-w-0 truncate mono text-[11.5px]", v.error && "text-bad")} title={v.name}>{v.name}</span>
                      {v.cached && <Badge tone="idle">cached</Badge>}
                      {isRunning && v.progress?.total ? <span className="text-[11px] text-fg3 tabular-nums">{Math.round(((v.progress.current ?? 0) / v.progress.total) * 100)}%</span> : null}
                      <span className="w-[48px] h-[3px] rounded-full bg-field overflow-hidden" title="Relative to the slowest step">
                        <span className="block h-full bg-accent/70" style={{ width: `${Math.min(100, ((dur ?? 0) / maxStep) * 100)}%` }} />
                      </span>
                      <span className="text-[11px] text-fg3 tabular-nums w-[52px] text-right">{dur != null ? duration(dur) : isRunning ? duration(Date.now() - Date.parse(v.started!)) : ""}</span>
                    </div>
                    {expanded && v.logs.length > 0 && (
                      <pre className="mono text-[11px] leading-[1.5] m-0 px-10 pb-2 whitespace-pre-wrap break-all text-fg2 selectable max-h-[320px] overflow-auto">{v.logs.join("\n")}</pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {tab === "logs" && (
          <div className="relative">
            <div className="absolute right-3 top-2"><IconButton title="Copy logs" onClick={() => writeText(logText)}><IconCopy size={13} /></IconButton></div>
            <pre className="mono text-[11.5px] leading-[1.5] m-0 p-3 whitespace-pre-wrap break-all selectable" data-testid="build-logs">{logText || "No output yet."}</pre>
          </div>
        )}
        {tab === "config" && (
          <div className="p-4">
            <Section title="Result">
              <Row label="Status"><StatusPill s={status} /></Row>
              <Row label="Image" mono>{status === "succeeded" ? <button className="text-accent hover:underline" onClick={() => go("images", rec?.imageId ?? null, "info")}>{imageRef}</button> : imageRef}</Row>
              <Row label="Image ID" mono>{rec?.imageId ? shortId(rec.imageId) : null}</Row>
              <Row label="Duration">{duration(elapsed)}</Row>
              <Row label="Steps">{verts.length ? `${verts.length} total · ${verts.filter((v) => v.cached).length} cached` : null}</Row>
              <Row label="BuildKit ref" mono>{rec?.buildRef ?? null}</Row>
              <Row label="Engine context">{rec?.dockerContext ?? null}</Row>
            </Section>
            <Section title="Configuration">
              <Row label="Context" mono>{config.contextDir}</Row>
              <Row label="Dockerfile" mono>{config.dockerfile || "Dockerfile"}</Row>
              <Row label="Target" mono>{config.target || null}</Row>
              <Row label="Platform" mono>{config.platform || "engine default"}</Row>
              <Row label="Build args" mono>{config.buildArgs.length ? config.buildArgs.map((a) => `${a.key}=${a.value}`).join("  ") : null}</Row>
              <Row label="Options">{[config.noCache && "no cache", config.pull && "pull"].filter(Boolean).join(", ") || "—"}</Row>
              {l?.command && <Row label="Command" mono>{l.command}</Row>}
            </Section>
          </div>
        )}
      </div>
      {running && <CreateContainerDialog image={imageRef} onClose={() => setRunning(false)} />}
    </div>
  );
}

function HistoryDetail({ row }: { row: BuildRow }) {
  const tab = (useUi((s) => s.detailTab.builds) ?? "steps") as BTab;
  const ref = row.hist!.ref;
  const info = useQuery({ queryKey: ["buildkit-inspect", ref], queryFn: () => api.buildkitInspect(ref), retry: false });
  const logs = useQuery({ queryKey: ["buildkit-logs", ref], queryFn: () => api.buildkitLogs(ref), enabled: tab === "logs", retry: false });
  const d = info.data;
  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        icon={<IconBuilds />}
        title={<span className="flex items-center gap-2 min-w-0"><span className="truncate">{row.name}</span><StatusPill s={row.status} /></span>}
        subtitle={`BuildKit history · ${duration(row.durationMs)} · ${dateTime(row.started)}`}
        actions={<IconButton title="Delete record" tone="bad" onClick={() => deleteRows([row])}><IconTrash size={14} /></IconButton>}
        tabs={<Tabs<BTab> value={tab} onChange={(t) => setTab("builds", t)} tabs={[
          { id: "steps", label: "Info", icon: <IconBuilds size={12} /> },
          { id: "logs", label: "Logs", icon: <IconLogs size={12} /> },
          { id: "config", label: "Inspect", icon: <IconCode size={12} /> },
        ]} />}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {info.error != null && <ErrorBox error={info.error} />}
        {tab === "steps" && (info.isLoading ? <Loading /> : d && (
          <div className="p-4 fadein">
            {d.Error && <div className="mb-3 p-2.5 rounded-[8px] border border-bad/30 bg-bad/8 text-[12px] selectable whitespace-pre-wrap">{d.Error.Message ?? JSON.stringify(d.Error)}</div>}
            <Section title="Build">
              <Row label="Name" mono>{d.Name}</Row>
              <Row label="Dockerfile" mono>{d.Dockerfile}</Row>
              <Row label="Status">{d.Status}</Row>
              <Row label="Started">{dateTime(d.StartedAt)}</Row>
              <Row label="Duration">{d.Duration ? duration(d.Duration / 1e6) : null}</Row>
              <Row label="Steps">{`${d.NumCompletedSteps ?? 0}/${d.NumTotalSteps ?? 0} completed · ${d.NumCachedSteps ?? 0} cached`}</Row>
              {d.Platform && <Row label="Platform" mono>{(d.Platform as string[]).join(", ")}</Row>}
              {d.VCSRevision && <Row label="Revision" mono>{d.VCSRevision}</Row>}
              <Row label="Ref" mono>{ref}</Row>
            </Section>
            {d.Labels?.length > 0 && (
              <Section title="Labels">
                {d.Labels.map((x: any) => <div key={x.Name} className="px-3 py-[5px] border-b border-line last:border-b-0 mono text-[11.5px] selectable break-all"><span className="text-fg2">{x.Name}</span> = {x.Value}</div>)}
              </Section>
            )}
            {d.Materials?.length > 0 && (
              <Section title="Base images">
                {d.Materials.map((m: any) => <div key={m.URI} className="px-3 py-[5px] border-b border-line last:border-b-0 mono text-[11.5px] selectable break-all">{decodeURIComponent(m.URI)}</div>)}
              </Section>
            )}
          </div>
        ))}
        {tab === "logs" && (logs.isLoading ? <Loading /> : logs.error ? <ErrorBox error={logs.error} /> : <pre className="mono text-[11.5px] leading-[1.5] m-0 p-3 whitespace-pre-wrap break-all selectable">{logs.data || "No logs stored."}</pre>)}
        {tab === "config" && d && <JsonView value={d} />}
      </div>
    </div>
  );
}
