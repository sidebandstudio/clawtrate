prepare_tmpdir() {
  local base tmp fallback=0
  base="$(resolve_installer_path "${TMPDIR:-/tmp}")"
  if ! tmp="$(mktemp -d "${base%/}/openclaw-install.XXXXXX" 2>/dev/null)"; then
    if ! tmp="$(mktemp -d /tmp/openclaw-install.XXXXXX 2>/dev/null)"; then
      fail "Cannot create a temporary directory. Check permissions for TMPDIR and /tmp, then retry setup."
    fi
    fallback=1
  fi
  TMPFILES+=("$tmp")
  export TMPDIR="$tmp"
  if [[ "$fallback" -eq 1 ]]; then
    emit_json step name temporary-directory status warn reason using-fallback
    log "Using a private directory under /tmp because TMPDIR is unavailable."
  fi
}
