import { useMemo, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { imageName } from "../../lib/format";
import { queryClient, useImages, useNetworks, useVolumes } from "../../lib/queries";
import { go } from "../../lib/store";
import { toast } from "../../lib/toast";
import type { KV } from "../../lib/types";
import { Modal } from "../../components/dialog";
import { KVEditor } from "../../components/kv";
import { Button, Checkbox, Field, IconButton } from "../../components/ui";
import { IconPlus, IconX } from "../../components/icons";

interface PortRow { hostPort: string; containerPort: string; protocol: string }
interface MountRow { source: string; target: string; readOnly: boolean }

export function CreateContainerDialog({ onClose, image: initialImage, defaults }: {
  onClose: () => void; image?: string; defaults?: { ports?: string[]; env?: string[] };
}) {
  const images = useImages().data ?? [];
  const volumes = useVolumes().data ?? [];
  const networks = useNetworks().data ?? [];
  const [image, setImage] = useState(initialImage ?? "");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [ports, setPorts] = useState<PortRow[]>(
    (defaults?.ports ?? []).map((p) => {
      const [cp, proto] = p.split("/");
      return { hostPort: cp, containerPort: cp, protocol: proto || "tcp" };
    }),
  );
  const [env, setEnv] = useState<KV[]>([]);
  const [mounts, setMounts] = useState<MountRow[]>([]);
  const [network, setNetwork] = useState("");
  const [restart, setRestart] = useState("no");
  const [autoRemove, setAutoRemove] = useState(false);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tags = useMemo(() => images.flatMap((i) => (i.RepoTags ?? []).filter((t) => t !== "<none>:<none>")).sort(), [images]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createContainer({
        image, name: name || undefined, command: command || undefined, env,
        ports: ports.filter((p) => p.containerPort),
        mounts: mounts.filter((m) => m.source && m.target),
        labels: [], network: network || undefined, restartPolicy: restart, autoRemove, start,
      });
      queryClient.invalidateQueries({ queryKey: ["containers"] });
      toast(r.started ? `Started ${name || r.id.slice(0, 12)}` : `Created ${name || r.id.slice(0, 12)}`, "ok");
      go("containers", r.id, "info");
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Container"
      subtitle="Images that aren't on this machine are pulled first."
      onClose={onClose}
      width={600}
      footer={
        <>
          {error && <div className="flex-1 text-bad text-[12px] self-center truncate" title={error}>{error}</div>}
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" busy={busy} disabled={!image.trim()} onClick={submit}>{start ? "Create & Start" : "Create"}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Image">
            <input autoFocus className="field mono" list="berth-images" placeholder="nginx:alpine" value={image} onChange={(e) => setImage(e.target.value)} />
            <datalist id="berth-images">{tags.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="Name" hint="Optional; Docker picks one otherwise.">
            <input className="field" placeholder="my-container" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label="Command" hint="Overrides the image's default command.">
          <input className="field mono" placeholder="e.g. sh -c 'echo hi && sleep 60'" value={command} onChange={(e) => setCommand(e.target.value)} />
        </Field>

        <Field label="Ports">
          <div className="flex flex-col gap-1.5">
            {ports.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input className="field mono w-[90px]" placeholder="host" value={p.hostPort} onChange={(e) => setPorts(ports.map((x, j) => (j === i ? { ...x, hostPort: e.target.value } : x)))} />
                <span className="text-fg3">→</span>
                <input className="field mono w-[90px]" placeholder="container" value={p.containerPort} onChange={(e) => setPorts(ports.map((x, j) => (j === i ? { ...x, containerPort: e.target.value } : x)))} />
                <select className="field" value={p.protocol} onChange={(e) => setPorts(ports.map((x, j) => (j === i ? { ...x, protocol: e.target.value } : x)))}>
                  <option value="tcp">TCP</option><option value="udp">UDP</option>
                </select>
                <IconButton title="Remove" onClick={() => setPorts(ports.filter((_, j) => j !== i))}><IconX size={12} /></IconButton>
              </div>
            ))}
            <button type="button" className="self-start inline-flex items-center gap-1 text-accent text-[12px] hover:underline" onClick={() => setPorts([...ports, { hostPort: "", containerPort: "", protocol: "tcp" }])}>
              <IconPlus size={12} /> Add port
            </button>
          </div>
        </Field>

        <Field label="Environment variables">
          <KVEditor value={env} onChange={setEnv} addLabel="Add variable" />
        </Field>

        <Field label="Volumes & bind mounts" hint="Source is a volume name or an absolute path on your Mac.">
          <div className="flex flex-col gap-1.5">
            {mounts.map((m, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input className="field mono flex-1" list="berth-volumes" placeholder="volume or /Users/…" value={m.source} onChange={(e) => setMounts(mounts.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))} />
                <span className="text-fg3">→</span>
                <input className="field mono flex-1" placeholder="/data" value={m.target} onChange={(e) => setMounts(mounts.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} />
                <label className="text-[12px] text-fg2 flex items-center gap-1"><input type="checkbox" checked={m.readOnly} onChange={(e) => setMounts(mounts.map((x, j) => (j === i ? { ...x, readOnly: e.target.checked } : x)))} />RO</label>
                <IconButton title="Remove" onClick={() => setMounts(mounts.filter((_, j) => j !== i))}><IconX size={12} /></IconButton>
              </div>
            ))}
            <datalist id="berth-volumes">{volumes.map((v) => <option key={v.Name} value={v.Name} />)}</datalist>
            <button type="button" className="self-start inline-flex items-center gap-1 text-accent text-[12px] hover:underline" onClick={() => setMounts([...mounts, { source: "", target: "", readOnly: false }])}>
              <IconPlus size={12} /> Add mount
            </button>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Network">
            <select className="field" value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option value="">Default (bridge)</option>
              {networks.filter((n) => n.Name !== "bridge").map((n) => <option key={n.Id} value={n.Name}>{n.Name}</option>)}
            </select>
          </Field>
          <Field label="Restart policy">
            <select className="field" value={restart} onChange={(e) => setRestart(e.target.value)}>
              <option value="no">Never</option>
              <option value="on-failure">On failure</option>
              <option value="unless-stopped">Unless stopped</option>
              <option value="always">Always</option>
            </select>
          </Field>
        </div>
        <div className="flex gap-6">
          <Checkbox checked={start} onChange={setStart} label="Start after creating" />
          <Checkbox checked={autoRemove} onChange={setAutoRemove} label="Remove after stop" hint="--rm" />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export { imageName };
