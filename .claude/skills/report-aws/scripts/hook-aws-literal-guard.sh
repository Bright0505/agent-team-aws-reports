#!/usr/bin/env bash
# PreToolUse hook：擋下「含 shell 展開的 aws 指令」（確定性，取代單靠 prompt 約束）
#
# 為什麼：settings 的 deny 清單是字串比對，`aws ... $(...)` 或 `$VAR` 展開後可能解析成
# 變更帳號的呼叫，deny 對展開失明。此 hook 在 Bash 工具執行前攔截：
# 指令中 aws 位於指令位置（開頭或 ;|&( 之後）且整條指令含 $(、${、$變數 或反引號 → 拒絕。
#
# 已知界限（防線疊加，不是唯一防線）：
#   - `VAR=x aws ...` 前綴賦值形式抓不到；直譯器內部呼叫 aws 抓不到——那兩類由 IAM 唯讀憑證擋。
#   - 版控內的固定腳本（bash .claude/skills/report-aws/scripts/scan.sh）不受影響：
#     外層指令是 bash+路徑，aws 不在指令位置。
#
# 介面：stdin 收 JSON（.tool_input.command），exit 2＝擋下（stderr 回饋給模型），exit 0＝放行。

set -u
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

# aws 在指令位置?
if ! printf '%s' "$cmd" | grep -qE '(^|[;&|(][[:space:]]*)aws[[:space:]]'; then
  exit 0
fi
# 含展開?（$( 、${ 、$字母 、反引號）
if printf '%s' "$cmd" | grep -qE '\$\(|\$\{|\$[A-Za-z_]|`'; then
  echo "已擋下：aws 指令不得含 \$變數/\$(...)/反引號展開（deny 清單對展開失明）。" >&2
  echo "需要帳號 ID 之類的值時，先用 Read 從 data/scan-meta.json 取出，把值直接寫進指令。" >&2
  exit 2
fi
exit 0
