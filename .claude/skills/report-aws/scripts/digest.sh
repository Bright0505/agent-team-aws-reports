#!/usr/bin/env bash
# 掃描資料精簡（本機 jq，確定性；不呼叫 AWS、不需要憑證）
#
# 用法（從專案根目錄）：bash .claude/skills/report-aws/scripts/digest.sh （scan.sh 末尾自動呼叫；也可單獨重跑）
#
# 為什麼不在 scan.sh 用 --query 裁切：
#   --query 是「擷取時破壞、不可逆」——欄位判斷錯了只能重掃帳號，但重掃時帳號狀態已變，
#   會破壞報告「期別＝已結束週期的快照」的稽核軌跡。且 --query 欄位名打錯時 AWS CLI
#   靜默回 null 且 exit 0，run() 完全接不住。
#   改由本機 jq 從完整的 data/ 衍生 data/digest/：判斷錯了改 jq 重跑即可，秒級、離線、
#   可重現，原始證據永遠保留。
#
# 只精簡「樣板欄位多」的檔案。load-balancers（13 欄）、target-groups（18 欄，全是健康檢查
# 設定）、rds-instances（57 欄但四支柱各有所用）本來就精實，壓縮它們等於刪掉某支柱要用的
# 欄位，省不多又高風險——故不處理，agent 直接讀原始檔。
#
# ⚠️ 必要欄位斷言：每個 digest 產出後會斷言關鍵證據欄位仍存在，少一個就 exit 1。
#    這些欄位是既有發現的唯一證據來源（見下方各段註解），刪掉不會讓 agent 寫「資料缺口」，
#    而是讓它推出相反的結論（例：WebACLId 消失 → 從「未掛 WAF」變成「沒問題」）。
#    新增檢查重點而需要新欄位時，補進投影並在此加斷言。

set -u
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_ROOT="$PWD"
if [ ! -f "$WORK_ROOT/CLAUDE.md" ]; then
  echo "錯誤：請從專案根目錄執行：bash .claude/skills/report-aws/scripts/digest.sh" >&2
  exit 1
fi
DATA="$WORK_ROOT/data"
DIGEST="$DATA/digest"

# 沒有掃描資料就直接失敗——若放任 if [ -f ] 守衛逐一跳過，腳本會什麼都沒做卻回報成功，
# 正是「靜默無作為」的失敗模式。
if [ ! -f "$DATA/active-regions.txt" ]; then
  echo "錯誤：找不到 $DATA/active-regions.txt，請先執行 bash scripts/scan.sh" >&2
  exit 1
fi

mkdir -p "$DIGEST"

FAIL=0
MADE=0

