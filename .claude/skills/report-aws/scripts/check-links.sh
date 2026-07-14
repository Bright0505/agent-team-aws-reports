#!/usr/bin/env bash
# AWS 官方文件連結有效性檢查（確定性，不經過 LLM）
# 只對 AWS 文件站發 HTTP GET，不碰 AWS 帳號、不需要憑證。
#
# 用法：bash .claude/skills/report-aws/scripts/check-links.sh [檔案或目錄...]
#   預設檢查 skill 內整個 references/ 目錄（依支柱拆分的 aws-docs-*.md）；
#   也可指定 findings/*.md report/*.md 檢查報告內的連結。
#   退出碼：有「確認失效」的連結 exit 1；只有「無法連線（網路問題）」exit 0 但列警告。
#
# 判別方式：AWS 兩個站的 404 特徵不同，兩種都要檢查——
#   docs.aws.amazon.com：SPA，不存在的頁面仍回 HTTP 200，但本體只有約 1.2KB 的殼
#   aws.amazon.com：本體正常大小，但 <title> 為 "Error - 404 - Not Found"
# 因此不能用 HTTP 狀態碼判斷，改以「本體大小 + 標題」為準。
# curl 失敗/空回應 ≠ 失效——那是網路問題，重試一次後仍失敗則標「無法連線」，
# 與「確認失效」分開計（暫時性網路抖動不該讓確定性檢查閘出假警報）。
#
# 連結以 xargs -P8 平行檢查（序列跑最壞會被單一慢站放大到分鐘級）。

set -u
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

MIN_BYTES=3000   # 小於此值視為 docs 站的 404 空殼

# ── 單一 URL 檢查模式（由 xargs 平行呼叫自身）────────────────────────
if [ "${1:-}" = "--check-one" ]; then
  url="$2"
  fetch() { curl -sSL --max-time 20 -A 'Mozilla/5.0 aws-report-link-check' "$url" 2>/dev/null; }
  body="$(fetch)"
  if [ -z "$body" ]; then
    sleep 2
    body="$(fetch)"   # 重試一次：區分暫時性網路抖動與真失效
  fi
  n="$(printf %s "$body" | wc -c | tr -d ' ')"
  title="$(printf %s "$body" | grep -oiE '<title>[^<]*</title>' | head -1 | sed -E 's|</?[Tt][Ii][Tt][Ll][Ee]>||g')"
  if [ -z "$body" ]; then
    printf 'UNREACHABLE\t%s\t連線失敗（重試一次後仍無回應，網路問題非失效）\n' "$url"
  elif [ "$n" -lt "$MIN_BYTES" ]; then
    printf 'DEAD\t%s\t本體僅 %s 位元組（docs 站 404 空殼）\n' "$url" "$n"
  elif printf %s "$title" | grep -qiE '(^| )Error - 404|404 - Not Found|Page Not Found'; then
    printf 'DEAD\t%s\t標題：%s\n' "$url" "$title"
  else
    printf 'OK\t%s\t\n' "$url"
  fi
  exit 0
fi

# ── 主模式 ──────────────────────────────────────────────────────────
FILES=("$@")
[ ${#FILES[@]} -eq 0 ] && FILES=("$SKILL_DIR/references")

URLS="$(grep -rhoE 'https://[a-z0-9.-]*aws[a-z0-9.-]*\.(com|amazon\.com)/[^ )">]*' "${FILES[@]}" 2>/dev/null \
        | sed 's/[.,)]*$//' | sort -u)"

if [ -z "$URLS" ]; then
  echo "找不到任何 AWS 連結：${FILES[*]}" >&2
  exit 1
fi

TOTAL="$(printf '%s\n' "$URLS" | wc -l | tr -d ' ')"
echo "檢查 $TOTAL 個連結（來源：${FILES[*]}；8 路平行）"
echo ""

RESULTS="$(printf '%s\n' "$URLS" | xargs -P 8 -I {} bash "$0" --check-one "{}")"

DEAD_N=0; UNREACH_N=0
while IFS=$'\t' read -r status url detail; do
  case "$status" in
    OK)          echo "  ok      $url" ;;
    DEAD)        echo "  失效    $url"; echo "          （${detail}）"; DEAD_N=$((DEAD_N + 1)) ;;
    UNREACHABLE) echo "  ⚠️ 連不上 $url"; echo "          （${detail}）"; UNREACH_N=$((UNREACH_N + 1)) ;;
  esac
done <<< "$RESULTS"

echo ""
if [ "$DEAD_N" -gt 0 ]; then
  echo "=== 有 $DEAD_N / $TOTAL 個連結確認失效，請更新 references/ 下對應支柱的目錄檔 ==="
  [ "$UNREACH_N" -gt 0 ] && echo "（另有 $UNREACH_N 個連不上——網路問題，稍後重跑確認）"
  exit 1
fi
if [ "$UNREACH_N" -gt 0 ]; then
  echo "=== 無確認失效；$UNREACH_N / $TOTAL 個連不上（網路問題，稍後重跑確認），其餘全數有效 ==="
  exit 0
fi
echo "=== $TOTAL 個連結全數有效 ==="
