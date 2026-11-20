#!/bin/sh
# Installs the latest Clawtrate beta for macOS.
#
#   curl -fsSL https://clawtrate.dev/install.sh | sh
#
# It downloads the build the beta feed names for this Mac's processor, checks
# its SHA-256, the app's signature, the Developer ID team that signed it and
# Apple's notarization, and only then copies Clawtrate.app into /Applications. It asks before it replaces a copy that is already there.
# It never uses sudo and changes no system setting. Any failed check stops it
# before anything is installed.
#
# Two variables point it elsewhere, for testing: CLAWTRATE_FEED (the feed's
# address, which may then also be http:// or file://) and
# CLAWTRATE_APPLICATIONS (the folder to install into).

set -eu

FEED_DEFAULT="https://clawtrate.dev/updates/beta/latest-mac.json"
FEED="${CLAWTRATE_FEED:-$FEED_DEFAULT}"
DEST="${CLAWTRATE_APPLICATIONS:-/Applications}"
APP="Clawtrate.app"

say() { printf '%s\n' "$*"; }
stop() {
  printf 'Stopped: %s\n' "$*" >&2
  say "Nothing was installed." >&2
  exit 1
}

# The default feed and its files are fetched over HTTPS only. A test feed
# given through CLAWTRATE_FEED may also be local.
if [ "$FEED" = "$FEED_DEFAULT" ]; then
  PROTO="=https"
else
  PROTO="=https,http,file"
fi
fetch() { curl --proto "$PROTO" --proto-redir "$PROTO" -fsSL --retry 2 "$@"; }

[ "$(uname -s)" = "Darwin" ] || stop "this script installs the macOS app. On Windows, download Clawtrate from https://clawtrate.dev."
[ "$(id -u)" != "0" ] || stop "run this as yourself, not with sudo or as root."
for tool in curl shasum ditto codesign spctl plutil; do
  command -v "$tool" >/dev/null 2>&1 || stop "$tool is missing from this Mac."
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/clawtrate-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# 1. The feed: the signing team, and one build per processor, keyed by what
#    `uname -m` prints:
#    {"teamIdentifier": "<10 characters>",
#     "arm64":  {"version": "...", "url": "https://....zip", "sha256": "<64 hex>"},
#     "x86_64": {"version": "...", "url": "https://....zip", "sha256": "<64 hex>"}}
say "Reading the beta feed: $FEED"
status="$(curl --proto "$PROTO" --proto-redir "$PROTO" -sSL -o "$WORK/latest-mac.json" -w '%{http_code}' "$FEED" 2>/dev/null)" || status="failed"
case "$status" in
  200 | 000) [ -s "$WORK/latest-mac.json" ] || stop "the beta feed is empty." ;;
  404) stop "no macOS beta has been published yet. Watch https://github.com/sidebandstudio/clawtrate/releases for the first one." ;;
  failed) stop "could not read the beta feed. Check your connection and try again." ;;
  *) stop "the beta feed answered with HTTP $status." ;;
esac

field() { plutil -extract "$1" raw -expect string -o - "$WORK/latest-mac.json" 2>/dev/null; }
ARCH="$(uname -m)"
case "$ARCH" in
  arm64 | x86_64) ;;
  *) stop "this Mac's processor ($ARCH) is not one Clawtrate is built for." ;;
esac
plutil -extract "$ARCH" raw -o - "$WORK/latest-mac.json" >/dev/null 2>&1 ||
  stop "the beta feed has no build for this Mac's processor ($ARCH)."
