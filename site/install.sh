#!/bin/sh
# Installs the latest Clawtrate beta for macOS. Download it whole, then run it:
#
#   sh -c 'f=$(mktemp) && trap "rm -f \"$f\"" EXIT && c=$(curl -q -sS --proto =https --max-redirs 0 -o "$f" -w "%{http_code}" https://clawtrate.dev/install.sh) && [ "$c" = 200 ] && sh "$f"'
#
# It reads the Beta feed, takes the build for this Mac's processor, and checks
# the download's SHA-256, the archive's layout, the app's bundle id, version and
# processor, its Developer ID signature and team, and Apple's notarization.
# Only then does it copy Clawtrate.app into /Applications, asking before it
# replaces a copy that is there. It never uses sudo and changes no system
# setting. Nothing runs until the whole file has arrived: the last line calls
# main.
#
# For tests only, these point it at stand-ins on this Mac's loopback address:
# CLAWTRATE_FEED (the feed), CLAWTRATE_RELEASES (the release download prefix)
# and CLAWTRATE_ASSETS (the origin a release download redirects to), each
# http://127.0.0.1:<port>/...; and CLAWTRATE_APPLICATIONS, the folder to
# install into.

# An incomplete download that ends before main is called runs nothing and fails.
trap 'exit 1' EXIT

# The Developer ID team that signs Clawtrate's releases. Set when the first
# signed beta is cut; until then the installer refuses to run.
CLAWTRATE_TEAM_ID="APPLE_CLAWTRATE_TEAM_ID"

BUNDLE_ID="dev.clawtrate.desktop"
APP="Clawtrate.app"
FEED_URL="https://clawtrate.dev/updates/beta/latest-mac.json"
RELEASES_URL="https://github.com/sidebandstudio/clawtrate/releases/download/"
ASSETS_ORIGIN="https://release-assets.githubusercontent.com"
RELEASES_PAGE="https://github.com/sidebandstudio/clawtrate/releases"

say() { printf '%s\n' "$*"; }

# A refusal. What it means for an existing copy is said on the way out.
stop() {
  printf 'Stopped: %s\n' "$*" >&2
  exit 1
}

# The exit path for every outcome, also after INT, TERM or HUP: put a previous
# copy back when the replacement did not finish, and say where things are.
# shellcheck disable=SC2329 # called by the EXIT trap
finish() {
  status=$?
  trap '' INT TERM HUP
  case "$PHASE" in
    installed) ;;
    placed | aside)
      if [ -n "$MOVED" ]; then
        # The new copy was put in place but not confirmed: take it out again.
        mv "$TARGET" "$STAGE/rejected.app" 2>/dev/null || :
      fi
      if [ -n "$OLD" ] && [ -d "$OLD" ]; then
        if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] && mv "$OLD" "$TARGET" 2>/dev/null; then
          say "Your previous copy of Clawtrate was put back." >&2
        else
          KEEP_STAGE=1
          say "Clawtrate could not be restored. Your previous copy is at $OLD." >&2
        fi
      else
        say "Nothing was installed." >&2
      fi
      ;;
    *) [ "$status" -eq 0 ] || say "Nothing was installed." >&2 ;;
  esac
  if [ -n "$STAGE" ] && [ -z "$KEEP_STAGE" ]; then rm -rf "$STAGE"; fi
  if [ -n "$LOCKED" ]; then rmdir "$LOCK" 2>/dev/null || :; fi
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  exit "$status"
}

# Only loopback http for the test variables; the default addresses are fixed.
loopback() {
  case "$1" in
    http://127.0.0.1:[0-9]*/*) ;;
    *) stop "$2 must be an http://127.0.0.1:<port>/ address." ;;
  esac
}

