import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { api, errMsg } from "../../lib/api";
import { queryClient } from "../../lib/queries";
import { go } from "../../lib/store";
import type { BuildConfig, KV } from "../../lib/types";
import { Modal } from "../../components/dialog";
import { KVEditor } from "../../components/kv";
import { Button, Checkbox, Field } from "../../components/ui";
import { IconFolder } from "../../components/icons";
import { startBuild } from "./session";

export const emptyConfig = (): BuildConfig => ({
  id: "", name: "", contextDir: "", dockerfile: "", image: "", tag: "latest", buildArgs: [], target: "", platform: "", noCache: false, pull: false,
});

export function NewBuildDialog({ initial, onClose }: { initial?: BuildConfig; onClose: () => void }) {
  const [c, setC] = useState<BuildConfig>(initial ?? emptyConfig());
  const [saveIt, setSaveIt] = useState(!!initial?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<BuildConfig>) => setC((x) => ({ ...x, ...p }));

  const pickDir = async () => {
    const d = await open({ directory: true, title: "Choose the build context folder" });
    if (typeof d === "string") {
      const base = d.split("/").filter(Boolean).pop() ?? "";
      set({ contextDir: d, image: c.image || base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), name: c.name || base });
    }
  };
  const pickFile = async () => {
    const f = await open({ directory: false, title: "Choose a Dockerfile", defaultPath: c.contextDir || undefined });
    if (typeof f === "string") {
      const rel = c.contextDir && f.startsWith(c.contextDir + "/") ? f.slice(c.contextDir.length + 1) : f;
      set({ dockerfile: rel, contextDir: c.contextDir || f.split("/").slice(0, -1).join("/") });
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let cfg = { ...c, name: c.name || c.image };
      if (saveIt) {
        const all = await api.saveBuildConfig(cfg);
        cfg = all[0];
        queryClient.invalidateQueries({ queryKey: ["build-configs"] });
      }
      const id = await startBuild(cfg);
      if (id) { go("builds", id, "steps"); onClose(); }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New Build" subtitle="Runs docker buildx build with BuildKit and loads the result into the engine." onClose={onClose} width={580} footer={<>
      {error && <div className="flex-1 text-bad text-caption self-center truncate" title={error}>{error}</div>}
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" busy={busy} disabled={!c.contextDir || !c.image} onClick={submit}>Build</Button>
    </>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Build context">
          <div className="flex gap-1.5">
            <input className="field mono flex-1" value={c.contextDir} onChange={(e) => set({ contextDir: e.target.value })} placeholder="/Users/you/project" />
            <Button onClick={pickDir}><IconFolder size={12} /> Choose…</Button>
          </div>
        </Field>
        <Field label="Dockerfile" hint="Relative to the context, or absolute. Empty means ./Dockerfile.">
          <div className="flex gap-1.5">
            <input className="field mono flex-1" value={c.dockerfile ?? ""} onChange={(e) => set({ dockerfile: e.target.value })} placeholder="Dockerfile" />
            <Button onClick={pickFile}>Choose…</Button>
          </div>
        </Field>
        <div className="flex gap-2">
          <div className="flex-[3]"><Field label="Image name"><input className="field mono" value={c.image} onChange={(e) => set({ image: e.target.value })} placeholder="my-app" /></Field></div>
          <div className="flex-[1.2]"><Field label="Tag"><input className="field mono" value={c.tag ?? ""} onChange={(e) => set({ tag: e.target.value })} placeholder="latest" /></Field></div>
        </div>
        <div className="flex gap-2">
          <div className="flex-1"><Field label="Target stage"><input className="field mono" value={c.target ?? ""} onChange={(e) => set({ target: e.target.value })} placeholder="optional" /></Field></div>
          <div className="flex-1"><Field label="Platform">
            <select className="field" value={c.platform ?? ""} onChange={(e) => set({ platform: e.target.value })}>
              <option value="">Engine default</option>
              <option value="linux/arm64">linux/arm64</option>
              <option value="linux/amd64">linux/amd64</option>
            </select>
          </Field></div>
        </div>
        <Field label="Build arguments"><KVEditor value={c.buildArgs} onChange={(v: KV[]) => set({ buildArgs: v })} addLabel="Add argument" /></Field>
        <div className="flex gap-6">
          <Checkbox checked={c.noCache} onChange={(v) => set({ noCache: v })} label="No cache" />
          <Checkbox checked={c.pull} onChange={(v) => set({ pull: v })} label="Pull base images" />
        </div>
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <Checkbox checked={saveIt} onChange={setSaveIt} label="Save this configuration" />
          {saveIt && <input className="field flex-1" value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="Configuration name" />}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
