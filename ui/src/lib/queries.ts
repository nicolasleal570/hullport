import { QueryClient, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import { api, errMsg } from "./api";
import { toast } from "./toast";
import type { ConnStatus, EngineEvent } from "./types";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Engine events drive refreshes, so lists don't poll.
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// ---- connection status (pushed by the backend) ----
let status: ConnStatus = { state: "connecting", context: "", host: "" };
const statusListeners = new Set<() => void>();
function setStatus(s: ConnStatus) {
  const wasConnected = status.state === "connected";
  status = s;
  statusListeners.forEach((l) => l());
  if (s.state === "connected" && !wasConnected) queryClient.invalidateQueries();
}
export const getStatus = () => status;
export const useStatus = () =>
  useSyncExternalStore((cb) => { statusListeners.add(cb); return () => statusListeners.delete(cb); }, () => status);
export const useConnected = () => useStatus().state === "connected";

const KEYS_BY_KIND: Record<string, string[]> = {
  container: ["containers", "container", "networks-detail", "volumes-usage", "images"],
  image: ["images", "image"],
  volume: ["volumes", "volume", "volumes-usage"],
  network: ["networks", "network", "containers", "container"],
};

let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
const eventListeners = new Set<(e: EngineEvent) => void>();
export function onEngineEvent(fn: (e: EngineEvent) => void) {
  eventListeners.add(fn);
  return () => { eventListeners.delete(fn); };
}

function scheduleInvalidate(keys: string[]) {
  keys.forEach((k) => pending.add(k));
  clearTimeout(timer);
  timer = setTimeout(() => {
    const ks = pending;
    pending = new Set();
    queryClient.invalidateQueries({ predicate: (q) => ks.has(String(q.queryKey[0])) });
  }, 120);
}

/** Subscribe once to backend status and engine events. */
export function useEngineBridge() {
  useEffect(() => {
    let alive = true;
    const unsubs: (() => void)[] = [];
    api.status().then((s) => alive && setStatus(s)).catch(() => {});
    listen<ConnStatus>("docker://status", (e) => setStatus(e.payload)).then((u) => unsubs.push(u));
    listen<EngineEvent>("docker://event", (e) => {
      const ev = e.payload;
      // exec_* and health events are noisy and don't change lists.
      if (ev.action.startsWith("exec_") || ev.action.startsWith("health_status") || ev.action === "top") return;
      eventListeners.forEach((l) => l(ev));
      scheduleInvalidate(KEYS_BY_KIND[ev.kind] ?? []);
    }).then((u) => unsubs.push(u));
    return () => { alive = false; unsubs.forEach((u) => u()); };
  }, []);
}

const enabled = () => status.state === "connected";

export const useContainers = () => {
  const c = useConnected();
  return useQuery({ queryKey: ["containers"], queryFn: api.containers, enabled: c });
};
export const useImages = () => {
  const c = useConnected();
  return useQuery({ queryKey: ["images"], queryFn: api.images, enabled: c });
};
export const useVolumes = () => {
  const c = useConnected();
  return useQuery({ queryKey: ["volumes"], queryFn: api.volumes, enabled: c });
};
export const useVolumeUsage = () => {
  const c = useConnected();
  return useQuery({
    queryKey: ["volumes-usage"],
    queryFn: async () => {
      const df = await api.diskUsage();
      const m = new Map<string, number>();
      for (const v of df.Volumes ?? []) if (v.UsageData && v.UsageData.Size >= 0) m.set(v.Name, v.UsageData.Size);
      return m;
    },
    enabled: c,
    staleTime: 30_000,
  });
};
export const useNetworks = () => {
  const c = useConnected();
  return useQuery({ queryKey: ["networks"], queryFn: api.networks, enabled: c });
};

export function refreshAll() {
  if (enabled()) queryClient.invalidateQueries();
  else api.reconnect();
}

/** Run a Docker operation with consistent feedback. */
export async function run<T>(label: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (success) toast(success, "ok");
    return r;
  } catch (e) {
    toast(`${label}: ${errMsg(e)}`, "error");
    return undefined;
  }
}
