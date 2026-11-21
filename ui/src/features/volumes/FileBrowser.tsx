import { useQuery } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { api, errMsg } from "../../lib/api";
import { bytes, dateTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import type { FileEntry } from "../../lib/types";
import { Button, ErrorBox, IconButton, Loading, cx } from "../../components/ui";
import { IconChevron, IconDownload, IconFile, IconFolder, IconLink, IconRefresh } from "../../components/icons";

/** Read-only explorer: files are listed and read through a helper container that mounts the volume read-only. */
export function FileBrowser({ volume }: { volume: string }) {
  const [path, setPath] = useState("/");
  const [picked, setPicked] = useState<FileEntry | null>(null);
  const list = useQuery({
    queryKey: ["volume-files", volume, path],
    queryFn: () => api.volumeListDir(volume, path),
    staleTime: 5000,
    retry: false,
  });
  const join = (name: string) => (path === "/" ? `/${name}` : `${path}/${name}`);
  const file = useQuery({
    queryKey: ["volume-file", volume, picked ? join(picked.name) : ""],
    queryFn: () => api.volumeReadFile(volume, join(picked!.name)),
    enabled: !!picked && picked.kind === "file",
    retry: false,
  });

  // Stop the helper container when the browser closes.
  useEffect(() => () => { api.volumeBrowseClose(volume).catch(() => {}); }, [volume]);

  const crumbs = path.split("/").filter(Boolean);
  const open = (e: FileEntry) => {
    if (e.kind === "dir") { setPath(join(e.name)); setPicked(null); }
    else setPicked(e);
  };
  const exportSel = async (e: FileEntry) => {
    const isDir = e.kind === "dir";
    const dest = await save({ defaultPath: isDir ? `${e.name}.tar` : e.name, title: isDir ? "Export folder as .tar" : "Export file" });
    if (!dest) return;
    try {
      const n = await api.volumeExport(volume, join(e.name), dest);
      toast(`Exported ${bytes(n)} to ${dest.split("/").pop()}`, "ok");
      revealItemInDir(dest).catch(() => {});
    } catch (err) {
      toast(`Export failed: ${errMsg(err)}`, "error");
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col" data-testid="file-browser">
      <div className="h-[36px] shrink-0 flex items-center gap-1 px-3 border-b border-line text-[12.5px]">
        <button className="hover:text-accent font-medium" onClick={() => { setPath("/"); setPicked(null); }}>{volume.length > 24 ? volume.slice(0, 12) + "…" : volume}</button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <IconChevron size={10} className="text-fg3" />
            <button className="hover:text-accent" onClick={() => { setPath("/" + crumbs.slice(0, i + 1).join("/")); setPicked(null); }}>{c}</button>
          </span>
        ))}
        <div className="flex-1" />
        <span className="text-fg3 text-[11px] mr-1">read-only</span>
        {picked && <Button onClick={() => exportSel(picked)}><IconDownload size={12} /> Export</Button>}
        <IconButton title="Refresh" onClick={() => { list.refetch(); file.refetch(); }}><IconRefresh size={13} /></IconButton>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="w-[46%] min-w-[220px] overflow-auto border-r border-line">
          {list.isLoading && <Loading label="Opening volume…" />}
          {list.error != null && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
          {path !== "/" && !list.isLoading && (
            <div onDoubleClick={() => setPath(path.split("/").slice(0, -1).join("/") || "/")} className="flex items-center gap-2 px-3 h-[26px] text-fg2 hover:bg-hover">
              <IconFolder size={13} /> ..
            </div>
          )}
          {list.data?.length === 0 && <div className="px-3 py-3 text-fg3 text-[12px]">Empty folder</div>}
          {list.data?.map((e) => (
            <div
              key={e.name}
              onClick={() => setPicked(e)}
              onDoubleClick={() => open(e)}
              className={cx("flex items-center gap-2 px-3 h-[26px] text-[12.5px]", picked?.name === e.name ? "bg-sel" : "hover:bg-hover")}
              title={`${e.mode} · ${dateTime(e.modified)}`}
            >
              <span className={e.kind === "dir" ? "text-accent" : "text-fg2"}>
                {e.kind === "dir" ? <IconFolder size={13} /> : e.kind === "link" ? <IconLink size={13} /> : <IconFile size={13} />}
              </span>
              <span className="flex-1 truncate">{e.name}</span>
              {e.kind !== "dir" && <span className="text-fg3 text-[11px] tabular-nums">{bytes(e.size)}</span>}
            </div>
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-auto">
          {!picked && <div className="h-full flex items-center justify-center text-fg3 text-[12px] px-6 text-center">Double-click a folder to open it. Select a file to preview it.</div>}
          {picked?.kind === "dir" && (
            <div className="p-4 text-[12.5px] text-fg2">
              <div className="font-medium text-fg mb-1">{picked.name}/</div>
              Folder · modified {dateTime(picked.modified)}
              <div className="mt-3 flex gap-2"><Button onClick={() => open(picked)}>Open</Button><Button onClick={() => exportSel(picked)}>Export as .tar</Button></div>
            </div>
          )}
          {picked?.kind === "link" && <div className="p-4 text-[12.5px] text-fg2">Symbolic link · {picked.mode}</div>}
          {picked?.kind === "file" && (
            <>
              <div className="px-3 h-[28px] flex items-center gap-2 border-b border-line text-[11.5px] text-fg2">
                <span className="font-medium text-fg truncate">{picked.name}</span>
                <span>{bytes(picked.size)}</span><span>{picked.mode}</span><span>{dateTime(picked.modified)}</span>
              </div>
              {file.isLoading && <Loading label="Reading…" />}
              {file.error != null && <ErrorBox error={file.error} />}
              {file.data?.binary && <div className="p-4 text-fg2 text-[12.5px]">Binary file ({bytes(file.data.size)}). Export it to open on your Mac.</div>}
              {file.data?.text != null && (
                <>
                  {file.data.truncated && <div className="px-3 py-1 text-[11px] text-warn">Showing the first 1 MB. Export the file to see all of it.</div>}
                  <pre className="mono text-[11.5px] leading-[1.5] p-3 m-0 whitespace-pre-wrap break-all selectable">{file.data.text}</pre>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
