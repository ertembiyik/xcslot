#!/bin/sh
# Prints the Homebrew formula for a release from its checksums file.
#   formula.sh TAG CHECKSUMS
set -eu

tag=${1:?usage: formula.sh TAG CHECKSUMS}
sums=${2:?usage: formula.sh TAG CHECKSUMS}
repo=${XCSLOT_REPOSITORY:-ertembiyik/xcslot}

sha() {
	value=$(awk -v file="$1" '$2 == file || $2 == "*" file { print $1 }' "$sums")
	[ -n "$value" ] || { echo "formula.sh: $sums has no checksum for $1" >&2; exit 1; }
	printf '%s' "$value"
}

arm=$(sha xcslot-darwin-arm64)
intel=$(sha xcslot-darwin-x64)
base=https://github.com/$repo/releases/download/$tag

cat <<RUBY
class Xcslot < Formula
  desc "Warm Xcode build slots for parallel coding agents"
  homepage "https://github.com/$repo"
  version "${tag#v}"
  license "MIT"

  depends_on :macos

  on_arm do
    url "$base/xcslot-darwin-arm64"
    sha256 "$arm"
  end
  on_intel do
    url "$base/xcslot-darwin-x64"
    sha256 "$intel"
  end

  def install
    bin.install Dir["xcslot-darwin-*"].first => "xcslot"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/xcslot --version")
  end
end
RUBY
