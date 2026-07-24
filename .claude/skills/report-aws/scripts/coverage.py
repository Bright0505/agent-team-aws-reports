#!/usr/bin/env python3
"""服務覆蓋率自檢：帳號實際用到哪些服務？scan.sh 有沒有全掃到？

由 scripts/digest.sh 呼叫，只讀本機 data/ 與 scan.sh 原始碼，不呼叫 AWS。

為什麼要有這支：
  掃描覆蓋率原本只能靠「多找幾個帳號來測」驗證，但案例少時無從得知漏了什麼。
  其實帳號本身就有「用了哪些服務」的權威清單——
    來源 A：Cost Explorer（有計費 = 確定在用），已存於 data/global/cost-by-service.json
    來源 B：Resource Groups Tagging API（現存資源 ARN），存於 data/regions/<R>/tagged-resources.json
  用 (A ∪ B) 去 diff scan.sh 實際掃的服務，就能確定性地標出「帳號有用、卻沒掃到」的缺口。
  不需要更多案例——現有帳號就是量化覆蓋率的基準，且每次掃描都會自動抓出新缺口。

canonical key ＝ ARN service namespace（小寫），AWS 定義的受控字彙，Tagging API 免費送。
三個來源都往它映射後才能 diff。

「已掃清單」不另外維護第二份，而是直接解析 scan.sh 的 run() 呼叫（單一事實來源、零漂移）：
  加新的 run() 自動被納入；出現沒登記過的 CLI token 就大聲列進「未能對應」，
  把對照表漂移變成看得見的告警，而不是靜默失準（沿用 digest.sh 的 loud-failure 文化）。

退出碼（關鍵取捨）：
  預設 report-only、回 0——即使有缺口也回 0。因為本支由 digest.sh 呼叫，digest.sh 把子程序
  非零視為 FAIL 而中斷整個掃描；覆蓋率缺口不必然是 bug（服務可能刻意不在報告範圍），
  不該中斷無人值守流程。人工稽核／CI 想把缺口當閘門時，設環境變數 COVERAGE_STRICT=1，
  此時有缺口或有未能對應項才回非零（且此模式應獨立執行，不走 digest.sh 路徑）。

盲點（誠實揭露，也寫進 coverage.md 檔頭）：
  1. 免費且不可貼標的服務兩來源都看不到（IAM 最典型），存在偵測下限——真正免費又非 taggable
     的服務仍靠 scan.sh 的人工判斷清單，本表不宣稱「已完整」。
  2. CE 無 region 維度（帳號全域）、可能落後未結帳；Tagging API 逐區、全域服務 ARN 可能缺 region。
  3. CE 服務顯示字串 AWS 偶爾會改（AmazonCloudWatch vs Amazon CloudWatch），故未對應一律列出。
  4. WAF 版本歧義：CE 只說「AWS WAF」，實體可能是 wafv2 / waf(classic)；此處歸到 wafv2。
"""
import json
import os
import re
import sys

DATA = os.path.join(os.getcwd(), "data")
DIGEST = os.path.join(DATA, "digest")
SCAN_SH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scan.sh")