# Reads latest-mac.json strictly: JSON with no repeated key and exactly this
# shape, both builds of one beta version, each at its release's own address.
# Prints the version, the address and the SHA-256 of the build for $1.
read_feed() {
  cat >"$WORK/feed.js" <<'JS'
ObjC.import("Foundation");
function run(argv) {
  const [path, arch, prefix, team] = argv;
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (text.isNil()) throw new Error("not UTF-8 text");
  const s = text.js;
  let i = 0;
  const ws = () => { while (i < s.length && " \t\n\r".includes(s[i])) i++; };
  const fail = (why) => { throw new Error(why + " at " + i); };
  function value() {
    ws();
    const c = s[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]])
      if (s.startsWith(word, i)) { i += word.length; return v; }
    fail("unexpected character");
  }
  function object() {
    i++; ws();
    const out = {}; const seen = new Set();
    if (s[i] === "}") { i++; return out; }
    for (;;) {
      ws(); if (s[i] !== '"') fail("expected a key");
      const key = string();
      if (seen.has(key)) fail("repeated key " + key);
      seen.add(key);
      ws(); if (s[i] !== ":") fail("expected a colon"); i++;
      out[key] = value(); ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "}") { i++; return out; }
      fail("expected a comma or a closing brace");
    }
  }
  function array() {
    i++; ws();
    const out = [];
    if (s[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value()); ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "]") { i++; return out; }
      fail("expected a comma or a closing bracket");
    }
  }
  function string() {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(s.slice(i));
    if (!m) fail("bad string");
    i += m[0].length;
    return JSON.parse(m[0]);
  }
  function number() {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) fail("bad number");
    i += m[0].length;
    return Number(m[0]);
  }
  const feed = value(); ws();
  if (i !== s.length) fail("content after the document");
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (v) => Object.keys(v).sort().join(",");
  if (!isObject(feed) || keys(feed) !== "arm64,teamIdentifier,x86_64") throw new Error("wrong fields");
  if (feed.teamIdentifier !== team) throw new Error("the feed names another signing team");
  const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})-beta\.[1-9]\d{7}\.(0|[1-9]\d{0,11})$/;
  const files = { arm64: "mac-arm64", x86_64: "mac-x64" };
  let version = null;
  for (const key of ["arm64", "x86_64"]) {
    const e = feed[key];
    if (!isObject(e) || keys(e) !== "sha256,url,version") throw new Error(key + ": wrong fields");
    if (typeof e.version !== "string" || e.version.length > 50 || !VERSION.test(e.version))
      throw new Error(key + ": not a beta version");
    if (version !== null && e.version !== version) throw new Error("the two builds name different versions");
    version = e.version;
    if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(key + ": bad SHA-256");
    const expected = prefix + "v" + e.version + "/Clawtrate-" + e.version + "-" + files[key] + ".zip";
    if (e.url !== expected) throw new Error(key + ": not this release's download address");
  }
  const e = feed[arch];
  return [e.version, e.url, e.sha256].join("\n");
}
JS
  osascript -l JavaScript "$WORK/feed.js" "$WORK/latest-mac.json" "$1" "$RELEASES" "$CLAWTRATE_TEAM_ID" 2>"$WORK/feed-error.txt"
}

