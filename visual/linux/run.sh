#!/usr/bin/env bash
# `pnpm visual:linux [playwright arguments]` runs the screenshot tests as CI's visual-linux job
# does: in the pinned Linux image (Dockerfile beside this file), against visual/baselines/linux/.
# It needs Docker. The arguments go to `playwright test`, for example
# `visual/shell.visual.spec.ts -g "phone"`. Results land in test-results/visual/.
#
# The image runs on the computer's own architecture: arm64 on Apple silicon, amd64 on CI. Both
# draw the baselines within the tests' tolerance (#392). CLAWTRATE_VISUAL_PLATFORM=linux/amd64
# draws exactly as CI does; on Apple silicon that needs Docker's Rosetta emulation, since Node
# fails under QEMU's. CLAWTRATE_VISUAL_IMAGE names an image already built from this definition
# (CI builds it in a step of its own); CLAWTRATE_VISUAL_STORE names the volume or folder for
# pnpm's store.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"
platform=${CLAWTRATE_VISUAL_PLATFORM:-}
image=${CLAWTRATE_VISUAL_IMAGE:-}
if [ -z "$image" ]; then
  # Tagged by the definition's content, so a changed definition builds a new image.
  hash=$(cat visual/linux/Dockerfile visual/linux/fonts.conf visual/linux/run-inside.sh | git hash-object --stdin)
  image="clawtrate-visual:${hash:0:12}${platform:+-${platform#linux/}}"
  if ! docker image inspect "$image" > /dev/null 2>&1; then
    docker build ${platform:+--platform "$platform"} -t "$image" visual/linux
  fi
fi
mkdir -p visual/baselines/linux test-results/visual
# The checkout as it stands, without node_modules (the image installs Linux ones) and without
# the baselines (the Linux ones are mounted, so updates land in the checkout).
git ls-files -z --cached --others --exclude-standard -- ':!:visual/baselines' |
  tar --null -T - -cf - |
  docker run --rm -i --init --ipc=host ${platform:+--platform "$platform"} \
    -e CI -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$root/visual/baselines/linux:/baselines" \
    -v "$root/test-results/visual:/results" \
    -v "${CLAWTRATE_VISUAL_STORE:-clawtrate-visual-pnpm-store}:/pnpm-store" \
    "$image" clawtrate-visual "$@"