# ── 對照表：CE human-readable 名稱 → canonical ARN service namespace ──────────
CE_NAME_TO_PREFIX = {
    "Amazon Elastic Compute Cloud - Compute": "ec2",
    "Amazon Elastic Compute Cloud": "ec2",
    "EC2 - Other": "ec2",
    "Amazon Virtual Private Cloud": "ec2",   # VPC/NAT/EIP 計費落在此名下，scan 由 ec2 涵蓋
    "Amazon Simple Storage Service": "s3",
    "Amazon Relational Database Service": "rds",
    "Amazon CloudFront": "cloudfront",
    "Amazon Elastic Load Balancing": "elasticloadbalancing",
    "Amazon Elastic Container Service": "ecs",
    "Amazon Elastic Container Registry (ECR)": "ecr",
    "Amazon EC2 Container Registry (ECR)": "ecr",
    "Amazon Elastic Kubernetes Service": "eks",
    "AmazonCloudWatch": "cloudwatch",
    "Amazon CloudWatch": "cloudwatch",
    "AWS Key Management Service": "kms",
    "Amazon Simple Queue Service": "sqs",
    "Amazon Simple Notification Service": "sns",
    "AWS Secrets Manager": "secretsmanager",
    "AWS Step Functions": "states",
    "Amazon API Gateway": "apigateway",
    "Amazon EventBridge": "events",
    "AWS Glue": "glue",
    "AWS WAF": "wafv2",
    "AWS CloudFormation": "cloudformation",
    "AWS Lambda": "lambda",
    "Amazon DynamoDB": "dynamodb",
    "Amazon ElastiCache": "elasticache",
    "Amazon Redshift": "redshift",
    "Amazon Elastic File System": "elasticfilesystem",
    "AWS Backup": "backup",
    "Amazon Route 53": "route53",
    "AWS Systems Manager": "ssm",
    "AWS Certificate Manager": "acm",
    "Amazon GuardDuty": "guardduty",
    "AWS Config": "config",
    "AWS CloudTrail": "cloudtrail",
    "AWS Security Hub": "securityhub",
    "Amazon Simple Email Service": "ses",
    "Amazon Kinesis": "kinesis",
    "Amazon OpenSearch Service": "es",
    "AWS Identity and Access Management": "iam",
}

# 非服務項（帳單費用類），濾掉不當服務
CE_IGNORE = re.compile(
    r"^(Tax|Refund|Credit|.*Savings Plan.*|.*Support.*|.*Discount.*|Enterprise Program Discount)$",
    re.IGNORECASE,
)

# scan.sh 的 CLI service token → canonical ARN prefix（未列者 identity）
CLI_TO_PREFIX = {
    "s3api": "s3",
    "elbv2": "elasticloadbalancing",
    "configservice": "config",
    "stepfunctions": "states",
    "apigatewayv2": "apigateway",
    "efs": "elasticfilesystem",
}

