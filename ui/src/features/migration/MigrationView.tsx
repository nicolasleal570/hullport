import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import {
  api, errMsg, type MigrationContainer, type MigrationImage, type MigrationItem, type MigrationPlan, type MigrationVolume,
} from "../../lib/api";
import { bytes } from "../../lib/format";
import { defaultSelection } from "./defaults";
import { go } from "../../lib/store";
import { toast } from "../../lib/toast";
import { confirmAction } from "../../components/dialog";
import { Badge, Button, Dot, ErrorBox, Loading, cx } from "../../components/ui";

/** Copy images, volumes and loose containers from OrbStack into Hullport's engine. */
export function MigrationView() {
  const q = useQuery({ queryKey: ["migration-plan"], queryFn: api.migrationPlan, staleTime: 0 });
  const plan = q.data;
  return (
    <div className="h-full flex flex-col" data-section="migrate">
      <div data-tauri-drag-region className="h-[52px] shrink-0 flex items-center gap-3 pl-4 pr-3 border-b border-line">
        <h1 data-tauri-drag-region className="text-[15px] font-semibold flex-1">Migrate from OrbStack</h1>
        <Button kind="ghost" onClick={() => go("engines")}>Back to Engines</Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-5 max-w-[920px]">
        <p className="text-[12.5px] text-fg2 leading-relaxed mb-4">
          Copies what lives in OrbStack into Hullport's engine. OrbStack is only read: volumes are copied through helper containers named{" "}
          <span className="mono">hullport-migrate-*</span> that mount them read-only, never run, and are removed right after. Nothing already in
          Hullport is overwritten unless you ask for it below.
        </p>
        {q.isLoading && <Loading label="Reading OrbStack and Hullport…" />}
        {q.error != null && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
        {plan && <Plan plan={plan} refresh={() => q.refetch()} />}
      </div>
    </div>
  );
}

function Plan({ plan, refresh }: { plan: MigrationPlan; refresh: () => void }) {
  // A loose container with changes in its writable layer is the user's call: off by default.
  const loose = plan.containers.filter((c) => !c.composeProject);
  const [initial] = useState(() => defaultSelection(plan));
  const [images, setImages] = useState(() => new Set(initial.images));
  const [volumes, setVolumes] = useState(() => new Set(initial.volumes));
  const [replace, setReplace] = useState(() => new Set<string>());
  const [containers, setContainers] = useState(() => new Set(initial.containers));
  const [progress, setProgress] = useState<Record<string, MigrationItem>>({});
  const [results, setResults] = useState<MigrationItem[] | null>(null);
  const [running, setRunning] = useState(false);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    setter(next);
  };

  const needed = useMemo(
    () =>
      plan.images.filter((i) => images.has(i.id)).reduce((n, i) => n + i.size, 0) +
      plan.volumes.filter((v) => volumes.has(v.name)).reduce((n, v) => n + (v.size ?? 0), 0),
    [plan, images, volumes],
  );
  const tight = plan.macFreeBytes != null && needed > plan.macFreeBytes * 0.8;
  const projects = useMemo(() => {
    const m = new Map<string, { dir?: string | null; names: string[] }>();
    for (const c of plan.containers.filter((c) => c.composeProject)) {
      const p = m.get(c.composeProject!) ?? { dir: c.composeDir, names: [] };
      p.names.push(c.name);
      m.set(c.composeProject!, p);
    }
    return [...m.entries()];
  }, [plan]);

  if (!plan.source.available || !plan.target.available) {
    return (
      <div className="rounded-[10px] border border-line bg-panel p-4">
        {!plan.source.available && <SideDown label="OrbStack isn't running" hint="Start OrbStack: the migration reads from it while it runs." error={plan.source.error} />}
        {!plan.target.available && <SideDown label="Hullport's engine isn't running" hint="Start it from the menu bar icon or the Engines page." error={plan.target.error} />}
        <Button kind="primary" onClick={refresh}>Check Again</Button>
      </div>
    );
  }

  const start = async () => {
    const replacing = [...replace].filter((v) => volumes.has(v));
    const { ok } = await confirmAction({
      title: "Copy into Hullport?",
      message: (
        <>
          {images.size} image(s), {volumes.size} volume(s) and {containers.size} container(s), about {bytes(needed)}. OrbStack is only read.
          {replacing.length > 0 && (
            <div className="mt-2 text-bad">
              Hullport's copy of {replacing.join(", ")} will be deleted and replaced with OrbStack's.
            </div>
          )}
        </>
      ),
      confirmLabel: "Copy",
      danger: replacing.length > 0,
    });
    if (!ok) return;
    setRunning(true);
    setResults(null);
    setProgress({});
    try {
      await api.migrationRun(
        { images: [...images], volumes: [...volumes], replaceVolumes: replacing, containers: [...containers] },
        (e) => {
          if (e.type === "item") setProgress((p) => ({ ...p, [`${e.kind}:${e.name}`]: e }));
          else {
            setRunning(false);
            setResults(e.results);
            if (e.canceled) toast("Migration canceled", "error");
          }
        },
      );
    } catch (err) {
      setRunning(false);
      toast(`Migration failed: ${errMsg(err)}`, "error");
    }
  };

  return (
    <>
      <div className={cx("rounded-[10px] border p-3 mb-4 text-[12.5px] flex items-center gap-3", tight ? "border-warn/35 bg-warn/8" : "border-line bg-panel")}>
        <div className="flex-1">
          Selected: <b>{bytes(needed)}</b> to copy into Hullport · {plan.macFreeBytes != null ? `${bytes(plan.macFreeBytes)} free on this Mac` : "free space unknown"}
          {tight && <div className="text-warn mt-0.5">That's tight: both copies exist until you uninstall OrbStack.</div>}
        </div>
        <Button disabled={running} onClick={refresh}>Refresh</Button>
        <Button kind="primary" busy={running} disabled={images.size + volumes.size + containers.size === 0} onClick={start}>Copy into Hullport</Button>
      </div>

      {results && <Report results={results} projects={projects} />}

      <Section title="Images" note={`${plan.images.length} in OrbStack`}>
        {plan.images.map((i) => (
          <ImageRow key={i.id} i={i} checked={images.has(i.id)} onChange={(on) => toggle(images, setImages, i.id, on)} p={progress[`image:${i.tags[0] ?? i.id}`]} disabled={running} />
        ))}
      </Section>

      <Section title="Volumes" note={`${plan.volumes.length} in OrbStack`}>
        {plan.volumes.map((v) => (
          <VolumeRow
            key={v.name}
            v={v}
            checked={volumes.has(v.name)}
            replace={replace.has(v.name)}
            onChange={(on) => toggle(volumes, setVolumes, v.name, on)}
            onReplace={(on) => {
              toggle(replace, setReplace, v.name, on);
              toggle(volumes, setVolumes, v.name, on);
            }}
            p={progress[`volume:${v.name}`]}
            disabled={running}
          />
        ))}
      </Section>

      <Section title="Containers" note="Compose projects are started again with docker compose up; loose containers are recreated stopped.">
        {projects.map(([name, p]) => (
          <Row key={name} left={<Dot tone="idle" />} title={<>{name} <Badge>compose</Badge></>} sub={`${p.names.join(", ")} · run docker compose up in ${p.dir ?? "the project folder"}`} right="not copied" />
        ))}
        {loose.map((c) => (
          <ContainerRow key={c.name} c={c} checked={containers.has(c.name)} onChange={(on) => toggle(containers, setContainers, c.name, on)} p={progress[`container:${c.name}`]} disabled={running} />
        ))}
        {plan.containers.length === 0 && <Row title="No containers in OrbStack" />}
      </Section>
    </>
  );
}

function SideDown({ label, hint, error }: { label: string; hint: string; error?: string | null }) {
  return (
    <div className="mb-3">
      <div className="font-semibold flex items-center gap-2"><Dot tone="bad" />{label}</div>
      <div className="text-[12px] text-fg2 mt-0.5">{hint}</div>
      {error && <div className="text-[11.5px] text-fg3 mt-0.5 selectable">{error}</div>}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-[12px] font-semibold text-fg2">{title}</div>
        {note && <div className="text-[11.5px] text-fg3">{note}</div>}
      </div>
      <div className="rounded-[10px] border border-line bg-panel overflow-hidden">{children}</div>
    </div>
  );
}

function Row({ left, title, sub, right }: { left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-line last:border-b-0 min-h-[44px]">
      {left && <div className="w-4 flex justify-center shrink-0">{left}</div>}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{title}</div>
        {sub && <div className="text-[11.5px] text-fg2">{sub}</div>}
      </div>
      {right && <div className="text-[12px] text-fg2 text-right shrink-0 max-w-[280px]">{right}</div>}
    </div>
  );
}

function Check({ checked, onChange, disabled }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--c-accent)]" />;
}

