# RM Inbox

A static page that feeds the Rupee Mechanics studio: reference links and videos, news screenshots, and the studio's status.

- No build step, no secrets. `index.html` + `app.js`.
- The page talks only to `api.github.com`, using a fine-grained token you paste once. The token is kept in that browser's `localStorage` and never leaves it except as the `Authorization` header to GitHub. **Forget token** removes it.
- `noindex` and `no-referrer` are set.
