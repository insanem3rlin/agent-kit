---
name: context7
description: Fetch real, up-to-date documentation for a third-party library or framework via the Context7 REST API (no MCP server). Use when the user asks how to use a specific library/framework/API, wants current/official docs or correct API signatures, says "check the docs"/"use real docs"/"context7", or when you're unsure of a library's current API and would otherwise guess.
---

# Context7 docs lookup

Pull current library docs straight from Context7's HTTP API, with no MCP server. There are two steps: resolve a library ID, then fetch docs for it.

Base URL: `https://context7.com/api/v2`

## When to use

Reach for this before answering library/framework "how do I…" questions, or whenever you'd otherwise rely on possibly-stale memory of an external API. Skip it for this repo's own code or for general programming questions.

## API key (optional)

Works keyless at low rate limits. With a key (`ctx7sk-…` from https://context7.com/dashboard) you get higher limits, and you set it once in your shell profile as `CONTEXT7_API_KEY`. The commands below add the `Authorization` header only when that variable is set.

## Step 1: Resolve the library ID

```bash
curl -sG "https://context7.com/api/v2/libs/search" \
  --data-urlencode "libraryName=next.js" \
  --data-urlencode "query=app router server actions" \
  ${CONTEXT7_API_KEY:+-H "Authorization: Bearer $CONTEXT7_API_KEY"}
```

- `libraryName` is the library to find (e.g. `react`, `pyside6`, `sqlalchemy`).
- `query` is what you actually need, which improves ranking.

Pick the best hit's `id` from the JSON (e.g. `/vercel/next.js`). IDs may carry a version: `/vercel/next.js/v15.1.8` or `/facebook/react@v18.2.0`.

## Step 2: Fetch the docs

```bash
MSYS_NO_PATHCONV=1 curl -sG "https://context7.com/api/v2/context" \
  --data-urlencode "libraryId=/vercel/next.js" \
  --data-urlencode "query=how to implement server actions with auth" \
  --data-urlencode "type=txt" \
  ${CONTEXT7_API_KEY:+-H "Authorization: Bearer $CONTEXT7_API_KEY"}
```

`MSYS_NO_PATHCONV=1` is required on Windows Git Bash, because the leading-slash `libraryId` is otherwise rewritten into a Windows path and the request 404s.

- `libraryId` comes from step 1.
- `query` is a detailed natural-language question, so be specific.
- `type` is `txt` (default, best for reading) or `json`.

Read the returned snippets, then answer the user grounded in them. Cite the library ID you used.

## Notes

- Run these with the Bash tool (the `${VAR:+…}` conditional header is bash syntax). In PowerShell, build the header array conditionally instead.
- Keyless `GET` URLs also work with WebFetch (no custom header), which is handy when you only need a quick read and have no key.
- If a search returns nothing useful, retry step 1 with a simpler `libraryName` (drop version suffixes, try the org/package name).
