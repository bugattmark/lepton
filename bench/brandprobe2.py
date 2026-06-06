"""Round 2: corrected params for the high-value brand-discovery endpoints."""
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
        return e.code, e.read()[:400].decode("utf-8", "replace")
    except Exception as e:
        return "ERR", str(e)[:200]

def users_from(obj):
    if isinstance(obj, dict):
        for k in ("users", "accounts", "items", "response", "data", "results"):
            if isinstance(obj.get(k), list): return obj[k]
        return [obj]
    return obj if isinstance(obj, list) else []

def line(user):
    u = user.get("user") if isinstance(user.get("user"), dict) else user
    un = u.get("username");  cat = u.get("category") or u.get("category_name") or ""
    return f"   @{str(un):<26} cat={str(cat):<28} biz={str(u.get('is_business'))[:5]:<5} foll={u.get('follower_count') or u.get('social_context') or ''}"

def show(label, status, obj, n=10):
    print(f"\n{'='*78}\n{label}\n  HTTP {status}")
    if not isinstance(obj, (dict, list)): print("  ->", obj); return
    if isinstance(obj, dict): print("  keys:", list(obj.keys())[:12])
    us = [x for x in users_from(obj) if isinstance(x, dict)]
    print(f"  ~{len(us)} items")
    for u in us[:n]:
        if (u.get("user") or u).get("username"): print(line(u))

# seed id
s, seed = call("/v1/user/by/username", username="glossier")
su = seed.get("user") if isinstance(seed, dict) and isinstance(seed.get("user"), dict) else seed
sid = su.get("pk") or su.get("id")
print("glossier id:", sid, "| category field on profile:", repr(su.get("category")),
      "| is_business:", su.get("is_business"), "| keys:", [k for k in su.keys() if 'cat' in k.lower() or 'business' in k.lower()])

# [3] category expansion (THE one) — param is user_id
s, o = call("/v2/user/explore/businesses/by/id", user_id=sid)
show("[3] /v2/user/explore/businesses/by/id user_id=glossier (same-category brands)", s, o)
time.sleep(0.3)

# [4] similar accounts — param is user_id
s, o = call("/v2/user/suggested/profiles", user_id=sid)
show("[4] /v2/user/suggested/profiles user_id=glossier (similar accounts)", s, o)
time.sleep(0.3)

# [2] gql topsearch (accounts+media interleaved)
s, o = call("/gql/topsearch", query="coffee roaster london", flat="true")
show("[2] /gql/topsearch query='coffee roaster london'", s, o)
time.sleep(0.3)

# [5] region: place -> top medias -> authors
s, places = call("/v2/fbsearch/places", query="Dubai Mall")
pk = None
for it in users_from(places):
    loc = it.get("location") if isinstance(it, dict) and isinstance(it.get("location"), dict) else it
    pk = (loc or {}).get("pk") or (loc or {}).get("location_id") or (loc or {}).get("id")
    if pk: print("\nfirst place:", (loc or {}).get("name"), pk, "| place keys:", list((loc or {}).keys())[:10]); break
if pk:
    s, o = call("/v1/location/medias/top", location_pk=pk)
    print(f"\n[5b] /v1/location/medias/top location_pk={pk}  HTTP {s}")
    meds = users_from(o)
    print("  ~", len(meds), "medias; authors:")
    seen=set()
    for m in meds[:14]:
        u = (m.get("user") or {}) if isinstance(m, dict) else {}
        un = u.get("username")
        if un and un not in seen:
            seen.add(un); print(f"   @{un:<26} cat={u.get('category') or ''}")

# enrichment confirm: does by/username carry category for a real brand?
for h in ["drbrandt","redcactusvintageuk"]:
    s, d = call("/v1/user/by/username", username=h)
    u = d.get("user") if isinstance(d, dict) and isinstance(d.get("user"), dict) else d
    if isinstance(u, dict):
        print(f"\nenrich @{h}: cat={u.get('category')!r} biz={u.get('is_business')} foll={u.get('follower_count')} email={u.get('public_email')!r} url={u.get('external_url')!r}")
