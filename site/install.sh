#!/bin/sh
# An incomplete download that ends before main is called runs nothing and fails.
trap 'exit 1' EXIT

# Installs the Clawtrate beta on a Mac where Clawtrate is not installed yet:
#
#   curl -fsSL https://clawtrate.dev/install.sh | sh
#
# It reads the Beta feed, takes the build for this Mac's processor, and checks
# the download's SHA-256, the archive's layout, the app's bundle id, version and
# processor, its Developer ID signature and team, and Apple's notarization.
# Only then does it move Clawtrate.app into /Applications, and it checks the
# copy it placed again before saying so. Where Clawtrate is already installed
# it changes nothing: updates come from Settings in the app. It never uses sudo
# and changes no system setting. Nothing runs until the whole file has arrived:
# the last line calls main with the one argument main requires.
#
# For tests only, these point it at stand-ins on this Mac's loopback address:
# CLAWTRATE_FEED (the feed), CLAWTRATE_RELEASES (the release download prefix)
# and CLAWTRATE_ASSETS (the origin a release download redirects to), each
# http://127.0.0.1:<port>/...; and CLAWTRATE_APPLICATIONS, the folder to
# install into.

# The Developer ID team that signs Clawtrate's releases.
CLAWTRATE_TEAM_ID="9X79V37Q89"

BUNDLE_ID="dev.clawtrate.desktop"
APP="Clawtrate.app"
FEED_URL="https://clawtrate.dev/updates/beta/latest-mac.json"
RELEASES_URL="https://github.com/sidebandstudio/clawtrate/releases/download/"
ASSETS_ORIGIN="https://release-assets.githubusercontent.com"
RELEASES_PAGE="https://github.com/sidebandstudio/clawtrate/releases"

say() { printf '%s\n' "$*"; }

# A refusal. What it leaves behind is said on the way out.
stop() {
  printf 'Stopped: %s\n' "$*" >&2
  exit 1
}

# The way out for every outcome, also after INT, TERM or HUP. It removes this
# run's own private files and nothing else.
# shellcheck disable=SC2329 # called by the EXIT trap
finish() {
  status=$?
  trap '' INT TERM HUP
  if [ "$PHASE" != installed ]; then
    if [ -n "$STAGED_ID" ] && [ -d "$TARGET" ] && [ ! -L "$TARGET" ] &&
      [ "$(stat -f '%d:%i' "$TARGET" 2>/dev/null)" = "$STAGED_ID" ]; then
      say "Clawtrate is at $TARGET. It passed its checks before the move, but the check after it did not finish. To repeat it, move Clawtrate to the Trash and run this again." >&2
    elif [ -n "$LEFT" ]; then
      say "$LEFT" >&2
    elif [ -n "$KEEP_STAGE" ]; then
      say "Nothing was installed. The checked copy is at $STAGE/$APP." >&2
    elif [ "$status" -ne 0 ]; then
      say "Nothing was installed." >&2
    fi
  fi
  if [ -n "$STAGE" ] && [ -z "$KEEP_STAGE" ]; then
    rm -rf "$STAGE" || say "Could not remove the staging folder at $STAGE." >&2
  fi
  if [ -n "$LOCKED" ]; then
    rmdir "$LOCK" || say "Could not remove the install lock at $LOCK." >&2
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK" || say "Could not remove the temporary folder at $WORK." >&2
  fi
  exit "$status"
}

# Only loopback http for the test variables, with a decimal port; the default
# addresses are fixed.
loopback() {
  rest="${1#http://127.0.0.1:}"
  port="${rest%%/*}"
  if [ "$rest" = "$1" ] || [ "$port" = "$rest" ]; then
    stop "$2 must be an http://127.0.0.1:<port>/ address."
  fi
  case "$port" in
    '' | 0* | *[!0-9]*) stop "$2 must name a port from 1 to 65535." ;;
  esac
  [ "${#port}" -le 5 ] && [ "$port" -le 65535 ] || stop "$2 must name a port from 1 to 65535."
}

