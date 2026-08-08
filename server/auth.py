"""Optional shared-secret auth, for running Coach Potato as a self-hosted
server other devices connect to (the "Ghidra server" shape: one machine holds
the database, every client talks to it over HTTP).

OFF by default. With no token configured the app behaves exactly as it always
has — a single local user on 127.0.0.1, no login, no cookie. Set a token
(`COACH_POTATO_TOKEN` env var, or a `COACH_POTATO_TOKEN=` line in .env) and
every request must carry it.

Why a cookie and not just an `Authorization` header: the frontend reaches the
server through more than fetch() — `<img src>` for background pictures and
research screenshots, `<a href download>` for the backup zip and Markdown
export, `<video src>` for clips, and `window.open()` for the comparison and
compare-tier-list pop-outs. Only a cookie rides along on all of those. The
header is still accepted, for scripts and curl.

`SameSite=Lax` is what stands in for CSRF tokens here: another origin's form
POST won't carry the cookie. The cookie holds a hash of the token rather than
the token itself — both are bearer credentials, but the hash keeps the literal
secret out of the browser's cookie jar and out of any request log that records
`Cookie:` headers.

This is a shared secret, not user accounts: everyone who logs in shares one
database (same blocks, same notes, same profiles). Serve it over a private
network — Tailscale/WireGuard/LAN — not a port forward, and put it behind a
TLS terminator if it must cross the open internet, since the token travels in
the clear over plain HTTP.
"""
import asyncio
import hashlib
import os
import secrets

from fastapi import Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

COOKIE_NAME = "cp_auth"
COOKIE_MAX_AGE = 30 * 86_400  # 30 days; a re-login is a re-typed token, no more
ENV_VAR = "COACH_POTATO_TOKEN"
LOGIN_PATH = "/login"
LOGOUT_PATH = "/logout"
FAILED_LOGIN_DELAY_S = 0.5  # crude brute-force tax; the token is long, this is enough

_UNSET = object()
_cached_token = _UNSET


def reset_cache():
    """Forget the resolved token (tests; also lets a restart-free reload be
    added later if it's ever wanted)."""
    global _cached_token
    _cached_token = _UNSET


def force_off():
    """Keep auth off no matter what's configured. The desktop app calls this:
    it binds loopback and IS the single user, so a token meant for ./serve.sh
    (sitting in the same .env) must not put a login screen in front of its own
    window."""
    global _cached_token
    _cached_token = ""


def configured_token() -> str:
    """The shared secret, or '' when auth is off. Env var wins; a
    `COACH_POTATO_TOKEN=` line in .env is the fallback, so the same
    copy-a-file workflow as RIOT_API_KEY works. Resolved once — changing it
    means restarting the server, which is the right ceremony for a credential.
    """
    global _cached_token
    if _cached_token is not _UNSET:
        return _cached_token
    token = (os.environ.get(ENV_VAR) or "").strip()
    if not token:
        from . import config

        env_path = config.ENV_FALLBACK_ROOT / ".env"
        if env_path.exists():
            token = (config.parse_env_file(env_path).get(ENV_VAR) or "").strip()
    _cached_token = token
    return token


def enabled() -> bool:
    return bool(configured_token())