# assert <說明> <jq 條件> <檔案>
assert() {
  if jq -e "$2" "$3" > /dev/null 2>&1; then
    echo "    ✅ $1"
  else
    echo "    ❌ 斷言失敗：$1（$3）" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "=== 產生 data/digest/ ==="

# ── 成本：Cost Explorer 輸出轉樞紐表 ────────────────────────────────
# 原始 JSON 每個 group 用 10 行包一個數字（3 期 × 17 服務 = 51 個 group）。
# 純數字重排，無欄位可失，零證據風險。
CE="$DATA/global/cost-by-service.json"
if [ -f "$CE" ]; then
  jq -r '
    [.ResultsByTime[] | .TimePeriod.Start[0:7]] as $months
    | [ .ResultsByTime[] as $r | $r.Groups[]
        | {m: $r.TimePeriod.Start[0:7], k: .Keys[0],
           a: (.Metrics.UnblendedCost.Amount | tonumber)} ] as $rows
    | ($rows | group_by(.k)
        | map({k: .[0].k, by: (map({(.m): .a}) | add), t: (map(.a) | add)})
        | sort_by(-.t)) as $svc
    | "# 各服務成本（USD，UnblendedCost）",
      "",
      "來源：data/global/cost-by-service.json（Cost Explorer）。此表為該檔的完整重排，無欄位省略。",
      "",
      (["| 服務 "] + ($months | map("| \(.) ")) + ["| 合計 |"] | add),
      (["|---"] + ($months | map("|---:")) + ["|---:|"] | add),
      ( $svc[] | . as $s
        | (["| \($s.k) "]
           + ($months | map("| \(($s.by[.] // 0) | .*100 | round / 100) "))
           + ["| \($s.t | .*100 | round / 100) |"] | add) ),
      (["| **合計** "]
       + ($months | map(. as $m | "| **\([$svc[] | .by[$m] // 0] | add | .*100 | round / 100)** "))
       + ["| **\([$svc[] | .t] | add | .*100 | round / 100)** |"] | add)
  ' "$CE" > "$DIGEST/cost-by-service.md"
  echo "  cost-by-service.md  $(wc -c < "$CE") → $(wc -c < "$DIGEST/cost-by-service.md") 位元組"
  MADE=$((MADE + 1))
  # 斷言：服務數與總額須與原始檔一致（重排不得遺漏任何服務）
  n_src="$(jq -r '[.ResultsByTime[].Groups[].Keys[0]] | unique | length' "$CE")"
  n_dst="$(grep -c '^| [^*-]' "$DIGEST/cost-by-service.md" || true)"
  if [ "$n_src" -eq "$((n_dst - 1))" ]; then
    echo "    ✅ 服務數一致（$n_src 個）"
  else
    echo "    ❌ 斷言失敗：服務數不符（原始 ${n_src}、digest $((n_dst - 1))）" >&2
    FAIL=$((FAIL + 1))
  fi
fi

# ── S3：把 s3-buckets-detail/ 的一堆小檔併成一張表 ──────────────────
# 掃描會為每個 bucket 產生 4–5 個各約 270 位元組的小檔（3 bucket = 12 個檔）。
# agent 要看完就得 Read 十幾次，於是會忍不住改用 `for` 迴圈 + cat——那含 shell 展開，
# 一定會觸發權限確認、破壞無人值守。合併成一張表後，一次 Read 就看完，誘因消失。
#
# ⚠️ 缺檔的語意必須區分，否則會推出相反結論：
#    NoSuchLifecycleConfiguration / NoSuchPublicAccessBlock 等 → 該項「未設定」（這是有效證據）
#    AccessDenied 等其他錯誤                                   → 「查詢失敗」（這是資料缺口）
#    versioning 檔存在但為空 → AWS CLI 對從未啟用版本控制的 bucket 回空輸出 → 「未啟用」
S3LIST="$DATA/global/s3-buckets.json"
S3D="$DATA/global/s3-buckets-detail"
if [ -f "$S3LIST" ] && [ -d "$S3D" ]; then
  # 判斷某個 detail 檔的狀態：值 / 未設定 / 查詢失敗
  s3state() {  # $1=bucket $2=aspect  → 印出狀態字串
    local f="$S3D/$1-$2.json"
    if [ -f "$f" ]; then
      if [ ! -s "$f" ]; then echo "__EMPTY__"; else cat "$f"; fi
    elif grep -q "s3-buckets-detail/$1-$2 " "$ERRLOG_D" 2>/dev/null && \
         grep -B1 "s3-buckets-detail/$1-$2 " "$ERRLOG_D" 2>/dev/null | grep -qiE 'NoSuch|NotFound|does not exist'; then
      echo "__UNSET__"
    else
      echo "__ERROR__"
    fi
  }
  ERRLOG_D="$DATA/scan-errors.log"

  {
    echo "# S3 Bucket 設定總表"
    echo ""
    echo "來源：data/global/s3-buckets.json 與 data/global/s3-buckets-detail/（12 個小檔的合併）。"
    echo "「未設定」＝AWS 回報該項組態不存在（有效證據）；「⚠️ 查詢失敗」＝其他錯誤，屬資料缺口，"
    echo "請查 data/scan-errors.log 再下判斷，不要當成「未設定」。"
    echo ""
    echo "| Bucket | 公開存取封鎖 (PAB) | 預設加密 | 版本控制 | Bucket Policy 公開 | 生命週期 |"
    echo "|---|---|---|---|---|---|"
    for b in $(jq -r '.Buckets[].Name' "$S3LIST"); do
      # PAB：四個旗標全 true 才算完全封鎖
      pab_raw="$(s3state "$b" public-access-block)"
      case "$pab_raw" in
        __UNSET__) pab="未設定" ;;
        __ERROR__) pab="⚠️ 查詢失敗" ;;
        __EMPTY__) pab="未設定" ;;
        *) if printf '%s' "$pab_raw" | jq -e '[.PublicAccessBlockConfiguration | to_entries[].value] | all' >/dev/null 2>&1; then
             pab="全部封鎖"
           elif printf '%s' "$pab_raw" | jq -e '[.PublicAccessBlockConfiguration | to_entries[].value] | any | not' >/dev/null 2>&1; then
             # 四個旗標全 false ＝ 完全沒有封鎖。不可寫成「部分封鎖」——那會暗示有在擋，
             # 讓 agent 低估風險（上一版報告的 SEC-02［高］三個 bucket 全部公開，靠的就是這項證據）。
             pab="**完全未封鎖**（四項全 false）"
           else
             pab="部分封鎖：未開啟 $(printf '%s' "$pab_raw" | jq -r '[.PublicAccessBlockConfiguration | to_entries[] | select(.value|not) | .key] | join("/")')"
           fi ;;
      esac

      enc_raw="$(s3state "$b" encryption)"
      case "$enc_raw" in
        __UNSET__|__EMPTY__) enc="未設定" ;;
        __ERROR__) enc="⚠️ 查詢失敗" ;;
        *) enc="$(printf '%s' "$enc_raw" | jq -r '[.ServerSideEncryptionConfiguration.Rules[].ApplyServerSideEncryptionByDefault.SSEAlgorithm] | join(",")' 2>/dev/null || echo '?')" ;;
      esac

      ver_raw="$(s3state "$b" versioning)"
      case "$ver_raw" in
        __EMPTY__|__UNSET__) ver="未啟用" ;;
        __ERROR__) ver="⚠️ 查詢失敗" ;;
        *) ver="$(printf '%s' "$ver_raw" | jq -r '.Status // "未啟用"' 2>/dev/null || echo '未啟用')" ;;
      esac

      pol_raw="$(s3state "$b" policy-status)"
      case "$pol_raw" in
        __UNSET__|__EMPTY__) pol="無 policy" ;;
        __ERROR__) pol="⚠️ 查詢失敗" ;;
        *) pol="$(printf '%s' "$pol_raw" | jq -r 'if .PolicyStatus.IsPublic then "**公開**" else "非公開" end' 2>/dev/null || echo '?')" ;;
      esac

      lc_raw="$(s3state "$b" lifecycle)"
      case "$lc_raw" in
        __UNSET__|__EMPTY__) lc="未設定" ;;
        __ERROR__) lc="⚠️ 查詢失敗" ;;
        *) lc="$(printf '%s' "$lc_raw" | jq -r '[.Rules[].ID] | join(",")' 2>/dev/null || echo '有')" ;;
      esac

      echo "| $b | $pab | $enc | $ver | $pol | $lc |"
    done
  } > "$DIGEST/s3-buckets.md"

  NB="$(jq -r '.Buckets | length' "$S3LIST")"
  # 資料列＝以 "| " 開頭、且不是表頭那一列（分隔列以 "|-" 開頭，不會被算到）
  ND="$(grep '^| ' "$DIGEST/s3-buckets.md" | grep -vc '^| Bucket ' || true)"
  echo "  s3-buckets.md  $(du -sk "$S3D" | cut -f1)K（12 個小檔） → $(wc -c < "$DIGEST/s3-buckets.md") 位元組"
  MADE=$((MADE + 1))
  if [ "$NB" -eq "$ND" ]; then
    echo "    ✅ bucket 數一致（${NB}）"
  else
    echo "    ❌ 斷言失敗：bucket 數不符（原始 ${NB}、digest ${ND}）" >&2
    FAIL=$((FAIL + 1))
  fi