# Fetches the build: the release download address, and at most one redirect
# to the release-asset origin, checked before it is followed.
fetch_zip() {
  first="$(curl -q -sS --proto "$PROTO" --max-redirs 0 --max-filesize 2000000000 \
    -o "$WORK/Clawtrate.zip" -w '%{http_code} %{redirect_url}' --url "$1")" ||
    stop "the download did not finish."
  code="${first%% *}"
  next="${first#* }"
  case "$code" in
    200) return 0 ;;
    301 | 302 | 303 | 307 | 308) ;;
    *) stop "the download answered HTTP $code." ;;
  esac
  case "$next" in
    "$ASSETS"/*) ;;
    *) stop "the download redirected somewhere other than GitHub's release-asset host." ;;
  esac
  case "$next" in
    *'#'* | *' '*) stop "the download's redirect is not a plain address." ;;
  esac
  code="$(curl -q -sS --proto "$PROTO" --max-redirs 0 --max-filesize 2000000000 \
    -o "$WORK/Clawtrate.zip" -w '%{http_code}' --url "$next")" ||
    stop "the download did not finish."
  [ "$code" = 200 ] || stop "the download answered HTTP $code."
}

# The archive holds Clawtrate.app and nothing else: no other root, no path
# that climbs out, no repeated entry, links only where an Electron framework
# has them, and optionally the AppleDouble metadata ditto writes.
check_zip() {
  zip="$WORK/Clawtrate.zip"
  zipinfo -1 "$zip" >"$WORK/names.txt" 2>/dev/null || stop "the download is not a readable zip."
  listed="$(zipinfo -t "$zip" 2>/dev/null | sed -n 's/^\([0-9][0-9]*\) files*,.*/\1/p')"
  lines="$(wc -l <"$WORK/names.txt" | tr -d ' ')"
  [ -n "$listed" ] && [ "$listed" = "$lines" ] || stop "the archive's entry names cannot be read one per line."
  while IFS= read -r name; do
    path="${name%/}"
    case "$path" in
      "$APP" | "$APP"/*) ;;
      __MACOSX | "__MACOSX/$APP") [ "$name" != "$path" ] || stop "the archive has an unexpected entry: $name" ;;
      "__MACOSX/$APP"/*)
        # ditto's AppleDouble metadata: folders, and files named ._<name>.
        [ "$name" != "$path" ] || case "${path##*/}" in
          ._*) ;;
          *) stop "the archive has an unexpected entry: $name" ;;
        esac
        ;;
      *) stop "the archive holds something besides $APP: $name" ;;
    esac
    case "/$path/" in
      */../* | */./* | *//* | *\\*) stop "the archive has an unsafe path: $name" ;;
    esac
  done <"$WORK/names.txt"
  [ -z "$(sed 's#/$##' "$WORK/names.txt" | sort | uniq -d)" ] || stop "the archive repeats an entry."
  awk -v p="$APP/Contents/" 'index($0, p) == 1 { found = 1 } END { exit !found }' "$WORK/names.txt" ||
    stop "the archive does not contain $APP."
  zipinfo "$zip" 2>/dev/null | awk '$1 ~ /^l/ { sub(/^([^ ]+ +){8}/, ""); print }' >"$WORK/links.txt"
  while IFS= read -r link; do
    case "$link" in
      "$APP"/Contents/Frameworks/*.framework/Versions/Current) ;;
      "$APP"/Contents/Frameworks/*.framework/*/*) stop "the archive has a link where none belongs: $link" ;;
      "$APP"/Contents/Frameworks/*.framework/*) ;;
      *) stop "the archive has a link where none belongs: $link" ;;
    esac
  done <"$WORK/links.txt"
}

# The unpacked tree, read without following links: one real Clawtrate.app,
# only files, folders and the framework links, each pointing where it should.
check_tree() {
  [ "$(ls -A "$WORK/unpacked")" = "$APP" ] || stop "the archive unpacked to more than $APP."
  [ -d "$NEW" ] && [ ! -L "$NEW" ] || stop "$APP in the archive is not a folder."
  [ -z "$(find -P "$NEW" ! -type f ! -type d ! -type l | head -n 1)" ] ||
    stop "the app holds something that is not a file, a folder or a link."
  find -P "$NEW" -type l >"$WORK/tree-links.txt"
  while IFS= read -r link; do
    target="$(readlink "$link")"
    case "$link" in
      "$NEW"/Contents/Frameworks/*.framework/Versions/Current) [ "$target" = A ] ;;
      "$NEW"/Contents/Frameworks/*.framework/*/*) false ;;
      "$NEW"/Contents/Frameworks/*.framework/*) [ "$target" = "Versions/Current/${link##*/}" ] ;;
      *) false ;;
    esac || stop "the app has a link that points outside its framework: ${link#"$WORK"/unpacked/}"
  done <"$WORK/tree-links.txt"
}

# The bundle itself, read from the app rather than the feed.
check_bundle() {
  info="$1/Contents/Info.plist"
  [ -f "$info" ] && [ ! -L "$info" ] || stop "the app has no Info.plist."
  id="$(plutil -extract CFBundleIdentifier raw -expect string -o - "$info" 2>/dev/null)" || id=""
  [ "$id" = "$BUNDLE_ID" ] || stop "the app's bundle id is ${id:-missing}, not $BUNDLE_ID."
  APP_VERSION="$(plutil -extract CFBundleShortVersionString raw -expect string -o - "$info" 2>/dev/null)" || APP_VERSION=""
  [ "$APP_VERSION" = "$VERSION" ] || stop "the app is version ${APP_VERSION:-unknown}, but the feed names $VERSION."
  exe="$1/Contents/MacOS/Clawtrate"
  [ -f "$exe" ] && [ ! -L "$exe" ] || stop "the app has no Clawtrate executable."
  kind="$(file -b "$exe")"
  [ "$kind" = "Mach-O 64-bit executable $ARCH" ] || stop "the app is built for another processor ($kind), not $ARCH."
}

