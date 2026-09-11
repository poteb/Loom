@echo off
rem Public https URL for the dev server, e.g. to add https://<host>.trycloudflare.com/mcp as a claude.ai connector.
rem IPv4 + http2 are forced because the default settings time out on the tunnel API from some networks.
cloudflared tunnel --edge-ip-version 4 --protocol http2 --url http://127.0.0.1:3000
