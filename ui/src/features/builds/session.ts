import { useSyncExternalStore } from "react";
import { api, errMsg } from "../../lib/api";
import { queryClient } from "../../lib/queries";
import { toast } from "../../lib/toast";
import type { BuildConfig, BuildRecord, SolveStatus } from "../../lib/types";

export interface Vertex {
  digest: string; name: string; order: number; started?: string; completed?: string;
  cached?: boolean; error?: string; logs: string[]; progress?: { current?: number; total?: number };
}
export interface LiveBuild {
  id: string; config: BuildConfig; command: string; startedAt: number; status: BuildRecord["status"];
  vertices: Map<string, Vertex>; text: string[]; warnings: string[]; record?: BuildRecord; error?: string;
}

const live = new Map<string, LiveBuild>();
let version = 0;
const ls = new Set<() => void>();
let raf = 0;
const emit = () => {
  // Coalesce bursts of BuildKit updates into one render per frame.
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; version++; ls.forEach((l) => l()); });
};

export const useLiveBuilds = () => {
  useSyncExternalStore((cb) => { ls.add(cb); return () => ls.delete(cb); }, () => version);
  return live;
};

const decode = (b64: string) => {
  try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; }
};

function apply(b: LiveBuild, s: SolveStatus) {
  for (const v of s.vertexes ?? []) {
    let x = b.vertices.get(v.digest);
    if (!x) { x = { digest: v.digest, name: v.name ?? "", order: b.vertices.size + 1, logs: [] }; b.vertices.set(v.digest, x); }
    if (v.name) x.name = v.name;
    if (v.started) x.started = v.started;
    if (v.completed) x.completed = v.completed;
    if (v.cached) x.cached = true;
    if (v.error) x.error = v.error;
  }
  for (const st of s.statuses ?? []) {
    const x = b.vertices.get(st.vertex);
    if (x) x.progress = { current: st.current, total: st.total };
  }
  for (const l of s.logs ?? []) {
    const x = b.vertices.get(l.vertex);
    if (!x) continue;
    const text = decode(l.data);
    const lines = text.split(/\r?\n/);
    if (x.logs.length && lines.length) x.logs[x.logs.length - 1] += lines.shift()!;
    x.logs.push(...lines);
    if (x.logs.length > 4000) x.logs.splice(0, x.logs.length - 4000);
  }
  for (const w of s.warnings ?? []) if (w.short) b.warnings.push(decode(w.short));
}

export async function startBuild(config: BuildConfig): Promise<string | null> {
  let buildId: string | null = null;
  const pending: LiveBuild = {
    id: "", config, command: "", startedAt: Date.now(), status: "running", vertices: new Map(), text: [], warnings: [],
  };
  try {
    buildId = await api.buildStart(config, (e) => {
      if (e.type === "started") {
        pending.id = e.buildId;
        pending.command = e.command;
        live.set(e.buildId, pending);
      } else if (e.type === "status") apply(pending, e.status);
      else if (e.type === "text") { pending.text.push(e.line); if (pending.text.length > 2000) pending.text.shift(); }
      else {
        pending.record = e.record;
        pending.status = e.record.status;
        pending.error = e.record.error ?? undefined;
        queryClient.invalidateQueries({ queryKey: ["build-records"] });
        queryClient.invalidateQueries({ queryKey: ["buildkit-history"] });
        queryClient.invalidateQueries({ queryKey: ["images"] });
        const name = `${config.image}:${config.tag || "latest"}`;
        if (e.record.status === "succeeded") toast(`Built ${name}`, "ok");
        else if (e.record.status === "canceled") toast(`Build of ${name} canceled`);
        else toast(`Build of ${name} failed`, "error");
      }
      emit();
    });
    if (!live.has(buildId)) { pending.id = buildId; live.set(buildId, pending); }
    queryClient.invalidateQueries({ queryKey: ["build-records"] });
    emit();
    return buildId;
  } catch (e) {
    toast(`Build failed to start: ${errMsg(e)}`, "error");
    return null;
  }
}

export function sortedVertices(b: LiveBuild) {
  return [...b.vertices.values()].sort((a, c) => a.order - c.order);
}
