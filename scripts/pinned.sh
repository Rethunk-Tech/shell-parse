# shellcheck shell=sh
# A release binary pinned by version and checksum, downloaded once into the user cache. Never a PATH
# binary: version text is not a checksum. Sets $bin; a fifth argument names the archive member to extract.
pinned() {
  name=$1 version=$2 sha256=$3 url=$4 member=${5:-}
  cache="${XDG_CACHE_HOME:-${HOME}/.cache}/${name}/${version}"
  bin="$cache/$name"
  [ -x "$bin" ] && return 0
  mkdir -p "$cache"
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --max-time 60 --retry 5 --retry-all-errors -o "$tmp" "$url"
  echo "$sha256  $tmp" | sha256sum -c - >&2
  if [ -n "$member" ]; then
    tar -xOf "$tmp" "$member" >"$bin"
  else
    mv "$tmp" "$bin"
  fi
  rm -f "$tmp"
  trap - EXIT
  chmod +x "$bin"
}
