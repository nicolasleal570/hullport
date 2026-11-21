#!/bin/bash
# Proof of concept for the Hullport engine: fetch the pinned pieces, install them under
# $HULLPORT_HOME (default ~/.hullport) and run the VM with Lima. It never touches ~/.docker,
# /var/run/docker.sock or anything belonging to OrbStack.
#
#   scripts/engine.sh fetch      download and verify everything in engine/versions.toml
#   scripts/engine.sh build      build Lima from the pinned source with engine/patches (needs Go)
#   scripts/engine.sh install    copy the verified pieces into $HULLPORT_HOME (VM must be stopped)
#   scripts/engine.sh start      create the data disk and the VM if needed, then boot it
#   scripts/engine.sh stop       shut the VM down cleanly
#   scripts/engine.sh status     show the VM and the Docker socket
#   scripts/engine.sh shell      open a shell inside the VM
#   eval "$(scripts/engine.sh env)"   point this terminal's docker at Hullport
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HULLPORT_HOME="${HULLPORT_HOME:-$HOME/.hullport}"
DOWNLOADS="$ROOT/target/engine/downloads"
SRC="$ROOT/target/engine/src"
INSTANCE=hullport
DATA_DISK=hullport-data
DATA_DISK_SIZE=60GiB

export LIMA_HOME="$HULLPORT_HOME/vm"
LIMACTL="$HULLPORT_HOME/lima/bin/limactl"

