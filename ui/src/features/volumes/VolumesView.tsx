import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { ago, bytes, containerName, dateTime, matches } from "../../lib/format";
import { queryClient, refreshAll, run, useContainers, useVolumes, useVolumeUsage } from "../../lib/queries";
import { go, select, setTab, useUi } from "../../lib/store";
import { toast } from "../../lib/toast";
import type { ContainerSummary, KV, Volume } from "../../lib/types";
import { confirmAction, Modal } from "../../components/dialog";
import { useShortcut } from "../../components/hooks";
import { SortButton, useListSort } from "../../components/sort";
import { KVEditor } from "../../components/kv";
import { DetailHeader, JsonView, MasterDetail, Toolbar } from "../../components/layout";
import { openMenu, type MenuItem } from "../../components/menu";
import { Table, type Column } from "../../components/table";
import { Badge, Button, CopyButton, Dot, Empty, ErrorBox, Field, IconButton, Loading, Row, Section, Tabs } from "../../components/ui";
import { IconCode, IconCopy, IconFolder, IconInfo, IconPlus, IconRefresh, IconTrash, IconVolumes } from "../../components/icons";
import { writeText } from "../../components/clipboard";
import { FileBrowser } from "./FileBrowser";

function attachMap(containers?: ContainerSummary[]) {
  const m = new Map<string, ContainerSummary[]>();
  for (const c of containers ?? []) {
    for (const mt of c.Mounts ?? []) {
      if (mt.Type === "volume" && mt.Name) {
        if (!m.has(mt.Name)) m.set(mt.Name, []);
        m.get(mt.Name)!.push(c);
      }
    }
  }
  return m;
}

const isAnon = (name: string) => /^[0-9a-f]{64}$/.test(name);

