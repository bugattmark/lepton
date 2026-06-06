#!/usr/bin/env python3
# Map raw onbento brand+contacts -> BrandInput (our triage) and POST to the local seed endpoint.
import json, sys, urllib.request, os, glob

TENANT="227ed9ac-fec4-450f-a306-b779ca4d7770"
SECRET="bento_seed_9f3c1a7e4b"
SEED_URL="http://localhost:8080/api/seed/bento"

CONTACT_KEEP=["id","name","title","email","emailDomain","hunterScore","score",
              "hunterVerifiedAt","source","isDirectContact","manualVerificationRequired",
              "countryCode","location"]
SIGNALS=["pricePoint","size","tier","nicheness","targetGender","minTargetAge","maxTargetAge",
         "languages","mainLanguage","instagramCategory","instagramPostingFrequency",
         "instagramMostRecentPost","instagramPostCount","isSocialMediaVerified","hasShopifyShop",
         "compensationTypes","worksWithInfluencer","worksWithUgc","worksWithPodcasters",
         "worksWithProfileTypes","highestEmailScore","hasContacts","hasNonGenericContacts",
         "countries","continents","locations","allCategories","bentoBrandSimilarity","instagramPhotos"]

def norm_site(w):
    if not w: return None
    w=w.strip()
    if not w: return None
    return w if w.startswith("http") else "https://"+w

def map_contact(c):
    out={k:c.get(k) for k in CONTACT_KEEP if c.get(k) is not None}
    if "email" in out and "emailDomain" not in out and "@" in str(out["email"]):
        out["emailDomain"]=str(out["email"]).split("@")[-1]
    return out

def map_brand(b):
    iu=b.get("instagramUsername")
    contacts_raw=(b.get("__contacts") or {})
    sel=contacts_raw.get("selectableContacts") or []
    contacts=[map_contact(c) for c in sel]
    socials={}
    if iu: socials["instagram"]=iu
    if b.get("tiktokUsername"): socials["tiktok"]=b["tiktokUsername"]
    raw={k:v for k,v in b.items() if k not in ("__contacts","__contactsError")}
    enrichment={
        "signals":{k:b.get(k) for k in SIGNALS if b.get(k) is not None},
        "raw":raw,
    }
    return {
        "name": b.get("brandName"),
        "logoUrl": b.get("logoUrl"),
        "instagramHandle": iu,
        "instagramUrl": f"https://www.instagram.com/{iu}" if iu else None,
        "followers": b.get("instagramFollowerCount"),
        "website": norm_site(b.get("website")),
        "email": None, "phone": None,
        "description": b.get("aboutSummary"),
        "locationCity": None, "locationRegion": None,
        "locationCountry": b.get("countryName"),
        "categories": {"main": b.get("mainCategoryNames") or [], "secondary": b.get("secondaryCategoryNames") or []},
        "socials": socials or None,
        "contacts": contacts or None,
        "enrichment": enrichment,
        "source": "bento",
        "sourceRef": str(b.get("id")) if b.get("id") is not None else None,
    }

def post(rows):
    body=json.dumps({"tenantId":TENANT,"brands":rows}).encode()
    req=urllib.request.Request(SEED_URL,data=body,
        headers={"content-type":"application/json","x-seed-secret":SECRET})
    return json.load(urllib.request.urlopen(req,timeout=120))

if __name__=="__main__":
    files=sys.argv[1:] or sorted(glob.glob(os.path.expanduser("~/Downloads/bento_batch_*.json")))
    total_in=0
    for f in files:
        raw=json.load(open(f))
        rows=[map_brand(b) for b in raw if b.get("brandName")]
        total_in+=len(rows)
        res=post(rows)
        print(f"{os.path.basename(f)}: sent {len(rows)} -> inserted {res.get('inserted')} updated {res.get('updated')} | DB total {res.get('total')}")
    print(f"done. mapped {total_in} rows from {len(files)} file(s)")