def cookie_value(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _presented(request: Request) -> str:
    """The credential this request carries, in whatever form it arrived —
    normalised to the cookie's hashed shape so one comparison covers all
    three."""
    cookie = request.cookies.get(COOKIE_NAME)
    if cookie:
        return cookie
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return cookie_value(header[7:].strip())
    raw = request.headers.get("x-auth-token", "").strip()
    return cookie_value(raw) if raw else ""


def is_authorized(request: Request) -> bool:
    token = configured_token()
    if not token:
        return True
    return secrets.compare_digest(_presented(request), cookie_value(token))


def _safe_next(raw: str) -> str:
    """Only same-site absolute paths — '//evil.com' is protocol-relative and
    would make the login form an open redirect."""
    if raw.startswith("/") and not raw.startswith("//"):
        return raw
    return "/"


def _login_html(next_path: str, error: str = "") -> str:
    # Self-contained: /static is behind auth too, so this page can't link the
    # stylesheet. Colors mirror style.css's light/dark roots.
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coach Potato — sign in</title>
<style>
  :root {{
    --page: #f9f9f7; --surface: #fcfcfb; --text: #0b0b0b; --muted: #898781;
    --border: rgba(11, 11, 11, 0.10); --accent: #2a78d6; --critical: #d03b3b;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --page: #0d0d0d; --surface: #1a1a19; --text: #ffffff; --muted: #898781;
      --border: rgba(255, 255, 255, 0.10); --accent: #3987e5;
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; background: var(--page); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }}
  form {{
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 28px 26px; width: min(360px, calc(100vw - 32px));
  }}
  h1 {{ margin: 0 0 4px; font-size: 19px; }}
  p {{ margin: 0 0 18px; color: var(--muted); font-size: 13px; }}
  input {{
    width: 100%; padding: 9px 11px; font: inherit; color: var(--text);
    background: var(--page); border: 1px solid var(--border); border-radius: 7px;
  }}
  input:focus {{ outline: 2px solid var(--accent); outline-offset: 1px; }}
  button {{
    width: 100%; margin-top: 12px; padding: 9px 11px; font: inherit; font-weight: 600;
    color: #fff; background: var(--accent); border: 0; border-radius: 7px; cursor: pointer;
  }}
  .error {{ margin: 12px 0 0; color: var(--critical); font-size: 13px; }}
</style></head>
<body>
  <form method="post" action="{LOGIN_PATH}">
    <h1>🥔 Coach Potato</h1>
    <p>This server is password-protected. Enter its access token.</p>
    <input type="hidden" name="next" value="{_escape(next_path)}">
    <input type="password" name="token" placeholder="Access token" autofocus
      autocomplete="current-password" spellcheck="false">
    <button type="submit">Sign in</button>
    {f'<p class="error">{_escape(error)}</p>' if error else ""}
  </form>
</body></html>"""


def _escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))


def _set_cookie(response, token: str):
    # No `secure`: self-hosting here means plain HTTP over a LAN or a VPN, and
    # a Secure cookie would simply be dropped. Behind a TLS proxy the flag is
    # unnecessary anyway — the hop is already encrypted.
    response.set_cookie(COOKIE_NAME, cookie_value(token), max_age=COOKIE_MAX_AGE,
                        httponly=True, samesite="lax", path="/")
    return response


def install(app):
    """Wire the gate and its two routes onto `app`. Safe to call when auth is
    off: every hook short-circuits on an empty token."""

    @app.middleware("http")
    async def require_token(request: Request, call_next):
        if not enabled() or request.url.path in (LOGIN_PATH, LOGOUT_PATH):
            return await call_next(request)
        if is_authorized(request):
            return await call_next(request)
        if request.url.path.startswith("/api"):
            # JSON for the frontend's fetch()es — app.js turns this into a
            # redirect to the login page.
            return JSONResponse({"detail": "authentication required"}, status_code=401)
        return HTMLResponse(_login_html(request.url.path), status_code=401)

    @app.get(LOGIN_PATH, include_in_schema=False)
    def login_form(request: Request):
        if is_authorized(request):
            return RedirectResponse("/", status_code=303)
        return HTMLResponse(_login_html(_safe_next(request.query_params.get("next", "/"))))

    @app.post(LOGIN_PATH, include_in_schema=False)
    async def login_submit(token: str = Form(""), next: str = Form("/")):
        target = _safe_next(next)
        expected = configured_token()
        if not expected:
            return RedirectResponse(target, status_code=303)
        if not secrets.compare_digest(token.strip(), expected):
            await asyncio.sleep(FAILED_LOGIN_DELAY_S)
            return HTMLResponse(_login_html(target, "Wrong token — try again."),
                                status_code=401)
        return _set_cookie(RedirectResponse(target, status_code=303), expected)

    @app.get(LOGOUT_PATH, include_in_schema=False)
    def logout():
        response = RedirectResponse(LOGIN_PATH, status_code=303)
        response.delete_cookie(COOKIE_NAME, path="/")
        return response