TEAM="$(field teamIdentifier)" || stop "the beta feed does not name the signing team."
printf '%s' "$TEAM" | grep -Eq '^[A-Z0-9]{10}$' || stop "the beta feed's signing team is not a Developer ID team identifier."
VERSION="$(field "$ARCH.version")" || stop "the beta feed's $ARCH build has no version."
URL="$(field "$ARCH.url")" || stop "the beta feed's $ARCH build has no file address."
SHA256="$(field "$ARCH.sha256")" || stop "the beta feed's $ARCH build has no SHA-256."
SHA256="$(printf '%s' "$SHA256" | tr 'A-F' 'a-f')"
printf '%s' "$SHA256" | grep -Eq '^[0-9a-f]{64}$' || stop "the beta feed's SHA-256 is not 64 hexadecimal characters."
case "$URL" in
  *.zip) ;;
  *) stop "the beta feed names a file that is not a .zip." ;;
esac
say "Latest beta: Clawtrate $VERSION for $ARCH"

# 2. The download, and its SHA-256.
say "Downloading $URL"
fetch -o "$WORK/Clawtrate.zip" "$URL" || stop "the download did not finish."
ACTUAL="$(shasum -a 256 "$WORK/Clawtrate.zip" | cut -d ' ' -f 1)"
[ "$ACTUAL" = "$SHA256" ] || stop "the download's SHA-256 is $ACTUAL, but the feed says $SHA256."
say "SHA-256 matches the feed."

# 3. Unpack it, keeping the app's signature intact.
mkdir "$WORK/unpacked"
ditto -x -k "$WORK/Clawtrate.zip" "$WORK/unpacked" || stop "the download is not a readable zip."
NEW="$WORK/unpacked/$APP"
[ -d "$NEW" ] || stop "the download does not contain $APP."

# 4. The signature and Apple's notarization.
codesign --verify --deep --strict "$NEW" 2>"$WORK/codesign.txt" ||
  stop "the app's signature is not valid: $(cat "$WORK/codesign.txt")"
say "Signature is valid."
SIGNER="$(codesign -dv "$NEW" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
[ "$SIGNER" = "$TEAM" ] ||
  stop "the app is signed by team ${SIGNER:-unknown}, not by Clawtrate's team $TEAM."
say "Signed by Clawtrate's Developer ID team ($TEAM)."
spctl --assess --type execute "$NEW" 2>"$WORK/spctl.txt" ||
  stop "macOS does not accept the app as notarized: $(cat "$WORK/spctl.txt")"
say "Notarization is accepted by macOS."

# 5. Install, asking before an existing copy is replaced.
[ -d "$DEST" ] || stop "$DEST does not exist."
[ -w "$DEST" ] || stop "you cannot write to $DEST without an administrator. Download Clawtrate from https://clawtrate.dev/download/mac instead."
TARGET="$DEST/$APP"
if [ -e "$TARGET" ]; then
  say "Clawtrate is already in $DEST."
  answer=""
  if (exec </dev/tty) 2>/dev/null; then
    printf 'Replace it with Clawtrate %s? Quit Clawtrate first. [y/N] ' "$VERSION"
    read -r answer </dev/tty || answer=""
  fi
  case "$answer" in
    y | Y | yes | YES) ;;
    *) stop "the copy in $DEST was left as it was." ;;
  esac
fi

STAGED="$DEST/.$APP.installing.$$"
rm -rf "$STAGED"
ditto "$NEW" "$STAGED" || {
  rm -rf "$STAGED"
  stop "could not copy the app into $DEST."
}
if [ -e "$TARGET" ]; then
  OLD="$DEST/.$APP.previous.$$"
  mv "$TARGET" "$OLD" || {
    rm -rf "$STAGED"
    stop "could not move the existing copy aside. Is Clawtrate still open?"
  }
  mv "$STAGED" "$TARGET" || {
    mv "$OLD" "$TARGET"
    rm -rf "$STAGED"
    stop "could not put the new copy in place; the existing one was restored."
  }
  rm -rf "$OLD"
  say "Replaced the previous copy of Clawtrate."
else
  mv "$STAGED" "$TARGET" || {
    rm -rf "$STAGED"
    stop "could not put the app in place."
  }
fi

say "Installed Clawtrate $VERSION in $TARGET"
say "Open it from Applications. It checks for updates on the Beta track."