fi

# ── CloudFront ─────────────────────────────────────────────────────
# 必留證據：WebACLId（COST-01 孤兒 WAF、COST-02 停用發佈仍掛 WAF、良好實務「PRD 已掛 WAF」）
#           Origins[].OriginProtocolPolicy / OriginSslProtocols（SEC-05 http-only 回源繞過 WAF）
#           Origins[].HTTPSPort + CacheBehaviors（PERF origin 指 https 但 ALB 無 443 監聽器）
#           Enabled（COST-02 已停用但仍掛 WAF）
CF="$DATA/global/cloudfront-distributions.json"
if [ -f "$CF" ]; then
  jq '{DistributionList: {Items: [.DistributionList.Items[] | {
    Id, ARN, DomainName, Status, Enabled, Comment, Staging,
    Aliases: .Aliases.Items,
    WebACLId, HttpVersion, IsIPV6Enabled, PriceClass,
    Restrictions: .Restrictions.GeoRestriction.RestrictionType,
    OriginGroupsQuantity: .OriginGroups.Quantity,
    Origins: [.Origins.Items[] | {
      Id, DomainName, OriginPath, OriginAccessControlId,
      OriginProtocolPolicy: .CustomOriginConfig.OriginProtocolPolicy,
      HTTPSPort: .CustomOriginConfig.HTTPSPort,
      OriginSslProtocols: .CustomOriginConfig.OriginSslProtocols.Items,
      S3OriginAccessIdentity: .S3OriginConfig.OriginAccessIdentity }],
    DefaultCacheBehavior: {
      ViewerProtocolPolicy: .DefaultCacheBehavior.ViewerProtocolPolicy,
      Compress: .DefaultCacheBehavior.Compress,
      AllowedMethods: .DefaultCacheBehavior.AllowedMethods.Items,
      CachePolicyId: .DefaultCacheBehavior.CachePolicyId },
    CacheBehaviors: [(.CacheBehaviors.Items // [])[] | {
      PathPattern, ViewerProtocolPolicy, TargetOriginId, Compress }],
    ViewerCertificate: {
      MinimumProtocolVersion: .ViewerCertificate.MinimumProtocolVersion,
      SSLSupportMethod: .ViewerCertificate.SSLSupportMethod,
      CertificateSource: .ViewerCertificate.CertificateSource,
      CloudFrontDefaultCertificate: .ViewerCertificate.CloudFrontDefaultCertificate }
  }]}}' "$CF" > "$DIGEST/cloudfront-distributions.json"
  echo "  cloudfront-distributions.json  $(wc -c < "$CF") → $(wc -c < "$DIGEST/cloudfront-distributions.json") 位元組"
  MADE=$((MADE + 1))

  N="$(jq -r '.DistributionList.Items | length' "$CF")"
  D="$DIGEST/cloudfront-distributions.json"
  assert "發佈數一致（$N 個）"          ".DistributionList.Items | length == $N" "$D"
  assert "WebACLId 保留"                "[.DistributionList.Items[] | select(has(\"WebACLId\"))] | length == $N" "$D"
  assert "Enabled 保留"                 "[.DistributionList.Items[] | select(has(\"Enabled\"))] | length == $N" "$D"
  assert "Origins[].OriginProtocolPolicy 保留" \
         "[.DistributionList.Items[].Origins[] | select(has(\"OriginProtocolPolicy\"))] | length > 0" "$D"
  assert "Origins[].HTTPSPort 保留" \
         "[.DistributionList.Items[].Origins[] | select(has(\"HTTPSPort\"))] | length > 0" "$D"
  assert "ViewerCertificate.MinimumProtocolVersion 保留" \
         "[.DistributionList.Items[] | select(.ViewerCertificate | has(\"MinimumProtocolVersion\"))] | length == $N" "$D"
