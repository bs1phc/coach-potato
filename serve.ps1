# Self-host mode (Windows / PowerShell equivalent of serve.sh).
#
# Unlike run.ps1 (local dev — loopback only, auto-reload) this binds every
# interface and REFUSES to start without an access token, because anyone who
# can reach the port would otherwise get your Riot API key out of Settings
# plus full write access to the database. See server/auth.py.
#
# Reach it over a private network (Tailscale/WireGuard/LAN). Do not port-
# forward it to the open internet without a TLS terminator in front — the
# token crosses plain HTTP.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$serveHost = if ($env:HOST) { $env:HOST } else { "0.0.0.0" }
$port = if ($env:PORT) { $env:PORT } else { "8321" }

# The token can also live in .env, next to RIOT_API_KEY.
if (-not $env:COACH_POTATO_TOKEN -and (Test-Path ".env")) {
  $line = Select-String -Path ".env" -Pattern '^COACH_POTATO_TOKEN=(.*)$' | Select-Object -First 1
  if ($line) { $env:COACH_POTATO_TOKEN = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $env:COACH_POTATO_TOKEN) {
  Write-Host "Refusing to start: no COACH_POTATO_TOKEN set." -ForegroundColor Red
  Write-Host ""
  Write-Host "This mode is reachable from other machines. Without a token, anyone who"
  Write-Host "can reach the port can read your Riot API key and write to your database."
  Write-Host ""
  Write-Host "Generate one:"
  Write-Host "  .\.venv\Scripts\python.exe -c ""import secrets; print(secrets.token_urlsafe(24))"""
  Write-Host ""
  Write-Host 'Then either set $env:COACH_POTATO_TOKEN = "..." or add a COACH_POTATO_TOKEN='
  Write-Host "line to .env, and re-run."
  exit 1
}

Write-Host "Coach Potato serving on http://${serveHost}:${port} (token auth on)"
# No --reload: this is a long-running server, not the dev loop.
& ".\.venv\Scripts\python.exe" -m uvicorn server.app:app --host $serveHost --port $port
