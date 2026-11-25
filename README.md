# Rupee Mechanics

A static page that feeds the Rupee Mechanics studio: reference links and videos, news screenshots, and the studio's status.

- No build step, no secrets. `index.html` + `app.js`.
- The page talks only to `api.github.com`, using a fine-grained token you paste once. The token is kept in that browser's `localStorage` and never leaves it except as the `Authorization` header to GitHub. **Forget token** removes it.
- `noindex` and `no-referrer` are set.

## Share button

- **Android (Chrome):** open the page → menu ⋮ → *Add to Home screen* / *Install*. Rupee Mechanics then appears in every app's Share menu (Instagram → Share → Rupee Mechanics).
- **iPhone:** iOS doesn't let web pages join the Share menu, so a Shortcut does it once: Shortcuts → **+** → *Receive* **URLs** *from* **Share Sheet** → add **URL Encode** (Shortcut Input) → add **Open URLs** with `https://arcbha.github.io/rm-inbox/?url=` followed by the *URL Encoded Text* variable → name it **Send to Rupee Mechanics**. Instagram → Share → *Share to…* (or ⋯ More) → **Send to Rupee Mechanics**.
- Either way the link lands in References → Links with one tap left (**Send to studio**). The page reads `?url=`, `?text=` or `?title=`.

## Carousels (Studio tab)

Carousels rendered by `engine/carousel.py` appear above the reels: swipe the slides, tap ▶ on a video slide, **Share / Save** sends the full-size slides (PNG + MP4, in order) to the phone's share sheet — *Save to Photos* or straight into Instagram — and **Copy caption** copies the post text.

## Plan tab

- **Pre-market post** — on/off switch for the 7:45 IST market-day post (ET, Mint and Google News → the 4–5 things that matter before 9:15 → a carousel in Studio). Writes `studio/schedule/recurring.json`.
- **Save artwork** — one picture, short video or PDF for a later post: the next morning post, a post on a date, or just the shelf; used as cover, WILD slide, a slide, or Claude decides. Writes `studio/artwork/queue/<stem>.<ext>` + `<stem>.json`.
- **Schedule a post** — carousel, poster, reel (visuals) or custom, at a date and time (IST), with story links, a brief and artwork from the shelf. Writes `studio/schedule/queue/sched-<ms>.json`.
- **Coming up** and **Artwork shelf** read `studio/schedule/items/` and `studio/artwork/*/art.json` (cancel / remove from there).

Finance_Repo's news Action files the queues (`engine/schedule.py ingest`) and the RM scheduler task runs them. News links alone are enough on the News tab (the studio reads the article).
- **Market now → Top 5 now** — one tap (optional focus note): Finance_Repo's `market-now` Action runs Claude Code on the news and the 5 points for this moment appear here in about 3 minutes; *Make it a carousel* schedules a post from them. Needs the `CLAUDE_CODE_OAUTH_TOKEN` secret on Finance_Repo once (`claude setup-token`).
