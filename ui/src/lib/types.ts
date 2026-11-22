// Shapes of the Docker Engine API JSON the backend forwards (PascalCase, as Docker sends it).

export interface Port { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }
export interface MountPoint {
  Type?: string; Name?: string; Source?: string; Destination?: string; Driver?: string; Mode?: string; RW?: boolean;
}
export interface EndpointSettings {
  NetworkID?: string; EndpointID?: string; Gateway?: string; IPAddress?: string; IPPrefixLen?: number;
  MacAddress?: string; Aliases?: string[] | null; GlobalIPv6Address?: string; DNSNames?: string[] | null;
}
export interface ContainerSummary {
  Id: string; Names?: string[]; Image?: string; ImageID?: string; Command?: string; Created?: number;
  Ports?: Port[]; Labels?: Record<string, string>; State?: string; Status?: string;
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, EndpointSettings> };
  Mounts?: MountPoint[];
}
export interface ImageSummary {
  Id: string; ParentId?: string; RepoTags?: string[]; RepoDigests?: string[]; Created: number; Size: number;
  SharedSize?: number; Labels?: Record<string, string> | null; Containers?: number;
}
export interface Volume {
  Name: string; Driver: string; Mountpoint: string; CreatedAt?: string; Labels?: Record<string, string> | null;
  Scope?: string; Options?: Record<string, string> | null; UsageData?: { Size: number; RefCount: number } | null;
}
export interface IpamConfig { Subnet?: string; Gateway?: string; IPRange?: string }
export interface Network {
  Name: string; Id: string; Created?: string; Scope?: string; Driver?: string; EnableIPv6?: boolean; EnableIPv4?: boolean;
  IPAM?: { Driver?: string; Config?: IpamConfig[] | null; Options?: Record<string, string> | null };
  Internal?: boolean; Attachable?: boolean; Ingress?: boolean; Options?: Record<string, string> | null;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, { Name?: string; EndpointID?: string; MacAddress?: string; IPv4Address?: string; IPv6Address?: string }> | null;
}

export interface ConnStatus {
  state: "connecting" | "connected" | "disconnected";
  context: string; host: string; error?: string | null;
  serverVersion?: string | null; apiVersion?: string | null; os?: string | null; arch?: string | null;
  engineName?: string | null; cpus?: number | null; memTotal?: number | null; containersRunning?: number | null;
  /** The chosen context, when it didn't answer and another engine is used instead for now. */
  fallbackFrom?: string | null;
}
export interface DockerContext {
  name: string; description: string; host: string; isCliCurrent: boolean; available: boolean; source: string;
}
export interface ContextList { contexts: DockerContext[]; cliCurrent: string; selected?: string | null }

export interface KV { key: string; value: string }

export interface LogLine { ts: string; stream: "out" | "err"; text: string }
export type LogEvent = { type: "lines"; lines: LogLine[] } | { type: "end"; error?: string | null };

export interface StatsSample {
  cpuPercent: number; memUsed: number; memLimit: number; netRx: number; netTx: number;
  blkRead: number; blkWrite: number; pids: number; onlineCpus: number;
}
export type StatsEvent = { type: "sample"; sample: StatsSample } | { type: "end"; error?: string | null };

export type ExecEvent = { type: "data"; data: string } | { type: "exit"; code?: number | null; error?: string | null };

export type PullEvent =
  | { type: "progress"; info: PullInfo }
  | { type: "text"; line: string }
  | { type: "done"; error?: string | null; canceled: boolean };
export interface PullInfo {
  id?: string; status?: string; progress?: string; error?: string;
  progressDetail?: { current?: number; total?: number };
}

export interface FileEntry { name: string; kind: "dir" | "file" | "link" | "other"; size: number; modified: number; mode: string }
export interface FileContent { text?: string | null; binary: boolean; truncated: boolean; size: number }

export interface BuildConfig {
  id: string; name: string; contextDir: string; dockerfile?: string | null; image: string; tag?: string | null;
  buildArgs: KV[]; target?: string | null; platform?: string | null; noCache: boolean; pull: boolean; updatedAt?: string | null;
}
export interface BuildStepRecord { name: string; cached: boolean; error?: string | null; durationMs?: number | null }
export interface BuildRecord {
  id: string; config: BuildConfig; status: "running" | "succeeded" | "failed" | "canceled" | "interrupted";
  startedAt: string; finishedAt?: string | null; durationMs?: number | null; error?: string | null;
  imageId?: string | null; buildRef?: string | null; steps: BuildStepRecord[]; logTail: string; dockerContext?: string | null;
}
export type BuildEvent =
  | { type: "started"; buildId: string; command: string }
  | { type: "status"; status: SolveStatus }
  | { type: "text"; line: string }
  | { type: "done"; record: BuildRecord };
export interface SolveStatus {
  vertexes?: { digest: string; name?: string; started?: string; completed?: string; cached?: boolean; error?: string; inputs?: string[] }[];
  statuses?: { id: string; vertex: string; name?: string; current?: number; total?: number; completed?: string }[];
  logs?: { vertex: string; stream?: number; data: string; timestamp?: string }[];
  warnings?: { vertex: string; short?: string; level?: number }[];
}
export interface BuildkitHistoryItem {
  ref: string; name: string; status: string; created_at: string; completed_at?: string;
  total_steps?: number; completed_steps?: number; cached_steps?: number; error?: string;
}

export interface EngineEvent { kind: string; action: string; id: string; name?: string | null; time?: number | null }
export interface LaunchMode { mode: "normal" | "screenshot" | "selftest" | "verify" | "migrate" | "cutover" | "cutover-revert"; path?: string | null; fixtures?: string | null; external?: string | null; section?: string | null }
