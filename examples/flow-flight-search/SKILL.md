---
name: "flight-search-zurich-london"
summary: "Web automation flow: 在 flights.example.com 搜索 苏黎世→伦敦 的航班"
---

# Flow Skill: flight-search-zurich-london

> Goal: 在 flights.example.com 搜索 苏黎世→伦敦 的航班


## What this does

A recorded, replayable web-automation flow. Each step carries a **durable locator**
(semantic identity + stable attributes) so it survives most page redesigns.


## How to replay

```bash
cd <this folder>
python scripts/replay.py --dry-run --state page.json   # offline check
python scripts/replay.py --url <live-url>             # live (needs Chrome daemon)
```

## Steps

1. **TYPE_TEXT** `Where from?`  text='Zürich'
2. **TYPE_TEXT** `Where to?`  text='London'
3. **CLICK** `搜索`
4. **CLICK** `旧导出`

## Verification (run after replay)

- `field_value` {'name': 'Where from?', 'equals': 'Zürich'}
- `field_value` {'name': 'Where to?', 'equals': 'London'}
- `element_present` {'name': '搜索'}