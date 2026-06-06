#!/usr/bin/env python3
"""
Native-ChatGPT phone sourcing — one OpenAI Responses API call per lead, with the
built-in `web_search` tool. No Exa, no scraping: the model searches the live web
(OpenTable, Eventbrite, Yell, Facebook About, Companies House, the official site)
and returns a validated UK mobile + source URL. Pure HTTP so it ports 1:1 to the
wa-saas Node backend.

Usage:
  OPENAI_API_KEY=sk-... python3 bench/gpt_phone.py [model] [max_workers]
"""
import os, sys, json, re, time, urllib.request, urllib.error, concurrent.futures as cf

API_KEY = os.environ["OPENAI_API_KEY"]
MODEL   = sys.argv[1] if len(sys.argv) > 1 else "gpt-5.5"
WORKERS = int(sys.argv[2]) if len(sys.argv) > 2 else 12
EFFORT  = sys.argv[3] if len(sys.argv) > 3 else "medium"   # none|low|medium|high|xhigh
URL     = "https://api.openai.com/v1/responses"

INSTR = None  # no system prompt — just like typing into the web app


def lead_query(L):
    who = L.get("h") or L.get("s") or L["n"]
    extra = f" ({L['n']}, {L['a']})" if L.get("h") else f" ({L['n']})"
    return (f"can u find phone number for these guys: {who}{extra}? "
            f"output phone number in the format +44. mobile phone num preferred. "
            f"if none confidently found, output none.")


def call(L):
    payload = {
        "model": MODEL,
        "tools": [{"type": "web_search"}],
        "tool_choice": "required",
        "reasoning": {"effort": EFFORT},
        "input": lead_query(L),
    }
    if INSTR:
        payload["instructions"] = INSTR
    body = json.dumps(payload).encode()
    data = None; lasterr = ""
    for attempt in range(5):
        req = urllib.request.Request(URL, data=body, headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            lasterr = f"HTTP {e.code}: {e.read()[:200].decode('utf-8','ignore')}"
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1)); continue
            break
        except Exception as e:
            lasterr = f"ERR {e}"; time.sleep(2 * (attempt + 1)); continue
    if data is None:
        return {"name": L["n"], "phone": "", "phone_type": "none", "confidence": "none",
                "source_url": "", "email": "", "notes": lasterr}

    # pull assistant text out of the Responses output
    txt = data.get("output_text") or ""
    if not txt:
        for item in data.get("output", []):
            if item.get("type") == "message":
                for c in item.get("content", []):
                    if c.get("type") in ("output_text", "text"):
                        txt += c.get("text", "")
    return parse_reply(L, txt, data)


def parse_reply(L, txt, data):
    # pull first UK number out of the plain-text reply
    raw = re.sub(r'[^\d+]', '', txt.replace('(0)', ''))
    m = re.search(r'(?:\+?44|0)7\d{9}', txt.replace(' ', '').replace('-', ''))
    mob = m.group(0) if m else None
    if not mob:
        m = re.search(r'(?:\+?44|0)[12389]\d{8,9}', txt.replace(' ', '').replace('-', ''))
    phone = ""; ptype = "none"
    if m:
        d = re.sub(r'\D', '', m.group(0))
        if d.startswith('0'): d = '44' + d[1:]
        if d.startswith('44'): phone = '+' + d
        ptype = "mobile" if re.match(r'\+447\d{9}$', phone) else ("landline" if phone else "none")
    # grab a source url if the model cited one
    src = ""
    u = re.search(r'https?://[^\s")\]]+', txt)
    if u: src = u.group(0)
    u2 = (data or {}).get("usage", {}) or {}
    return {"name": L["n"], "phone": phone, "phone_type": ptype,
            "confidence": "likely" if phone else "none",
            "source_url": src, "email": "", "notes": txt[:160].replace('\n', ' '),
            "in_tok": u2.get("input_tokens", 0), "out_tok": u2.get("output_tokens", 0)}


def main():
    lf = os.environ.get("LEADS_FILE", "leads.json")
    leads = json.load(open(os.path.join(os.path.dirname(__file__), lf)))
    print(f"model={MODEL} effort={EFFORT} workers={WORKERS} leads={len(leads)}\n", flush=True)
    results = [None] * len(leads)
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(call, L): i for i, L in enumerate(leads)}
        done = 0
        for f in cf.as_completed(futs):
            i = futs[f]; results[i] = f.result(); done += 1
            r = results[i]
            print(f"[{done:>2}/{len(leads)}] {r.get('name','?')[:34]:<35} "
                  f"{r.get('phone') or '—':<16}{r.get('phone_type','?'):<9}{r.get('confidence','?')}",
                  flush=True)
    outf = os.environ.get("OUT_FILE", "gpt_phone.json")
    json.dump(results, open(os.path.join(os.path.dirname(__file__), outf), "w"), indent=2)

    mob = sum(1 for r in results if r.get("phone_type") == "mobile" and r.get("phone"))
    land = sum(1 for r in results if r.get("phone_type") == "landline" and r.get("phone"))
    ver = sum(1 for r in results if r.get("confidence") == "verified" and r.get("phone"))
    n = len(results)
    print(f"\n=== {MODEL} ===")
    print(f"mobile:   {mob}/{n} ({100*mob//n}%)")
    print(f"landline: {land}/{n} ({100*land//n}%)")
    print(f"any phone:{mob+land}/{n} ({100*(mob+land)//n}%)")
    print(f"verified (2-source): {ver}/{n}")
    # rough token cost (does NOT include the web_search tool fee, which is billed separately)
    it = sum(r.get("in_tok", 0) for r in results); ot = sum(r.get("out_tok", 0) for r in results)
    print(f"tokens: in={it} out={ot}  avg/lead in={it//n} out={ot//n}")
    print(f"NOTE: web_search tool fee (~$10-25/1k calls) is billed on top of tokens, 1 call/lead min")


if __name__ == "__main__":
    main()
