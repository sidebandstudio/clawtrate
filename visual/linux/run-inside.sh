#!/bin/sh
# Inside the image: unpack the checkout that run.sh sends on standard input, install its Linux
# dependencies, run the screenshot tests with the arguments given, and hand back the results.
# /baselines is the checkout's visual/baselines/linux/ and /results its test-results/visual/.
set -eu
mkdir -p /work/visual/baselines
cd /work
tar -xf -
ln -s /baselines visual/baselines/linux
# Electron is not needed: the visual tests serve the fixture build to Chromium.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm-store --reporter=silent
status=0
pnpm exec playwright test -c playwright.visual.config.ts "$@" || status=$?
find /results -mindepth 1 -delete
if [ -d test-results/visual ]; then cp -R test-results/visual/. /results/; fi
# Written as root; give them to the person or runner that started the container.
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /results /baselines
exit "$status"