/** What happened to an item during this run, or the reason it won't be copied. */
function status(p: MigrationItem | undefined, skip?: string | null, size?: number | null) {
  if (p?.status === "copying") return <span className="text-warn tabular-nums">copying… {bytes(p.bytes ?? 0)}</span>;
  if (p?.status === "done") return <span className="text-ok">copied {p.bytes ? bytes(p.bytes) : ""}</span>;
  if (p?.status === "failed") return <span className="text-bad" title={p.detail ?? ""}>failed: {p.detail}</span>;
  if (p?.status === "skipped") return <span title={p.detail ?? ""}>skipped: {p.detail}</span>;
  if (skip) return <span className="text-fg3">{skip}</span>;
  return size != null ? bytes(size) : null;
}

function ImageRow({ i, checked, onChange, p, disabled }: { i: MigrationImage; checked: boolean; onChange: (on: boolean) => void; p?: MigrationItem; disabled: boolean }) {
  return (
    <Row
      left={<Check checked={checked} disabled={disabled || !!i.skip} onChange={onChange} />}
      title={i.tags.join(", ") || i.id.slice(7, 19)}
      sub={`${i.platform} · ${bytes(i.size)}`}
      right={status(p, i.skip)}
    />
  );
}

function VolumeRow(props: {
  v: MigrationVolume; checked: boolean; replace: boolean; onChange: (on: boolean) => void; onReplace: (on: boolean) => void; p?: MigrationItem; disabled: boolean;
}) {
  const { v, checked, replace, onChange, onReplace, p, disabled } = props;
  const conflict = v.targetSize != null;
  const inUse = v.inUseBy.length > 0;
  const sub = (
    <>
      {v.size != null ? bytes(v.size) : "size unknown"}
      {inUse && <span className="text-warn"> · in use by {v.inUseBy.join(", ")}: stop it in OrbStack, then Refresh</span>}
      {conflict && (
        <label className="flex items-center gap-1.5 mt-1 text-fg">
          <Check checked={replace} disabled={disabled || inUse} onChange={onReplace} />
          Replace Hullport's copy ({bytes(v.targetSize)}) with OrbStack's ({bytes(v.size ?? 0)})
        </label>
      )}
    </>
  );
  return (
    <Row
      left={<Check checked={checked} disabled={disabled || inUse || (!!v.skip && !replace)} onChange={onChange} />}
      title={v.name}
      sub={sub}
      right={status(p, conflict && replace ? null : v.skip)}
    />
  );
}

