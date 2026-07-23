# Beleaf Render Service v3 — Premium Creative Engine

A browser-based Thai typography and layout renderer for Beleaf's n8n content pipeline.

## What changed

- Reads `creativeProfile`, `layoutPlan`, and `renderDirectives` from WF2/WF3.
- Backward compatible with the older `design.designTemplate` payload.
- Supports these layout structures: `banner_top`, `hero`, `floating`, `banner_left`, `corner`, `ribbon`, `diagonal`, `bottom_overlay`, `magazine`, `clinic`, `lifestyle`, `review`, `promotion`, `editorial`.
- Dynamic theme colors, bubble style, banner shape, typography, decoration, shadow and safe-zone placement.
- `/health` reports the deployed render version and supported layouts.

## Deploy

Push all files to the existing `beleaf-render-service` GitHub repository, commit, and let Render.com redeploy the Docker service. Keep the existing `RENDER_AUTH_TOKEN` environment variable.

Check:

```bash
curl https://YOUR-SERVICE.onrender.com/health
```

Expected version:

```json
{"ok":true,"version":"3.0.0-premium-creative-engine"}
```

## Payload

The service accepts the existing payload plus these optional root fields:

```json
{
  "creativeProfile": {},
  "layoutPlan": {},
  "renderDirectives": {},
  "structureType": "floating"
}
```

The renderer resolves values in this order:

1. Root payload directives
2. `layoutPlan`
3. `creativeProfile`
4. Legacy `design.designTemplate`
