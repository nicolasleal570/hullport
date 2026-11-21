import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { ago, bytes, containerName, dateTime, imageName, matches, shortId } from "../../lib/format";
import { queryClient, refreshAll, run, useContainers, useImages } from "../../lib/queries";
import { go, select, setTab, setUi, useUi } from "../../lib/store";
import { toast } from "../../lib/toast";
import type { ContainerSummary, ImageSummary } from "../../lib/types";
import { confirmAction } from "../../components/dialog";
import { useShortcut } from "../../components/hooks";
import { SortButton, useListSort } from "../../components/sort";
import { DetailHeader, JsonView, MasterDetail, Toolbar } from "../../components/layout";
import { openMenu, openMenuAt, type MenuItem } from "../../components/menu";
import { Table, type Column } from "../../components/table";
import { Badge, Button, CopyButton, Dot, Empty, ErrorBox, IconButton, Loading, Row, Section, Tabs } from "../../components/ui";
import { IconBroom, IconCode, IconCopy, IconDownload, IconImages, IconInfo, IconLayers, IconMore, IconPlay, IconRefresh, IconTag, IconTrash } from "../../components/icons";
import { writeText } from "../../components/clipboard";
import { CreateContainerDialog } from "../containers/CreateContainerDialog";
import { PullDialog } from "./PullDialog";
import { TagDialog } from "./TagDialog";

type Filter = "all" | "inuse" | "unused" | "dangling";

function usageMap(containers?: ContainerSummary[]) {
  const m = new Map<string, ContainerSummary[]>();
  for (const c of containers ?? []) {
    if (!c.ImageID) continue;
    if (!m.has(c.ImageID)) m.set(c.ImageID, []);
    m.get(c.ImageID)!.push(c);
  }
  return m;
}

