"""Token auth for self-host mode. Off unless a token is configured, so the
default (desktop app / localhost) path must stay completely open."""
import pytest
from fastapi.testclient import TestClient

from server import auth, config, db
from server.app import app

TOKEN = "s3cret-token-for-tests"


@pytest.fixture
def make_client(tmp_path, monkeypatch):
    """A TestClient over a throwaway db. `token=None` leaves auth off."""
    db_path = tmp_path / "t.sqlite"
    monkeypatch.setenv("LOL_DB_PATH", str(db_path))
    monkeypatch.setattr(config, "ENV_FALLBACK_ROOT", tmp_path)  # ignore the repo .env
    db.connect(db_path).close()

    def build(token=None):
        if token is None:
            monkeypatch.delenv(auth.ENV_VAR, raising=False)
        else:
            monkeypatch.setenv(auth.ENV_VAR, token)
        auth.reset_cache()
        return TestClient(app)

    yield build
    auth.reset_cache()  # never leak a token into another test module


def test_no_token_configured_leaves_everything_open(make_client):
    client = make_client()
    assert auth.enabled() is False
    assert client.get("/api/crawl/status").status_code == 200
    # the login page still exists, and just sends you to the app
    assert client.get("/login", follow_redirects=False).status_code == 303


def test_api_requires_the_token(make_client):
    client = make_client(TOKEN)
    r = client.get("/api/crawl/status")
    assert r.status_code == 401 and r.json()["detail"] == "authentication required"


def test_page_requests_get_the_login_form_not_json(make_client):
    client = make_client(TOKEN)
    r = client.get("/index.html")
    assert r.status_code == 401
    assert "Coach Potato" in r.text and 'name="token"' in r.text
    assert "text/html" in r.headers["content-type"]


def test_login_sets_a_cookie_that_unlocks_the_app(make_client):
    client = make_client(TOKEN)
    r = client.post("/login", data={"token": TOKEN, "next": "/"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/"
    assert auth.COOKIE_NAME in r.cookies
    # the cookie carries a hash, never the token itself
    assert TOKEN not in r.headers["set-cookie"]
    assert client.get("/api/crawl/status").status_code == 200
    # ...and logging out closes it again
    client.get("/logout", follow_redirects=False)
    assert client.get("/api/crawl/status").status_code == 401


def test_wrong_token_is_rejected(make_client, monkeypatch):
    monkeypatch.setattr(auth, "FAILED_LOGIN_DELAY_S", 0)  # don't pay the brute-force tax
    client = make_client(TOKEN)
    r = client.post("/login", data={"token": "nope", "next": "/"}, follow_redirects=False)
    assert r.status_code == 401 and "Wrong token" in r.text
    assert auth.COOKIE_NAME not in r.cookies
    assert client.get("/api/crawl/status").status_code == 401


def test_bearer_and_x_auth_token_headers_work_without_a_cookie(make_client):
    client = make_client(TOKEN)
    assert client.get("/api/crawl/status",
                      headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert client.get("/api/crawl/status",
                      headers={"X-Auth-Token": TOKEN}).status_code == 200
    assert client.get("/api/crawl/status",
                      headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_login_next_cannot_become_an_open_redirect(make_client):
    client = make_client(TOKEN)
    r = client.post("/login", data={"token": TOKEN, "next": "//evil.example.com"},
                    follow_redirects=False)
    assert r.headers["location"] == "/"
    # a genuine in-app path is preserved
    r = client.post("/login", data={"token": TOKEN, "next": "/index.html#progress"},
                    follow_redirects=False)
    assert r.headers["location"] == "/index.html#progress"


def test_force_off_beats_a_configured_token(make_client):
    """What desktop.py does: a token left in .env for ./serve.sh must not put a
    login screen in front of the local single-user window."""
    client = make_client(TOKEN)
    assert client.get("/api/crawl/status").status_code == 401
    auth.force_off()
    assert auth.enabled() is False
    assert client.get("/api/crawl/status").status_code == 200


def test_token_can_come_from_the_env_file(tmp_path, monkeypatch):
    monkeypatch.setenv("LOL_DB_PATH", str(tmp_path / "t.sqlite"))
    monkeypatch.delenv(auth.ENV_VAR, raising=False)
    monkeypatch.setattr(config, "ENV_FALLBACK_ROOT", tmp_path)
    (tmp_path / ".env").write_text(f"RIOT_API_KEY=x\n{auth.ENV_VAR}={TOKEN}\n")
    auth.reset_cache()
    try:
        assert auth.configured_token() == TOKEN
        with TestClient(app) as client:
            assert client.get("/api/crawl/status").status_code == 401
    finally:
        auth.reset_cache()
