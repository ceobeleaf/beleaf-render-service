# Beleaf Smart Layout Render Service v2.0.0

Browser-based Thai typography and rule-based layout engine for Workflow 3.

## What changed in v2

- Larger, rounded headline banner with shadow
- Automatic headline and bubble font fitting
- 4 layout presets: `hero`, `review`, `editorial`, `promotion`, plus `comparison`
- Bubble placement around a central product-safe area
- Up to 6 overlay bubbles
- Keeps the existing `/render` request format, so the current n8n workflow remains compatible
- Optional `outputWidth` and `outputHeight` fields; defaults to 1080 × 1080

## Required files

The repository root must contain exactly:

- `Dockerfile`
- `package.json`
- `server.js`
- `README.md`

## Render.com

Set environment variable:

`RENDER_AUTH_TOKEN=<your existing token>`

Deploy using Docker. After deployment, test:

`GET /health`

Expected response:

```json
{"ok":true,"service":"beleaf-render-service","version":"2.0.0"}
```

## API

`POST /render`

Header:

`Authorization: Bearer <RENDER_AUTH_TOKEN>`

The request body remains compatible with v1:

```json
{
  "imageBase64": "...",
  "imageMimeType": "image/jpeg",
  "design": {},
  "headline": "ข้อความพาดหัว",
  "overlayText": ["ข้อความ 1", "ข้อความ 2"],
  "imageSequence": 1,
  "imageCount": 2
}
```

Optional dimensions:

```json
{
  "outputWidth": 1080,
  "outputHeight": 1080
}
```

## Design Bible mapping

The renderer reads either:

- `design.designTemplate`, or
- the sheet field `Design Template JSON`

Recognized layout names:

- `hero`
- `review`
- `editorial`
- `promotion`
- `comparison`
- `center` maps to `hero`
- `left` and `right` map to `review`

This is a deterministic rule-based layout engine. It does not yet detect the exact product silhouette. It reserves the central image area and places text around it, which is much safer than the v1 corner-only placement.
