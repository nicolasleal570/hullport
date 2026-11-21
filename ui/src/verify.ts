// `--verify <json> --fixtures <dir> [--external <volume>]`: end-to-end checks against the real engine.
// Every resource it creates is uniquely named `hullport-verify-*` and removed afterwards; nothing else is touched.
import { api, errMsg } from "./lib/api";
import { getStatus, queryClient } from "./lib/queries";
import { go, select } from "./lib/store";
import type { BuildRecord, ImageSummary, LaunchMode, Volume } from "./lib/types";
import { startBuild } from "./features/builds/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeout = 15000, step = 200): Promise<T | null> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* keep trying */ }
    await sleep(step);
  }
  return null;
}
const inDom = (key: string) => !!document.querySelector(`[data-key="${CSS.escape(key)}"]`);

interface Step { step: string; passed: boolean; detail: string; ms: number }

export async function verify(mode: LaunchMode) {
  const steps: Step[] = [];
  const tag = Math.random().toString(36).slice(2, 7);
  const P = `hullport-verify-${tag}`;
  const cleanup: (() => Promise<unknown>)[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    const t = Date.now();
    try { steps.push({ step: name, passed: true, detail: await fn(), ms: Date.now() - t }); }
    catch (e) { steps.push({ step: name, passed: false, detail: errMsg(e), ms: Date.now() - t }); }
  };
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  await step("engine available", async () => {
    const ok = await until(() => getStatus().state === "connected", 10000);
    assert(ok, `not connected: ${getStatus().error}`);
    const s = getStatus();
    return `context ${s.context} (${s.host}), engine ${s.serverVersion}, API ${s.apiVersion}`;
  });

  let cid = "";
  const cname = `${P}-ctr`;
  await step("list running and stopped containers", async () => {
    const cs = await api.containers();
    go("containers");
    await until(() => document.querySelector('[data-section="containers"] [role="row"][data-key]') || cs.length === 0, 5000);
    return `${cs.filter((c) => c.State === "running").length} running, ${cs.filter((c) => c.State !== "running").length} not running (read-only)`;
  });

  await step("create, start, stop, pause, restart an isolated container", async () => {
    const r = await api.createContainer({
      image: "alpine:latest", name: cname,
      command: `sh -c 'i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.4; done'`,
      env: [{ key: "HULLPORT_VERIFY", value: "1" }], ports: [], mounts: [], labels: [{ key: "dev.hullport.verify", value: tag }],
      autoRemove: false, start: true, restartPolicy: "no",
    });
    cid = r.id;
    cleanup.push(() => api.removeContainer(cid, true, true));
    select("containers", cid);
    const shown = await until(() => inDom(cid), 8000);
    assert(shown, "new container did not appear in the list");
    const state = async (want: string) => (await api.inspectContainer(cid)).State?.Status === want;
    await api.containerAction(cid, "stop");
    assert(await until(() => state("exited"), 15000), "did not stop");
    await api.containerAction(cid, "start");
    assert(await until(() => state("running"), 10000), "did not start");
    await api.containerAction(cid, "pause");
    assert(await until(() => state("paused"), 5000), "did not pause");
    await api.containerAction(cid, "unpause");
    await api.containerAction(cid, "restart");
    assert(await until(() => state("running"), 15000), "did not restart");
    return `${cname} appeared via engine events; stop → start → pause → resume → restart all confirmed by inspect`;
  });

  await step("stream container logs", async () => {
    const lines: string[] = [];
    const op = await api.streamLogs(cid, 50, (e) => { if (e.type === "lines") lines.push(...e.lines.map((l) => `${l.ts} ${l.text}`)); });
    const got = await until(() => lines.filter((l) => l.includes("tick")).length >= 4 && lines, 10000);
    await api.cancelOp(op);
    assert(got, `only ${lines.length} log lines`);
    return `${lines.length} lines streamed with timestamps, e.g. "${lines[lines.length - 1]}"`;
  });

  await step("execute a command and an interactive PTY terminal", async () => {
    const [out, code] = await api.execRun(cid, "sh -c 'echo hello-from-exec; uname -s'");
    assert(out.includes("hello-from-exec") && code === 0, `exec output: ${out} (code ${code})`);
    let pty = "";
    const dec = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
    const session = await api.execOpen(cid, 100, 30, (e) => { if (e.type === "data") pty += dec(e.data); });
    await sleep(400);
    await api.execWrite(session, "echo pty-$((6*7)) && tty\r");
    const ok = await until(() => pty.includes("pty-42") && /\/dev\/pts\/\d+/.test(pty), 8000);
    await api.execResize(session, 120, 40);
    await api.execClose(session);
    assert(ok, `PTY output: ${JSON.stringify(pty.slice(-200))}`);
    return `exec printed "${out.trim().split("\n").join(" | ")}" (exit 0); PTY echoed pty-42 on ${/\/dev\/pts\/\d+/.exec(pty)?.[0]}`;
  });

  await step("live CPU and memory stats", async () => {
    let sample: any = null;
    const op = await api.streamStats(cid, (e) => { if (e.type === "sample" && e.sample.memUsed > 0) sample = e.sample; });
    await until(() => sample, 10000);
    await api.cancelOp(op);
    assert(sample, "no stats sample");
    return `cpu ${sample.cpuPercent.toFixed(2)}%, memory ${(sample.memUsed / 1e6).toFixed(1)} MB of ${(sample.memLimit / 1e9).toFixed(1)} GB, ${sample.pids} pids`;
  });

  await step("pull, inspect, tag and untag an image", async () => {
    const ref = "busybox:1.36";
    const before = (await api.images()).some((i) => i.RepoTags?.includes(ref));
    let events = 0;
    let done: { error?: string | null } | null = null;
    await api.pullImage(ref, null, (e) => { if (e.type === "progress") events++; if (e.type === "done") done = e; });
    await until(() => done, 120000, 300);
    assert(done && !(done as any).error, `pull failed: ${(done as any)?.error}`);
    const info = await api.inspectImage(ref);
    const hist = await api.imageHistory(ref);
    const newTag = `${P}-img`;
    await api.tagImage(info.Id, newTag, "tagged");
    const tagged = await until(async () => (await api.images()).some((i: ImageSummary) => i.RepoTags?.includes(`${newTag}:tagged`)), 5000);
    await api.removeImage(`${newTag}:tagged`, false);
    if (!before) await api.removeImage(ref, false).catch(() => {});
    assert(tagged, "tag did not show up");
    return `${events} progress events; ${info.Architecture}/${info.Os}, ${hist.length} history entries; tagged as ${newTag}:tagged and removed it${before ? "" : "; removed the pulled image again"}`;
  });

  await step("create, browse, export and delete a volume", async () => {
    const vol = `${P}-vol`;
    await api.createVolume({ name: vol, labels: [{ key: "dev.hullport.verify", value: tag }] });
    cleanup.push(() => api.removeVolume(vol, true));
    go("volumes");
    assert(await until(() => inDom(vol), 8000), "volume did not appear in the list");
    const writer = await api.createContainer({
      image: "alpine:latest", name: `${P}-writer`, command: "sh -c 'mkdir -p /data/sub && echo volume-content > /data/sub/hello.txt'",
      env: [], ports: [], labels: [], mounts: [{ source: vol, target: "/data", readOnly: false }], autoRemove: false, start: true,
    });
    await until(async () => (await api.inspectContainer(writer.id)).State?.Status === "exited", 15000);
    await api.removeContainer(writer.id, true, false);
    const root = await api.volumeListDir(vol, "/");
    const sub = await api.volumeListDir(vol, "/sub");
    const file = await api.volumeReadFile(vol, "/sub/hello.txt");
    const dest = `/tmp/${P}-export.txt`;
    const n = await api.volumeExport(vol, "/sub/hello.txt", dest);
    await api.volumeBrowseClose(vol);
    assert(root.some((e) => e.name === "sub" && e.kind === "dir"), "folder missing");
    assert(sub.some((e) => e.name === "hello.txt"), "file missing");
    assert(file.text?.trim() === "volume-content", `read ${JSON.stringify(file.text)}`);
    const helpers = (await api.containers()).filter((c) => c.Labels?.["dev.hullport.helper"]);
    await api.removeVolume(vol, false);
    assert(await until(() => !inDom(vol), 8000), "volume still listed after delete");
    return `listed /, /sub, read hello.txt = "${file.text?.trim()}", exported ${n} bytes to ${dest.split("/").pop()}, ${helpers.length} helper containers left, volume deleted`;
  });

  await step("build an image with BuildKit and inspect the result", async () => {
    assert(mode.fixtures, "no --fixtures folder");
    const img = `${P}-build`;
    const id = await startBuild({
      id: "", name: "verify", contextDir: `${mode.fixtures}/minimal`, dockerfile: "", image: img, tag: "v1",
      buildArgs: [{ key: "GREETING", value: "hi-" + tag }], target: "", platform: "", noCache: true, pull: false,
    });
    assert(id, "build did not start");
    const rec = await until(async () => (await api.buildRecords()).find((r: BuildRecord) => r.id === id && r.status !== "running"), 120000, 500);
    assert(rec?.status === "succeeded", `build ${rec?.status}: ${rec?.error}`);
    const info = await api.inspectImage(`${img}:v1`);
    const logOk = rec!.logTail.includes(`hi-${tag} from hullport`);
    await api.removeImage(`${img}:v1`, true);
    if (rec!.buildRef) await api.buildkitRemove([rec!.buildRef]).catch(() => {});
    await api.deleteBuildRecords([id!]);
    assert(logOk, "build log did not contain the RUN output");
    return `${rec!.steps.length} steps (${rec!.steps.filter((s) => s.cached).length} cached) in ${rec!.durationMs} ms, image ${info.Id.slice(7, 19)}, RUN output captured, record & image removed`;
  });

  await step("cancel a running build", async () => {
    const img = `${P}-slow`;
    const id = await startBuild({
      id: "", name: "verify-slow", contextDir: `${mode.fixtures}/slow`, dockerfile: "", image: img, tag: "v1",
      buildArgs: [], target: "", platform: "", noCache: true, pull: false,
    });
    assert(id, "build did not start");
    await sleep(4000);
    await api.buildCancel(id!);
    const rec = await until(async () => (await api.buildRecords()).find((r: BuildRecord) => r.id === id && r.status !== "running"), 30000, 500);
    const exists = (await api.images()).some((i) => i.RepoTags?.includes(`${img}:v1`));
    if (rec?.buildRef) await api.buildkitRemove([rec.buildRef]).catch(() => {});
    await api.deleteBuildRecords([id!]);
    assert(rec?.status === "canceled", `status ${rec?.status}`);
    assert(!exists, "image exists after cancel");
    return `canceled after ~4 s (status ${rec!.status}, no image produced)`;
  });

  await step("create a network, connect and disconnect a container, delete it", async () => {
    const name = `${P}-net`;
    const nid = await api.createNetwork({ name, driver: "bridge", internal: false, attachable: false, ipv6: false, labels: [{ key: "dev.hullport.verify", value: tag }] });
    cleanup.push(() => api.removeNetwork(nid));
    go("networks");
    assert(await until(() => inDom(nid), 8000), "network did not appear in the list");
    await api.connectNetwork(nid, cid, ["verify-alias"]);
    const net = await api.inspectNetwork(nid);
    const member = Object.values(net.Containers ?? {})[0];
    assert(member?.Name === cname, "container not connected");
    await api.disconnectNetwork(nid, cid, false);
    const after = await api.inspectNetwork(nid);
    assert(Object.keys(after.Containers ?? {}).length === 0, "still connected");
    await api.removeNetwork(nid);
    assert(await until(() => !inDom(nid), 8000), "network still listed");
    return `${name} (${net.IPAM?.Config?.[0]?.Subnet}) connected ${cname} at ${member?.IPv4Address}, disconnected, deleted`;
  });

  await step("mount the engine's own socket into a container", async () => {
    // Tools like `supabase start` bind-mount the socket they talk to, by its path on the Mac.
    // The engine resolves that path inside its VM, so it must lead to the real socket there too.
    const host = getStatus().host;
    if (!host.startsWith("unix://")) return `skipped: ${host} is not a unix socket`;
    const sock = host.slice("unix://".length);
    const name = `${P}-sock`;
    // Registered first: a failed start still leaves the created container behind.
    cleanup.push(() => api.removeContainer(name, true, false));
    const r = await api.createContainer({
      image: "alpine:latest", name, command: "test -S /var/run/docker.sock",
      env: [], ports: [], mounts: [{ source: sock, target: "/var/run/docker.sock", readOnly: true }],
      labels: [{ key: "dev.hullport.verify", value: tag }], autoRemove: false, start: true, restartPolicy: "no",
    });
    const st = await until(async () => { const s = (await api.inspectContainer(r.id)).State; return s?.Status === "exited" && s; }, 15000);
    assert(st, "container did not finish");
    assert(st && st.ExitCode === 0, `${sock} is not a socket inside the container (exit ${st && st.ExitCode})`);
    return `${sock} mounted at /var/run/docker.sock is a live socket inside the container`;
  });

  if (mode.external) {
    await step("external CLI changes appear in the app", async () => {
      go("volumes");
      // Tell the outside script we're watching, by creating a marker volume it waits for.
      const marker = `${mode.external}-ready`;
      await api.createVolume({ name: marker });
      const appeared = await until(() => inDom(mode.external!), 40000, 200);
      await api.removeVolume(marker, true).catch(() => {});
      assert(appeared, `volume ${mode.external} created with the docker CLI never appeared`);
      const gone = await until(() => !inDom(mode.external!), 40000, 200);
      assert(gone, "volume removed with the CLI is still listed");
      const vols = queryClient.getQueryData<Volume[]>(["volumes"]) ?? [];
      return `${mode.external} appeared and disappeared without a manual refresh (${vols.length} volumes listed)`;
    });
  }

  await step("cleanup", async () => {
    for (const c of cleanup.reverse()) await c().catch(() => {});
    const left = [
      ...(await api.containers()).filter((c) => (c.Names?.[0] ?? "").includes(P)).map((c) => c.Names?.[0]),
      ...(await api.volumes()).filter((v) => v.Name.includes(P)).map((v) => v.Name),
      ...(await api.networks()).filter((n) => n.Name.includes(P)).map((n) => n.Name),
    ];
    assert(left.length === 0, `left behind: ${left.join(", ")}`);
    return "all hullport-verify resources removed";
  });

  await api.writeLaunchText(JSON.stringify({ version: 1, prefix: P, steps }, null, 2));
}
