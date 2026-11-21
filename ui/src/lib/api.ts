import { Channel, invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

const call = <R>(cmd: string, args?: Record<string, unknown>) => invoke<R>(cmd, args);

function stream<E>(cmd: string, args: Record<string, unknown>, onEvent: (e: E) => void) {
  const channel = new Channel<E>();
  channel.onmessage = onEvent;
  return call<string>(cmd, { ...args, channel });
}

export const api = {
  // engine & contexts
  status: () => call<T.ConnStatus>("get_status"),
  contexts: () => call<T.ContextList>("list_contexts"),
  setContext: (name: string | null) => call<void>("set_context", { name }),
  reconnect: () => call<void>("reconnect"),
  diskUsage: () => call<{ Volumes?: T.Volume[]; Images?: T.ImageSummary[] }>("disk_usage"),
  cancelOp: (id: string) => call<boolean>("cancel_op", { id }),
  launchMode: () => call<T.LaunchMode>("launch_mode"),
  writeLaunchB64: (data: string) => call<void>("write_launch_output_b64", { data }),
  writeLaunchText: (text: string) => call<void>("write_launch_output_text", { text }),
  exit: (code = 0) => call<void>("exit_app", { code }),
  dockerCli: () => call<string | null>("docker_cli_path"),

  // engines
  engines: () => call<EnginesOverview>("engines_overview"),
  engineStart: () => call<void>("engine_start"),
  engineStop: () => call<void>("engine_stop"),

  // containers
  containers: () => call<T.ContainerSummary[]>("list_containers"),
  inspectContainer: (id: string) => call<any>("inspect_container", { id }),
  containerAction: (id: string, action: string) => call<void>("container_action", { id, action }),
  removeContainer: (id: string, force = true, volumes = false) => call<void>("remove_container", { id, force, volumes }),
  renameContainer: (id: string, name: string) => call<void>("rename_container", { id, name }),
  createContainer: (spec: CreateContainerSpec) => call<{ id: string; warnings: string[]; started: boolean }>("create_container", { spec }),
  /** `since` (RFC 3339) resumes after a restart instead of re-reading the tail. */
  streamLogs: (id: string, tail: number, on: (e: T.LogEvent) => void, since?: string) =>
    stream("stream_logs", { id, tail, since: since ?? null }, on),
  streamStats: (id: string, on: (e: T.StatsEvent) => void) => stream("stream_stats", { id }, on),
  top: (id: string) => call<{ Titles?: string[]; Processes?: string[][] }>("container_top", { id }),

  // exec
  execOpen: (container: string, cols: number, rows: number, on: (e: T.ExecEvent) => void, command?: string, user?: string) =>
    stream("exec_open", { container, cols, rows, command: command ?? null, user: user ?? null }, on),
  execWrite: (session: string, data: string) => call<void>("exec_write", { session, data }),
  execResize: (session: string, cols: number, rows: number) => call<void>("exec_resize", { session, cols, rows }),
  execClose: (session: string) => call<void>("exec_close", { session }),
  execRun: (container: string, command: string) => call<[string, number]>("exec_run", { container, command }),

  // images
  images: () => call<T.ImageSummary[]>("list_images"),
  inspectImage: (id: string) => call<any>("inspect_image", { id }),
  imageHistory: (id: string) => call<{ Id: string; Created: number; CreatedBy: string; Size: number; Comment?: string; Tags?: string[] | null }[]>("image_history", { id }),
  tagImage: (id: string, repo: string, tag: string) => call<void>("tag_image", { id, repo, tag }),
  removeImage: (id: string, force = false) => call<any>("remove_image", { id, force }),
  pruneImages: (all: boolean) => call<{ ImagesDeleted?: any[]; SpaceReclaimed?: number }>("prune_images", { all }),
  pullImage: (reference: string, platform: string | null, on: (e: T.PullEvent) => void) => stream("pull_image", { reference, platform }, on),

  // volumes
  volumes: () => call<T.Volume[]>("list_volumes"),
  inspectVolume: (name: string) => call<T.Volume>("inspect_volume", { name }),
  createVolume: (spec: { name: string; driver?: string; labels?: T.KV[]; driverOpts?: T.KV[] }) => call<T.Volume>("create_volume", { spec }),
  removeVolume: (name: string, force = false) => call<void>("remove_volume", { name, force }),
  volumeListDir: (volume: string, path: string) => call<T.FileEntry[]>("volume_list_dir", { volume, path }),
  volumeReadFile: (volume: string, path: string) => call<T.FileContent>("volume_read_file", { volume, path }),
  volumeExport: (volume: string, path: string, dest: string) => call<number>("volume_export", { volume, path, dest }),
  volumeBrowseClose: (volume: string) => call<void>("volume_browse_close", { volume }),

  // networks
  networks: () => call<T.Network[]>("list_networks"),
  inspectNetwork: (id: string) => call<T.Network>("inspect_network", { id }),
  createNetwork: (spec: CreateNetworkSpec) => call<string>("create_network", { spec }),
  removeNetwork: (id: string) => call<void>("remove_network", { id }),
  connectNetwork: (network: string, container: string, aliases?: string[], ipv4?: string) =>
    call<void>("connect_network", { network, container, aliases: aliases ?? null, ipv4: ipv4 ?? null }),
  disconnectNetwork: (network: string, container: string, force = false) => call<void>("disconnect_network", { network, container, force }),

  // builds
  buildStart: (config: T.BuildConfig, on: (e: T.BuildEvent) => void) => stream("build_start", { config }, on),
  buildCancel: (id: string) => call<boolean>("build_cancel", { id }),
  buildRecords: () => call<T.BuildRecord[]>("build_records"),
  deleteBuildRecords: (ids: string[]) => call<void>("delete_build_records", { ids }),
  buildConfigs: () => call<T.BuildConfig[]>("build_configs"),
  saveBuildConfig: (config: T.BuildConfig) => call<T.BuildConfig[]>("save_build_config", { config }),
  deleteBuildConfig: (id: string) => call<T.BuildConfig[]>("delete_build_config", { id }),
  buildkitHistory: () => call<T.BuildkitHistoryItem[]>("buildkit_history"),
  buildkitInspect: (reference: string) => call<any>("buildkit_history_inspect", { reference }),
  buildkitLogs: (reference: string) => call<string>("buildkit_history_logs", { reference }),
  buildkitRemove: (references: string[]) => call<void>("buildkit_history_remove", { references }),
};

export interface CreateContainerSpec {
  image: string; name?: string; command?: string; env: T.KV[];
  ports: { hostIp?: string; hostPort: string; containerPort: string; protocol?: string }[];
  mounts: { source: string; target: string; readOnly: boolean }[];
  labels: T.KV[]; network?: string; restartPolicy?: string; autoRemove: boolean; start: boolean; platform?: string;
}
export interface CreateNetworkSpec {
  name: string; driver?: string; subnet?: string; gateway?: string; ipRange?: string;
  internal: boolean; attachable: boolean; ipv6: boolean; labels: T.KV[];
}

export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as any).message);
  return String(e);
}

export type EngineState = "notInstalled" | "stopped" | "starting" | "running" | "stopping" | "failed";
export interface HullportEngine {
  state: EngineState; error?: string | null; socket: string; context: string;
  cpus?: string | null; memory?: string | null; disk?: string | null; managed: boolean;
}
export interface EngineInfo { id: string; name: string; installed: boolean; running: boolean; socket: string; context: string; note: string }
export interface EnginesOverview { hullport: HullportEngine; others: EngineInfo[]; dockerCli?: string | null }
