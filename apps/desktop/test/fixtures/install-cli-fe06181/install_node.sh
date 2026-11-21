install_node() {
  # Packaging provisions each requested architecture in a fresh private prefix.
  # It must execute that Node (Rosetta for x64 on ARM), never link the host runtime.
  local os="$1"
  local arch="$2"
  local url
  local tmp
  local dir
  local base_url
  local tarball
  local expected_sha
  local actual_sha

  select_node_version_for_platform "$os" "$arch"
  if ! node_version_is_supported "$NODE_VERSION"; then
    fail "Node ${NODE_VERSION} is unsupported; use ${SUPPORTED_NODE_VERSION_LABEL}."
  fi
  dir="$(node_dir)"

  if [[ "$os" == "freebsd" ]]; then
    if [[ "$NODE_ONLY" -eq 1 ]]; then
      fail "Private Node.js recovery is unavailable on FreeBSD. Update Node.js and npm with pkg, then retry."
    fi
    local system_node system_npm installed_version
    system_node="$(command_path_without_node_prefix node || true)"
    system_npm="$(command_path_without_node_prefix npm || true)"
    emit_json step name node status start method system
    # FreeBSD has no official Node binary archive. Validate the package-owned
    # runtime before publishing links so a failed prerequisite leaves the CLI intact.
    if ! linked_node_is_usable "$system_node" "$system_npm"; then
      fail "FreeBSD requires ${SUPPORTED_NODE_VERSION_LABEL}, working npm, and WAL-reset-safe SQLite. Ask the system administrator to install or update node24 and npm-node24 with pkg, then retry with node and npm on PATH."
    fi
    system_node="$("$system_node" -p 'process.execPath')"
    system_npm="$("$system_node" -p 'require("node:fs").realpathSync(process.argv[1])' "$system_npm")"
    link_node_runtime_paths "$system_node" "$system_npm"
    installed_version="$("$(node_bin)" -v)"
    emit_json step name node status ok method system version "$installed_version"
    return
  fi

  if [[ "$os" == "linux" ]] && command -v apk >/dev/null 2>&1 && is_musl_linux; then
    install_alpine_node
    return
  fi

  if linked_node_is_usable; then
    ln -sfn "$dir" "${PREFIX}/tools/node"
    emit_json step name node status skip path "$dir"
    return
  fi

  emit_json step name node status start version "$NODE_VERSION"
  log "Installing Node ${NODE_VERSION} (user-space)..."

  mkdir -p "${PREFIX}/tools"
  # Darwin's default mktemp location can ignore TMPDIR; use the prepared path explicitly.
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-node.XXXXXX")"
  TMPFILES+=("$tmp")
  base_url="https://nodejs.org/dist/v${NODE_VERSION}"
  tarball="node-v${NODE_VERSION}-${os}-${arch}.tar.gz"
  url="${base_url}/${tarball}"

  detect_downloader
  require_bin tar

  download_file "${base_url}/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  expected_sha="$(grep "  ${tarball}$" "$tmp/SHASUMS256.txt" | awk '{print $1}' | head -n 1 || true)"
  if [[ -z "${expected_sha}" ]]; then
    fail "Failed to resolve Node shasum for ${tarball}"
  fi

  download_file "$url" "$tmp/node.tgz"
  actual_sha="$(sha256_file "$tmp/node.tgz")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    fail "Node tarball sha256 mismatch for ${tarball} (expected ${expected_sha}, got ${actual_sha})"
  fi

  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$tmp/node.tgz" -C "$dir" --strip-components=1
  rm -rf "$tmp"

  if ! linked_node_is_usable; then
    local installed_version
    local required_version
    local sqlite_version
    installed_version="$("$(node_bin)" -v 2>/dev/null || echo unknown)"
    required_version="$(required_node_version)"
    sqlite_version="$(node_binary_sqlite_version "$(node_bin)")"
    fail "Installed Node ${NODE_VERSION} must provide Node >= ${required_version} with WAL-reset-safe SQLite; found Node ${installed_version}, SQLite ${sqlite_version}. Re-run with --node-version 24.22.1 (or newer)"
  fi
  # Existing CLI wrappers use this alias; activate only a runtime that can start.
  ln -sfn "$dir" "${PREFIX}/tools/node"
  emit_json step name node status ok version "$NODE_VERSION"
}
