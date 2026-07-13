#!/usr/bin/env bash
# 掃描資料精簡（本機 jq，確定性；不呼叫 AWS、不需要憑證）
#
# 用法：bash scripts/digest.sh          （scan.sh 末尾自動呼叫；也可單獨重跑）
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
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/data"
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
    echo "    ❌ 斷言失敗：服務數不符（原始 $n_src、digest $((n_dst - 1))）" >&2
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