function ContainerRow({ c, checked, onChange, p, disabled }: { c: MigrationContainer; checked: boolean; onChange: (on: boolean) => void; p?: MigrationItem; disabled: boolean }) {
  const sub = (
    <>
      {c.image} · {c.state}
      {!!c.changes && <span className="text-warn"> · {c.changes} file(s) changed inside it won't be copied</span>}
    </>
  );
  return <Row left={<Check checked={checked} disabled={disabled || c.inTarget} onChange={onChange} />} title={c.name} sub={sub} right={status(p, c.inTarget ? "already in Hullport" : null)} />;
}

function Report({ results, projects }: { results: MigrationItem[]; projects: [string, { dir?: string | null; names: string[] }][] }) {
  const by = (s: MigrationItem["status"]) => results.filter((r) => r.status === s);
  const failed = by("failed");
  const skipped = by("skipped");
  return (
    <div className={cx("rounded-[10px] border p-4 mb-5 text-[12.5px]", failed.length ? "border-bad/35 bg-bad/5" : "border-ok/35 bg-ok/5")} data-testid="migration-report">
      <div className="font-semibold mb-1">
        Copied {by("done").length} · skipped {skipped.length} · failed {failed.length}
      </div>
      {[...failed, ...skipped].map((r) => (
        <div key={`${r.kind}:${r.name}`} className="text-fg2">
          {r.kind} <span className="mono">{r.name}</span>: {r.detail}
        </div>
      ))}
      {projects.length > 0 && (
        <div className="mt-2">
          Next, start each Compose project against Hullport from its folder:
          {projects.map(([name, p]) => (
            <div key={name} className="mono text-[11.5px] mt-1 selectable">cd {p.dir ?? name} && docker compose up -d</div>
          ))}
        </div>
      )}
    </div>
  );
}
