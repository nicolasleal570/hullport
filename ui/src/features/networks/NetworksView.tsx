import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { ago, containerName, dateTime, matches, shortId } from "../../lib/format";
import { queryClient, refreshAll, run, useContainers, useNetworks } from "../../lib/queries";
import { go, select, setTab, useUi } from "../../lib/store";
import { toast } from "../../lib/toast";
import type { ContainerSummary, KV, Network } from "../../lib/types";
import { confirmAction, Modal } from "../../components/dialog";
import { useShortcut } from "../../components/hooks";
import { SortButton, useListSort } from "../../components/sort";
import { KVEditor } from "../../components/kv";
import { DetailHeader, JsonView, MasterDetail, Toolbar } from "../../components/layout";
import { openMenu, type MenuItem } from "../../components/menu";
import { Table, type Column } from "../../components/table";
import { Badge, Button, Checkbox, CopyButton, Dot, Empty, ErrorBox, Field, IconButton, Loading, Row, Section, Tabs } from "../../components/ui";
import { IconCode, IconContainers, IconCopy, IconInfo, IconNetworks, IconPlug, IconPlus, IconRefresh, IconTrash, IconX } from "../../components/icons";
import { writeText } from "../../components/clipboard";

const BUILTIN = new Set(["bridge", "host", "none"]);
const isBuiltin = (n: Network) => BUILTIN.has(n.Name) || n.Driver === "null";

function membersMap(containers?: ContainerSummary[]) {
  const m = new Map<string, ContainerSummary[]>();
  for (const c of containers ?? []) {
    for (const [name, ep] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
      const key = ep.NetworkID || name;
      for (const k of new Set([key, name])) {
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(c);
      }
    }
  }
  return m;
}

