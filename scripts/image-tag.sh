#!/usr/bin/env bash
# Prints a tag for the reviewer image made from a hash of everything the image is built from.
# The Build and push workflow tags each image it pushes with it, and the action pulls the image
# by it, so the action can skip building when main already published the same image.
# Usage: scripts/image-tag.sh [repository root, default: the current directory]
set -euo pipefail
cd "${1:-.}"
find Dockerfile package.json src experiments/prototypes -type f -print0 \
  | LC_ALL=C sort -z \
  | xargs -0 sha256sum \
  | sha256sum \
  | cut -c1-32 \
  | sed 's/^/content-/'
