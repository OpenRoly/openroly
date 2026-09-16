#!/usr/bin/env bash
# PBI-0557: Claude Code が usage limit(API の rate limit)で turn を落とした時に、その事を work に残す。
# plugin の hooks/hooks.json(StopFailure・matcher rate_limit)から呼ばれる。StopFailure は出力も
# exit code も捨てられる(event は通知・log 専用)なので、ここでの目的は副作用の 1 行だけ ——
# 何が欠けていても何も出さず exit 0(statusline.sh と同じ規律。入力を止めない・error を見せない)。
#
# `openroly work stalled --reason usage_limit` は id を渡さない(hook は work id を知らない):
# この端末の runtime が claim した live lease の work に 1 本に絞れる時だけ diagnostic が積まれ、
# 絞れなければ何も起きない(別の runtime が動かしている work に「claude が止まった」を付けない)。
# 起動口は binary(~/.openroly/bin/openroly)→ bun + repo checkout の順(statusline.sh と同じ)。

OPENROLY_DIR="${OPENROLY_HOME:-$HOME/.openroly}"

[ -f "$OPENROLY_DIR/credentials.json" ] || exit 0

if [ -x "$OPENROLY_DIR/bin/openroly" ]; then
  set -- "$OPENROLY_DIR/bin/openroly"
elif command -v bun >/dev/null 2>&1; then
  # hooks/ は statusline.sh より 1 段深い: hooks → claude → official → adapters → repo(PBI-0565)
  REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." 2>/dev/null && pwd) || exit 0
  [ -f "$REPO/apps/cli/src/openroly.ts" ] || exit 0
  set -- bun "$REPO/apps/cli/src/openroly.ts"
else
  exit 0
fi

# 前景で待つ(StopFailure は turn の終わりで走るので入力は固まらない)。失敗しても黙って戻る
"$@" work stalled --reason usage_limit >/dev/null 2>&1 &
exit 0
