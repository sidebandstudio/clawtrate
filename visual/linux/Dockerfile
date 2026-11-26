# The browser, fonts and Node that the screenshot tests render with on Linux, so CI and a person's
# computer draw the same pixels (docs/development/testing.md). It builds for amd64 and arm64.

# Playwright 1.65.1's image for Ubuntu 24.04, by digest: Chromium 1255 (the build @playwright/test
# 1.65.1 drives), Node 26.13.1, FreeType 2.13.2, HarfBuzz 8.3.0, fontconfig 2.15.0 and Noto Color
# Emoji 2.047. The digest is the multi-platform index; the amd64 image is
# sha256:766137e2d9caad4744187e53cdc89320ba6f2eb57cff097374020944b44dd0a9.
ARG BASE=mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

# DejaVu Sans 2.37, for the arrows and key symbols that Figtree and JetBrains Mono lack (→ ↵ ⇧ ⌥ ⌘ ⌃).
# Without it fontconfig picks a different font for each one, some of them CJK or bitmap fonts.
FROM ${BASE} AS fonts
ARG DEJAVU_URL=https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2
ARG DEJAVU_SHA256=fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7
# An Ubuntu mirror that is mid-sync serves index files of the wrong size, so each download is retried
# and the whole update is tried three times, 10 seconds apart (#684). `--error-on=any` makes a
# transient fetch error fail the update too, so it is retried. Only this stage uses apt. The font
# download is retried too.
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
  && for attempt in 1 2 3; do \
    apt-get update --error-on=any && break; \
    if [ "$attempt" = 3 ]; then echo "apt-get update failed 3 times" >&2; exit 1; fi; \
    echo "apt-get update failed, trying again in 10 seconds" >&2; sleep 10; \
  done \
  && apt-get install -y --no-install-recommends bzip2 \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o /tmp/dejavu.tar.bz2 "$DEJAVU_URL" \
  && echo "$DEJAVU_SHA256  /tmp/dejavu.tar.bz2" | sha256sum -c - \
  && mkdir /dejavu \
  && tar -xjf /tmp/dejavu.tar.bz2 -C /dejavu --strip-components=1 \
    dejavu-fonts-ttf-2.37/LICENSE \
    dejavu-fonts-ttf-2.37/ttf/DejaVuSans.ttf \
    dejavu-fonts-ttf-2.37/ttf/DejaVuSans-Bold.ttf \
    dejavu-fonts-ttf-2.37/ttf/DejaVuSansMono.ttf \
    dejavu-fonts-ttf-2.37/ttf/DejaVuSansMono-Bold.ttf

FROM ${BASE}
COPY --from=fonts /dejavu/ /usr/local/share/fonts/dejavu/
RUN cd /usr/local/share/fonts/dejavu \
  && printf '%s  %s\n' \
    7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954 ttf/DejaVuSans.ttf \
    e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724 ttf/DejaVuSans-Bold.ttf \
    b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582 ttf/DejaVuSansMono.ttf \
    bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769 ttf/DejaVuSansMono-Bold.ttf \
    | sha256sum -c -
COPY fonts.conf /etc/fonts/local.conf
RUN fc-cache -f && npm install --global pnpm@11.9.0
COPY run-inside.sh /usr/local/bin/clawtrate-visual
