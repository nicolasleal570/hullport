import { useState } from "react";
import { api, errMsg } from "../../lib/api";
import { imageName } from "../../lib/format";
import { queryClient } from "../../lib/queries";
import { toast } from "../../lib/toast";
import type { ImageSummary } from "../../lib/types";
import { Modal } from "../../components/dialog";
import { Button, Field } from "../../components/ui";

export function TagDialog({ image, onClose }: { image: ImageSummary; onClose: () => void }) {
  const n = imageName(image);
  const [repo, setRepo] = useState(n.dangling ? "" : n.repo);
  const [tag, setTag] = useState(n.dangling ? "latest" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.tagImage(image.Id, repo.trim(), tag.trim() || "latest");
      queryClient.invalidateQueries({ queryKey: ["images"] });
      toast(`Tagged ${repo}:${tag || "latest"}`, "ok");
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Tag Image" subtitle={`Add a name to ${n.dangling ? image.Id.slice(7, 19) : `${n.repo}:${n.tag}`}`} onClose={onClose} width={440}
      footer={<>
        {error && <div className="flex-1 text-bad text-[12px] self-center truncate" title={error}>{error}</div>}
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" busy={busy} disabled={!repo.trim()} onClick={submit}>Tag</Button>
      </>}>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="flex-[3]"><Field label="Repository"><input autoFocus className="field mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="myorg/app" /></Field></div>
        <div className="flex-[1.4]"><Field label="Tag"><input className="field mono" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="latest" /></Field></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
