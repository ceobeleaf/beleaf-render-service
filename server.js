/**
 * BELEAF Render Service v2
 * ------------------------------------------------------------------
 * รับ payload เดิมจาก n8n Workflow 3 (POST /render, Bearer token, คืน PNG)
 * แต่วางเลย์เอาต์ใหม่ตามแบบที่วัดจากโพสต์ Dr.PONG / Nuriv จริง
 *
 * สิ่งที่ต่างจากตัวเดิม
 *  1. ใช้ overlayText แหล่งเดียว ไม่ผสม panel.overlayText จนได้กล่องบ้างไม่ได้กล่องบ้าง
 *  2. อ่าน renderDirectives.bannerMode  -> "tag" = ป้ายมุมมนเว้นขอบ (แบบ Dr.PONG)
 *  3. อ่าน renderDirectives.fontScale   -> คุมขนาดตัวอักษรจริง
 *  4. ใช้ cornerRadius / shadow จากชีตจริง
 *  5. สีตัวอักษรบนป้ายเลือกอัตโนมัติจากความสว่างของสีพื้น (ดำบนส้ม แบบ Dr.PONG)
 *  6. ไม่มีลายน้ำ 1/1 และไม่ยัดอีโมจิลงกลางข้อความจนทับกัน
 */

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '30mb' }));

const AUTH_TOKEN = process.env.RENDER_AUTH_TOKEN || '';
const PORT = process.env.PORT || 10000;

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
  }
  return browserPromise;
}

/* ---------- helpers ---------- */

const str = (v, d = '') => {
  const s = String(v ?? '').trim();
  return s || d;
};
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ความสว่างแบบ WCAG อย่างง่าย — ใช้เลือกว่าจะวางตัวอักษรสีดำหรือขาว
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(str(hex));
  if (!m) return '#111111';
  const int = parseInt(m[1], 16);
  const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? '#141414' : '#FFFFFF';
}

// ดึงอีโมจิที่ AI แทรกมากลางประโยคออก แล้วส่งกลับแยกไว้ใช้เป็นสติกเกอร์
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{1F900}-\u{1F9FF}]/gu;
function splitEmoji(text) {
  const t = str(text);
  const found = t.match(EMOJI_RE) || [];
  return { text: t.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim(), emoji: found };
}

/* ---------- ตัวคุมขนาด (สัดส่วนต่อความสูงภาพ) ----------
   ตัวเลขชุดนี้วัดจากโพสต์ Dr.PONG ที่ยอดแชร์สูง
   พาดหัวประมาณ 7-9% ของความสูงภาพ / ข้อความในกล่องประมาณ 4%      */
const SCALE = {
  small:  { headline: 0.062, bubble: 0.036 },
  medium: { headline: 0.076, bubble: 0.042 },
  large:  { headline: 0.090, bubble: 0.048 },
};

/* ---------- ตำแหน่งกล่องข้อความ ----------
   หลบตรงกลางภาพไว้ให้สินค้า วางเป็นคู่ซ้าย-ขวาเหมือน Dr.PONG      */
const SLOTS = [
  { top: '21%', left: '5%',  align: 'flex-start' },
  { top: '21%', right: '5%', align: 'flex-end' },
  { top: '45%', left: '5%',  align: 'flex-start' },
  { top: '45%', right: '5%', align: 'flex-end' },
  { top: '68%', left: '5%',  align: 'flex-start' },
  { top: '68%', right: '5%', align: 'flex-end' },
];

