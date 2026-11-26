# Rupee Mechanics

A static page that feeds the Rupee Mechanics studio. Five tabs in a bottom bar:

- **Pre & Post** — Market now (Top 5 now), the pre-market (7:45 IST) and post-market (5:45 pm IST) post switches, and for each a cover artwork picked from Saved Artwork.
- **Newsroom** — News (link and/or screenshots, Make a, note, cover art reference: upload or Saved Artwork, Send / Send & build now) · Schedule (+ the scheduled list) · Reference. Sharing a link from the phone asks: Bookmark, Teach the AI, or News story.
- **Saved Artwork** — Artwork (save a picture for a post + the shelf) · Bookmarks (links and screenshots you like; private, the studio never reads them).
- **Studio** — rendered carousels and reels, newest version of each post only (the studio prunes older ones); **Delete** removes a post's preview.
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

## Pre & Post · Saved Artwork · Schedule

- **Pre-market / Post-market post** — on/off switches (`studio/schedule/recurring.json` → `runs[id=premarket|postmarket].enabled`). The artwork picker rewrites `studio/artwork/<id>/art.json` to `use_on: "next"`, `slot: "premarket|postmarket"`, `for: "cover"` (one per post; tap again to clear).
- **Save artwork** — one picture, short video or PDF for a later post: the next pre/post-market post, a post on a date, or just the shelf; used as cover, WILD slide, a slide, or Claude decides. Writes `studio/artwork/queue/<stem>.<ext>` + `<stem>.json`.
- **Schedule a post** — carousel, poster, reel (visuals) or custom, at a date and time (IST), with story links, a brief and artwork from the shelf. Writes `studio/schedule/queue/sched-<ms>.json`; the Scheduled list below it reads `studio/schedule/items/` (cancel / remove).
- **News cover art from Saved Artwork** — the shelf file's blob is reused (no upload) at `studio/editor-assets/<slug>/cover-inspiration.<ext>`; meta.json gets `cover_ref` + `cover_art: <id>`.
- **Studio → Delete** — one commit: the slug's `studio/previews/index.json` entry and its preview files.

Finance_Repo's news Action files the queues (`engine/schedule.py ingest`) and the RM scheduler task runs them. News links alone are enough on the News tab (the studio reads the article).
- **Market now → Top 5 now** — one tap (optional focus note): Finance_Repo's `market-now` Action runs Claude Code on the news and the 5 points for this moment appear here in about 3 minutes; *Make it a carousel* schedules a post from them. Needs the `CLAUDE_CODE_OAUTH_TOKEN` secret on Finance_Repo once (`claude setup-token`).
