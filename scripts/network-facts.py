#!/usr/bin/env python3
"""跨檔關聯:把「要比對好幾個檔才看得出來」的網路事實直接算成結論。

由 scripts/digest.sh 呼叫,只讀本機 data/,不呼叫 AWS。

為什麼要有這支:
  2026-07 的驗證跑發現,security-auditor 把「正式 RDS 落在全部通 IGW 的公有子網」這項
  [高] 發現降級成 [中]「RDS 可公開存取」,並給出「確認 DB 位於無 IGW 路由的私有子網」
  這條在本帳號做不到的建議(六個子網全部通 IGW,根本沒有私有子網)。
  證據當時全都在 data/ 裡,但那需要跨三個檔交叉比對(rds-instances × subnets × route-tables),
  LLM 沒做這一步就漏掉了。

  這種「機械性的跨檔比對」不該交給 LLM 判斷——它會忘、會隨機。算成事實表之後,
  agent 讀到的直接是結論,沒有機會漏。

注意:沒有明確關聯路由表的子網,會落到該 VPC 的 main route table——
      這一步不能省,本帳號 18 個子網裡就有 6 個是這種。
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DIGEST = os.path.join(DATA, "digest")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def name_of(tags):
    for t in tags or []:
        if t.get("Key") == "Name":
            return t.get("Value")
    return None


def region_facts(region, out):
    # 優先讀 digest（已保留 Tags/Routes），沒有才退回原始檔
    def pick(fname):
        d = load(os.path.join(DIGEST, "regions", region, fname))
        return d if d else load(os.path.join(DATA, "regions", region, fname))

    subnets = (pick("subnets.json") or {}).get("Subnets", [])
    rtbs = (pick("route-tables.json") or {}).get("RouteTables", [])
    rds = (load(os.path.join(DATA, "regions", region, "rds-instances.json")) or {}).get("DBInstances", [])
    if not subnets or not rtbs:
        return False

    # VPC 的 main route table（未明確關聯的子網會落到這張）
    main_rt = {}
    for r in rtbs:
        if any(a.get("Main") for a in r.get("Associations") or []):
            main_rt[r.get("VpcId")] = r

    # 子網 → 生效的 route table
    explicit = {}
    for r in rtbs:
        for a in r.get("Associations") or []:
            if a.get("SubnetId"):
                explicit[a["SubnetId"]] = r

    def igw_route(rt):
        for rr in (rt or {}).get("Routes") or []:
            gw = rr.get("GatewayId") or ""
            if gw.startswith("igw-"):
                return gw
        return None

    rows = []
    for s in subnets:
        sid = s["SubnetId"]
        rt = explicit.get(sid) or main_rt.get(s.get("VpcId"))
        igw = igw_route(rt)
        rows.append({
            "id": sid,
            "name": name_of(s.get("Tags")) or "(無 Name)",
            "vpc": s.get("VpcId"),
            "az": s.get("AvailabilityZone"),
            "rtb": (rt or {}).get("RouteTableId", "(查無路由表)"),
            "via_main": sid not in explicit,
            "igw": igw,
            "auto_pub_ip": s.get("MapPublicIpOnLaunch"),
        })

    out.append(f"\n## {region}\n")
    out.append("### 子網的實際對外路由\n")
    out.append("「有效路由表」＝該子網明確關聯的路由表；未明確關聯者落到 VPC 的 main route table（標 *main*）。\n")
    out.append("| 子網名稱 | 子網 ID | AZ | 有效路由表 | 0.0.0.0/0 → IGW | 自動配公有 IP |")
    out.append("|---|---|---|---|---|---|")
    for r in sorted(rows, key=lambda x: x["name"]):
        rtb = r["rtb"] + (" *main*" if r["via_main"] else "")
        igw = f"**是**（{r['igw']}）" if r["igw"] else "否"
        rows_pub = "是" if r["auto_pub_ip"] else "否"
        out.append(f"| {r['name']} | {r['id']} | {r['az']} | {rtb} | {igw} | {rows_pub} |")

    # 命名矛盾：名字說 private，路由卻通 IGW
    contra = [r for r in rows if "private" in (r["name"] or "").lower() and r["igw"]]
    out.append("\n### ⚠️ 命名與實際組態的落差\n")
    if contra:
        out.append(f"**有 {len(contra)} 個子網命名為 private，實際卻有 `0.0.0.0/0 → IGW` 的路由（＝公有子網）**：\n")
        for r in contra:
            out.append(f"- `{r['name']}`（{r['id']}）→ 路由表 `{r['rtb']}` 通 `{r['igw']}`"
                       f"{'；且自動配發公有 IP' if r['auto_pub_ip'] else ''}")
        out.append("\n這代表「命名意圖」與「實際組態」不符：架構上以為有私有層，實際上沒有。")
        out.append("任何「把資源移到私有子網」的建議，在本帳號都必須先**建立**真正的私有子網（無 IGW 路由），")
        out.append("不能只寫「確認位於私有子網」——因為目前不存在這種子網。")
    else:
        out.append("無：命名為 private 的子網都沒有 IGW 路由。")

    # RDS 落點
    if rds:
        out.append("\n### RDS 的實際網路落點\n")
        out.append("| RDS | PubliclyAccessible | DB subnet group | 子網組成 |")
        out.append("|---|---|---|---|")
        by_id = {r["id"]: r for r in rows}
        for db in rds:
            sids = [x.get("SubnetIdentifier") for x in (db.get("DBSubnetGroup") or {}).get("Subnets") or []]
            pub = [s for s in sids if by_id.get(s, {}).get("igw")]
            priv = [s for s in sids if s in by_id and not by_id[s].get("igw")]
            unknown = [s for s in sids if s not in by_id]
            if sids and len(pub) == len(sids):
                comp = f"**{len(sids)} 個子網全部是公有（全部通 IGW）**"
            elif pub:
                comp = f"{len(pub)} 個公有 / {len(priv)} 個私有"
            elif sids:
                comp = f"{len(priv)} 個全部是私有"
            else:
                comp = "（無 DB subnet group 資料）"
            if unknown:
                comp += f"；{len(unknown)} 個子網不在掃描資料中（資料缺口）"
            pa = "**true**" if db.get("PubliclyAccessible") else "false"
            out.append(f"| `{db.get('DBInstanceIdentifier')}` | {pa} | "
                       f"`{(db.get('DBSubnetGroup') or {}).get('DBSubnetGroupName','?')}` | {comp} |")
    return True


def main():
    regions_file = os.path.join(DATA, "active-regions.txt")
    if not os.path.exists(regions_file):
        print("錯誤：找不到 data/active-regions.txt，請先執行 bash scripts/scan.sh", file=sys.stderr)
        return 1
    with open(regions_file) as f:
        regions = [r.strip() for r in f if r.strip()]

    out = [
        "# 網路事實表（跨檔關聯，確定性計算）",
        "",
        "由 `scripts/network-facts.py` 從 `subnets` / `route-tables` / `rds-instances` 交叉比對算出，",
        "**不是 LLM 的判斷**。這些關聯要同時看三個檔才看得出來，容易被漏掉，故先算成結論。",
        "",
        "引用時對回 `data/regions/<區域>/` 的原始檔（本表只是它們的確定性推導）。",
    ]
    made = any(region_facts(r, out) for r in regions)
    if not made:
        print("錯誤：沒有任何區域算得出網路事實（subnets/route-tables 缺漏）", file=sys.stderr)
        return 1

    os.makedirs(DIGEST, exist_ok=True)
    path = os.path.join(DIGEST, "network-facts.md")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")
    print(f"  network-facts.md  {os.path.getsize(path)} 位元組（跨檔關聯：子網路由／命名落差／RDS 落點）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
