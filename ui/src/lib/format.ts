import type { ContainerSummary, ImageSummary } from "./types";

export function bytes(n?: number | null, digits = 1): string {
  if (n == null || isNaN(n) || n < 0) return "—";
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function ago(input?: number | string | null): string {
  if (input == null || input === "") return "—";
  const ms = typeof input === "number" ? input * 1000 : Date.parse(input);
  if (isNaN(ms) || ms <= 0) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)} mo ago`;
  return `${Math.round(s / 86400 / 365)} y ago`;
}

export function dateTime(input?: number | string | null): string {
  if (input == null || input === "") return "—";
  const d = typeof input === "number" ? new Date(input * 1000) : new Date(input);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function duration(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export const shortId = (id?: string | null) => (id ?? "").replace(/^sha256:/, "").slice(0, 12);

export const containerName = (c: ContainerSummary) => (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");

export function imageName(i: ImageSummary): { repo: string; tag: string; dangling: boolean } {
  const t = (i.RepoTags ?? []).find((x) => x !== "<none>:<none>");
  if (!t) {
    const d = (i.RepoDigests ?? [])[0];
    return { repo: d ? d.split("@")[0] : "<none>", tag: "<none>", dangling: true };
  }
  const idx = t.lastIndexOf(":");
  return { repo: t.slice(0, idx), tag: t.slice(idx + 1), dangling: false };
}

export function composeProject(c: ContainerSummary) {
  return c.Labels?.["com.docker.compose.project"];
}

export function containerTitle(c: ContainerSummary) {
  const svc = c.Labels?.["com.docker.compose.service"];
  return svc && composeProject(c) ? svc : containerName(c);
}

export type Tone = "ok" | "warn" | "bad" | "idle";

export function stateTone(state?: string): Tone {
  switch (state) {
    case "running": return "ok";
    case "paused": case "restarting": case "created": return "warn";
    case "dead": return "bad";
    default: return "idle";
  }
}

export function publishedPorts(c: ContainerSummary) {
  const seen = new Set<string>();
  const out: { host: number; container: number; proto: string; ip: string }[] = [];
  for (const p of c.Ports ?? []) {
    if (!p.PublicPort) continue;
    const key = `${p.PublicPort}/${p.Type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: p.PublicPort, container: p.PrivatePort, proto: p.Type, ip: p.IP ?? "" });
  }
  return out.sort((a, b) => a.host - b.host);
}

export function matches(q: string, ...fields: (string | undefined | null)[]) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => f && f.toLowerCase().includes(needle));
}