export function NetworksView() {
  const q = useNetworks();
  const containers = useContainers().data;
  const search = useUi((s) => s.search.networks ?? "");
  const selected = useUi((s) => s.selected.networks ?? null);
  const [creating, setCreating] = useState(false);
  useShortcut("n", () => setCreating(true));
  const listSort = useListSort("networks", "driver", false);
  const members = useMemo(() => membersMap(containers), [containers]);
  const membersOf = (n: Network) => members.get(n.Id) ?? members.get(n.Name) ?? [];
  const rows = useMemo(
    () => (q.data ?? []).filter((n) => matches(search, n.Name, n.Driver, n.Id, ...(n.IPAM?.Config ?? []).map((c) => c.Subnet))),
    [q.data, search],
  );

  const columns: Column<Network>[] = [
    {
      id: "name", header: "Name", width: "minmax(160px, 1.6fr)", sort: (a, b) => a.Name.localeCompare(b.Name),
      cell: (n) => {
        const ms = membersOf(n);
        return (
          <div className="flex items-center gap-2.5 min-w-0 py-[3px]">
            <Dot tone={ms.some((c) => c.State === "running") ? "ok" : "idle"} />
            <div className="min-w-0">
              <div className="truncate font-medium leading-tight flex items-center gap-1.5">{n.Name}{isBuiltin(n) && <Badge>system</Badge>}</div>
              <div className="truncate text-[11.5px] text-fg2 leading-tight">{ms.length ? `${ms.length} container${ms.length > 1 ? "s" : ""}` : "No containers"}</div>
            </div>
          </div>
        );
      },
    },
    { id: "driver", header: "Driver", width: "62px", sort: (a, b) => (a.Driver ?? "").localeCompare(b.Driver ?? ""), cell: (n) => <span className="text-fg2 text-[12px]">{n.Driver}</span> },
    { id: "subnet", header: "Subnet", width: "minmax(100px, 1fr)", cell: (n) => <span className="mono text-[11.5px] text-fg2">{n.IPAM?.Config?.[0]?.Subnet ?? "—"}</span> },
    { id: "created", header: "Created", width: "78px", align: "right", sort: (a, b) => Date.parse(a.Created ?? "") - Date.parse(b.Created ?? ""), cell: (n) => <span className="text-fg2 text-[12px] tabular-nums">{ago(n.Created)}</span> },
  ];

  const menu = (n: Network): MenuItem[] => [
    { label: "Show Containers", icon: <IconContainers size={13} />, onClick: () => go("networks", n.Id, "containers") },
    { label: "Inspect", icon: <IconCode size={13} />, onClick: () => go("networks", n.Id, "inspect") },
    "sep",
    { label: "Copy ID", icon: <IconCopy size={13} />, onClick: () => writeText(n.Id) },
    { label: "Copy Name", icon: <IconCopy size={13} />, onClick: () => writeText(n.Name) },
    "sep",
    { label: "Delete", icon: <IconTrash size={13} />, danger: true, disabled: isBuiltin(n), onClick: () => deleteNetwork(n, membersOf(n)), shortcut: "⌘⌫" },
  ];

  const sel = q.data?.find((n) => n.Id === selected);
  let list;
  if (q.isLoading) list = <Loading />;
  else if (q.error) list = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (!rows.length) list = <Empty title="No matching networks" />;
  else
    list = (
      <Table
        label="Networks"
        rows={rows}
        rowKey={(n) => n.Id}
        columns={columns}
        selected={selected}
        onSelect={(id) => select("networks", id)}
        onOpen={(id) => go("networks", id, "containers")}
        onDelete={(id) => { const n = q.data?.find((x) => x.Id === id); if (n && !isBuiltin(n)) deleteNetwork(n, membersOf(n)); }}
        onContextMenu={(e, n) => openMenu(e, menu(n))}
        {...listSort}
        dim={(n) => isBuiltin(n)}
        rowActions={(n) => !isBuiltin(n) ? <IconButton title="Delete" tone="bad" onClick={() => deleteNetwork(n, membersOf(n))}><IconTrash size={13} /></IconButton> : null}
      />
    );

  return (
    <div className="h-full flex flex-col" data-section="networks">
      <Toolbar section="networks" title="Networks" count={q.data?.length}>
        <SortButton section="networks" special="Type" />
        <IconButton title="Refresh (⌘R)" onClick={refreshAll}><IconRefresh size={14} /></IconButton>
        <IconButton title="New network (⌘N)" onClick={() => setCreating(true)}><IconPlus size={15} /></IconButton>
      </Toolbar>
      <MasterDetail
        list={list}
        detail={sel ? <NetworkDetail key={sel.Id} n={sel} /> : <Empty icon={<IconNetworks />} title="No network selected">Networks are groups of containers in the same subnet that can reach each other by name. Compose creates them for you.</Empty>}
      />
      {creating && <CreateNetworkDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

async function deleteNetwork(n: Network, ms: ContainerSummary[]) {
  if (isBuiltin(n)) return;
  const { ok } = await confirmAction({
    title: "Delete network?",
    message: (
      <>
        <b className="text-fg">{n.Name}</b> will be permanently deleted.
        {ms.length > 0 && <div className="mt-2 text-warn">{ms.length} container{ms.length > 1 ? "s are" : " is"} still connected ({ms.map(containerName).join(", ")}). Disconnect them first or Docker will refuse.</div>}
      </>
    ),
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const r = await run("Delete failed", () => api.removeNetwork(n.Id));
  if (r !== undefined) {
    toast("Network deleted", "ok");
    select("networks", null);
    queryClient.invalidateQueries({ queryKey: ["networks"] });
  }
}

type NTab = "info" | "containers" | "inspect";
function NetworkDetail({ n }: { n: Network }) {
  const tab = (useUi((s) => s.detailTab.networks) ?? "info") as NTab;
  const q = useQuery({ queryKey: ["network", n.Id], queryFn: () => api.inspectNetwork(n.Id) });
  const [connecting, setConnecting] = useState(false);
  const d = q.data ?? n;
  const members = Object.entries(d.Containers ?? {});
  const canConnect = !["host", "none"].includes(n.Name);
  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        icon={<IconNetworks />}
        title={<span className="flex items-center gap-2">{n.Name}{isBuiltin(n) && <Badge>system</Badge>}</span>}
        subtitle={`${n.Driver} · ${n.Scope} · ${members.length} connected`}
        actions={
          <>
            {canConnect && <Button onClick={() => setConnecting(true)}><IconPlug size={12} /> Connect</Button>}
            {!isBuiltin(n) && <IconButton title="Delete" tone="bad" onClick={() => deleteNetwork(n, [])}><IconTrash size={14} /></IconButton>}
          </>
        }
        tabs={<Tabs<NTab> value={tab} onChange={(t) => setTab("networks", t)} tabs={[
          { id: "info", label: "Info", icon: <IconInfo size={12} /> },
          { id: "containers", label: `Containers ${members.length}`, icon: <IconContainers size={12} /> },
          { id: "inspect", label: "Inspect", icon: <IconCode size={12} /> },
        ]} />}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {q.error != null && <ErrorBox error={q.error} />}
        {tab === "info" && (
          <div className="p-4 fadein">
            {isBuiltin(n) && (
              <div className="mb-3 text-[12px] text-fg2 rounded-[8px] border border-line px-3 py-2 bg-panel">
                {n.Name === "bridge" ? "The default bridge network. Containers without a network join it; they can't reach each other by name here." : n.Name === "host" ? "Containers on this network share the engine's network stack (no isolation, no port publishing)." : "Containers here have no networking."} Built-in networks can't be deleted.
              </div>
            )}
            <Section title="General">
              <Row label="ID" mono><span className="inline-flex items-center gap-1">{shortId(n.Id)}<CopyButton text={n.Id} /></span></Row>
              <Row label="Driver">{d.Driver}</Row>
              <Row label="Scope">{d.Scope}</Row>
              <Row label="Created">{dateTime(d.Created)}</Row>
              <Row label="Internal">{d.Internal ? "Yes (no outside access)" : "No"}</Row>
              <Row label="Attachable">{d.Attachable ? "Yes" : "No"}</Row>
              <Row label="IPv6">{d.EnableIPv6 ? "Enabled" : "Disabled"}</Row>
            </Section>
            <Section title="IP address management">
              <Row label="IPAM driver">{d.IPAM?.Driver}</Row>
              {(d.IPAM?.Config ?? []).length === 0 && <Row label="Subnet">{null}</Row>}
              {(d.IPAM?.Config ?? []).map((c, i) => (
                <div key={i}>
                  <Row label="Subnet" mono>{c.Subnet}</Row>
                  <Row label="Gateway" mono>{c.Gateway}</Row>
                  {c.IPRange && <Row label="IP range" mono>{c.IPRange}</Row>}
                </div>
              ))}
            </Section>
            {d.Options && Object.keys(d.Options).length > 0 && (
              <Section title="Options">
                {Object.entries(d.Options).map(([k, v]) => <div key={k} className="px-3 py-[5px] border-b border-line last:border-b-0 mono text-[11.5px] selectable break-all"><span className="text-fg2">{k}</span> = {v}</div>)}
              </Section>
            )}
            {d.Labels && Object.keys(d.Labels).length > 0 && (
              <Section title="Labels">
                {Object.entries(d.Labels).map(([k, v]) => <div key={k} className="px-3 py-[5px] border-b border-line last:border-b-0 mono text-[11.5px] selectable break-all"><span className="text-fg2">{k}</span> = {v}</div>)}
              </Section>
            )}
          </div>
        )}
        {tab === "containers" && (
          <div className="p-4 fadein">
            <Section title={`Connected containers (${members.length})`} right={canConnect ? <Button kind="ghost" onClick={() => setConnecting(true)}><IconPlus size={12} /> Connect</Button> : undefined}>
              {members.length === 0 ? <div className="px-3 py-2 text-fg3 text-[12px]">No containers are connected</div> : members.map(([cid, m]) => (
                <div key={cid} className="flex items-center gap-3 px-3 h-[32px] border-b border-line last:border-b-0 hover:bg-hover">
                  <button className="flex-1 min-w-0 truncate text-left hover:text-accent" onClick={() => go("containers", cid, "info")}>{m.Name}</button>
                  <span className="mono text-[11.5px] text-fg2">{m.IPv4Address || "—"}</span>
                  <span className="mono text-[11px] text-fg3 w-[118px] truncate">{m.MacAddress}</span>
                  <IconButton title="Disconnect" tone="bad" disabled={n.Name === "host" || n.Name === "none"} onClick={() => disconnect(n, cid, m.Name ?? cid)}><IconX size={12} /></IconButton>
                </div>
              ))}
            </Section>
          </div>
        )}
        {tab === "inspect" && (q.data ? <JsonView value={q.data} /> : <Loading />)}
      </div>
      {connecting && <ConnectDialog n={n} connected={members.map(([id]) => id)} onClose={() => setConnecting(false)} />}
    </div>
  );
}

async function disconnect(n: Network, cid: string, name: string) {
  const { ok, option } = await confirmAction({
    title: "Disconnect container?",
    message: <><b className="text-fg">{name}</b> will lose its connection to <b className="text-fg">{n.Name}</b>.</>,
    confirmLabel: "Disconnect",
    danger: true,
    option: { label: "Force" },
  });
  if (!ok) return;
  const r = await run("Disconnect failed", () => api.disconnectNetwork(n.Id, cid, option));
  if (r !== undefined) {
    toast(`Disconnected ${name}`, "ok");
    queryClient.invalidateQueries({ queryKey: ["network", n.Id] });
    queryClient.invalidateQueries({ queryKey: ["containers"] });
  }
}

function ConnectDialog({ n, connected, onClose }: { n: Network; connected: string[]; onClose: () => void }) {
  const containers = (useContainers().data ?? []).filter((c) => !connected.includes(c.Id) && c.HostConfig?.NetworkMode !== "host" && c.HostConfig?.NetworkMode !== "none");
  const [cid, setCid] = useState(containers[0]?.Id ?? "");
  const [aliases, setAliases] = useState("");
  const [ip, setIp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connectNetwork(n.Id, cid, aliases.split(/[\s,]+/).filter(Boolean), ip || undefined);
      queryClient.invalidateQueries({ queryKey: ["network", n.Id] });
      queryClient.invalidateQueries({ queryKey: ["containers"] });
      toast(`Connected to ${n.Name}`, "ok");
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Connect to ${n.Name}`} onClose={onClose} width={460} footer={<>
      {error && <div className="flex-1 text-bad text-[12px] self-center truncate" title={error}>{error}</div>}
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" busy={busy} disabled={!cid} onClick={submit}>Connect</Button>
    </>}>
      {containers.length === 0 ? <div className="text-fg2 text-[12.5px]">Every eligible container is already connected.</div> : (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label="Container">
            <select className="field" value={cid} onChange={(e) => setCid(e.target.value)}>
              {containers.map((c) => <option key={c.Id} value={c.Id}>{containerName(c)} ({c.State})</option>)}
            </select>
          </Field>
          {!isBuiltin(n) && <Field label="Aliases" hint="Extra DNS names on this network, separated by commas."><input className="field mono" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="db, cache" /></Field>}
          {!isBuiltin(n) && (n.IPAM?.Config ?? []).length > 0 && <Field label="IPv4 address" hint="Optional; requires a user-defined subnet."><input className="field mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="auto" /></Field>}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

function CreateNetworkDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [subnet, setSubnet] = useState("");
  const [gateway, setGateway] = useState("");
  const [ipRange, setIpRange] = useState("");
  const [internal, setInternal] = useState(false);
  const [attachable, setAttachable] = useState(false);
  const [ipv6, setIpv6] = useState(false);
  const [labels, setLabels] = useState<KV[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await api.createNetwork({ name, driver, subnet, gateway, ipRange, internal, attachable, ipv6, labels });
      queryClient.invalidateQueries({ queryKey: ["networks"] });
      toast(`Created network ${name}`, "ok");
      go("networks", id, "info");
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New Network" onClose={onClose} width={500} footer={<>
      {error && <div className="flex-1 text-bad text-[12px] self-center truncate" title={error}>{error}</div>}
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" busy={busy} disabled={!name.trim()} onClick={submit}>Create</Button>
    </>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="flex gap-3">
          <div className="flex-[3]"><Field label="Name"><input autoFocus className="field mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-net" /></Field></div>
          <div className="flex-[1.3]"><Field label="Driver">
            <select className="field" value={driver} onChange={(e) => setDriver(e.target.value)}>
              <option value="bridge">bridge</option><option value="macvlan">macvlan</option><option value="ipvlan">ipvlan</option><option value="overlay">overlay</option>
            </select>
          </Field></div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Subnet"><input className="field mono" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="172.30.0.0/24" /></Field>
          <Field label="Gateway"><input className="field mono" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="172.30.0.1" /></Field>
          <Field label="IP range"><input className="field mono" value={ipRange} onChange={(e) => setIpRange(e.target.value)} placeholder="optional" /></Field>
        </div>
        <div className="text-[11px] text-fg3 -mt-1">Leave the addresses empty to let Docker pick a free subnet.</div>
        <div className="flex flex-col gap-0.5">
          <Checkbox checked={internal} onChange={setInternal} label="Internal" hint="No access to outside networks." />
          <Checkbox checked={attachable} onChange={setAttachable} label="Attachable" hint="Standalone containers may join (swarm overlay)." />
          <Checkbox checked={ipv6} onChange={setIpv6} label="Enable IPv6" />
        </div>
        <Field label="Labels"><KVEditor value={labels} onChange={setLabels} keyPlaceholder="key" addLabel="Add label" /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
