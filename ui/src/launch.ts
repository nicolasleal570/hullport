// `--screenshot <png>` and `--self-test <json>` modes used to check the build automatically.
import { toPng } from "html-to-image";
import { api, errMsg } from "./lib/api";
import { getStatus, queryClient } from "./lib/queries";
import { go, select, type Section } from "./lib/store";
import type { ContainerSummary } from "./lib/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 8000, step = 100): Promise<T | null> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}
const frames = (n: number) => new Promise<void>((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });

export async function runLaunchMode() {
  let mode;
  try { mode = await api.launchMode(); } catch { return; }
  if (mode.mode === "normal" || !mode.path) return;
  document.documentElement.classList.add("opaque");
  try {
    if (mode.mode === "screenshot") await screenshot((mode.section as Section) || "containers");
    else if (mode.mode === "verify") await (await import("./verify")).verify(mode);
    else await selfTest();
  } finally {
    await api.exit(0);
  }
}

async function screenshot(section: Section) {
  go(section);
  await waitFor(() => getStatus().state === "connected", 8000);
  await waitFor(() => queryClient.getQueryData(["containers"]), 6000);
  if (section === "containers") {
    const cs = (queryClient.getQueryData(["containers"]) as ContainerSummary[] | undefined) ?? [];
    const first = cs.find((c) => c.State === "running") ?? cs[0];
    if (first) select("containers", first.Id);
  } else {
    // Select the first row of the section, like a person exploring it.
    const row = await waitFor(() => document.querySelector<HTMLElement>(`[data-section="${section}"] [role="row"][data-key]`), 6000);
    if (row) select(section, row.dataset.key!);
  }
  await frames(120);
  await sleep(300);
  const opts = { pixelRatio: 1, backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--c-bg").trim() || "#1c1c1e", cacheBust: true };
  await toPng(document.body, opts).catch(() => "");
  const url = await toPng(document.body, opts);
  await api.writeLaunchB64(url.slice(url.indexOf(",") + 1));
}

interface Step { step: string; passed: boolean; detail: string }

async function selfTest() {
  const steps: Step[] = [];
  const connected = await waitFor(() => getStatus().state === "connected", 10000);

  // move: walk every section the way a person would and see each one render.
  const visited: string[] = [];
  for (const s of ["containers", "images", "volumes", "builds", "networks"] as Section[]) {
    go(s);
    const el = await waitFor(() => document.querySelector(`[data-section="${s}"]`), 5000);
    await waitFor(() => !document.querySelector(`[data-section="${s}"]`)?.textContent?.includes("Loading"), 8000);
    if (el) visited.push(`${s}:${el.querySelectorAll('[role="row"][data-key]').length}`);
  }
  steps.push({ step: "move", passed: visited.length === 5, detail: `opened ${visited.length}/5 sections (section:rows ${visited.join(", ")})` });

  // act: create a disposable volume, see it appear via engine events, delete it, see it go.
  if (!connected) {
    steps.push({ step: "act", passed: false, detail: `engine not connected: ${getStatus().error ?? "unknown"}` });
  } else {
    const name = `berth-selftest-${Math.random().toString(36).slice(2, 8)}`;
    try {
      go("volumes");
      await api.createVolume({ name });
      const shown = await waitFor(() => document.querySelector(`[data-key="${name}"]`), 6000);
      await api.removeVolume(name, false);
      const gone = await waitFor(() => !document.querySelector(`[data-key="${name}"]`), 6000);
      const cs = await api.containers();
      steps.push({
        step: "act",
        passed: !!shown && !!gone,
        detail: `created volume ${name} (${shown ? "appeared in list" : "did not appear"}), deleted it (${gone ? "removed from list" : "still listed"}); engine reports ${cs.length} containers`,
      });
    } catch (e) {
      await api.removeVolume(name, false).catch(() => {});
      steps.push({ step: "act", passed: false, detail: `docker operation failed: ${errMsg(e)}` });
    }
  }

  // hud: connection status, context and the five sections are drawn.
  go("containers");
  await sleep(300);
  const state = document.querySelector('[data-testid="engine-state"]')?.textContent ?? "";
  const ctx = document.querySelector('[data-testid="engine-context"]')?.textContent ?? "";
  const navs = document.querySelectorAll("[data-nav]").length;
  const title = document.querySelector("main h1")?.textContent ?? "";
  steps.push({
    step: "hud",
    passed: state === "Connected" && !!ctx && ctx !== "—" && navs === 5 && !!title,
    detail: `status "${state}", context "${ctx}", ${navs} sidebar sections, toolbar "${title}"`,
  });

  await api.writeLaunchText(JSON.stringify({ version: 1, steps }, null, 2));
}
