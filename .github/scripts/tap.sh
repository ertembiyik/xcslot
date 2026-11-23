#!/bin/sh
# Puts a release's formula into the Homebrew tap, so `brew install ertembiyik/tap/xcslot` finds it.
#   tap.sh TAG CHECKSUMS
# TAP_KEY is the private half of the tap repository's deploy key (write access to the tap only).
# Running it again for the same release changes nothing, so a failed job can be rerun.
set -eu

tag=${1:?usage: tap.sh TAG CHECKSUMS}
sums=${2:?usage: tap.sh TAG CHECKSUMS}
tap=${XCSLOT_TAP:-ertembiyik/homebrew-tap}
[ -n "${TAP_KEY:-}" ] || { echo "tap.sh: TAP_KEY is empty: add the tap's deploy key as the release environment's secret HOMEBREW_TAP_KEY, then rerun this job" >&2; exit 1; }

root=$(cd "$(dirname "$0")/../.." && pwd)
work=${RUNNER_TEMP:?RUNNER_TEMP must name a scratch directory}/tap
rm -rf "$work"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

key=$work/key
( umask 077; printf '%s\n' "$TAP_KEY" > "$key" )
export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

git clone --quiet --depth 1 "git@github.com:$tap.git" "$work/repo"
mkdir -p "$work/repo/Formula"
sh "$root/.github/scripts/formula.sh" "$tag" "$sums" > "$work/repo/Formula/xcslot.rb"
ruby -c "$work/repo/Formula/xcslot.rb" > /dev/null
brew style "$work/repo/Formula/xcslot.rb"

cd "$work/repo"
if [ -z "$(git status --porcelain)" ]; then
	echo "tap.sh: the tap already has $tag"
	exit 0
fi
git add Formula/xcslot.rb
git -c user.name="xcslot release" -c user.email="noreply@github.com" commit --quiet -m "xcslot ${tag#v}"
git push --quiet origin HEAD
echo "tap.sh: pushed xcslot ${tag#v} to $tap"
