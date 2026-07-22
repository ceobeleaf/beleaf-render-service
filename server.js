// Beleaf Smart Layout Render Service v2.0.0
// Rule-based Thai typography/layout engine for n8n.

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '30mb' }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.RENDER_AUTH_TOKEN || '';
const VERSION = '2.0.0';

const GOOGLE_FONT_FAMILIES = [
  'Anuphan:wght@400;600;700;800;900',
  'IBM+Plex+Sans+Thai:wght@400;500;600;700',
  'Sarabun:wght@400;500;600;700;800',
  'Mitr:wght@400;500;600;700',
  'Prompt:wght@400;500;600;700;800',
  'Kanit:wght@400;500;600;700;800;900',
  'Noto+Sans+Thai:wght@400;500;600;700;800;900',
];

function fontFamilyCss(name) {
  const base = String(name || '')
    .replace(/\s*(Thin|Light|Regular|Medium|SemiBold|Bold|ExtraBold|Black)\s*$/i, '')
    .trim();
  if (/^IBM Plex Thai/i.test(base)) return 'IBM Plex Sans Thai';
  return base || 'Noto Sans Thai';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clamp(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function normalizeHex(value, fallback) {
  const v = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

function readableTextColor(hex) {
  const h = normalizeHex(hex, '#888888').slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? '#171717' : '#FFFFFF';
}

function parseMaybeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getTemplate(design) {
  const direct = design?.designTemplate;
  const sheetValue = design?.['Design Template JSON'];
  return parseMaybeJson(direct || sheetValue, {});
}

function pickPalette(template, design) {
  const banner = template.banner || {};
  const palette = banner.palette || parseMaybeJson(design?.['Accent Palette JSON'], {});
  return {
    urgency: normalizeHex(palette.urgency, '#E9342B'),
    trust: normalizeHex(palette.trust, '#202124'),
    natural: normalizeHex(palette.natural, '#4E7D50'),
    premium: normalizeHex(palette.premium, '#C59A32'),
  };
}

function chooseLayout(template, design, overlayCount) {
  const raw = String(template.layout || design?.['Layout Preset'] || 'hero').toLowerCase();
  if (['hero', 'review', 'editorial', 'promotion', 'comparison', 'center', 'left', 'right'].includes(raw)) {
    if (raw === 'center') return 'hero';
    if (raw === 'left' || raw === 'right') return 'review';
    return raw;
  }
  return overlayCount >= 4 ? 'review' : 'hero';
}

function slotPlan(layout, count) {
  const plans = {
    hero: [
      { x: 5, y: 27, w: 34, h: 11, align: 'left' },
      { x: 61, y: 27, w: 34, h: 11, align: 'right' },
      { x: 4, y: 69, w: 36, h: 11, align: 'left' },
      { x: 60, y: 69, w: 36, h: 11, align: 'right' },
      { x: 25, y: 84, w: 50, h: 10, align: 'center' },
    ],
    review: [
      { x: 3, y: 26, w: 35, h: 11, align: 'left' },
      { x: 62, y: 26, w: 35, h: 11, align: 'right' },
      { x: 2, y: 49, w: 34, h: 11, align: 'left' },
      { x: 64, y: 49, w: 34, h: 11, align: 'right' },
      { x: 3, y: 74, w: 39, h: 11, align: 'left' },
      { x: 58, y: 74, w: 39, h: 11, align: 'right' },
    ],
    editorial: [
      { x: 5, y: 27, w: 44, h: 11, align: 'left' },
      { x: 51, y: 38, w: 44, h: 11, align: 'right' },
      { x: 5, y: 62, w: 42, h: 11, align: 'left' },
      { x: 53, y: 76, w: 42, h: 11, align: 'right' },
    ],
    promotion: [
      { x: 5, y: 28, w: 42, h: 12, align: 'left' },
      { x: 53, y: 28, w: 42, h: 12, align: 'right' },
      { x: 4, y: 71, w: 40, h: 12, align: 'left' },
      { x: 56, y: 71, w: 40, h: 12, align: 'right' },
      { x: 24, y: 85, w: 52, h: 10, align: 'center' },
    ],
    comparison: [
      { x: 4, y: 28, w: 42, h: 12, align: 'left' },
      { x: 54, y: 28, w: 42, h: 12, align: 'right' },
      { x: 4, y: 70, w: 42, h: 12, align: 'left' },
      { x: 54, y: 70, w: 42, h: 12, align: 'right' },
    ],
  };
  return (plans[layout] || plans.hero).slice(0, count);
}

function buildHtml({ imageDataUrl, design, headline, overlayText, imageSequence, imageCount, width, height }) {
  const template = getTemplate(design);
  const banner = template.banner || {};
  const bubble = template.bubble || {};
  const badge = template.badge || {};
  const palette = pickPalette(template, design);
  const layout = chooseLayout(template, design, overlayText.length);

  const accentKey = banner.defaultAccentKey || 'urgency';
  const bannerColor = palette[accentKey] || palette.urgency;
  const bannerTextColor = readableTextColor(bannerColor);
  const headlineFont = fontFamilyCss(banner.font || design?.['Font Headline']);
  const bodyFont = fontFamilyCss(bubble.font || design?.['Font Body']);
  const headlineWeight = clamp(banner.weight || design?.['Headline Weight'] || 800, 600, 900);

  const headlineHeight = clamp(banner.heightPercent || (layout === 'promotion' ? 19 : 17), 14, 23);
  const bubbleBg = normalizeHex(bubble.background || design?.['Bubble Background Color'], '#FFF7F0');
  const bubbleText = normalizeHex(bubble.textColor || design?.['Bubble Text Color'], '#33231F');
  const bubbleRadius = bubble.shape === 'pill' ? 999 : 18;
  const maxCount = clamp(bubble.maxCount || design?.['Bubble Max Count'] || 5, 1, 6);
  const items = overlayText.filter(Boolean).slice(0, maxCount);
  const slots = slotPlan(layout, items.length);

  const bubbleHtml = items.map((text, i) => {
    const slot = slots[i];
    const primary = i === 0 && items.length >= 3;
    return `<div class="bubble ${primary ? 'bubble-primary' : ''}" style="left:${slot.x}%;top:${slot.y}%;width:${slot.w}%;height:${slot.h}%;text-align:${slot.align};background:${bubbleBg};color:${bubbleText};border-radius:${bubbleRadius}px;font-family:'${bodyFont}',sans-serif;">${escapeHtml(text)}</div>`;
  }).join('\n');

  const badgeText = String(badge.text || design?.['Badge Default Text'] || '').trim();
  const badgeHtml = badgeText
    ? `<div class="badge" style="background:${normalizeHex(badge.color || design?.['Badge Color'], '#FFD2A6')};color:${readableTextColor(badge.color || design?.['Badge Color'] || '#FFD2A6')};font-family:'${bodyFont}',sans-serif;">${escapeHtml(badgeText)}</div>`
    : '';

  const fontLinks = GOOGLE_FONT_FAMILIES.map((f) => `family=${f}`).join('&');

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${fontLinks}&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff}
  .canvas{position:relative;width:100%;height:100%;overflow:hidden;background-image:url('${imageDataUrl}');background-size:cover;background-position:center}
  .headline-wrap{position:absolute;z-index:5;left:5%;right:5%;top:2.3%;height:${headlineHeight}%;display:flex;align-items:center;justify-content:center;padding:1.4% 4%;border-radius:28px;background:${bannerColor};box-shadow:0 8px 22px rgba(0,0,0,.20)}
  .headline{width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:${bannerTextColor};font-family:'${headlineFont}',sans-serif;font-weight:${headlineWeight};line-height:1.08;letter-spacing:-.8px;overflow:hidden}
  .bubble{position:absolute;z-index:4;display:flex;align-items:center;justify-content:center;padding:1.2% 1.8%;font-weight:700;line-height:1.18;box-shadow:0 5px 14px rgba(0,0,0,.16);border:2px solid rgba(255,255,255,.44);overflow:hidden}
  .bubble-primary{font-weight:800;box-shadow:0 7px 18px rgba(0,0,0,.20)}
  .badge{position:absolute;z-index:6;right:5%;bottom:4%;max-width:42%;padding:1.15% 2.1%;border-radius:18px;font-size:clamp(25px,3vw,38px);font-weight:800;line-height:1.15;box-shadow:0 6px 16px rgba(0,0,0,.18)}
  .seq{position:absolute;z-index:7;left:2%;bottom:1.8%;font:500 16px/1 sans-serif;color:rgba(255,255,255,.7);text-shadow:0 1px 3px rgba(0,0,0,.8)}
</style>
</head>
<body>
  <div class="canvas">
    <div class="headline-wrap"><div id="headline" class="headline">${escapeHtml(headline)}</div></div>
    ${bubbleHtml}
    ${badgeHtml}
    <div class="seq">${Number(imageSequence || 1)}/${Number(imageCount || 1)}</div>
  </div>
<script>
  function fitText(el, max, min) {
    let size = max;
    el.style.fontSize = size + 'px';
    while (size > min && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
      size -= 2;
      el.style.fontSize = size + 'px';
    }
  }
  async function fitAll() {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    fitText(document.getElementById('headline'), ${Math.round(width * 0.075)}, ${Math.round(width * 0.043)});
    document.querySelectorAll('.bubble').forEach((el, i) => fitText(el, i === 0 ? ${Math.round(width * 0.043)} : ${Math.round(width * 0.039)}, ${Math.round(width * 0.026)}));
  }
  window.__fitPromise = fitAll();
</script>
</body>
</html>`;
}

let browserPromise;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserPromise;
}

function authorize(req, res) {
  if (!AUTH_TOKEN) return true;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token === AUTH_TOKEN) return true;
  res.status(401).json({ error: 'UNAUTHORIZED' });
  return false;
}

app.post('/render', async (req, res) => {
  if (!authorize(req, res)) return;
  try {
    const {
      imageBase64,
      imageMimeType = 'image/jpeg',
      design = {},
      headline,
      overlayText = [],
      imageSequence = 1,
      imageCount = 1,
      outputWidth = 1080,
      outputHeight = 1080,
    } = req.body || {};

    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    if (!String(headline || '').trim()) return res.status(400).json({ error: 'headline required' });

    const width = clamp(outputWidth, 720, 2160);
    const height = clamp(outputHeight, 720, 2160);
    const imageDataUrl = `data:${imageMimeType};base64,${imageBase64}`;
    const html = buildHtml({
      imageDataUrl,
      design,
      headline: String(headline).trim(),
      overlayText: Array.isArray(overlayText) ? overlayText.map(String) : [],
      imageSequence,
      imageCount,
      width,
      height,
    });

    const browser = await getBrowser();
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 45000 });
      await page.evaluate(async () => {
        if (window.__fitPromise) await window.__fitPromise;
      });
      const buffer = await page.screenshot({ type: 'png' });
      res.set({
        'Content-Type': 'image/png',
        'X-Beleaf-Render-Version': VERSION,
        'Cache-Control': 'no-store',
      });
      res.send(buffer);
    } finally {
      await page.close();
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'RENDER_FAILED', message: String(error?.message || error) });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'beleaf-render-service', version: VERSION });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Beleaf Smart Layout Render Service v${VERSION} listening on :${PORT}`);
});
