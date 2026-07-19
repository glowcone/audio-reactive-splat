#!/bin/sh
set -eu

# Pages cannot upload the 58 MB source PLY as a static asset. The matching
# /gaussian route is supplied by a Pages Function backed by R2 instead.
rm -rf dist
mkdir -p dist
cp -R viewer/. dist/
