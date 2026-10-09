#!/bin/sh
# Keep incomplete releases out of releases/latest. Published assets are immutable.
set -eu
fail() { printf 'release: %s\n' "$*" >&2; exit 1; }
assets=${1:?Usage: publish-release.sh ASSET_DIRECTORY}
: "${RELEASE_TAG:?RELEASE_TAG must be set}"
printf '%s\n' "$RELEASE_TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Invalid release tag.'
version=${RELEASE_TAG#v}
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$assets"
count=0
for file in ./*.tar.gz; do
  [ -f "$file" ] || fail 'Missing release archives.'
  count=$((count + 1))
done
[ "$count" = 4 ] || fail 'Expected exactly four platform archives.'
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"
  else shasum -a 256 "$@"; fi
}
set --
: > SHA256SUMS
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  asset=abele-node-$version-$platform.tar.gz
  if [ ! -f "$asset" ] || [ -L "$asset" ]; then fail "Missing regular asset: $asset"; fi
  checksum "$asset" >> SHA256SUMS || fail 'Cannot compute release checksums.'
  set -- "$@" "$asset"
done
# Publish the installer from this tagged checkout, never from main.
[ -f "$source_dir/install.sh" ] && [ ! -L "$source_dir/install.sh" ] || fail 'Missing regular install.sh in release checkout.'
cp "$source_dir/install.sh" install.sh
checksum install.sh >> SHA256SUMS || fail 'Cannot compute installer checksum.'
set -- "$@" install.sh
if draft=$(gh release view "$RELEASE_TAG" --json isDraft --jq .isDraft); then
  [ "$draft" = true ] || fail 'Release already published; refusing to replace public assets.'
else
  gh release create "$RELEASE_TAG" --draft --verify-tag --title "AbeleNode $RELEASE_TAG" --generate-notes
fi
gh release upload "$RELEASE_TAG" "$@" SHA256SUMS --clobber
verify=$(mktemp -d .verify.XXXXXX)
trap 'rm -rf "$verify"' 0
trap 'exit 1' HUP INT TERM
# Verify the exact remote asset set and the uploaded bytes, not just upload's exit.
printf '%s\n' "$@" SHA256SUMS | LC_ALL=C sort > "$verify/expected-names"
gh release view "$RELEASE_TAG" --json assets --jq '.assets[].name' > "$verify/remote-names"
LC_ALL=C sort "$verify/remote-names" > "$verify/sorted-names"
cmp "$verify/expected-names" "$verify/sorted-names" || fail 'Remote release asset set is incomplete or unexpected.'
gh release download "$RELEASE_TAG" --dir "$verify" --pattern "abele-node-$version-*.tar.gz" --pattern install.sh --pattern SHA256SUMS
cmp SHA256SUMS "$verify/SHA256SUMS" || fail 'Remote checksum manifest differs from the local manifest.'
(cd "$verify" && checksum -c SHA256SUMS) || fail 'Downloaded release checksum verification failed.'
# Only this final operation exposes the complete release as latest.
gh release edit "$RELEASE_TAG" --draft=false --latest