# Reads latest-mac.json strictly: JSON with no repeated key and exactly this
# shape, both builds of one real beta version, each at its release's own
# address. Prints the version, the address and the SHA-256 of the build for $1.
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
    const out = Object.create(null); const seen = new Set();
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
  const exactKeys = (v, want) => {
    const have = Object.keys(v).sort();
    return have.length === want.length && have.every((key, n) => key === want[n]);
  };
  if (!isObject(feed) || !exactKeys(feed, ["arm64", "teamIdentifier", "x86_64"])) throw new Error("wrong fields");
  if (feed.teamIdentifier !== team) throw new Error("the feed names another signing team");
  // The release's own beta version: a real calendar date and a run number.
  const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})-beta\.([1-9]\d{7})\.(0|[1-9]\d{0,11})$/;
  const isBeta = (v) => {
    if (typeof v !== "string" || v.length > 50) return false;
    const m = VERSION.exec(v);
    if (!m || m[0] !== v) return false;
    const iso = m[4].slice(0, 4) + "-" + m[4].slice(4, 6) + "-" + m[4].slice(6);
    const time = Date.parse(iso);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso;
  };
  const files = { arm64: "mac-arm64", x86_64: "mac-x64" };
  let version = null;
  for (const key of ["arm64", "x86_64"]) {
    const e = feed[key];
    if (!isObject(e) || !exactKeys(e, ["sha256", "url", "version"])) throw new Error(key + ": wrong fields");
    if (!isBeta(e.version)) throw new Error(key + ": not a beta version");
    if (version !== null && e.version !== version) throw new Error("the two builds name different versions");
    version = e.version;
    const digest = typeof e.sha256 === "string" ? /^[0-9a-f]{64}$/.exec(e.sha256) : null;
    if (!digest || digest[0] !== e.sha256) throw new Error(key + ": bad SHA-256");
    const expected = prefix + "v" + e.version + "/Clawtrate-" + e.version + "-" + files[key] + ".zip";
    if (e.url !== expected) throw new Error(key + ": not this release's download address");
  }
  const e = feed[arch];
  return [e.version, e.url, e.sha256].join("\n");
}
JS
  osascript -l JavaScript "$WORK/feed.js" "$WORK/latest-mac.json" "$1" "$RELEASES" "$CLAWTRATE_TEAM_ID" 2>"$WORK/feed-error.txt"
}

# Older curl versions check only a declared length. Limit the output file even when there is
# no Content-Length. The Mac's bash measures file limits in KiB outside POSIX mode.
download() {
  if [ "$PROTO" = "=http" ]; then set -- "$@" --noproxy 127.0.0.1; fi
  BASH_ENV=/dev/null /bin/bash -c '
    set +o posix
    bytes=$1
    shift
    blocks=$((bytes / 1024))
    current=$(ulimit -Sf) || exit 1
    if [ "$current" = unlimited ] || [ "$current" -gt "$blocks" ]; then
      ulimit -Sf "$blocks" || exit 1
    fi
    exec curl -q --max-filesize "$bytes" "$@"
  ' download "$@" -sS --globoff --proto "$PROTO" --max-redirs 0
}

# Fetches the build: the release download address, and at most one redirect
# to the release-asset origin, checked before it is followed. A download that
# stalls below 1 KB/s for 30 seconds fails.
fetch_zip() {
  first="$(download 2000000000 \
    --connect-timeout 15 --speed-limit 1024 --speed-time 30 \
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
  code="$(download 2000000000 \
    --connect-timeout 15 --speed-limit 1024 --speed-time 30 \
    -o "$WORK/Clawtrate.zip" -w '%{http_code}' --url "$next")" ||
    stop "the download did not finish."
  [ "$code" = 200 ] || stop "the download answered HTTP $code."
}