export function ImagesView() {
  const q = useImages();
  const containers = useContainers().data;
  const search = useUi((s) => s.search.images ?? "");
  const selected = useUi((s) => s.selected.images ?? null);
  const filter = useUi((s) => s.imageFilter) as Filter;
  const [pulling, setPulling] = useState(false);
  const [runImage, setRunImage] = useState<ImageSummary | null>(null);
  const [tagImage, setTagImage] = useState<ImageSummary | null>(null);
  useShortcut("n", () => setPulling(true));
  const listSort = useListSort("images", "size", true);
  const usage = useMemo(() => usageMap(containers), [containers]);

  const rows = useMemo(
    () =>
      (q.data ?? []).filter((i) => {
        const n = imageName(i);
        const used = (usage.get(i.Id)?.length ?? 0) > 0;
        if (filter === "inuse" && !used) return false;
        if (filter === "unused" && used) return false;
        if (filter === "dangling" && !n.dangling) return false;
        return matches(search, ...(i.RepoTags ?? []), i.Id);
      }),
    [q.data, search, filter, usage],
  );

  const columns: Column<ImageSummary>[] = [
    {
      id: "name", header: "Repository", width: "minmax(180px, 1.8fr)",
      sort: (a, b) => imageName(a).repo.localeCompare(imageName(b).repo),
      cell: (i) => {
        const n = imageName(i);
        const used = (usage.get(i.Id)?.length ?? 0) > 0;
        return (
          <div className="flex items-center gap-2.5 min-w-0 py-[3px]">
            <Dot tone={used ? "ok" : "idle"} />
            <div className="min-w-0" title={`${n.repo}:${n.tag}`}>
              <div className="truncate font-medium leading-tight">{n.repo.includes("/") ? n.repo.slice(n.repo.lastIndexOf("/") + 1) : n.repo}</div>
              <div className="truncate text-[11.5px] text-fg2 leading-tight">
                {n.dangling ? <Badge tone="warn">dangling</Badge> : <><span className="text-fg">{n.tag}</span>{n.repo.includes("/") && <span className="text-fg3"> · {n.repo.slice(0, n.repo.lastIndexOf("/"))}</span>}</>}
                {(i.RepoTags?.length ?? 0) > 1 && <span className="text-fg3"> · +{i.RepoTags!.length - 1} tags</span>}
              </div>
            </div>
          </div>
        );
      },
    },
    { id: "id", header: "ID", width: "100px", cell: (i) => <span className="mono text-[11.5px] text-fg2">{shortId(i.Id)}</span>, sort: (a, b) => a.Id.localeCompare(b.Id) },
    { id: "size", header: "Size", width: "76px", align: "right", sort: (a, b) => a.Size - b.Size, cell: (i) => <span className="tabular-nums text-fg2 text-[12px]">{bytes(i.Size)}</span> },
    { id: "created", header: "Created", width: "80px", align: "right", sort: (a, b) => a.Created - b.Created, cell: (i) => <span className="tabular-nums text-fg2 text-[12px]">{ago(i.Created)}</span> },
  ];

  const menu = (i: ImageSummary): MenuItem[] => [
    { label: "Run…", icon: <IconPlay size={12} />, onClick: () => setRunImage(i) },
    { label: "Tag…", icon: <IconTag size={13} />, onClick: () => setTagImage(i) },
    { label: "Show Layers", icon: <IconLayers size={13} />, onClick: () => go("images", i.Id, "layers") },
    { label: "Inspect", icon: <IconCode size={13} />, onClick: () => go("images", i.Id, "inspect") },
    "sep",
    { label: "Copy ID", icon: <IconCopy size={13} />, onClick: () => writeText(i.Id) },
    ...(i.RepoTags?.[0] ? [{ label: "Copy Name", icon: <IconCopy size={13} />, onClick: () => writeText(i.RepoTags![0]) } as MenuItem] : []),
    "sep",
    { label: "Delete", icon: <IconTrash size={13} />, danger: true, onClick: () => deleteImage(i, usage.get(i.Id) ?? []), shortcut: "⌘⌫" },
  ];

  const prune = async (el: HTMLElement) => {
    openMenuAt(el, [
      { label: "Delete Dangling Images…", onClick: () => doPrune(false) },
      { label: "Delete All Unused Images…", danger: true, onClick: () => doPrune(true) },
    ]);
  };

  const sel = q.data?.find((i) => i.Id === selected);
  const dangling = q.data?.filter((i) => imageName(i).dangling).length ?? 0;
  const totalSize = q.data?.reduce((a, i) => a + i.Size, 0) ?? 0;

  let list;
  if (q.isLoading) list = <Loading />;
  else if (q.error) list = <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  else if (!q.data?.length) list = <Empty icon={<IconImages />} title="No images" action={<Button kind="primary" onClick={() => setPulling(true)}>Pull an image</Button>}>Images are used to run containers. They contain an application and its dependencies.</Empty>;
  else if (!rows.length) list = <Empty title="No matching images">Try another filter or search.</Empty>;
  else
    list = (
      <Table
        label="Images"
        rows={rows}
        rowKey={(i) => i.Id}
        columns={columns}
        selected={selected}
        onSelect={(id) => select("images", id)}
        onOpen={(id) => { const i = q.data?.find((x) => x.Id === id); if (i) setRunImage(i); }}
        onDelete={(id) => { const i = q.data?.find((x) => x.Id === id); if (i) deleteImage(i, usage.get(i.Id) ?? []); }}
        onContextMenu={(e, i) => openMenu(e, menu(i))}
        {...listSort}
        dim={(i) => imageName(i).dangling}
        rowActions={(i) => (
          <>
            <IconButton title="Run" onClick={() => setRunImage(i)}><IconPlay size={12} /></IconButton>
            <IconButton title="Delete" tone="bad" onClick={() => deleteImage(i, usage.get(i.Id) ?? [])}><IconTrash size={13} /></IconButton>
          </>
        )}
      />
    );

  return (
    <div className="h-full flex flex-col" data-section="images">
      <Toolbar
        section="images"
        title="Images"
        count={q.data?.length}
        filters={
          <div className="flex items-center gap-2">
            <Tabs<Filter>
              value={filter}
              onChange={(f) => setUi({ imageFilter: f })}
              tabs={[{ id: "all", label: "All" }, { id: "inuse", label: "In Use" }, { id: "unused", label: "Unused" }, { id: "dangling", label: `Dangling${dangling ? ` ${dangling}` : ""}` }]}
            />
            <span className="text-fg3 text-[12px] tabular-nums">{bytes(totalSize)}</span>
          </div>
        }
      >
        <SortButton section="images" special="Size" />
        <IconButton title="Refresh (⌘R)" onClick={refreshAll}><IconRefresh size={14} /></IconButton>
        <IconButton title="Clean up unused images" onClick={(e) => prune(e.currentTarget as HTMLElement)}><IconBroom size={14} /></IconButton>
        <IconButton title="Pull image (⌘N)" onClick={() => setPulling(true)}><IconDownload size={15} /></IconButton>
      </Toolbar>
      <MasterDetail
        list={list}
        detail={sel ? <ImageDetail key={sel.Id} i={sel} users={usage.get(sel.Id) ?? []} onRun={() => setRunImage(sel)} onTag={() => setTagImage(sel)} menu={menu(sel)} /> : <Empty icon={<IconImages />} title="No image selected">Select an image to see its layers, configuration and the containers using it.</Empty>}
      />
      {pulling && <PullDialog onClose={() => setPulling(false)} onRun={(ref) => { setPulling(false); setRunImage({ Id: ref, RepoTags: [ref], Created: 0, Size: 0 }); }} />}
      {runImage && (
        <RunFromImage image={runImage} onClose={() => setRunImage(null)} />
      )}
      {tagImage && <TagDialog image={tagImage} onClose={() => setTagImage(null)} />}
    </div>
  );
}

