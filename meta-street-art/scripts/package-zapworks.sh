#!/usr/bin/env sh
# Builds spraypath-zapworks.zip, ready to upload to a ZapWorks "Universal AR" project
# (Experience tab → upload ZIP). Hosting on ZapWorks needs no domain registration.
set -e
cd "$(dirname "$0")/.."
rm -f spraypath-zapworks.zip
zip -q spraypath-zapworks.zip index.html ar.html spots.js nav-core.js manifest.json icon.svg
echo "Created spraypath-zapworks.zip"
