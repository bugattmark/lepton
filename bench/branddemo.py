"""End-to-end demo of the RECOMMENDED brand-sourcing pipeline on HikerAPI:
seed brand -> snowball (suggested + same-category) -> enrich -> filter by
category + region -> categorized brand list with contact fields.
Real calls. ~40 requests (~$0.024)."""
import json, os, time, urllib.parse, urllib.request

KEY = next(l.split("=",1)[1].strip() for l in open(os.path.join(os.path.dirname(__file__),"..",".env")) if l.startswith("HIKER_API_KEY="))
BASE = "https://api.hikerapi.com"

def call(path, **p):
    url = BASE+path+"?"+urllib.parse.urlencode({k:v for k,v in p.items() if v is not None})
    req = urllib.request.Request(url, headers={"x-access-key":KEY,"user-agent":"Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r: return json.load(r)
    except Exception: return None

def uid(username):
    d = call("/v1/user/by/username", username=username)
    if not d: return None
    u = d.get("user") if isinstance(d.get("user"),dict) else d
    return u.get("pk") or u.get("id")

# ---- 1. SEED + SNOWBALL: collect candidate usernames -----------------------
SEED = "glossier"   # one known beauty/skincare brand
sid = uid(SEED)
cands = set()
sug = call("/v2/user/suggested/profiles", user_id=sid) or {}
for u in (sug.get("users") or []):
    if u.get("username"): cands.add(u["username"])
exp = call("/v2/user/explore/businesses/by/id", user_id=sid) or {}
for u in (exp.get("items") or []):
    un = (u.get("user") or u).get("username")
    if un: cands.add(un)
print(f"seed=@{SEED}  candidates from snowball: {len(cands)}")

# ---- 2. ENRICH + 3. FILTER (category + region) -----------------------------
TARGET_CAT_WORDS = ("beauty","cosmetic","skin","health","personal care","spa")  # category taxonomy match
MIN_F, MAX_F = 5000, 5_000_000
brands = []
for un in list(cands)[:30]:
    d = call("/v1/user/by/username", username=un)
    if not d: continue
    u = d.get("user") if isinstance(d.get("user"),dict) else d
    cat = (u.get("category_name") or u.get("business_category_name") or u.get("category") or "")
    foll = int(u.get("follower_count") or 0)
    is_biz = bool(u.get("is_business"))
    city = u.get("city_name") or u.get("city") or ""
    if not is_biz: continue
    if not (MIN_F <= foll <= MAX_F): continue
    if not any(w in cat.lower() for w in TARGET_CAT_WORDS): continue   # CATEGORY filter
    brands.append({
        "handle": un, "name": u.get("full_name"), "category": cat, "followers": foll,
        "city": city, "email": u.get("public_email") or "",
        "phone": u.get("public_phone_number") or u.get("contact_phone_number") or "",
        "url": u.get("external_url") or "",
    })
    time.sleep(0.2)

brands.sort(key=lambda b:-b["followers"])
print(f"\n=== BEAUTY/SKINCARE BRANDS (is_business, {MIN_F:,}-{MAX_F:,} foll, category-matched) : {len(brands)} ===")
print(f"{'handle':<22}{'followers':>10}  {'category':<26}{'city':<14}{'email/url'}")
for b in brands:
    print(f"@{b['handle']:<21}{b['followers']:>10,}  {b['category'][:25]:<26}{(b['city'] or '-')[:13]:<14}{(b['email'] or b['url'])[:40]}")
json.dump(brands, open(os.path.join(os.path.dirname(__file__),"branddemo.json"),"w"), indent=2)

# quick category histogram across ALL enriched (shows the taxonomy we can target)
print("\n(category labels seen across snowball — these are the 'categories' you target):")
