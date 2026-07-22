# Beleaf Render Service

Browser-based Thai typography renderer for Beleaf Workflow 3.

## Required filenames

Keep these exact names in the repository root:

- `Dockerfile`
- `package.json`
- `server.js`
- `README.md`

## Version alignment

This release pins both layers to Playwright `1.61.1`:

- Docker image: `mcr.microsoft.com/playwright:v1.61.1-jammy`
- npm package: `playwright: 1.61.1`

Do not change only one of them. The Docker image and npm package must remain on the same Playwright version.

## Render environment variable

Set:

`RENDER_AUTH_TOKEN=<your secret token>`

## Endpoints

### Health check

`GET /health`

Expected response:

```json
{
  "ok": true,
  "service": "beleaf-render-service",
  "version": "1.1.0"
}
```

### Render

`POST /render`

Header:

`Authorization: Bearer <RENDER_AUTH_TOKEN>`

The response is raw `image/png` binary.

## Deploy update on Render

1. Replace the four files in the GitHub repository with this package.
2. Commit the changes.
3. Render should deploy automatically.
4. Wait until the deployment status is Live.
5. Open `/health` and verify version `1.1.0`.
6. Re-run the `Render Thai PNG` node in n8n.