fi

# ── Subnets / Route Tables（逐區域）────────────────────────────────
# 必留證據：Tags（SEC-09／REL：PRD「private」子網實為公網可路由——沒有 Name 標籤，
#           agent 只會看到「某子網 MapPublicIpOnLaunch=true」而推論「這是公有子網，正常」，
#           得出相反結論。Tags 是「命名意圖 vs 實際組態落差」的唯一依據。）
while IFS= read -r R; do
  [ -z "$R" ] && continue
  SRC="$DATA/regions/$R"; OUT="$DIGEST/regions/$R"; mkdir -p "$OUT"

  if [ -f "$SRC/subnets.json" ]; then
    jq '{Subnets: [.Subnets[] | {SubnetId, VpcId, AvailabilityZone, CidrBlock,
      MapPublicIpOnLaunch, State, AvailableIpAddressCount, DefaultForAz, Tags}]}' \
      "$SRC/subnets.json" > "$OUT/subnets.json"
    echo "  regions/$R/subnets.json  $(wc -c < "$SRC/subnets.json") → $(wc -c < "$OUT/subnets.json") 位元組"
    MADE=$((MADE + 1))
    N="$(jq -r '.Subnets | length' "$SRC/subnets.json")"
    # 變數後緊貼全形字元須用 ${N}，否則 bash 會把全形字元當成變數名的一部分、set -u 報錯
    assert "subnets 筆數一致（${N}）" ".Subnets | length == $N" "$OUT/subnets.json"
    assert "subnets Tags 保留"      "[.Subnets[] | select(has(\"Tags\"))] | length == $N" "$OUT/subnets.json"
    assert "subnets MapPublicIpOnLaunch 保留" \
           "[.Subnets[] | select(has(\"MapPublicIpOnLaunch\"))] | length == $N" "$OUT/subnets.json"
  fi

  if [ -f "$SRC/route-tables.json" ]; then
    jq '{RouteTables: [.RouteTables[] | {RouteTableId, VpcId, Routes, PropagatingVgws, Tags,
      Associations: [.Associations[] | {SubnetId, Main}]}]}' \
      "$SRC/route-tables.json" > "$OUT/route-tables.json"
    echo "  regions/$R/route-tables.json  $(wc -c < "$SRC/route-tables.json") → $(wc -c < "$OUT/route-tables.json") 位元組"
    MADE=$((MADE + 1))
    N="$(jq -r '.RouteTables | length' "$SRC/route-tables.json")"
    assert "route-tables 筆數一致（${N}）" ".RouteTables | length == $N" "$OUT/route-tables.json"
    assert "route-tables Tags 保留"      "[.RouteTables[] | select(has(\"Tags\"))] | length == $N" "$OUT/route-tables.json"
    assert "route-tables Routes 保留"    "[.RouteTables[] | select(has(\"Routes\"))] | length == $N" "$OUT/route-tables.json"
  fi
