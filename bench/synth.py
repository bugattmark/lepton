import json, re

# strict UK validation
def valid_uk_mobile(d):
    d=re.sub(r'[^\d+]','',d)
    m=re.fullmatch(r'\+447\d{9}', d)          # +44 7XXXXXXXXX  (07 + 9)
    if not m: return None
    digits=d[3:]                               # 7XXXXXXXXX
    if re.search(r'(\d)\1{5,}', digits): return None      # 000000 / repeats = placeholder
    if digits.endswith('000000') or digits.endswith('123456'): return None
    return d

def valid_uk_landline(d):
    d=re.sub(r'[^\d+]','',d)
    if not re.fullmatch(r'\+44(1\d{8,9}|2\d{9}|3\d{9}|8\d{8,9})', d): return None
    if re.search(r'(\d)\1{5,}', d): return None
    if '123456789' in d: return None
    return d

hiker={r['handle']:r for r in json.load(open('bench/hiker.json'))}
unwrap={r['url']:r for r in json.load(open('bench/unwrap.json'))}

def best(rec):
    """return (validated_mobile, validated_phone, high_conf) for an unwrap record"""
    mob=None; land=None; hc=False
    for p in rec.get('phones',[]):
        vm=valid_uk_mobile(p['num']); vl=valid_uk_landline(p['num'])
        if p['src'] in ('tel:','wa.me'):           # high-confidence source
            if vm: mob=mob or vm; hc=True
            elif vl: land=land or vl; hc=True
        if vm: mob=mob or vm
        elif vl: land=land or vl
    return mob, (mob or land), hc

# ---- per-method on the 16 resolved handles (the comparable cohort) ----
HANDLES=[h for h,r in hiker.items() if r['followers']!='ERR']
rows=[]
for h in HANDLES:
    hr=hiker[h]
    ig_phone = valid_uk_mobile('+44'+re.sub(r'\D','',hr['ig_phone'])[-10:]) if hr['ig_phone'] else None
    url=hr['url']
    um, up, hc = best(unwrap.get(url, {})) if url.startswith('http') else (None,None,False)
    agree = bool(ig_phone and um and ig_phone==um)
    rows.append(dict(h=h, foll=hr['followers'], ig=ig_phone, web_mob=um, web_any=up, hc=hc, email=bool(hr['email']), agree=agree))

n=len(rows)
def pct(c): return f"{c}/{n} ({100*c//n}%)"
print(f"=== HANDLE COHORT (n={n} resolved IG handles) ===\n")
print(f"{'handle':<22}{'foll':>7}  {'HikerAPI igPhone':<18}{'web-unwrap mobile':<18}{'agree'}")
for r in rows:
    print(f"{r['h']:<22}{str(r['foll']):>7}  {str(r['ig'] or '—'):<18}{str(r['web_mob'] or '—'):<18}{'✓' if r['agree'] else ''}")

print(f"\n--- method fill on handle cohort ---")
print(f"HikerAPI public_phone (mobile):   {pct(sum(1 for r in rows if r['ig']))}")
print(f"HikerAPI public_email:            {pct(sum(1 for r in rows if r['email']))}")
print(f"Web-unwrap VALID mobile:          {pct(sum(1 for r in rows if r['web_mob']))}")
print(f"Web-unwrap high-conf (tel:/wa):   {pct(sum(1 for r in rows if r['hc']))}")
print(f"COMBINED (Hiker ig OR web mobile):{pct(sum(1 for r in rows if r['ig'] or r['web_mob']))}")
print(f"Cross-method AGREEMENT (Hiker==web): {sum(1 for r in rows if r['agree'])} (these are gold — 2 sources confirm)")

# ---- full 66-URL web-unwrap precision audit ----
allrecs=list(unwrap.values())
raw=sum(1 for r in allrecs if r.get('phones'))
vmob=sum(1 for r in allrecs if best(r)[0])
vany=sum(1 for r in allrecs if best(r)[1])
hcc=sum(1 for r in allrecs if best(r)[2])
N=len(allrecs)
print(f"\n=== WEB-UNWRAP PRECISION AUDIT (all {N} URLs) ===")
print(f"raw 'has a phone-shaped match':   {raw}/{N} ({100*raw//N}%)  <- inflated")
print(f"VALID UK mobile after filter:     {vmob}/{N} ({100*vmob//N}%)  <- honest")
print(f"VALID any (mobile or landline):   {vany}/{N} ({100*vany//N}%)")
print(f"high-confidence (tel:/wa.me src): {hcc}/{N} ({100*hcc//N}%)  <- safest to dial")