# Read engine/versions.toml into LIMA_URL, GUEST_IMAGE_SHA256, ... (SECTION_KEY, upper case).
eval "$(awk '
  /^\[/ { s = toupper(substr($0, 2, length($0) - 2)); next }
  /^[a-z0-9_]+ = "/ { k = toupper($1); v = $0; sub(/^[^"]*"/, "", v); sub(/"[^"]*$/, "", v); printf "%s_%s=\x27%s\x27\n", s, k, v }
' "$ROOT/engine/versions.toml")"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# download NAME URL SHA256: each piece gets its own folder; nothing is kept unless the checksum matches.
download() {
  local name="$1" url="$2" sum="$3" dir="$DOWNLOADS/$1" file
  file="$dir/$(basename "$url")"
  mkdir -p "$dir"
  if [ -f "$file" ] && echo "$sum  $file" | shasum -a 256 -c --status; then
    echo "  $name: cached"
    return
  fi
  echo "  $name: downloading $url"
  curl -fL --progress-bar -o "$file.part" "$url"
  if ! echo "$sum  $file.part" | shasum -a 256 -c --status; then
    rm -f "$file.part"
    echo "checksum mismatch for $name" >&2
    exit 1
  fi
  mv "$file.part" "$file"
}

cmd_fetch() {
  say "Fetching pinned pieces into $DOWNLOADS"
  download guest_image "$GUEST_IMAGE_URL" "$GUEST_IMAGE_SHA256"
  download docker_cli "$DOCKER_CLI_URL" "$DOCKER_CLI_SHA256"
  download compose "$COMPOSE_URL" "$COMPOSE_SHA256"
  download buildx "$BUILDX_URL" "$BUILDX_SHA256"
  download credential_osxkeychain "$CREDENTIAL_OSXKEYCHAIN_URL" "$CREDENTIAL_OSXKEYCHAIN_SHA256"
}

# checkout NAME GIT VERSION COMMIT: a fresh clone of the tag, refused unless it is the pinned commit.
checkout() {
  local name="$1" git="$2" version="$3" commit="$4" dir="$SRC/$1"
  rm -rf "$dir"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "v$version" "$git" "$dir"
  if [ "$(git -C "$dir" rev-parse HEAD)" != "$commit" ]; then
    echo "$name v$version is not at the pinned commit $commit" >&2
    exit 1
  fi
  for p in "$ROOT/engine/patches/$name"/*.patch; do
    [ -e "$p" ] || continue
    echo "  $name: applying $(basename "$p")"
    git -C "$dir" apply "$p"
  done
}

cmd_build() {
  command -v go >/dev/null || { echo "Go is needed to build Lima (brew install go)" >&2; exit 1; }
  say "Building Lima $LIMA_VERSION with engine/patches"
  checkout gvisor-tap-vsock "$GVISOR_TAP_VSOCK_GIT" "$GVISOR_TAP_VSOCK_VERSION" "$GVISOR_TAP_VSOCK_COMMIT"
  checkout lima "$LIMA_GIT" "$LIMA_VERSION" "$LIMA_COMMIT"
  (cd "$SRC/lima" && go mod edit -replace github.com/containers/gvisor-tap-vsock=../gvisor-tap-vsock && make native >"$SRC/lima-build.log" 2>&1) \
    || { echo "Lima build failed, see $SRC/lima-build.log" >&2; exit 1; }
  echo "  built $("$SRC/lima/_output/bin/limactl" --version)"
}

cmd_install() {
  cmd_fetch
  [ -x "$SRC/lima/_output/bin/limactl" ] || cmd_build
  if [ -x "$LIMACTL" ] && "$LIMACTL" list --format '{{.Status}}' "$INSTANCE" 2>/dev/null | grep -qx Running; then
    echo "stop the VM first (scripts/engine.sh stop): its host agent runs from $LIMACTL" >&2
    exit 1
  fi
  say "Installing into $HULLPORT_HOME"
  mkdir -p "$HULLPORT_HOME"/{bin,docker/cli-plugins,images,run,vm}
  # Lima finds its guest agent in ../share/lima next to bin/limactl, so the build layout is kept.
  rm -rf "$HULLPORT_HOME/lima"
  cp -R "$SRC/lima/_output" "$HULLPORT_HOME/lima"
  tar -xzf "$DOWNLOADS/docker_cli/$(basename "$DOCKER_CLI_URL")" -C "$HULLPORT_HOME/bin" --strip-components 1 docker/docker
  install -m 0755 "$DOWNLOADS/compose/$(basename "$COMPOSE_URL")" "$HULLPORT_HOME/docker/cli-plugins/docker-compose"
  install -m 0755 "$DOWNLOADS/buildx/$(basename "$BUILDX_URL")" "$HULLPORT_HOME/docker/cli-plugins/docker-buildx"
  install -m 0755 "$DOWNLOADS/credential_osxkeychain/$(basename "$CREDENTIAL_OSXKEYCHAIN_URL")" "$HULLPORT_HOME/bin/docker-credential-osxkeychain"
  cp -c "$DOWNLOADS/guest_image/$(basename "$GUEST_IMAGE_URL")" "$HULLPORT_HOME/images/" 2>/dev/null \
    || cp "$DOWNLOADS/guest_image/$(basename "$GUEST_IMAGE_URL")" "$HULLPORT_HOME/images/"
  # The CLI's own config folder, separate from ~/.docker until the cutover. No credsStore yet.
  [ -f "$HULLPORT_HOME/docker/config.json" ] || echo '{}' >"$HULLPORT_HOME/docker/config.json"

  sed -e "s|@GUEST_IMAGE_PATH@|$HULLPORT_HOME/images/$(basename "$GUEST_IMAGE_URL")|" \
      -e "s|@GUEST_IMAGE_SHA256@|$GUEST_IMAGE_SHA256|" \
      -e "s|@GUEST_DOCKER_VERSION@|$GUEST_DOCKER_VERSION|" \
      -e "s|@GUEST_CONTAINERD_VERSION@|$GUEST_DOCKER_CONTAINERD|" \
      -e "s|@HULLPORT_HOME@|$HULLPORT_HOME|" \
      "$ROOT/engine/hullport.yaml" >"$HULLPORT_HOME/hullport.yaml"

  # vz refuses to start unless limactl's signature carries this entitlement.
  if codesign -d --entitlements - "$LIMACTL" 2>/dev/null | grep -q com.apple.security.virtualization; then
    echo "  limactl carries com.apple.security.virtualization"
  else
    echo "limactl is missing the com.apple.security.virtualization entitlement" >&2
    exit 1
  fi
  "$LIMACTL" --version
  "$HULLPORT_HOME/bin/docker" --version
}

cmd_start() {
  if [ ! -d "$LIMA_HOME/_disks/$DATA_DISK" ]; then
    say "Creating the $DATA_DISK disk ($DATA_DISK_SIZE, sparse)"
    "$LIMACTL" --tty=false disk create "$DATA_DISK" --size "$DATA_DISK_SIZE" --format raw
  fi
  if "$LIMACTL" list --format '{{.Name}}' 2>/dev/null | grep -qx "$INSTANCE"; then
    say "Starting $INSTANCE"
    "$LIMACTL" --tty=false start "$INSTANCE"
  else
    say "Creating and starting $INSTANCE (first boot installs Docker, needs internet)"
    "$LIMACTL" --tty=false start --name "$INSTANCE" "$HULLPORT_HOME/hullport.yaml"
  fi
}

cmd_stop() { "$LIMACTL" --tty=false stop "$INSTANCE"; }

cmd_status() {
  "$LIMACTL" list
  "$LIMACTL" disk list
  ls -l "$HULLPORT_HOME/run/docker.sock" 2>/dev/null || echo "no socket at $HULLPORT_HOME/run/docker.sock"
}

cmd_shell() { "$LIMACTL" shell "$INSTANCE"; }

cmd_env() {
  echo "export DOCKER_HOST='unix://$HULLPORT_HOME/run/docker.sock'"
  echo "export DOCKER_CONFIG='$HULLPORT_HOME/docker'"
  echo "export PATH='$HULLPORT_HOME/bin':\"\$PATH\""
}

case "${1:-}" in
  fetch|build|install|start|stop|status|shell|env) "cmd_$1" ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