# Signature and notarization, as the release script checks them.
check_signature() {
  codesign --verify --deep --strict "$1" 2>"$WORK/codesign.txt" ||
    stop "the app's signature is not valid: $(cat "$WORK/codesign.txt")"
  codesign --display --verbose=2 "$1" >"$WORK/display.txt" 2>&1 ||
    stop "the app's signature cannot be read: $(cat "$WORK/display.txt")"
  signed_id="$(sed -n 's/^Identifier=//p' "$WORK/display.txt" | head -n 1)"
  authority="$(sed -n 's/^Authority=//p' "$WORK/display.txt" | head -n 1)"
  signer="$(sed -n 's/^TeamIdentifier=//p' "$WORK/display.txt" | head -n 1)"
  [ "$signed_id" = "$BUNDLE_ID" ] || stop "the app is signed as ${signed_id:-unknown}, not $BUNDLE_ID."
  case "$authority" in
    "Developer ID Application: "*) ;;
    *) stop "the app is not signed with a Developer ID Application certificate." ;;
  esac
  [ "$signer" = "$CLAWTRATE_TEAM_ID" ] ||
    stop "the app is signed by team ${signer:-unknown}, not by Clawtrate's team $CLAWTRATE_TEAM_ID."
  spctl --assess --type execute --verbose=2 "$1" >"$WORK/spctl.txt" 2>&1 ||
    stop "macOS does not accept the app: $(cat "$WORK/spctl.txt")"
  grep -qx 'source=Notarized Developer ID' "$WORK/spctl.txt" ||
    stop "macOS does not report the app as a notarized Developer ID app."
}

