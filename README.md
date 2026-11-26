# Rupee Mechanics

A static page that feeds the Rupee Mechanics studio. Five tabs in a bottom bar:

- **Pre & Post** — Market now (Top 5 now, **Earlier briefs** expands the history); the pre-market (7:45 IST) and post-market (5:45 pm IST) posts, each with an on/off switch (instant, one save per tap), **Choose cover art** (a picker over your bookmarks; the card shows only the chosen one) and **Build now**.
- **Newsroom** — News (link and/or screenshots, Make a, note, cover art reference: upload or a bookmark, Send / Send & build now) · Schedule (+ the scheduled list).
- **References** — learning material for the agents (links, screenshots, videos, carousels); the hourly GitHub scheduler queues a study run when something new is waiting. Sharing a link from the phone asks: Bookmark, Teach the AI, or News story.
- **Bookmarks** — the one place to save anything (a link and/or screenshots). Private, except a bookmark you pick as artwork: its first picture is copied for that post.
- **Studio** — rendered carousels and reels, newest version of each post only; per carousel **Delete**, **Fix…** (a note → the studio applies it and re-renders), **Published / Not posted** (rating).
- **Live bar** (under the header, on every tab) — what is building, the agent and stage, the account, paused/failed runs with **Retry**, and questions from the studio with an answer box. Reads the `live` branch + `studio/schedule/build/` + blocked `studio/jobs/`.
- **More** — the reference library, what you sent, studio status, Forget token.

- No build step, no secrets. `index.html` + `app.js`.
- The page talks only to `api.github.com`, using a fine-grained token you paste once. The token is kept in that browser's `localStorage` and never leaves it except as the `Authorization` header to GitHub. **Forget token** removes it.
- `noindex` and `no-referrer` are set.

## Share button

- **Android (Chrome):** open the page → menu ⋮ → *Add to Home screen* / *Install*. Rupee Mechanics then appears in every app's Share menu (Instagram → Share → Rupee Mechanics).
- **iPhone:** iOS doesn't let web pages join the Share menu, so a Shortcut does it once: Shortcuts → **+** → *Receive* **URLs** *from* **Share Sheet** → add **URL Encode** (Shortcut Input) → add **Open URLs** with `https://arcbha.github.io/rm-inbox/?url=` followed by the *URL Encoded Text* variable → name it **Send to Rupee Mechanics**. Instagram → Share → *Share to…* (or ⋯ More) → **Send to Rupee Mechanics**.
- Either way the link lands in References → Links with one tap left (**Send to studio**). The page reads `?url=`, `?text=` or `?title=`.

## Carousels (Studio tab)

Carousels rendered by `engine/carousel.py` appear above the reels: swipe the slides, tap ▶ on a video slide, **Share / Save** sends the full-size slides (PNG + MP4, in order) to the phone's share sheet — *Save to Photos* or straight into Instagram — and **Copy caption** copies the post text.

## Pre & Post · Bookmarks as artwork · Schedule

- **Pre-market / Post-market** — switches: `studio/schedule/recurring.json` → `runs[id=premarket|postmarket].enabled`. Picking a bookmark writes `studio/artwork/bm-<bookmark id>-<slot>/` (art.json `use_on: "next"`, `slot`, `for: "cover"`, `bookmark` + the bookmark's first picture, blob reused); one per post, tap again to clear (folder deleted). **Build now** commits `studio/schedule/build/build-<stamp>-<kind>-<date>.json` → the build-now Action runs `/premarket` or `/postmarket`.
- **Schedule a post** — picked bookmarks become `studio/artwork/bm-<id>/` in the same commit; the item's `artwork` lists those ids. The Scheduled list reads `studio/schedule/items/` and build requests.
- **News cover from a bookmark** — `studio/editor-assets/<slug>/cover-inspiration.<ext>` (blob reused); meta.json `cover_ref` + `cover_bookmark`.
- **Studio → Delete** — one commit: the slug's `studio/previews/index.json` entry and its preview files.

Finance_Repo's news Action files the queues (`engine/schedule.py ingest`) and the RM scheduler task runs them. News links alone are enough on the News tab (the studio reads the article).
- **Market now → Top 5 now** — one tap (optional focus note): Finance_Repo's `market-now` Action runs Claude Code on the news and the 5 points for this moment appear here in about 3 minutes; *Make it a carousel* schedules a post from them. Needs the `CLAUDE_CODE_OAUTH_TOKEN` secret on Finance_Repo once (`claude setup-token`).

## Requests (build-now)
Every action that makes something commits `studio/schedule/build/build-<IST stamp>-<slug>.json` = `{slug, kind, note, added, status: "pending", by: "rm-inbox"}`; kinds carousel · poster · reel · premarket · postmarket · revise · rate · resume. Contract: Finance_Repo `studio/schedule/README.md` § Carousels end to end.

Reads are never cached (`fetch(…, {cache: 'no-store'})`): GitHub answers with max-age=60, and a cached answer right after a save made switches and pickers flip back.