function RunFromImage({ image, onClose }: { image: ImageSummary; onClose: () => void }) {
  const ref = image.RepoTags?.find((t) => t !== "<none>:<none>") ?? image.Id;
  const q = useQuery({ queryKey: ["image", ref], queryFn: () => api.inspectImage(ref), retry: false });
  if (q.isLoading) return null;
  const exposed = Object.keys(q.data?.Config?.ExposedPorts ?? {});
  return <CreateContainerDialog image={ref} defaults={{ ports: exposed }} onClose={onClose} />;
}

async function deleteImage(i: ImageSummary, users: ContainerSummary[]) {
  const n = imageName(i);
  const { ok, option } = await confirmAction({
    title: "Delete image?",
    message: (
      <>
        <b className="text-fg">{n.dangling ? shortId(i.Id) : `${n.repo}:${n.tag}`}</b> will be permanently deleted.
        {users.length > 0 && <div className="mt-2 text-warn">Used by {users.length} container{users.length > 1 ? "s" : ""}: {users.map(containerName).join(", ")}.</div>}
        {(i.RepoTags?.length ?? 0) > 1 && <div className="mt-2">This removes all {i.RepoTags!.length} tags of this image.</div>}
      </>
    ),
    confirmLabel: "Delete",
    danger: true,
    option: users.length ? { label: "Force (containers keep running but lose the image name)" } : undefined,
  });
  if (!ok) return;
  const target = (i.RepoTags?.length ?? 0) > 1 ? i.Id : (i.RepoTags?.[0] && !n.dangling ? i.RepoTags[0] : i.Id);
  const r = await run("Delete failed", () => api.removeImage(target, option || (i.RepoTags?.length ?? 0) > 1));
  if (r !== undefined) {
    toast("Image deleted", "ok");
    select("images", null);
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }
}

async function doPrune(all: boolean) {
  const { ok } = await confirmAction({
    title: all ? "Delete all unused images?" : "Delete dangling images?",
    message: all
      ? "Every image not used by a container (running or stopped) will be permanently deleted. You can pull them again later."
      : "Untagged images that no container uses will be permanently deleted.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const r = await run("Cleanup failed", () => api.pruneImages(all));
  if (r) {
    toast(`Deleted ${r.ImagesDeleted?.length ?? 0} items · reclaimed ${bytes(r.SpaceReclaimed ?? 0)}`, "ok");
    queryClient.invalidateQueries({ queryKey: ["images"] });
  }
}

type ImgTab = "info" | "layers" | "inspect";

function ImageDetail({ i, users, onRun, onTag, menu }: { i: ImageSummary; users: ContainerSummary[]; onRun: () => void; onTag: () => void; menu: MenuItem[] }) {
  const tab = (useUi((s) => s.detailTab.images) ?? "info") as ImgTab;
  const n = imageName(i);
  const q = useQuery({ queryKey: ["image", i.Id], queryFn: () => api.inspectImage(i.Id) });
  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        icon={<IconImages />}
        title={n.dangling ? shortId(i.Id) : `${n.repo}:${n.tag}`}
        subtitle={`${bytes(i.Size)} · created ${ago(i.Created)}`}
        actions={
          <>
            <Button kind="primary" onClick={onRun}><IconPlay size={11} /> Run</Button>
            <IconButton title="Tag" onClick={onTag}><IconTag size={14} /></IconButton>
            <IconButton title="Delete" tone="bad" onClick={() => deleteImage(i, users)}><IconTrash size={14} /></IconButton>
            <IconButton title="More" onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, menu)}><IconMore size={14} /></IconButton>
          </>
        }
        tabs={<Tabs<ImgTab> value={tab} onChange={(t) => setTab("images", t)} tabs={[
          { id: "info", label: "Info", icon: <IconInfo size={12} /> },
          { id: "layers", label: "Layers", icon: <IconLayers size={12} /> },
          { id: "inspect", label: "Inspect", icon: <IconCode size={12} /> },
        ]} />}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {q.error != null && <ErrorBox error={q.error} />}
        {tab === "info" && q.data && <ImageInfo i={i} d={q.data} users={users} />}
        {tab === "info" && q.isLoading && <Loading />}
        {tab === "layers" && <Layers id={i.Id} />}
        {tab === "inspect" && q.data && <JsonView value={q.data} />}
      </div>
    </div>
  );
}

