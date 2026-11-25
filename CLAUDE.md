# RM Inbox — the phone front-end of the Rupee Mechanics studio

- Static page (GitHub Pages, this public repo): `index.html` + `app.js`, no build step, no secrets. It reads and writes **Arcbha/Finance_Repo** (private) through the GitHub API with the editor's fine-grained token.
- **The data contract lives in Finance_Repo**, not here: `studio/schedule/README.md` (artwork, schedule, pre-market), `studio/jobs/README.md` (news by link), `scripts/inbox.py` (reference queue). Change a file format there first, then the page here, in the same session (attach both repos).
- Every write is a queue file that a Finance_Repo Action processes (`inbox.yml` references, `news.yml` links/artwork/schedule). The page never edits studio files directly except small JSON switches (recurring.json enabled, a scheduled item's status).
- Test with Playwright against a mocked api.github.com (route interception) at 390 px wide before shipping; the editor uses it on a phone.
- Git: branch → PR → merge into `main` yourself (Pages serves `main`). Never put a colour decision here for studio output — the colorist owns colour in Finance_Repo; this page's own UI palette is fixed.