function buildHtml(payload) {
  const dt = payload?.design?.designTemplate || {};
  const banner = dt.banner || {};
  const bubble = dt.bubble || {};
  const typo = dt.typography || {};
  const rd = payload?.renderDirectives || {};
  const decoration = Array.isArray(dt.decoration) ? dt.decoration : [];

  const W = 1080;
  const H = 1080;

  // ---- ขนาดตัวอักษร ----
  const scaleKey = ['small', 'medium', 'large'].includes(str(rd.fontScale))
    ? str(rd.fontScale)
    : 'medium';
  const sc = SCALE[scaleKey];
  const headlinePx = Math.round(H * sc.headline);
  const bubblePx = Math.round(H * sc.bubble);

  // ---- สีป้ายพาดหัว ----
  const palette = banner.palette || {};
  const accentKey = str(banner.defaultAccentKey, 'urgency');
  const accent = str(palette[accentKey], str(palette.urgency, '#D9622B'));
  const headlineColor = readableOn(accent);

  // ---- ทรงป้ายพาดหัว ----
  // bannerMode = tag  -> ป้ายมุมมนเว้นขอบ (ค่าที่ WF2 ส่งมาแต่ตัวเดิมทิ้ง)
  const bannerMode = str(rd.bannerMode, str(banner.shape, 'bar')).toLowerCase();
  const isTag = /tag|chip|pill|rounded/.test(bannerMode);
  const radius = num(banner.cornerRadius, 24);
  const bannerShadow =
    str(banner.shadow, 'soft') === 'none'
      ? 'none'
      : '0 10px 28px rgba(0,0,0,0.22)';

  // ---- ข้อความ ----
  const hRaw = splitEmoji(payload.headline || dt.headline || '');
  const headline = hRaw.text;

  // แหล่งเดียวเท่านั้น กัน bug กล่องบ้างไม่กล่องบ้าง
  let overlay = Array.isArray(payload.overlayText) ? payload.overlayText : [];
  if (!overlay.length && Array.isArray(payload?.panel?.overlayText)) {
    overlay = payload.panel.overlayText;
  }
  const maxBlocks = Math.min(
    num(rd.maxOverlayBlocks, num(bubble.maxCount, 4)),
    SLOTS.length
  );
  const stickers = [];
  const blocks = overlay
    .map((t) => {
      const s = splitEmoji(t);
      stickers.push(...s.emoji);
      return s.text;
    })
    .filter(Boolean)
    .slice(0, maxBlocks);

  const bubbleBg = str(bubble.background, '#FFFFFF');
  const bubbleFg = str(bubble.textColor, '#1B1B1B');
  const bubbleRadius = /rect/.test(str(bubble.shape, 'rounded-rect')) ? 22 : 999;
  const bubbleShadow =
    str(bubble.shadow, 'soft') === 'none'
      ? 'none'
      : '0 6px 18px rgba(0,0,0,0.15)';

  const fontHeadline = str(typo.fontHeadline, 'Anuphan').replace(/\s*(ExtraBold|Bold)$/i, '');
  const fontBody = str(typo.fontBody, 'IBM Plex Sans Thai');
  const headlineWeight = num(typo.headlineWeight, 800);

  const bubbleHtml = blocks
    .map((t, i) => {
      const slot = SLOTS[i];
      const pos = slot.left ? `left:${slot.left};` : `right:${slot.right};`;
      return `<div class="bubble" style="top:${slot.top};${pos}">${esc(t)}</div>`;
    })
    .join('\n');

  // สติกเกอร์อีโมจิ วางทับมุมป้าย ไม่ปนกลางข้อความ
  const showSticker =
    decoration.includes('emoji_prefix') || decoration.includes('emoji_sticker');
  const stickerChar = hRaw.emoji[0] || stickers[0] || '';
  const stickerHtml =
    showSticker && stickerChar
      ? `<div class="sticker">${esc(stickerChar)}</div>`
      : '';

  const bannerBox = isTag
    ? `left:5.5%; max-width:80%; border-radius:${radius}px; padding:0.42em 0.78em;`
    : `left:0; width:100%; border-radius:0; padding:0.46em 4%;`;

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anuphan:wght@500;600;700;800&family=IBM+Plex+Sans+Thai:wght@500;600;700&family=Noto+Color+Emoji&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${W}px; height:${H}px; overflow:hidden; }
  .stage { position:relative; width:${W}px; height:${H}px; }
  .photo {
    position:absolute; inset:0;
    background-image:url('${payload.__imageDataUrl}');
    background-size:cover; background-position:center;
  }
  .banner {
    position:absolute; top:4.2%;
    ${bannerBox}
    background:${accent};
    color:${headlineColor};
    font-family:'${fontHeadline}','Noto Color Emoji',sans-serif;
    font-weight:${headlineWeight};
    font-size:${headlinePx}px;
    line-height:1.18;
    letter-spacing:${num(typo.letterSpacing, 0)}px;
    box-shadow:${bannerShadow};
    text-align:${str(dt.headlineAlignment, 'left') === 'center' && !isTag ? 'center' : 'left'};
    white-space:nowrap;
  }
  .sticker {
    position:absolute; top:1.2%; left:2.5%;
    font-family:'Noto Color Emoji',sans-serif;
    font-size:${Math.round(headlinePx * 1.05)}px;
    line-height:1; z-index:5;
    filter:drop-shadow(0 4px 10px rgba(0,0,0,.28));
  }
  .bubble {
    position:absolute;
    background:${bubbleBg};
    color:${bubbleFg};
    font-family:'${fontBody}',sans-serif;
    font-weight:700;
    font-size:${bubblePx}px;
    line-height:1.28;
    padding:0.52em 0.9em;
    border-radius:${bubbleRadius}px;
    box-shadow:${bubbleShadow};
    max-width:44%;
    white-space:nowrap;
  }
