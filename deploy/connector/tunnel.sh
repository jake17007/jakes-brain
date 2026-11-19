#!/usr/bin/env bash
# Runs on the PC from jakes-brain-tunnel.service: gives the Claude connector (127.0.0.1:4801,
# server/apps/connector.js) a public https address. Only that listener is forwarded; the app
# on :4800 stays LAN/tailnet-only. Settings come from ~/.config/jakes-brain/tunnel.env
# (written by setup-connector.sh, never in the repo).
set -euo pipefail
PORT=${JAKESDATA_CONNECTOR_PORT:-4801}
case "${TUNNEL:-}" in
  ngrok)
    # NGROK_AUTHTOKEN is read from the environment (kept off the command line / ps).
    exec "$HOME/.local/bin/ngrok" http "127.0.0.1:$PORT" --url "$NGROK_URL" --log stdout --log-format logfmt ;;
  cloudflare)
    # TUNNEL_TOKEN is read from the environment; the hostname -> http://localhost:4801 route
    # lives in the Cloudflare dashboard.
    exec "$HOME/.local/bin/cloudflared" tunnel --no-autoupdate run ;;
  funnel)
    # Tailscale Funnel through a Tailscale identity of Jake's Brain's own (a userspace tailscaled
    # run as this user: no sudo, its own <name>.<tailnet>.ts.net address, so it never collides with
    # another app's Funnel on the PC's main Tailscale). setup-connector.sh logs it in once and turns
    # Funnel on (443 -> 127.0.0.1:$PORT); that setting lives in this daemon's state and returns on
    # every start.
    dir="$HOME/.local/state/jakes-brain-tailscale"
    umask 077
    mkdir -p "$dir"
    exec "$(command -v tailscaled || echo /usr/sbin/tailscaled)" --tun=userspace-networking \
      --statedir="$dir" --state="$dir/tailscaled.state" --socket="$dir/tailscaled.sock" --port=0 --no-logs-no-support ;;
  *)
    echo "TUNNEL must be ngrok, cloudflare or funnel (see deploy/connector/README.md)" >&2
    exit 1 ;;
esac
