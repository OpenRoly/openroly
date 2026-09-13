#!/bin/sh
# openroly の単体実行ファイルを作る(PBI-0132)。end user から bun を剥がすための前半 ——
# 「置いてあれば使う」側は launcher(packages/mcp/openroly-mcp)と resolveMcpServerCommand が持つ。
#
#   ./scripts/build-binaries.sh                    配布 target 全部(darwin-arm64 / darwin-x64 / linux-x64)
#   ./scripts/build-binaries.sh --host-only        今の機械向けだけ → dist/openroly-mcp, dist/openroly
#   ./scripts/build-binaries.sh --host-only openroly-mcp  1 本だけ
#   ./scripts/build-binaries.sh --out /tmp/x       出力先を変える
#
# **binary は git に入れない**(1 本 61MB)。dist/ は .gitignore 済み。
# Release への添付と `openroly install` からの自動取得は PBI-0137(本 PBI のスコープ外)。
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
out="${OPENROLY_DIST:-$repo/dist}"
host_only=0
names=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host-only) host_only=1 ;;
    --out) shift; out="$1" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) names="$names $1" ;;
  esac
  shift
done
[ -n "$names" ] || names="openroly-mcp openroly"

entry_for() {
  case "$1" in
    openroly-mcp) echo "packages/mcp/src/server.ts" ;;
    openroly) echo "apps/cli/src/openroly.ts" ;;
    *) echo "unknown binary: $1 (openroly-mcp | openroly)" >&2; exit 2 ;;
  esac
}

mkdir -p "$out"
cd "$repo"

for name in $names; do
  entry=$(entry_for "$name")
  if [ "$host_only" -eq 1 ]; then
    echo "build $name (host)"
    bun build "$entry" --compile --outfile "$out/$name"
  else
    for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64; do
      echo "build $name (${target#bun-})"
      bun build "$entry" --compile --target="$target" --outfile "$out/$name-${target#bun-}"
    done
  fi
done

# 旧 binary 名の alias(PBI-0344 AC-4)。**黙って消さない** —— 端末の shell rc や launchd が
# 旧名を叩き続けている間は、同じ中身の binary を旧名でも置いておく(少なくとも 1 release)。
# glob は既に作った atn-* も拾うので、`*atn-mcp*` は飛ばす(2 回目の実行で self-copy しない)。
for f in "$out"/openroly-mcp*; do
  [ -e "$f" ] || continue
  # ${var/pat/rep} は POSIX sh に無い（ubuntu の /bin/sh = dash で Bad substitution 死 → exit 2・PBI-0380）
  base=${f##*/}
  case "$base" in *atn-mcp*) continue ;; esac
  cp "$f" "$out/atn-mcp${base#openroly-mcp}"
done
if [ -e "$out/openroly" ]; then cp "$out/openroly" "$out/atn"; fi

echo "done -> $out"