</style></head>
<body>
  <div class="stage">
    <div class="photo"></div>
    ${stickerHtml}
    <div class="banner" id="banner">${esc(headline)}</div>
    ${bubbleHtml}
  </div>
  <script>
    // ย่อขนาดอัตโนมัติถ้าข้อความยาวเกินกรอบ กันตัวอักษรล้นออกนอกภาพ
    function fit(el, maxRatio) {
      if (!el) return;
      var limit = ${W} * maxRatio;
      var size = parseFloat(getComputedStyle(el).fontSize);
      var guard = 0;
      while (el.scrollWidth > limit && size > 18 && guard < 60) {
        size -= 2; el.style.fontSize = size + 'px'; guard++;
      }
    }
    fit(document.getElementById('banner'), ${isTag ? 0.82 : 0.92});
    document.querySelectorAll('.bubble').forEach(function (b) { fit(b, 0.44); });
  </script>
</body></html>`;
}

/* ---------- routes ---------- */

app.get('/health', (_req, res) => res.json({ ok: true, service: 'beleaf-render-v2' }));

app.post('/render', async (req, res) => {
  try {
    if (AUTH_TOKEN) {
      const sent = str(req.headers.authorization).replace(/^Bearer\s+/i, '');
      if (sent !== AUTH_TOKEN) return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const body = req.body || {};
    if (!body.imageBase64) return res.status(400).json({ error: 'IMAGE_BASE64_MISSING' });
    if (!str(body.headline)) return res.status(400).json({ error: 'HEADLINE_MISSING' });

    const mime = str(body.imageMimeType, 'image/jpeg');
    body.__imageDataUrl = `data:${mime};base64,${body.imageBase64}`;

    const browser = await getBrowser();
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1080 },
      deviceScaleFactor: 1,
    });

    await page.setContent(buildHtml(body), { waitUntil: 'networkidle', timeout: 60000 });
    try {
      await page.evaluate(() => document.fonts.ready);
    } catch (_) {}
    await page.waitForTimeout(220);

    const png = await page.screenshot({ type: 'png' });
    await page.close();

    res.set('Content-Type', 'image/png');
    res.set('Content-Length', String(png.length));
    return res.send(png);
  } catch (err) {
    console.error('RENDER_FAILED', err);
    return res.status(500).json({ error: 'RENDER_FAILED', message: String(err && err.message) });
  }
});

app.listen(PORT, () => console.log(`beleaf-render-v2 listening on ${PORT}`));
