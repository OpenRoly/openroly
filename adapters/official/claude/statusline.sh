#!/usr/bin/env bash
# openroly の未読を Claude Code の statusline に出す(PBI-0130)。
#
# settings.json の statusLine から呼ぶ。render のたびに走るので、ここでは **HTTP を待たない**:
#   1. cache(~/.openroly/statusline)が在れば、その中身をそのまま出す(cat 1 回。bun を起動しない)
#   2. 最終試行から TTL 秒たっていたら、`openroly statusline --refresh` を背景に投げて即戻る
#      (次の render で新しい値が出る。起動口は binary(~/.openroly/bin/openroly)→ bun の順 — PBI-0132)
# 何が欠けていても **何も出さずに exit 0**。statusline に error 文字列を出さない・入力を止めない。
#
# 表示は件数だけ(組み立ては packages/adapter/src/brief.ts の formatStatusline が正本 ——
# この script は文字列を組まない)。
set -u

OPENROLY_DIR="${OPENROLY_HOME:-$HOME/.openroly}"
CACHE="$OPENROLY_DIR/statusline"
# 最終「試行」時刻。cache 本体と分けるのは、server 断で cache を更新しない時でも
# 再試行の間隔を守るため(毎 render で bun を起こさない)
STAMP="$CACHE.at"
TTL="${OPENROLY_STATUSLINE_TTL:-30}"

[ -f "$CACHE" ] && cat "$CACHE"

# 未接続の Mac では更新もしない
[ -f "$OPENROLY_DIR/credentials.json" ] || exit 0

# 更新の起動口: binary → bun + repo checkout の順(PBI-0132。binary が在れば bun を呼ばない)
if [ -x "$OPENROLY_DIR/bin/openroly" ]; then
  set -- "$OPENROLY_DIR/bin/openroly"
elif command -v bun >/dev/null 2>&1; then
  REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd) || exit 0
  [ -f "$REPO/apps/cli/src/openroly.ts" ] || exit 0
  set -- bun "$REPO/apps/cli/src/openroly.ts"
else
  exit 0
fi

now=$(date +%s)
last=0
if [ -f "$STAMP" ]; then
  # **`stat -f` を先に試してはいけない**(PBI-0313) —— GNU coreutils の `-f` は `--file-system` で、
  # `%m` は file system 用の書式に無いので **`%m` をそのまま印字して exit 0**。`||` の fallback が
  # 走らず、mtime の代わりに文字列 `%m` が返って TTL の比較が壊れる(Linux で毎回 refresh に倒れる)
  if stat -c %Y . >/dev/null 2>&1; then
    last=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)   # GNU coreutils
  else
    last=$(stat -f %m "$STAMP" 2>/dev/null || echo 0)   # BSD (macOS)
  fi
fi
[ $((now - last)) -lt "$TTL" ] && exit 0

# spawn の前に印を付ける —— 更新が失敗しても次の render がまた bun を起こさない
mkdir -p "$OPENROLY_DIR" 2>/dev/null || exit 0
touch "$STAMP" 2>/dev/null || exit 0

# 背景で更新して即戻る(前景で待たない = 入力が固まらない)
nohup "$@" statusline --refresh >/dev/null 2>&1 &
exit 0
