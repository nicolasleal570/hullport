import type { KV } from "../lib/types";
import { IconButton } from "./ui";
import { IconPlus, IconX } from "./icons";

/** Editable list of key/value pairs (env vars, labels, build args). */
export function KVEditor({ value, onChange, keyPlaceholder = "KEY", valuePlaceholder = "value", addLabel = "Add" }: {
  value: KV[]; onChange: (v: KV[]) => void; keyPlaceholder?: string; valuePlaceholder?: string; addLabel?: string;
}) {
  const set = (i: number, patch: Partial<KV>) => onChange(value.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)));
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((kv, i) => (
        <div key={i} className="flex gap-1.5 items-center">
          <input className="field mono flex-[2]" placeholder={keyPlaceholder} value={kv.key} onChange={(e) => set(i, { key: e.target.value })}
            onPaste={(e) => {
              const t = e.clipboardData.getData("text");
              if (t.includes("=") && t.includes("\n")) {
                e.preventDefault();
                const extra = t.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => {
                  const k = l.indexOf("=");
                  return k < 0 ? { key: l.trim(), value: "" } : { key: l.slice(0, k).trim(), value: l.slice(k + 1) };
                });
                onChange([...value.slice(0, i), ...extra, ...value.slice(i + 1)]);
              }
            }} />
          <input className="field mono flex-[3]" placeholder={valuePlaceholder} value={kv.value} onChange={(e) => set(i, { value: e.target.value })} />
          <IconButton title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}><IconX size={12} /></IconButton>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...value, { key: "", value: "" }])} className="self-start inline-flex items-center gap-1 text-accent text-[12px] hover:underline">
        <IconPlus size={12} /> {addLabel}
      </button>
    </div>
  );
}
