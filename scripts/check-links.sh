#!/usr/bin/env bash
# AWS 官方文件連結有效性檢查（確定性，不經過 LLM）
# 只對 AWS 文件站發 HTTP GET，不碰 AWS 帳號、不需要憑證。
#
# 用法：bash scripts/check-links.sh [檔案...]
#   預設檢查 references/aws-docs.md；也可指定 findings/*.md report/*.md 檢查報告內的連結。
#   有失效連結時 exit 1，全數有效 exit 0。
#
# 判別方式：AWS 兩個站的 404 特徵不同，兩種都要檢查——
#   docs.aws.amazon.com：SPA，不存在的頁面仍回 HTTP 200，但本體只有約 1.2KB 的殼
#   aws.amazon.com：本體正常大小，但 <title> 為 "Error - 404 - Not Found"
# 因此不能用 HTTP 狀態碼判斷，改以「本體大小 + 標題」為準。

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MIN_BYTES=3000   # 小於此值視為 docs 站的 404 空殼

FILES=("$@")
[ ${#FILES[@]} -eq 0 ] && FILES=("references/aws-docs.md")

# 抽出所有 AWS 官方連結（去重）
URLS="$(grep -rhoE 'https://[a-z0-9.-]*aws[a-z0-9.-]*\.(com|amazon\.com)/[^ )">]*' "${FILES[@]}" 2>/dev/null \
        | sed 's/[.,)]*$//' | sort -u)"

if [ -z "$URLS" ]; then
  echo "找不到任何 AWS 連結：${FILES[*]}" >&2
  exit 1
fi

TOTAL="$(printf '%s\n' "$URLS" | wc -l | tr -d ' ')"
echo "檢查 $TOTAL 個連結（來源：${FILES[*]}）"
echo ""

FAILED=0
while IFS= read -r url; do
  [ -z "$url" ] && continue
  body="$(curl -sSL --max-time 20 -A 'Mozilla/5.0 aws-report-link-check' "$url" 2>/dev/null)"
  n="$(printf %s "$body" | wc -c | tr -d ' ')"
  title="$(printf %s "$body" | grep -oiE '<title>[^<]*</title>' | head -1 | sed -E 's|</?[Tt][Ii][Tt][Ll][Ee]>||g')"

  if [ "$n" -lt "$MIN_BYTES" ]; then
    echo "  失效  $url"
    echo "        （本體僅 ${n} 位元組，為 docs 站的 404 空殼）"
    FAILED=$((FAILED + 1))
  elif printf %s "$title" | grep -qiE '(^| )Error - 404|404 - Not Found|Page Not Found'; then
    echo "  失效  $url"
    echo "        （標題：${title}）"
    FAILED=$((FAILED + 1))
  else
    echo "  ok    $url"
  fi
done <<< "$URLS"

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "=== 有 $FAILED / $TOTAL 個連結失效，請更新 references/aws-docs.md ==="
  exit 1
fi
echo "=== $TOTAL 個連結全數有效 ==="
