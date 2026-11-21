# Hullport

> **For private use.** Berth is your own Docker management app for macOS, built for use on your own computer.


A lightweight macOS Docker manager for **Containers, Images, Volumes, Builds and Networks**.
Hullport connects to an existing Docker Engine (OrbStack, Docker Desktop,
Colima, Rancher Desktop…) and never runs its own container runtime.

## Open it

- **Easiest:** double-click **`Open Hullport.command`** in this folder (it builds the app the first time if needed).
- Or open **`target/release/bundle/macos/Hullport.app`** in Finder. Drag it into your Applications folder to keep it.
- First launch: macOS may say the app is from an unidentified developer (it isn't signed). Right-click the app → **Open** → **Open**.
- OrbStack (or another Docker engine) must be running; Hullport connects to it automatically.

## Replacing OrbStack

Hullport is the app; an **engine** runs the containers. Open **Engines** in the sidebar to install and start
**Colima** (free, open source) with Homebrew; Hullport switches to it automatically. Data stored in OrbStack isn't
moved. See `HANDOFF.md` for the full steps and caveats.

## Use it

- **⌘1–⌘5** switch sections · **⌘F** search · **⌘N** new container / pull / volume / build / network · **⌘R** refresh
- **↑/↓** move through a list · **Return** opens logs (containers), Run (images), files (volumes) · **⌘⌫** delete (always asks)
- Right-click any row for its full menu. The sidebar shows the engine status; click the context name to switch Docker contexts.

## Build it

Requirements: macOS 11+, Rust (stable), Node 20+, and a running Docker engine. Builds and BuildKit history
also need the `docker` CLI with buildx.

```sh
npm install
npm run build          # type-check + bundle the interface into dist/
cargo build            # debug app at target/debug/hullport
npm run tauri build    # signed-less Hullport.app in target/release/bundle/macos/
```

`cargo build` alone works once `dist/` exists (the interface is embedded at compile time).

### Check modes

```sh
target/debug/hullport --screenshot shots/now.png [--section images]   # draws ~120 frames, saves a PNG, exits
target/debug/hullport --self-test shots/self-test.json                # walks the sections, creates+deletes a throwaway volume
target/debug/hullport --verify shots/verify.json --fixtures "$PWD/tests/fixtures" [--external <volume-name>]
```

`--verify` runs end-to-end checks against the real engine (container lifecycle, logs, exec + PTY, stats, pull/tag,
volume browse/export, BuildKit build + cancel, network connect/disconnect). It only creates resources named
`hullport-verify-*` and removes them afterwards. With `--external NAME` it creates a marker volume `NAME-ready`
and waits for a volume `NAME` to be created and removed with the docker CLI, to prove external changes show up.

## Architecture

```
src/                     Rust backend (Tauri 2)
  docker/context.rs      Docker context + endpoint discovery (mirrors the CLI's rules)
  docker/mod.rs          DockerManager: connection, version negotiation, reconnect, engine events → UI
  docker/cli.rs          locating and invoking the docker CLI (buildx, credentialed pulls)
  cmd/*.rs               typed commands per area (containers, exec, images, volumes, networks, builds, system)
  store.rs               JSON persistence: preferences, saved build configs, build records
ui/src/                  React + TypeScript + Tailwind interface
  lib/api.ts             typed wrappers for every backend command (streams use Tauri channels)
  lib/queries.ts         TanStack Query + engine-event invalidation (no polling)
  features/<area>/       one folder per section: list, inspector, dialogs
  components/            table, menus, dialogs, layout, icons
```

- All Docker access happens in Rust through **bollard** (Docker Engine API) over the context's socket; the UI never sees credentials.
- Streaming (logs, stats, pulls, terminal, builds) uses Tauri channels; every stream has a cancel handle.
- Builds run `docker buildx build --progress=rawjson` so the UI can show BuildKit's real step graph; cancel sends SIGINT.
- Volume files are read through a short-lived `alpine` helper container that mounts the volume **read-only**,
  labelled `dev.hullport.helper` and removed when the browser closes (and on next launch if left behind).

