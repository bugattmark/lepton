import json, time, urllib.request

HK = "kqoc0j65ejuihy794hxaop2cer48xn2w"
HANDLES = ["suppersby","skcsupperclubs","so_last_century","go.east.vintage","folkandbespoke",
"thecraftandflea","mp4presents","errantminds","insomniacz_events","pinataplay",
"bellestreetproductions","ukstandupclub","bittenpeachuk","shenaniganscabaretuk","7pmcomedy",
"honeywoods_bec","taraknott_","viviennemayweddings"]

def get(h):
    url = "https://api.hikerapi.com/v1/user/by/username?username=" + h
    req = urllib.request.Request(url, headers={"x-access-key": HK})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)

rows = []
for h in HANDLES:
    try:
        d = get(h)
        rows.append({
            "handle": h,
            "followers": d.get("follower_count"),
            "is_business": d.get("is_business"),
            "acct_type": d.get("account_type"),
            "email": d.get("public_email") or "",
            "ig_phone": d.get("public_phone_number") or d.get("contact_phone_number") or "",
            "url": d.get("external_url") or "",
        })
    except Exception as e:
        rows.append({"handle": h, "followers": "ERR", "is_business": "", "acct_type": "",
                     "email": "", "ig_phone": "", "url": str(e)[:50]})
    time.sleep(0.4)

json.dump(rows, open("bench/hiker.json", "w"), indent=2)
print(f"{'handle':<24}{'foll':>8}  {'biz':<5}{'email':<34}{'igPhone':<14}url")
for r in rows:
    print(f"{r['handle']:<24}{str(r['followers']):>8}  {str(r['is_business']):<5}{r['email'][:33]:<34}{str(r['ig_phone'])[:13]:<14}{r['url'][:45]}")