export function VolumesView() {
  const q = useVolumes();
  const usage = useVolumeUsage().data;
  const containers = useContainers().data;
  const search = useUi((s) => s.search.volumes ?? "");
  const selected = useUi((s) => s.selected.volumes ?? null);
  const [creating, setCreating] = useState(false);
  useShortcut("n", () => setCreating(true));
  const listSort = useListSort("volumes", "containers", true);
  const attached = useMemo(() => attachMap(containers), [containers]);
  const rows = useMemo(() => (q.data ?? []).filter((v) => matches(search, v.Name, v.Driver, v.Labels?.["com.docker.compose.project"])), [q.data, search]);

  const columns: Column<Volume>[] = [
    {
      id: "name", header: "Name", width: "minmax(180px, 2fr)", sort: (a, b) => a.Name.localeCompare(b.Name),
      cell: (v) => {
        const users = attached.get(v.Name) ?? [];
        const project = v.Labels?.["com.docker.compose.project"];
        return (
          <div className="flex items-center gap-2.5 min-w-0 py-[3px]">
            <Dot tone={users.some((c) => c.State === "running") ? "ok" : "idle"} />
            <div className="min-w-0">
              <div className="truncate font-medium leading-tight">{isAnon(v.Name) ? v.Name.slice(0, 12) + "…" : v.Name}</div>
              <div className="truncate text-[11.5px] text-fg2 leading-tight">
                {users.length ? `${users.length} container${users.length > 1 ? "s" : ""}` : "Unused"}{project ? ` · ${project}` : ""}{isAnon(v.Name) ? " · anonymous" : ""}
              </div>
            </div>
          </div>
        );
      },
    },
    { id: "driver", header: "Driver", width: "64px", cell: (v) => <span className="text-fg2 text-[12px]">{v.Driver}</span> },
    { id: "size", header: "Size", width: "74px", align: "right", sort: (a, b) => (usage?.get(a.Name) ?? -1) - (usage?.get(b.Name) ?? -1), cell: (v) => <span className="text-fg2 text-[12px] tabular-nums">{usage ? bytes(usage.get(v.Name)) : "…"}</span> },
    { id: "created", header: "Created", width: "80px", align: "right", sort: (a, b) => Date.parse(a.CreatedAt ?? "") - Date.parse(b.CreatedAt ?? ""), cell: (v) => <span className="text-fg2 text-[12px] tabular-nums">{ago(v.CreatedAt)}</span> },
  ];

  const menu = (v: Volume): MenuItem[] => [
    { label: "Browse Files", icon: <IconFolder size={13} />, onClick: () => go("volumes", v.Name, "files") },
    { label: "Inspect", icon: <IconCode size={13} />, onClick: () => go("volumes", v.Name, "inspect") },
    "sep",
    { label: "Copy Name", icon: <IconCopy size={13} />, onClick: () => writeText(v.Name) },
    { label: "Copy Mountpoint", icon: <IconCopy size={13} />, onClick: () => writeText(v.Mountpoint) },
    "sep",
    { label: attached.get(v.Name)?.length ? "Delete (Volume in use)" : "Delete", icon: <IconTrash size={13} />, danger: true, disabled: !!attached.get(v.Name)?.length, onClick: () => deleteVolume(v, attached.get(v.Name) ?? []), shortcut: "⌘⌫" },
  ];

  const sel = q.data?.find((v) => v.Name === selected);
  let list;
  if (q.isLoading) list = <Loading />;
  else if (q.error) list = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (!q.data?.length) list = <Empty icon={<IconVolumes />} title="No volumes" action={<Button kind="primary" onClick={() => setCreating(true)}>New Volume</Button>}>Volumes are for sharing data between containers. Unlike bind mounts, they live inside the engine's Linux file system.</Empty>;
  else if (!rows.length) list = <Empty title="No matching volumes" />;
  else
    list = (
      <Table
        label="Volumes"
        rows={rows}
        rowKey={(v) => v.Name}
        columns={columns}
        selected={selected}
        onSelect={(id) => select("volumes", id)}
        onOpen={(id) => go("volumes", id, "files")}
        onDelete={(id) => { const v = q.data?.find((x) => x.Name === id); if (v) deleteVolume(v, attached.get(v.Name) ?? []); }}
        onContextMenu={(e, v) => openMenu(e, menu(v))}
        {...listSort}
        extraSorts={{ containers: (a, b) => (attached.get(a.Name)?.length ?? 0) - (attached.get(b.Name)?.length ?? 0) }}
        dim={(v) => !(attached.get(v.Name)?.length)}
        rowActions={(v) => (
          <>
            <IconButton title="Browse files" onClick={() => go("volumes", v.Name, "files")}><IconFolder size={13} /></IconButton>
            <IconButton title={attached.get(v.Name)?.length ? "Volume in use" : "Delete volume"} disabled={!!attached.get(v.Name)?.length} tone="bad" onClick={() => deleteVolume(v, attached.get(v.Name) ?? [])}><IconTrash size={13} /></IconButton>
          </>
        )}
      />
    );

  const total = usage ? [...usage.values()].reduce((a, b) => a + b, 0) : null;
  return (
    <div className="h-full flex flex-col" data-section="volumes">
      <Toolbar section="volumes" title="Volumes" count={q.data?.length} filters={total != null ? <span className="text-fg3 text-[12px] tabular-nums">{bytes(total)} used</span> : undefined}>
        <SortButton section="volumes" special="Number of Containers" />
        <IconButton title="Refresh (⌘R)" onClick={refreshAll}><IconRefresh size={14} /></IconButton>
        <IconButton title="New volume (⌘N)" onClick={() => setCreating(true)}><IconPlus size={15} /></IconButton>
      </Toolbar>
      <MasterDetail
        list={list}
        detail={sel ? <VolumeDetail key={sel.Name} v={sel} users={attached.get(sel.Name) ?? []} size={usage?.get(sel.Name)} /> : <Empty icon={<IconVolumes />} title="No volume selected">Select a volume to see where it's used and browse its files.</Empty>}
      />
      {creating && <CreateVolumeDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

async function deleteVolume(v: Volume, users: ContainerSummary[]) {
  if (users.length) {
    await confirmAction({
      title: "Volume is in use",
      message: <>Remove {users.map(containerName).join(", ")} before deleting <b className="text-fg">{v.Name}</b>. Docker refuses to delete volumes that containers still reference.</>,
      confirmLabel: "OK",
    });
    return;
  }
  const { ok } = await confirmAction({
    title: "Delete volume?",
    message: <><b className="text-fg break-all">{v.Name}</b> and all of its data will be permanently deleted.</>,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const r = await run("Delete failed", () => api.removeVolume(v.Name, false));
  if (r !== undefined) {
    toast("Volume deleted", "ok");
    select("volumes", null);
    queryClient.invalidateQueries({ queryKey: ["volumes"] });
  }
}

type VTab = "info" | "files" | "inspect";
function VolumeDetail({ v, users, size }: { v: Volume; users: ContainerSummary[]; size?: number }) {
  const tab = (useUi((s) => s.detailTab.volumes) ?? "info") as VTab;
  const q = useQuery({ queryKey: ["volume", v.Name], queryFn: () => api.inspectVolume(v.Name) });
  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        icon={<IconVolumes />}
        title={v.Name}
        subtitle={`${v.Driver} · ${size != null ? bytes(size) : "size unknown"} · ${users.length ? `used by ${users.length}` : "unused"}`}
        actions={<IconButton title={users.length ? "Volume in use" : "Delete volume"} disabled={users.length > 0} tone="bad" onClick={() => deleteVolume(v, users)}><IconTrash size={14} /></IconButton>}
        tabs={<Tabs<VTab> value={tab} onChange={(t) => setTab("volumes", t)} tabs={[
          { id: "info", label: "Info", icon: <IconInfo size={12} /> },
          { id: "files", label: "Files", icon: <IconFolder size={12} /> },
          { id: "inspect", label: "Inspect", icon: <IconCode size={12} /> },
        ]} />}
      />
      <div className="flex-1 min-h-0 overflow-auto relative">
        {tab === "info" && (
          <div className="p-4 fadein">
            <Section title="General">
              <Row label="Name" mono><span className="inline-flex items-center gap-1 break-all">{v.Name}<CopyButton text={v.Name} /></span></Row>
              <Row label="Driver">{v.Driver}</Row>
              <Row label="Scope">{v.Scope}</Row>
              <Row label="Size">{size != null ? bytes(size) : "—"}</Row>
              <Row label="Created">{dateTime(v.CreatedAt)}</Row>
              <Row label="Mountpoint" mono>
                <span className="break-all">{v.Mountpoint}</span>
                <div className="text-fg3 font-sans text-[11px] mt-0.5">Path inside the engine's Linux VM, not on your Mac. Use Files to browse it.</div>
              </Row>
              {v.Options && Object.keys(v.Options).length > 0 && <Row label="Options" mono>{Object.entries(v.Options).map(([k, x]) => `${k}=${x}`).join(", ")}</Row>}
            </Section>
            <Section title={`Used by (${users.length})`}>
              {users.length === 0 ? <div className="px-3 py-2 text-fg3 text-[12px]">No containers reference this volume</div> : users.map((c) => {
                const m = c.Mounts?.find((x) => x.Name === v.Name);
                return (
                  <button key={c.Id} onClick={() => go("containers", c.Id, "info")} className="w-full flex items-center gap-2 px-3 h-[30px] border-b border-line last:border-b-0 hover:bg-hover text-left">
                    <Dot tone={c.State === "running" ? "ok" : "idle"} />
                    <span className="flex-1 truncate">{containerName(c)}</span>
                    <span className="mono text-[11px] text-fg2">{m?.Destination}</span>
                    {m?.RW === false && <Badge>ro</Badge>}
                  </button>
                );
              })}
            </Section>
            <Section title="Labels">
              {!v.Labels || !Object.keys(v.Labels).length ? <div className="px-3 py-2 text-fg3 text-[12px]">No labels</div> : Object.entries(v.Labels).map(([k, x]) => (
                <div key={k} className="px-3 py-[5px] border-b border-line last:border-b-0 mono text-[11.5px] selectable break-all"><span className="text-fg2">{k}</span> = {x}</div>
              ))}
            </Section>
          </div>
        )}
        {tab === "files" && <FileBrowser volume={v.Name} />}
        {tab === "inspect" && (q.data ? <JsonView value={q.data} /> : q.error ? <ErrorBox error={q.error} /> : <Loading />)}
      </div>
    </div>
  );
}

function CreateVolumeDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("local");
  const [labels, setLabels] = useState<KV[]>([]);
  const [opts, setOpts] = useState<KV[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await api.createVolume({ name: name.trim(), driver, labels, driverOpts: opts });
      queryClient.invalidateQueries({ queryKey: ["volumes"] });
      toast(`Created volume ${v.Name}`, "ok");
      go("volumes", v.Name, "info");
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New Volume" onClose={onClose} width={480} footer={<>
      {error && <div className="flex-1 text-bad text-[12px] self-center truncate" title={error}>{error}</div>}
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" busy={busy} onClick={submit}>Create</Button>
    </>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="flex gap-3">
          <div className="flex-[3]"><Field label="Name" hint="Leave empty for a random name."><input autoFocus className="field mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-data" /></Field></div>
          <div className="flex-1"><Field label="Driver"><input className="field mono" value={driver} onChange={(e) => setDriver(e.target.value)} /></Field></div>
        </div>
        <Field label="Labels"><KVEditor value={labels} onChange={setLabels} keyPlaceholder="key" addLabel="Add label" /></Field>
        <Field label="Driver options"><KVEditor value={opts} onChange={setOpts} keyPlaceholder="type" valuePlaceholder="tmpfs" addLabel="Add option" /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
