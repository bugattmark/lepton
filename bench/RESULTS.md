# Phone-sourcing benchmark — UK small event organisers (n=78 from uk-event-organisers.md)

Goal: given an Instagram handle and/or website for a small UK event organiser, find a
**WhatsApp-reachable phone** (valid UK mobile preferred). Metric that matters = **valid
mobile/phone fill**, not raw "found something". All numbers below are from **real API calls**.

## TL;DR — the winner

**OpenAI `gpt-5.4` + native `web_search` tool, one call per lead.** ~34% phone fill,
~$0.043/lead (~$0.16 per phone actually found), **zero scraping infrastructure**. This is
implemented in `src/iglead.ts` (`lookupPhone` / `lookupPhones`). Set `IGLEAD_MODEL=gpt-5.5`
if you need max recall (44%) and will pay ~30% more per result.

The remaining ~55-65% of leads **publish no phone anywhere** (email/contact-form only) —
a true ceiling, confirmed independently by a careful manual ChatGPT web pass. No tool fixes
this; those leads need an inbound `wa.me` funnel or an email-first channel.

---

## ChatGPT-with-web-search: the real findings

### Effort level controls recall (and latency, and cost)
Plain bare prompt ("can u find phone number for these guys: @x?"), `tool_choice:required`:

| Effort | Time/lead | Fill | Note |
|---|---|---|---|
| `low`, 1 search | ~7s | 29% | gives up after one search page |
| `medium`, 2-3 searches | ~25s | **44%** (gpt-5.5) | the web app's actual setting |
| `high`, multi-search | ~2-3min | ~50%+ on tail | over-collects venue numbers; not worth latency |

### Model tier — the cost lever (measured, medium, plain prompt, n=78)

| Model | Recall | tokens/lead (in/out) | $/lead | **$ per phone found** | /1,000 leads |
|---|---|---|---|---|---|
| **gpt-5.5** | **35/78 (44%)** | ~8.9k / 384 | ~$0.071 | **$0.20** | ~$71 |
| **gpt-5.4** ← default | 27/78 (34%) | 8961 / 384 | ~$0.043 | **$0.16** | ~$43 |
| gpt-5.4-mini | **1/78 (1%)** | 102 / 3 | — | — | ❌ **does NOT run the search loop** — returns "none" immediately. Unusable. |

Cost driver is **input tokens (~9k/lead = the web_search reasoning loop)**, NOT the search
fee. The web_search tool itself is only $10/1k calls = ~$0.01-0.015/lead. So model tier,
not search count, is what moves the bill. `gpt-5.4` ≈ half the token price of `gpt-5.5`.

### Two prompt findings
- **`tool_choice:required` is mandatory.** Without it, at `low`/`medium` the model often
  answers "none" without searching (a bare prompt got suppersby's number in a solo test but
  returned "none" in a batch — it just didn't look). Forcing ≥1 search fixed it.
- **A "reject venue/ticketing numbers" clause HURTS net recall.** It cut gpt-5.5 from
  44%→35% because it over-rejected legitimate landlines (Smart Supper Club, Comedy Cabin)
  along with the genuine venue noise. The plain prompt + light post-hoc validation
  (`normalizeUk` in iglead.ts) is the better balance. The web app's precision comes from the
  model's own judgement at `medium`, not from an explicit instruction.

---

## Other tools benchmarked — and why they lost

| Tool | Phone result | Cost | Verdict |
|---|---|---|---|
| **HikerAPI** (`public_phone`) | 5/16 handles | ~$0.0006/req | **Keep as cheap fallback.** Returns IG's declared `public_phone` — precise but only ~31% of handles set one. Complements ChatGPT (e.g. has Tara Knott, which ChatGPT missed). |
| **influencers.club** | `contact_phone_number` = **identical to HikerAPI** | 1 credit/req (expensive) | **Drop for phones.** Its phone field IS the IG public phone — finds nothing beyond HikerAPI, at 10-50x the price. Returned `None` for every lead that had no IG phone (bittenpeach, pinata, so_last_century). Only useful for email-type classification (business vs personal vs role-based) + follower/niche analytics — not contact discovery. |
| **Free web-unwrap** (urllib+regex+linktree hop) | 53% raw / honest after validation | $0 | Superseded by ChatGPT (which searches off-site directories web-unwrap can't reach, e.g. OpenTable). |
| **Google Maps / GBP** (Apify compass) | recovered 2 physical-premise leads | ~$0.007/place | Niche win for shops/venues that hide the phone on their site but keep a GMB listing. ChatGPT now finds most of these via search anyway. |
| **Apify browser extractor** | 0% lift | ~$20/1k | Added nothing. |
| **Apollo** | ~0% | ~$20/1k | No coverage of UK micro event orgs. |
| **Companies House** | no phones | — | Yields disambiguation only, never phone numbers. Key was rejected (Streaming-type). |
| **WHOIS** | registrar switchboard (trap) | $0 | Nominet/GDPR redacts the real registrant. Drop. |

---

## Recommended production pipeline (in `src/iglead.ts`)

```
1. ChatGPT gpt-5.4 + web_search, effort=medium, tool_choice=required, bare prompt
   → ~34% valid phone, ~$0.043/lead, no scraping stack
2. (optional) HikerAPI public_phone fallback for leads ChatGPT returns null on
   → cheap, recovers the handful with an IG-declared number ChatGPT missed
3. validate every result: normalize to E.164, classify mobile vs landline,
   drop placeholders/repeats (normalizeUk in iglead.ts)
4. leads with no phone anywhere (~55-65%) → inbound wa.me funnel / email channel,
   don't keep paying to re-search them
```

Net: **~$43 per 1,000 leads** at gpt-5.4 (or ~$71 at gpt-5.5 for 44% recall), single API key
(`OPENAI_API_KEY`), no Apify/Apollo/influencers.club/Companies-House dependencies.

## The ceiling is real
~55-65% of these leads publish no phone. This was confirmed two independent ways: the API
(`high` effort) and a careful manual ChatGPT web-research pass both bottomed out at the same
set of email/contact-form-only leads — touring festivals, DJ collectives, pop-up supper
clubs. That's not a method gap; the number does not exist publicly.