function ImageInfo({ i, d, users }: { i: ImageSummary; d: any; users: ContainerSummary[] }) {
  const cfg = d.Config ?? {};
  const env: string[] = cfg.Env ?? [];
  return (
    <div className="p-4 fadein">
      <Section title="General">
        <Row label="ID" mono><span className="inline-flex items-center gap-1">{shortId(i.Id)}<CopyButton text={i.Id} title="Copy ID" /></span></Row>
        <Row label="Tags">{(i.RepoTags ?? []).length ? <span className="flex flex-wrap gap-1">{i.RepoTags!.map((t) => <Badge key={t} tone="accent" plain>{t}</Badge>)}</span> : null}</Row>
        {i.RepoDigests?.[0] && <Row label="Digest" mono><span className="inline-flex items-center gap-1 break-all">{i.RepoDigests[0].split("@")[1]?.slice(0, 26)}…<CopyButton text={i.RepoDigests[0]} title="Copy digest" /></span></Row>}
        <Row label="Size">{bytes(i.Size)}</Row>
        <Row label="Created">{dateTime(i.Created)}</Row>
        <Row label="Platform">{[d.Os, d.Architecture, d.Variant].filter(Boolean).join("/")}</Row>
        <Row label="Entrypoint" mono>{cfg.Entrypoint?.join(" ") || null}</Row>
        <Row label="Command" mono>{cfg.Cmd?.join(" ") || null}</Row>
        {cfg.WorkingDir && <Row label="Working dir" mono>{cfg.WorkingDir}</Row>}
        {cfg.User && <Row label="User" mono>{cfg.User}</Row>}
        <Row label="Exposed ports" mono>{Object.keys(cfg.ExposedPorts ?? {}).join(", ") || null}</Row>
      </Section>
      <Section title={`Containers using this image (${users.length})`}>
        {users.length === 0 ? <div className="px-3 py-2 text-fg3 text-[12px]">Not used by any container</div> : users.map((c) => (
          <button key={c.Id} onClick={() => go("containers", c.Id, "info")} className="w-full flex items-center gap-2 px-3 h-[30px] border-b border-line last:border-b-0 hover:bg-hover text-left">
            <Dot tone={c.State === "running" ? "ok" : "idle"} />
            <span className="flex-1 truncate">{containerName(c)}</span>
            <span className="text-fg3 text-[11.5px]">{c.Status}</span>
          </button>
        ))}
      </Section>
      <Section title={`Environment (${env.length})`}>
        {env.length === 0 ? <div className="px-3 py-2 text-fg3 text-[12px]">None</div> : env.map((e, k) => {
          const x = e.indexOf("=");
          return <Row key={k} label={e.slice(0, x)} mono>{e.slice(x + 1)}</Row>;
        })}
      </Section>
      {cfg.Labels && Object.keys(cfg.Labels).length > 0 && (
        <Section title="Labels">
          {Object.entries(cfg.Labels as Record<string, string>).map(([k, v]) => (
            <div key={k} className="px-3 py-[5px] border-b border-line last:border-b-0 mono text-[11.5px] selectable break-all"><span className="text-fg2">{k}</span> = {v}</div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Layers({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["image", id, "history"], queryFn: () => api.imageHistory(id) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const rows = q.data ?? [];
  return (
    <div className="p-4 fadein">
      <Section title={`${rows.length} history entries · ${rows.filter((r) => r.Size > 0).length} layers with content`}>
        {rows.map((h, k) => {
          const cmd = (h.CreatedBy ?? "").replace(/^\/bin\/sh -c #\(nop\)\s*/, "").replace(/^\/bin\/sh -c /, "RUN ");
          return (
            <div key={k} className="flex gap-3 px-3 py-[6px] border-b border-line last:border-b-0 items-start">
              <span className="text-fg3 tabular-nums w-5 text-right text-[11.5px] pt-[1px]">{rows.length - k}</span>
              <span className="mono text-[11.5px] flex-1 min-w-0 break-all whitespace-pre-wrap selectable">{cmd || <span className="text-fg3">(empty)</span>}</span>
              <span className={`tabular-nums text-[11.5px] w-[64px] text-right ${h.Size > 0 ? "text-fg" : "text-fg3"}`}>{bytes(h.Size)}</span>
              <span className="tabular-nums text-[11.5px] text-fg3 w-[64px] text-right">{ago(h.Created)}</span>
            </div>
          );
        })}
      </Section>
    </div>
  );
}
