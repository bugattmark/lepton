import json, re, urllib.request, ssl, concurrent.futures as cf

ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
UA = {"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"}
SOCIAL = ("instagram.com","facebook.com","twitter.com","x.com","tiktok.com","youtube.com","linkedin.com","threads.net","spotify.com")

def fetch(url, t=15):
    if not url.startswith("http"): url="https://"+url
    try:
        req=urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=t, context=ctx) as r:
            return r.read(600000).decode("utf-8","ignore")
    except Exception:
        try:
            req=urllib.request.Request(url.replace("https://","http://"), headers=UA)
            with urllib.request.urlopen(req, timeout=t, context=ctx) as r:
                return r.read(600000).decode("utf-8","ignore")
        except Exception:
            return ""

WA   = re.compile(r'(?:wa\.me/|api\.whatsapp\.com/send\?phone=|whatsapp\.com/send/\?phone=)(\+?\d{9,15})')
TEL  = re.compile(r'tel:(\+?[\d][\d\s().-]{7,}\d)')
MOB  = re.compile(r'(?:\+?44\s?\(?0?\)?\s?|0)7\d{3}\s?\d{3}\s?\d{3}')
LAND = re.compile(r'(?:\+?44\s?\(?0?\)?\s?|0)(?:1\d{2,3}|20|23|24|11\d|28|29|0844|0845|0800|0333)\s?\d{3,4}\s?\d{3,4}')

def norm(s):
    d=re.sub(r'[^\d+]','',s)
    if d.startswith('0'): d='+44'+d[1:]
    if d.startswith('44'): d='+'+d
    if d.startswith('7') and len(d)==10: d='+44'+d
    return d

def is_mobile(d): return d.startswith('+447') or d.startswith('07') or re.match(r'\+?447',d)

def find_phones(html):
    found=[]
    for m in WA.findall(html): found.append(('wa.me',norm(m)))
    for m in TEL.findall(html): found.append(('tel:',norm(m)))
    for m in MOB.findall(html): found.append(('text-mob',norm(m)))
    for m in LAND.findall(html): found.append(('text-land',norm(m)))
    # dedupe
    seen={};
    for src,d in found:
        if len(re.sub(r'\D','',d))>=10 and d not in seen: seen[d]=src
    return [(s,d) for d,s in seen.items()]

def unwrap(url):
    html=fetch(url)
    res={"url":url,"phones":[],"hop":None}
    if not html: return res
    ph=find_phones(html)
    # follow one hop for linktree/dice/eventbrite aggregators
    if ("linktr.ee" in url or "link.dice" in url or "eventbrite" in url or "dice.fm" in url or not ph):
        links=re.findall(r'href="(https?://[^"]+)"', html)+re.findall(r'"(https?://[^"]+?\.[a-z]{2,}/?[^"]*)"', html)
        for L in links:
            if any(s in L for s in SOCIAL) or "linktr.ee" in L or "eventbrite" in L or "dice" in L: continue
            if any(L.endswith(e) for e in (".png",".jpg",".css",".js",".svg",".ico")): continue
            h2=fetch(L,10)
            if h2:
                p2=find_phones(h2)
                if p2: res["hop"]=L; ph=ph+p2; break
    # dedupe again
    seen={}
    for s,d in ph:
        if d not in seen: seen[d]=s
    res["phones"]=[{"num":d,"src":s,"mobile":is_mobile(d)} for d,s in seen.items()]
    return res

# build url list: hiker external_urls + md sites
urls=[]
try:
    for r in json.load(open("bench/hiker.json")):
        if r.get("url","").startswith("http"): urls.append(r["url"])
except: pass
urls += [u.strip() for u in open("bench/md_sites.txt") if u.strip()]
urls=list(dict.fromkeys(urls))

out=[]
with cf.ThreadPoolExecutor(max_workers=12) as ex:
    for r in ex.map(unwrap, urls): out.append(r)
json.dump(out, open("bench/unwrap.json","w"), indent=2)

anyp=sum(1 for r in out if r["phones"])
mob=sum(1 for r in out if any(p["mobile"] for p in r["phones"]))
wa=sum(1 for r in out if any(p["src"]=="wa.me" for p in r["phones"]))
print(f"URLs processed: {len(out)}")
print(f"  any phone:      {anyp}/{len(out)} ({100*anyp//len(out)}%)")
print(f"  MOBILE/WA-able: {mob}/{len(out)} ({100*mob//len(out)}%)")
print(f"  wa.me present:  {wa}/{len(out)}")
print("\n--- sample hits ---")
for r in out:
    if r["phones"]:
        ph=", ".join(f"{p['num']}({p['src']}{'*MOB' if p['mobile'] else ''})" for p in r["phones"][:3])
        print(f"{r['url'][:46]:<48}{ph}")
