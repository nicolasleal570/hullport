import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../../lib/api";
import { containerName, publishedPorts } from "../../lib/format";
import { queryClient, run } from "../../lib/queries";
import { go, select } from "../../lib/store";
import type { ContainerSummary } from "../../lib/types";
import { confirmAction } from "../../components/dialog";
import { writeText } from "../../components/clipboard";
import {
  IconCode, IconCopy, IconExternal, IconLogs, IconPause, IconPlay, IconRestart, IconStats, IconStop, IconTerminal, IconTrash,
} from "../../components/icons";
import type { MenuItem } from "../../components/menu";
import { toast } from "../../lib/toast";

const refresh = () => queryClient.invalidateQueries({ queryKey: ["containers"] });

export async function act(c: ContainerSummary | string, action: string) {
  const id = typeof c === "string" ? c : c.Id;
  const verb = { start: "Start", stop: "Stop", restart: "Restart", pause: "Pause", unpause: "Resume", kill: "Kill" }[action] ?? action;
  await run(`${verb} failed`, () => api.containerAction(id, action));
  refresh();
}

export async function deleteContainers(cs: ContainerSummary[]) {
  if (!cs.length) return;
  const running = cs.some((c) => c.State === "running" || c.State === "paused");
  const names = cs.map(containerName);
  const { ok, option } = await confirmAction({
    title: cs.length > 1 ? "Delete containers?" : "Delete container?",
    message: (
      <>
        <b className="text-fg">{names.slice(0, 6).join(", ")}{names.length > 6 ? ` and ${names.length - 6} more` : ""}</b> will be permanently deleted
        {running ? ", stopping them first" : ""}. Data in named volumes is kept.
      </>
    ),
    confirmLabel: "Delete",
    danger: true,
    option: { label: "Also delete anonymous volumes", hint: "Named volumes are never removed." },
  });
  if (!ok) return;
  let failed = 0;
  for (const c of cs) {
    const r = await run(`Delete ${containerName(c)}`, () => api.removeContainer(c.Id, true, option));
    if (r === undefined) failed++;
  }
  select("containers", null);
  refresh();
  if (!failed) toast(cs.length > 1 ? `Deleted ${cs.length} containers` : `Deleted ${names[0]}`, "ok");
}

export function openPort(port: number) {
  openUrl(`http://localhost:${port}`).catch((e) => toast(`Could not open browser: ${e}`, "error"));
}

export function containerMenu(c: ContainerSummary): MenuItem[] {
  const running = c.State === "running";
  const paused = c.State === "paused";
  const ports = publishedPorts(c);
  const items: MenuItem[] = [];
  if (!running && !paused) items.push({ label: "Start", icon: <IconPlay size={12} />, onClick: () => act(c, "start") });
  if (running || paused) items.push({ label: "Stop", icon: <IconStop size={12} />, onClick: () => act(c, "stop") });
  items.push({ label: "Restart", icon: <IconRestart size={13} />, onClick: () => act(c, "restart"), disabled: !running });
  if (running) items.push({ label: "Pause", icon: <IconPause size={12} />, onClick: () => act(c, "pause") });
  if (paused) items.push({ label: "Resume", icon: <IconPlay size={12} />, onClick: () => act(c, "unpause") });
  if (running) items.push({ label: "Kill", icon: <IconStop size={12} />, onClick: () => act(c, "kill") });
  items.push("sep");
  items.push({ label: "Show Logs", icon: <IconLogs size={13} />, onClick: () => go("containers", c.Id, "logs") });
  items.push({ label: "Open Terminal", icon: <IconTerminal size={13} />, onClick: () => go("containers", c.Id, "terminal"), disabled: !running });
  items.push({ label: "Show Stats", icon: <IconStats size={13} />, onClick: () => go("containers", c.Id, "stats"), disabled: !running });
  items.push({ label: "Inspect", icon: <IconCode size={13} />, onClick: () => go("containers", c.Id, "inspect") });
  for (const p of ports.slice(0, 4)) {
    items.push({ label: `Open localhost:${p.host}`, icon: <IconExternal size={13} />, onClick: () => openPort(p.host) });
  }
  items.push("sep");
  items.push({ label: "Copy ID", icon: <IconCopy size={13} />, onClick: () => writeText(c.Id) });
  items.push({ label: "Copy Name", icon: <IconCopy size={13} />, onClick: () => writeText(containerName(c)) });
  if (c.Image) items.push({ label: "Copy Image", icon: <IconCopy size={13} />, onClick: () => writeText(c.Image!) });
  items.push("sep");
  items.push({ label: "Delete", icon: <IconTrash size={13} />, danger: true, onClick: () => deleteContainers([c]), shortcut: "⌘⌫" });
  return items;
}