done < "$DATA/active-regions.txt"

# ── 掃描缺口表：把「空回應」與「失敗」分清楚 ────────────────────────
# 沒有這張表時，agent 看到 0 位元組的 data/global/budgets.json 分不清是
# 「帳號真的沒有 Budget」還是「掃描默默失敗了」，於是會自己組指令回頭問 AWS——
# 那類指令含 $(...) 展開，必定觸發權限確認、破壞無人值守（2026-07-13 實際發生過）。
# 給它一個權威答案，它就不需要自己去查。
ERRLOG_S="$DATA/scan-errors.log"
if [ -f "$ERRLOG_S" ]; then
  {
    echo "# 掃描缺口表"
    echo ""
    echo "來源：data/scan-errors.log。**這是關於「查不到的東西」的權威答案，不要自己回頭呼叫 AWS 補查。**"
    echo ""
    echo "## 未設定（AWS 回空回應）——這是有效證據，不是資料缺口"
    echo ""
    echo "呼叫成功但 AWS 回空，代表該項組態**確實不存在**。可以直接據此下發現（例：帳號沒有任何 Budget 告警）。"
    echo ""
    # 直接掃 data/ 找 0 位元組的檔——這是地面真相，比讀 scan-errors.log 可靠
    # （舊版 run() 不會寫 EMPTY:，但空檔照樣存在；靠檔案本身判斷就不會漏）
    EMPTIES="$(find "$DATA" -name '*.json' -size 0 -not -path "$DIGEST/*" 2>/dev/null | sed "s|^$DATA/||" | sort)"
    if [ -n "$EMPTIES" ]; then
      echo "| 項目 | 意義 |"
      echo "|---|---|"
      printf '%s\n' "$EMPTIES" | while IFS= read -r item; do
        echo "| \`$item\` | 未設定（AWS 回空回應） |"
      done
    else
      echo "（無）"
    fi
    echo ""
    echo "## 查詢失敗——真正的資料缺口"
    echo ""
    echo "錯誤訊息含 \`NoSuch\` / \`NotFound\` / \`does not exist\` 者，同樣代表「該項未設定」（有效證據）；"
    echo "其餘（權限不足、服務未啟用）才是真正查不到，寫入報告的「資料缺口」段落。"
    echo ""
    if grep -q '^FAILED:' "$ERRLOG_S" 2>/dev/null; then
      echo "| 項目 | 判定 |"
      echo "|---|---|"
      grep '^FAILED:' "$ERRLOG_S" | sed 's/^FAILED: //' | while IFS= read -r line; do
        item="${line%% ::*}"
        if grep -B1 -F "FAILED: $item " "$ERRLOG_S" | grep -qiE 'NoSuch|NotFound|does not exist'; then
          echo "| \`$item\` | 未設定（該組態不存在）——有效證據 |"
        else
          echo "| \`$item\` | **資料缺口**（權限不足／服務未啟用，見 scan-errors.log） |"
        fi
      done
    else
      echo "（無）"
    fi
  } > "$DIGEST/scan-gaps.md"
  echo "  scan-gaps.md  $(wc -c < "$DIGEST/scan-gaps.md") 位元組（空回應 vs 資料缺口）"
  MADE=$((MADE + 1))
  if grep -q "未設定（AWS 回空回應）" "$DIGEST/scan-gaps.md" && grep -q "查詢失敗" "$DIGEST/scan-gaps.md"; then
    echo "    ✅ 缺口表兩個區塊都在"
  else
    echo "    ❌ 斷言失敗：缺口表缺少區塊" >&2
    FAIL=$((FAIL + 1))
  fi
fi

# ── 跨檔關聯：把要比對好幾個檔才看得出來的網路事實算成結論 ──────────
# （子網實際路由／命名為 private 卻通 IGW／RDS 落在公有還是私有子網）
# 這類機械性比對不該交給 LLM 判斷——2026-07 的驗證跑就是漏了這一步，
# 把「RDS 落在全部通 IGW 的公有子網」[高] 降級成「RDS 可公開存取」[中]。
if python3 "$SKILL_DIR/scripts/network-facts.py"; then
  MADE=$((MADE + 1))
  NF="$DIGEST/network-facts.md"
  # 斷言：三個關聯區塊都要在（少任何一段代表關聯沒算出來，等於又把判斷丟回給 LLM）
  for sec in "子網的實際對外路由" "命名與實際組態的落差" "RDS 的實際網路落點"; do
    if grep -q "$sec" "$NF"; then
      echo "    ✅ 網路事實：${sec}"
    else
      echo "    ❌ 斷言失敗：網路事實表缺少「${sec}」區塊" >&2
      FAIL=$((FAIL + 1))
    fi
  done
else
  echo "    ❌ network-facts.py 執行失敗" >&2
  FAIL=$((FAIL + 1))
fi

echo ""
if [ "$MADE" -eq 0 ]; then
  echo "=== 精簡失敗：沒有產出任何 digest ===" >&2
  echo "data/ 下找不到預期的來源檔，掃描可能不完整。" >&2
  exit 1
fi
if [ "$FAIL" -gt 0 ]; then
  echo "=== 精簡失敗：$FAIL 項欄位斷言未通過 ===" >&2
  echo "digest 遺失了既有發現所依賴的證據欄位，請修正 scripts/digest.sh 的投影後重跑。" >&2
  exit 1
fi
echo "=== 精簡完成，所有證據欄位斷言通過 ==="