main() {
  trap - EXIT
  set -eu
  PHASE="" WORK="" STAGE="" OLD="" LOCKED="" KEEP_STAGE="" TARGET="" LOCK="" MOVED=""
  trap finish EXIT
  trap 'exit 1' INT TERM HUP

  [ "$(uname -s)" = "Darwin" ] || stop "this installer is for macOS."
  [ "$(id -u)" != "0" ] || stop "run this as yourself, not with sudo or as root."
  for tool in uname id sysctl curl shasum osascript zipinfo ditto find readlink file plutil \
    codesign spctl mktemp mkdir rmdir rm mv ls sed awk grep sort uniq wc cat tr head; do
    command -v "$tool" >/dev/null 2>&1 || stop "$tool is missing from this Mac."
  done
  printf '%s' "$CLAWTRATE_TEAM_ID" | grep -Eqx '[A-Z0-9]{10}' ||
    stop "this installer does not name Clawtrate's signing team yet. Use the download on https://clawtrate.dev."

  FEED="$FEED_URL" RELEASES="$RELEASES_URL" ASSETS="$ASSETS_ORIGIN" PROTO="=https"
  if [ -n "${CLAWTRATE_FEED:-}" ]; then
    loopback "$CLAWTRATE_FEED" CLAWTRATE_FEED
    FEED="$CLAWTRATE_FEED" PROTO="=http"
    if [ -n "${CLAWTRATE_RELEASES:-}" ]; then
      loopback "$CLAWTRATE_RELEASES" CLAWTRATE_RELEASES
      RELEASES="$CLAWTRATE_RELEASES"
    fi
    if [ -n "${CLAWTRATE_ASSETS:-}" ]; then
      loopback "$CLAWTRATE_ASSETS/" CLAWTRATE_ASSETS
      ASSETS="$CLAWTRATE_ASSETS"
    fi
  elif [ -n "${CLAWTRATE_RELEASES:-}${CLAWTRATE_ASSETS:-}" ]; then
    stop "CLAWTRATE_RELEASES and CLAWTRATE_ASSETS are for tests with CLAWTRATE_FEED."
  fi
  DEST="${CLAWTRATE_APPLICATIONS:-/Applications}"
  TARGET="$DEST/$APP"
  LOCK="$DEST/.clawtrate-install.lock"

  # An Apple silicon Mac takes its native build, also from a shell under Rosetta.
  ARCH="$(uname -m)"
  if [ "$(sysctl -in hw.optional.arm64 2>/dev/null)" = 1 ] ||
    [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    ARCH=arm64
  fi
  case "$ARCH" in
    arm64 | x86_64) ;;
    *) stop "this Mac's processor ($ARCH) is not one Clawtrate is built for." ;;
  esac

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/clawtrate-install.XXXXXX")"

  # 1. The feed: a direct HTTP 200, read strictly.
  say "Reading the Beta feed: $FEED"
  code="$(curl -q -sS --proto "$PROTO" --max-redirs 0 --max-filesize 65536 \
    -o "$WORK/latest-mac.json" -w '%{http_code}' --url "$FEED" 2>/dev/null)" ||
    stop "could not read the Beta feed. Check your connection and try again."
  case "$code" in
    200) ;;
    404) stop "the Mac beta feed is unavailable. Check GitHub Releases: $RELEASES_PAGE" ;;
    *) stop "the Beta feed answered HTTP $code." ;;
  esac
  picked="$(read_feed "$ARCH")" || stop "the Beta feed is not valid: $(sed -n '$p' "$WORK/feed-error.txt")"
  VERSION="$(printf '%s\n' "$picked" | sed -n 1p)"
  URL="$(printf '%s\n' "$picked" | sed -n 2p)"
  SHA256="$(printf '%s\n' "$picked" | sed -n 3p)"
  say "Latest beta: Clawtrate $VERSION for $ARCH"

  # 2. The download and its SHA-256.
  say "Downloading $URL"
  fetch_zip "$URL"
  actual="$(shasum -a 256 "$WORK/Clawtrate.zip" | sed 's/ .*//')"
  [ "$actual" = "$SHA256" ] || stop "the download's SHA-256 is $actual, but the feed says $SHA256."
  say "SHA-256 matches the feed."

  # 3. The archive, before and after unpacking, then the app itself.
  check_zip
  mkdir "$WORK/unpacked"
  ditto -x -k "$WORK/Clawtrate.zip" "$WORK/unpacked" || stop "the download did not unpack."
  NEW="$WORK/unpacked/$APP"
  check_tree
  check_bundle "$NEW"
  say "It is Clawtrate $APP_VERSION ($BUNDLE_ID) for $ARCH."
  check_signature "$NEW"
  say "Signed with Clawtrate's Developer ID ($CLAWTRATE_TEAM_ID) and notarized by Apple."

  # 4. The destination: a real folder, locked for this install.
  [ -d "$DEST" ] && [ ! -L "$DEST" ] || stop "$DEST is not a folder."
  [ -w "$DEST" ] || stop "you cannot write to $DEST without an administrator. Use the download on https://clawtrate.dev instead."
  mkdir "$LOCK" 2>/dev/null ||
    stop "another Clawtrate install is using $DEST. If none is running, remove $LOCK and try again."
  LOCKED=1
  if [ -L "$TARGET" ] || { [ -e "$TARGET" ] && [ ! -d "$TARGET" ]; }; then
    stop "$TARGET is not an app folder; it was left as it was."
  fi
  if [ -e "$TARGET" ]; then
    found="$(plutil -extract CFBundleIdentifier raw -expect string -o - "$TARGET/Contents/Info.plist" 2>/dev/null)" || found=""
    [ "$found" = "$BUNDLE_ID" ] || stop "$TARGET is not Clawtrate; it was left as it was."
    say "Clawtrate is already in $DEST."
    answer=""
    if (exec </dev/tty) 2>/dev/null; then
      printf 'Replace it with Clawtrate %s? Quit Clawtrate first. [y/N] ' "$APP_VERSION"
      read -r answer </dev/tty || answer=""
    fi
    case "$answer" in
      y | Y | yes | YES) ;;
      *) stop "the copy in $DEST was left as it was." ;;
    esac
  fi

  # 5. Stage on the same volume, swap, and confirm before saying so.
  STAGE="$(mktemp -d "$DEST/.clawtrate-install.XXXXXX")"
  ditto "$NEW" "$STAGE/$APP" || stop "could not copy the app into $DEST."
  if [ -e "$TARGET" ]; then
    OLD="$STAGE/previous.app"
    PHASE=aside
    mv "$TARGET" "$OLD" || stop "could not move the existing copy aside. Is Clawtrate still open?"
  fi
  [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || stop "something appeared at $TARGET during the install."
  PHASE=placed
  mv "$STAGE/$APP" "$TARGET" || stop "could not put the new copy in place."
  if [ -e "$TARGET/$APP" ] || [ -e "$STAGE/$APP" ]; then
    # $TARGET was created by something else after the check: take ours back out.
    mv "$TARGET/$APP" "$STAGE/rejected.app" 2>/dev/null || :
    stop "a folder appeared at $TARGET during the install; it was left as it was."
  fi
  MOVED=1
  check_bundle "$TARGET"
  codesign --verify --deep --strict "$TARGET" 2>"$WORK/codesign.txt" ||
    stop "the installed copy's signature is not valid: $(cat "$WORK/codesign.txt")"
  PHASE=installed
  [ -z "$OLD" ] || say "Replaced the previous copy of Clawtrate."
  say "Installed Clawtrate $APP_VERSION in $TARGET."
  say "Clawtrate checks for Beta updates in Settings."
  exit 0
}

main "$@"
