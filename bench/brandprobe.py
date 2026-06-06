"""Probe HikerAPI discovery endpoints for sourcing BRANDS by category / region.
Real calls. Prints shape + a category/region read on each candidate endpoint so we
can pick the winning discovery path before wiring it into src/sourcing.ts.
"""
import json, os, time, urllib.parse, urllib.request

KEY = None
for line in open(os.path.join(os.path.dirname(__file__), "..", ".env")):
    if line.startswith("HIKER_API_KEY="):
        KEY = line.split("=", 1)[1].strip()
BASE = "https://api.hikerapi.com"

def call(path, **params):
    url = BASE + path + "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(url, headers={"x-access-key": KEY, "user-agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode("utf-8", "replace")
    except Exception as e:
        return "ERR", str(e)[:200]

def users_from(obj):
    """Best-effort: pull user dicts out of whatever shape comes back."""
    if obj is None: return []
    if isinstance(obj, dict):
        for k in ("users", "accounts", "items", "response", "data"):
            v = obj.get(k)
            if isinstance(v, list): return v
        # topsearch style
        if "results" in obj and isinstance(obj["results"], list): return obj["results"]
        return [obj]
    if isinstance(obj, list): return obj
    return []

def show(label, status, obj, n=8):
    print(f"\n{'='*78}\n{label}\n  HTTP {status}")
    if not isinstance(obj, (dict, list)):
        print("  ->", obj); return []
    us = users_from(obj)
    if isinstance(obj, dict):
        print("  top keys:", list(obj.keys())[:12])
    print(f"  extracted ~{len(us)} user-ish items")
    rows = []
    for u in us[:n]:
        if not isinstance(u, dict): continue
        user = u.get("user") if isinstance(u.get("user"), dict) else u
        un = user.get("username")
        if not un: continue
        rows.append(user)
        print(f"   @{un:<24} cat={str(user.get('category') or user.get('category_name') or user.get('category_enum') or ''):<26}"
              f" biz={str(user.get('is_business'))[:5]:<5} foll={user.get('follower_count') or user.get('social_context') or ''}")
    return rows

# ---- 1. keyword account search: the brand+category workhorse ----------------
for q in ["skincare brand", "vintage clothing uk", "dubai fashion boutique"]:
    s, o = call("/v2/fbsearch/accounts", query=q)
    show(f"[1] /v2/fbsearch/accounts  query={q!r}", s, o)
    time.sleep(0.4)

# v3 variant (per schema there is /v3/fbsearch/accounts)
s, o = call("/v3/fbsearch/accounts", query="sustainable skincare")
show("[1b] /v3/fbsearch/accounts  query='sustainable skincare'", s, o)

# ---- 2. topsearch (accounts + media interleaved) ----------------------------
s, o = call("/v1/fbsearch/topsearch", query="coffee roaster london")
show("[2] /v1/fbsearch/topsearch query='coffee roaster london'", s, o)

# ---- 3. category expansion from a SEED brand id ----------------------------
# first resolve a seed brand username -> id, then ask for same-category recs
s, seed = call("/v1/user/by/username", username="glossier")
seed_id = None
if isinstance(seed, dict):
    su = seed.get("user") if isinstance(seed.get("user"), dict) else seed
    seed_id = su.get("pk") or su.get("id")
    print(f"\nseed glossier id={seed_id} cat={su.get('category')}")
if seed_id:
    s, o = call("/v2/user/explore/businesses/by/id", id=seed_id)
    show("[3] /v2/user/explore/businesses/by/id  (same-category recs for glossier)", s, o)
    time.sleep(0.4)
    s, o = call("/v2/user/suggested/profiles", target_id=seed_id)
    show("[4] /v2/user/suggested/profiles  (similar accounts to glossier)", s, o)

# ---- 5. REGION: place search -> top medias -> who posts there --------------
s, o = call("/v2/fbsearch/places", query="Dubai Mall")
show("[5] /v2/fbsearch/places query='Dubai Mall'", s, o)
place_pk = None
for cand in users_from(o):
    if isinstance(cand, dict):
        loc = cand.get("location") if isinstance(cand.get("location"), dict) else cand
        place_pk = loc.get("pk") or loc.get("id") or loc.get("location_id")
        if place_pk: break
print("  -> first place pk:", place_pk)
if place_pk:
    s, o = call("/v1/location/medias/top", id=place_pk)
    show("[5b] /v1/location/medias/top  (accounts posting at that place)", s, o)