# 已登記、確認過 canonical 對應的 CLI token。scan.sh 出現不在此集合的新 token → 列進「未能對應」
CLI_KNOWN = {
    "ec2", "s3api", "iam", "cloudfront", "route53", "ce", "budgets",
    "autoscaling", "lambda", "ecs", "eks", "rds", "dynamodb", "elbv2",
    "cloudtrail", "configservice", "guardduty", "securityhub", "kms",
    "cloudwatch", "logs", "directconnect", "resourcegroupstaggingapi",
    "sqs", "sns", "apigateway", "apigatewayv2", "events", "stepfunctions",
    "secretsmanager", "ssm", "acm", "wafv2", "elasticache", "redshift",
    "efs", "ecr", "backup",
}


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def ce_service_totals():
    """回傳 {CE 顯示名稱: 合計金額(float)}，跨所有時間期加總。"""
    ce = load(os.path.join(DATA, "global", "cost-by-service.json"))
    totals = {}
    if not ce:
        return totals
    for period in ce.get("ResultsByTime", []):
        for g in period.get("Groups", []):
            keys = g.get("Keys") or []
            if not keys:
                continue
            name = keys[0]
            amt = 0.0
            try:
                amt = float(g.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", 0))
            except (TypeError, ValueError):
                amt = 0.0
            totals[name] = totals.get(name, 0.0) + amt
    return totals


def arn_prefix_counts(regions):
    """掃所有區的 tagged-resources.json，回傳 {ARN service prefix: 現存資源數}。"""
    counts = {}
    for r in regions:
        d = load(os.path.join(DATA, "regions", r, "tagged-resources.json"))
        if not d:
            continue
        for m in d.get("ResourceTagMappingList", []):
            arn = m.get("ResourceARN") or ""
            parts = arn.split(":")
            if len(parts) >= 3 and parts[0] == "arn" and parts[2]:
                svc = parts[2].lower()
                counts[svc] = counts.get(svc, 0) + 1
    return counts


def scanned_prefixes():
    """已掃清單 → (canonical prefix 集合, 未登記 CLI token 集合)。

    來源有二，聯集後為權威清單：
      1. scan.sh 裡仍寫死的 run() 呼叫（核心掃描＋餵明細迴圈的 list，regex 抽 CLI token）
      2. scan-catalog.json ＋ 專案根目錄 scan-catalog.local.json 的 .services[].service
         （一次性 list/describe 已抽成宣告式 catalog，由 run_from_catalog 驅動）
    未在 CLI_KNOWN 的 token 仍照樣列進「未能對應」，避免無聲失準。
    """
    scanned = set()
    unknown_tokens = set()

    def register(token):
        if token not in CLI_KNOWN:
            unknown_tokens.add(token)
        scanned.add(CLI_TO_PREFIX.get(token, token))

    # 來源 1：scan.sh 的 run() 呼叫
    try:
        with open(SCAN_SH) as f:
            src = f.read()
        # 只認「run "<路徑>" <字面服務token> <verb>」；服務 token 須為裸字（小寫字母開頭），
        # 藉此排除 run_from_catalog 內以變數呼叫的 `run "$prefix/$out" "$svc" ...`（那由 catalog 來源涵蓋）
        for m in re.finditer(r'^\s*run\s+"[^"]*"\s+([a-z][a-z0-9-]*)\s', src, re.MULTILINE):
            register(m.group(1))
    except OSError:
        pass

    # 來源 2：catalog（基線＋專案根目錄補充）
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    for catalog in (os.path.join(scripts_dir, "scan-catalog.json"),
                    os.path.join(os.getcwd(), "scan-catalog.local.json")):
        d = load(catalog)
        if not d:
            continue
        for entry in d.get("services", []):
            svc = entry.get("service")
            if svc:
                register(svc)

    return scanned, unknown_tokens


def main():
    regions_file = os.path.join(DATA, "active-regions.txt")
    regions = []
    if os.path.exists(regions_file):
        with open(regions_file) as f:
            regions = [r.strip() for r in f if r.strip()]

    ce_totals = ce_service_totals()
    arn_counts = arn_prefix_counts(regions)
    scanned, unknown_tokens = scanned_prefixes()

    # 用到的服務（canonical prefix）＝ CE ∪ ARN
    used = {}   # prefix -> {"ce": 金額 or None, "arn": 數量 or None}
    unmapped_ce = []
    for name, amt in ce_totals.items():
        if CE_IGNORE.match(name):
            continue
        p = CE_NAME_TO_PREFIX.get(name)
        if p is None:
            unmapped_ce.append((name, amt))
            continue
        used.setdefault(p, {"ce": None, "arn": None})
        used[p]["ce"] = (used[p]["ce"] or 0.0) + amt
    for p, c in arn_counts.items():
        used.setdefault(p, {"ce": None, "arn": None})
        used[p]["arn"] = (used[p]["arn"] or 0) + c

    used_set = set(used)
    gaps = sorted(used_set - scanned)
    scanned_used = sorted(used_set & scanned)
    scanned_only = sorted(scanned - used_set)

    def fmt_ce(v):
        return f"{v:.2f}" if v is not None else "—"

    def fmt_arn(v):
        return str(v) if v is not None else "—"

    out = []
    out.append("# 服務覆蓋率自檢")
    out.append("")
    out.append("由 `scripts/coverage.py` 從 **Cost Explorer（有計費＝確定在用）∪ "
               "Resource Groups Tagging API（現存資源 ARN）** 推導帳號實際用到的服務，"
               "再 diff `scan.sh` 實際掃描的服務。**不是 LLM 的判斷**。")
    out.append("")
    out.append("canonical key ＝ ARN service namespace（小寫）。已掃清單直接解析 scan.sh 的 "
               "`run()` 呼叫，加新掃描自動納入、永不漂移。")
    out.append("")
    out.append("> **偵測下限（誠實揭露，勿當「已完整」）**：免費且不可貼標的服務兩來源都看不到"
               "（IAM 最典型）；CE 無 region 維度、可能落後未結帳；Tagging API 逐區、全域服務"
               "ARN 可能缺 region。真正免費又非 taggable 的服務仍靠 scan.sh 的人工清單。")
    out.append("")
    out.append(f"**摘要：帳號用到 {len(used_set)} 個服務 / scan.sh 掃到（對應到用量的）"
               f"{len(scanned_used)} 個 / 覆蓋率缺口 {len(gaps)} 個**")
    out.append("")

    out.append("## ⚠️ 覆蓋率缺口（帳號有用、scan.sh 未掃）")
    out.append("")
    if gaps:
        out.append(f"以下 {len(gaps)} 個服務有計費或有現存資源，但 scan.sh 沒有任何對應的 "
                   "`run()`。建議在 scan.sh 加對應的唯讀 `list-*`／`describe-*` 呼叫。")
        out.append("")
        out.append("| 服務（canonical） | CE 計費(USD) | 現存 ARN 數 |")
        out.append("|---|---:|---:|")
        for p in gaps:
            out.append(f"| {p} | {fmt_ce(used[p]['ce'])} | {fmt_arn(used[p]['arn'])} |")
    else:
        out.append("（無）帳號用到的服務都有對應的掃描。")
    out.append("")

    out.append("## ✅ 已掃到且有使用")
    out.append("")
    if scanned_used:
        out.append("| 服務（canonical） | CE 計費(USD) | 現存 ARN 數 |")
        out.append("|---|---:|---:|")
        for p in scanned_used:
            out.append(f"| {p} | {fmt_ce(used[p]['ce'])} | {fmt_arn(used[p]['arn'])} |")
    else:
        out.append("（無）")
    out.append("")

    out.append("## 已掃但本期無計費／無現存資源（僅供參考，非缺口）")
    out.append("")
    out.append("scan.sh 有掃、但在 CE 與 Tagging API 都看不到用量——多為免費服務（IAM 等）、"
               "當期未使用、或不可貼標。這是正常的，不是缺口。")
    out.append("")
    out.append(", ".join(f"`{p}`" for p in scanned_only) if scanned_only else "（無）")
    out.append("")

    out.append("## 未能對應（請補對照表，不可忽略）")
    out.append("")
    out.append("以下項目工具無法確定 canonical 對應——屬工具自身失準（多半是 AWS 改了 CE 顯示"
               "字串，或 scan.sh 加了新服務但未登記）。請補進 `coverage.py` 的對照表後重跑。")
    out.append("")
    out.append("**CE 名稱（未在 CE_NAME_TO_PREFIX）**：")
    if unmapped_ce:
        for name, amt in sorted(unmapped_ce, key=lambda x: -x[1]):
            out.append(f"- `{name}`（計費 {amt:.2f} USD）")
    else:
        out.append("- （無）")
    out.append("")
    out.append("**scan.sh CLI token（未在 CLI_KNOWN）**：")
    if unknown_tokens:
        for t in sorted(unknown_tokens):
            out.append(f"- `{t}` → 暫以 identity 當 canonical，請確認 ARN namespace 是否一致")
    else:
        out.append("- （無）")
    out.append("")

    os.makedirs(DIGEST, exist_ok=True)
    path = os.path.join(DIGEST, "coverage.md")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")
    print(f"  coverage.md  {os.path.getsize(path)} 位元組"
          f"（用到 {len(used_set)}／掃到 {len(scanned_used)}／缺口 {len(gaps)}）")

    # 未能對應：一律大聲告警（stderr 可見），但預設不改退出碼——見檔頭「退出碼取捨」
    if unmapped_ce or unknown_tokens:
        print(f"    ⚠️ 覆蓋率自檢有 {len(unmapped_ce)} 個未對應 CE 名稱、"
              f"{len(unknown_tokens)} 個未登記 CLI token（見 coverage.md），請補對照表", file=sys.stderr)

    if os.environ.get("COVERAGE_STRICT") == "1" and (gaps or unmapped_ce or unknown_tokens):
        print(f"    ❌ COVERAGE_STRICT：缺口 {len(gaps)}、未對應 "
              f"{len(unmapped_ce) + len(unknown_tokens)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
