#!/bin/bash
set -euo pipefail

if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted ||
      ${RUNNER_OS:-} != macOS || ${RUNNER_ARCH:-} != ARM64 || -z ${RUNNER_TEMP:-} ]]; then
  echo "This step runs only on a disposable GitHub-hosted Apple silicon Mac." >&2
  exit 1
fi

saved="$RUNNER_TEMP/first-run-developer-tools"
clt=/Library/Developer/CommandLineTools
unset DEVELOPER_DIR SDKROOT

restore() {
  [[ -d "$saved" ]] || return 0
  for bundle in "$saved"/Xcode*.app.hidden; do
    [[ -e "$bundle" || -L "$bundle" ]] || continue
    name=${bundle##*/}
    sudo -n /bin/mv "$bundle" "/Applications/${name%.hidden}"
  done
  if [[ -e "$saved/CommandLineTools" || -L "$saved/CommandLineTools" ]]; then
    sudo -n /bin/mv "$saved/CommandLineTools" "$clt"
  fi
  if [[ -s "$saved/selected" ]]; then
    sudo -n /usr/bin/xcode-select --switch "$(cat "$saved/selected")"
  fi
}

if [[ ${1:-hide} == restore ]]; then
  restore
  exit
fi

selected=$(/usr/bin/xcode-select --print-path 2>/dev/null || true)
case "$selected" in
  /Applications/Xcode*.app/Contents/Developer | "$clt" | "") ;;
  *) echo "Unexpected active developer directory: $selected" >&2; exit 1 ;;
esac

mkdir "$saved"
printf '%s' "$selected" > "$saved/selected"
if [[ -e "$clt" || -L "$clt" ]]; then
  sudo -n /bin/mv "$clt" "$saved/"
fi
for bundle in /Applications/Xcode*.app; do
  [[ -e "$bundle" || -L "$bundle" ]] || continue
  sudo -n /bin/mv "$bundle" "$saved/${bundle##*/}.hidden"
done

sudo -n /usr/bin/xcode-select --reset
if selected=$(/usr/bin/xcode-select --print-path 2>/dev/null); then
  echo "macOS still sees a developer directory: $selected" >&2
  exit 1
fi

# These are the tools the driver will use after the move. Leave Apple's git stub untouched.
node --version
test "$(/usr/bin/osascript -e 'return "ready"')" = ready
/usr/sbin/screencapture -x "$saved/display.png"
test -s "$saved/display.png"