# The archive holds Clawtrate.app and nothing else: no other root, no path
# that climbs out, no repeated entry, optionally the AppleDouble metadata
# ditto writes, and links only where an Electron framework has them, each read
# from the archive and compared with its one allowed target before unpacking.
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
  zipinfo "$zip" >"$WORK/listing.txt" 2>/dev/null || stop "the archive cannot be listed."
  awk '$1 ~ /^l/ { sub(/^([^ ]+ +){8}/, ""); print }' "$WORK/listing.txt" >"$WORK/links.txt"
  while IFS= read -r link; do
    case "$link" in
      *'*'* | *'?'* | *'['* | *']'*) stop "the archive has a link with an unusual name: $link" ;;
    esac
    rest="${link#"$APP"/Contents/Frameworks/}"
    framework="${rest%%/*}"
    child="${rest#*/}"
    if [ "$rest" = "$link" ] || [ "$framework" = "$rest" ] || [ -z "$child" ]; then
      stop "the archive has a link where none belongs: $link"
    fi
    case "$framework" in
      ?*.framework) ;;
      *) stop "the archive has a link where none belongs: $link" ;;
    esac
    if [ "$child" = Versions/Current ]; then
      want=A
    else
      case "$child" in
        */*) stop "the archive has a link where none belongs: $link" ;;
      esac
      want="Versions/Current/$child"
    fi
    unzip -qq -p "$zip" "$link" >"$WORK/link-target" 2>/dev/null || stop "the archive's link $link cannot be read."
    printf '%s' "$want" >"$WORK/link-wanted"
    cmp -s "$WORK/link-target" "$WORK/link-wanted" || stop "the archive's link $link points somewhere it should not."
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

# Signature and notarization, as the release script checks them. Sets CDHASH,
# the signature's code directory hash, so later copies can be matched to it.
check_signature() {
  codesign --verify --deep --strict "$1" 2>"$WORK/codesign.txt" ||
    stop "the app's signature is not valid: $(cat "$WORK/codesign.txt")"
  codesign --display --verbose=4 "$1" >"$WORK/display.txt" 2>&1 ||
    stop "the app's signature cannot be read: $(cat "$WORK/display.txt")"
  signed_id="$(sed -n 's/^Identifier=//p' "$WORK/display.txt" | head -n 1)"
  authority="$(sed -n 's/^Authority=//p' "$WORK/display.txt" | head -n 1)"
  signer="$(sed -n 's/^TeamIdentifier=//p' "$WORK/display.txt" | head -n 1)"
  CDHASH="$(sed -n 's/^CDHash=//p' "$WORK/display.txt" | head -n 1)"
  [ "$signed_id" = "$BUNDLE_ID" ] || stop "the app is signed as ${signed_id:-unknown}, not $BUNDLE_ID."
  case "$authority" in
    "Developer ID Application: "*) ;;
    *) stop "the app is not signed with a Developer ID Application certificate." ;;
  esac
  [ "$signer" = "$CLAWTRATE_TEAM_ID" ] ||
    stop "the app is signed by team ${signer:-unknown}, not by Clawtrate's team $CLAWTRATE_TEAM_ID."
  printf '%s' "$CDHASH" | grep -Eqx '[0-9a-f]{40}' || stop "the app's signature has no code directory hash."
  spctl --assess --type execute --verbose=2 "$1" >"$WORK/spctl.txt" 2>&1 ||
    stop "macOS does not accept the app: $(cat "$WORK/spctl.txt")"
  grep -qx 'source=Notarized Developer ID' "$WORK/spctl.txt" ||
    stop "macOS does not report the app as a notarized Developer ID app."
}

# What is at a path, in a few words, without following a link.
describe() {
  if [ -L "$1" ]; then
    say "a link"
  elif [ -d "$1" ]; then
    say "a folder"
  elif [ -e "$1" ]; then
    say "a file"
  else
    say "nothing"
  fi
}

# The kernel checks the destination and moves the staged directory in one operation.
place_app() {
  osascript -l JavaScript - "$1" "$2" 2>/dev/null <<'JS'
ObjC.bindFunction("renamex_np", ["int", ["string", "string", "unsigned int"]]);
function run([source, target]) {
  const RENAME_EXCL = 4;
  if ($.renamex_np(source, target, RENAME_EXCL) !== 0)
    throw new Error("Could not place the staged app.");
}
JS
}

already_installed() {
  stop "Clawtrate is already installed at $TARGET. Update it from Settings, or move it to the Trash and run this again."
}

main() {
  [ "$#" -eq 1 ] && [ "$1" = 'clawtrate-installer-complete' ] || exit 1
  trap - EXIT
  set -eu
  PHASE="" WORK="" STAGE="" LOCKED="" KEEP_STAGE="" LEFT="" TARGET="" LOCK="" STAGED_ID="" VERSION=""
  trap finish EXIT
  trap 'exit 1' INT TERM HUP

  [ "$(uname -s)" = "Darwin" ] || stop "this installer is for macOS."
  [ "$(id -u)" != "0" ] || stop "run this as yourself, not with sudo or as root."
  for tool in uname id sysctl curl shasum osascript zipinfo unzip cmp ditto find readlink file \
    plutil codesign spctl stat mktemp mkdir rmdir rm mv ls sed awk grep sort uniq wc cat tr head; do
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

  # A first install only: an existing copy updates itself from Settings.
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then already_installed; fi

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
  code="$(download 65536 \
    --connect-timeout 15 --max-time 30 -o "$WORK/latest-mac.json" -w '%{http_code}' --url "$FEED" 2>/dev/null)" ||
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
  CHECKED_CDHASH="$CDHASH"
  say "Signed with Clawtrate's Developer ID ($CLAWTRATE_TEAM_ID) and notarized by Apple."

  # 4. The destination: a real folder, locked for this install, with no Clawtrate.
  [ -d "$DEST" ] && [ ! -L "$DEST" ] || stop "$DEST is not a folder."
  [ -w "$DEST" ] || stop "you cannot write to $DEST without an administrator. Use the download on https://clawtrate.dev instead."
  cancelled=""
  trap 'cancelled=1' INT TERM HUP
  (trap '' INT TERM HUP; exec mkdir "$LOCK") 2>/dev/null ||
    stop "another Clawtrate install is using $DEST. If none is running, remove $LOCK and try again."
  LOCKED=1
  trap 'exit 1' INT TERM HUP
  [ -z "$cancelled" ] || exit 1
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then already_installed; fi

  # 5. Stage beside the target, check the staged copy as the same build, and
  # move it in with a move that never overwrites or nests.
  STAGE="$(mktemp -d "$DEST/.clawtrate-install.XXXXXX")"
  ditto "$NEW" "$STAGE/$APP" || stop "could not copy the app into $DEST."
  [ -d "$STAGE/$APP" ] && [ ! -L "$STAGE/$APP" ] || stop "the staged copy is not a folder."
  check_bundle "$STAGE/$APP"
  check_signature "$STAGE/$APP"
  [ "$CDHASH" = "$CHECKED_CDHASH" ] || stop "the staged copy is not the build that was checked."
  STAGED_ID="$(stat -f '%d:%i' "$STAGE/$APP")"
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then already_installed; fi
  PHASE=placing
  place_app "$STAGE/$APP" "$TARGET" || :
  if [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    STAGED_ID="" KEEP_STAGE=1
    stop "could not move the app to $TARGET."
  fi
  if [ -L "$TARGET" ] || [ ! -d "$TARGET" ] || [ "$(stat -f '%d:%i' "$TARGET")" != "$STAGED_ID" ]; then
    found="$(describe "$TARGET")"
    STAGED_ID=""
    [ ! -e "$STAGE/$APP" ] || KEEP_STAGE=1
    stop "$TARGET is $found that this installer did not put there; it was left as it was."
  fi

  # 6. The copy in place is the checked build, or this run takes it out again.
  if ! (
    check_bundle "$TARGET"
    check_signature "$TARGET"
    [ "$CDHASH" = "$CHECKED_CDHASH" ] || stop "the copy at $TARGET is not the build that was checked."
  ); then
    # Only this run's copy is taken out, and only what arrives is removed.
    failed="the copy at $TARGET did not pass its final check"
    if [ "$(stat -f '%d:%i' "$TARGET" 2>/dev/null)" != "$STAGED_ID" ]; then
      STAGED_ID=""
      stop "$failed, and $TARGET is no longer the copy this installer placed. It was left as it was."
    fi
    # A signal or a failed stat can leave the moved item unidentified. Preserve it until proven ours.
    KEEP_STAGE=1 LEFT="Could not confirm what was moved. The staging folder is at $STAGE."
    mv -n "$TARGET" "$STAGE/" 2>/dev/null || :
    moved="$(stat -f '%d:%i' "$STAGE/$APP" 2>/dev/null)" || moved=""
    if [ "$moved" = "$STAGED_ID" ]; then
      STAGED_ID="" KEEP_STAGE="" LEFT=""
      stop "$failed, so it was taken out again."
    elif [ -n "$moved" ]; then
      STAGED_ID="" LEFT="What was taken out is at $STAGE/$APP. This installer did not delete it."
      stop "$failed, and $TARGET changed while it was taken out."
    elif [ ! -e "$STAGE/$APP" ] && [ ! -L "$STAGE/$APP" ] && [ "$(stat -f '%d:%i' "$TARGET" 2>/dev/null)" = "$STAGED_ID" ]; then
      STAGED_ID="" KEEP_STAGE="" LEFT="Move $TARGET to the Trash."
      stop "$failed and could not be taken out."
    fi
    STAGED_ID=""
    stop "$failed, and $TARGET is no longer the copy this installer placed. It was left as it was."
  fi
  if [ -L "$TARGET" ] || [ ! -d "$TARGET" ] || [ "$(stat -f '%d:%i' "$TARGET" 2>/dev/null)" != "$STAGED_ID" ]; then
    STAGED_ID=""
    stop "$TARGET changed during its final check. Run the installer again to check the destination."
  fi
  PHASE=installed
  say "Installed Clawtrate $APP_VERSION in $TARGET."
  say "Later updates come from Settings in Clawtrate."
  exit 0
}

main 'clawtrate-installer-complete'
