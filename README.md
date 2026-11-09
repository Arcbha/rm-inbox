# RM Inbox

A static page that feeds the Rupee Mechanics studio: reference links and videos, news screenshots, and the studio's status.

- No build step, no secrets. `index.html` + `app.js`.
- The page talks only to `api.github.com`, using a fine-grained token you paste once. The token is kept in that browser's `localStorage` and never leaves it except as the `Authorization` header to GitHub. **Forget token** removes it.
- `noindex` and `no-referrer` are set.

## Share button

- **Android (Chrome):** open the page → menu ⋮ → *Add to Home screen* / *Install*. RM Inbox then appears in every app's Share menu (Instagram → Share → RM Inbox).
- **iPhone:** iOS doesn't let web pages join the Share menu, so a Shortcut does it once: Shortcuts → **+** → *Receive* **URLs** *from* **Share Sheet** → add **URL Encode** (Shortcut Input) → add **Open URLs** with `https://arcbha.github.io/rm-inbox/?url=` followed by the *URL Encoded Text* variable → name it **Send to RM**. Instagram → Share → *Share to…* (or ⋯ More) → **Send to RM**.
- Either way the link lands in References → Links with one tap left (**Send to studio**). The page reads `?url=`, `?text=` or `?title=`.
