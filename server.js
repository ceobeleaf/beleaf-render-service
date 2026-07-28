/**
 * BELEAF Render Service v3
 * ------------------------------------------------------------------
 * สัญญา API เหมือนเดิม: POST /render (Bearer) -> คืน PNG, GET /health
 *
 * v3 รองรับสไตล์จากชีตครบทุกแบบ (ของเดิม v2 รองรับแค่ทรงมุมมนอย่างเดียว)
 *   ป้ายพาดหัว 6 ทรง : rounded-rect / pill / rect / ribbon-cut / skew-rect / text-only
 *   กล่องข้อความ     : รองรับ rgba, gradient, transparent, เส้นขอบ, ทรง pill
 *   ฟอนต์ 6 ตระกูล   : Anuphan, IBM Plex Sans Thai, Kanit, Mitr, Prompt, Sarabun
 *   เงา 3 ระดับ      : none / soft / strong
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
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ตัดคำบอกน้ำหนักออกจากชื่อฟอนต์ เช่น "Kanit ExtraBold" -> "Kanit"
const FONT_WEIGHT_WORDS =
  /\s*(Thin|ExtraLight|UltraLight|Light|Regular|Book|Medium|SemiBold|DemiBold|Bold|ExtraBold|UltraBold|Black|Heavy)$/i;
const fontFamily = (v, fallback) => {
  const base = str(v, fallback).replace(FONT_WEIGHT_WORDS, '').trim();
  return base || fallback;
};

const SHADOW = {
  none: 'none',
  soft: '0 10px 26px rgba(0,0,0,0.22)',
  strong: '0 16px 40px rgba(0,0,0,0.38)',
};
const shadowOf = (v, d = 'soft') => SHADOW[str(v, d).toLowerCase()] ?? SHADOW[d];

// เลือกสีตัวอักษรตามความสว่างพื้น: พื้นเข้ม -> ขาว / พื้นอ่อน -> เข้ม
function readableOn(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(str(color));
  if (!m) return '#FFFFFF';
  const int = parseInt(m[1], 16);
  const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? '#141414' : '#FFFFFF';
}

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{1F900}-\u{1F9FF}]/gu;
function splitEmoji(text) {
  const t = str(text);
  const found = t.match(EMOJI_RE) || [];
  return { text: t.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim(), emoji: found };
}

/* ---------- ขนาด (สัดส่วนต่อความสูงภาพ) วัดจากโพสต์ Dr.PONG ที่แชร์สูง ---------- */
const SCALE = {
  small:  { headline: 0.062, bubble: 0.036 },
  medium: { headline: 0.076, bubble: 0.042 },
  large:  { headline: 0.090, bubble: 0.048 },
};

// v3.4: ผังวางกล่องข้อความ 6 แบบ เลือกได้รายเพจผ่านชีต 19 คอลัมน์ "Slot Pattern"
// ของเดิมมีผังเดียวตายตัว ทุกเพจจึงวางกล่องตำแหน่งเดียวกันหมด
const PATTERNS = {
  // คู่บน-คู่ล่าง เว้นกลางให้สินค้า (ค่าเริ่มต้นเดิม)
  split: {
    maxWidth: '44%',
    slots: [
      { top: '27%', left: '5%'  },
      { top: '27%', right: '5%' },
      { top: '74%', left: '5%'  },
      { top: '74%', right: '5%' },
      { top: '50%', left: '5%'  },
      { top: '50%', right: '5%' },
    ],
  },
  // เรียงชิดซ้ายลงมาเป็นคอลัมน์เดียว
  'left-stack': {
    maxWidth: '48%',
    slots: [
      { top: '26%', left: '5%' },
      { top: '39%', left: '5%' },
      { top: '52%', left: '5%' },
      { top: '65%', left: '5%' },
      { top: '78%', left: '5%' },
      { top: '13%', left: '5%' },
    ],
  },
  'right-stack': {
    maxWidth: '48%',
    slots: [
      { top: '26%', right: '5%' },
      { top: '39%', right: '5%' },
      { top: '52%', right: '5%' },
      { top: '65%', right: '5%' },
      { top: '78%', right: '5%' },
      { top: '13%', right: '5%' },
    ],
  },
  // สี่มุมภาพ เว้นกลางโล่ง
  'four-corners': {
    maxWidth: '40%',
    slots: [
      { top: '24%', left: '4%'  },
      { top: '24%', right: '4%' },
      { top: '78%', left: '4%'  },
      { top: '78%', right: '4%' },
      { top: '51%', left: '4%'  },
      { top: '51%', right: '4%' },
    ],
  },
  // โค้งตามขอบล่าง ปลายสองข้างยกขึ้น
  'bottom-arc': {
    maxWidth: '26%',
    slots: [
      { top: '70%', left: '2%'  },
      { top: '80%', left: '26%' },
      { top: '80%', right: '26%' },
      { top: '70%', right: '2%' },
      { top: '58%', left: '2%'  },
      { top: '58%', right: '2%' },
    ],
  },
  // สลับฟันปลาจากบนลงล่าง
  diagonal: {
    maxWidth: '42%',
    slots: [
      { top: '24%', left: '5%'  },
      { top: '42%', right: '5%' },
      { top: '60%', left: '5%'  },
      { top: '78%', right: '5%' },
      { top: '33%', right: '5%' },
      { top: '69%', left: '5%'  },
    ],
  },
};
const DEFAULT_PATTERN = 'split';

// AI Vision บอกมาตั้งแต่ WF1 ว่าที่ว่างอยู่ตรงไหน เอามาเรียงลำดับช่องวางกล่อง
function orderSlots(slots, hint) {
  const h = str(hint);
  const wantTop = /บน|top|upper/i.test(h);
  const wantBottom = /ล่าง|bottom|lower/i.test(h);
  const wantLeft = /ซ้าย|left/i.test(h);
  const wantRight = /ขวา|right/i.test(h);
  if (!wantTop && !wantBottom && !wantLeft && !wantRight) return slots;
  const tops = slots.map(s => parseFloat(s.top));
  const mid = (Math.min(...tops) + Math.max(...tops)) / 2;
  const score = (sl) => {
    let n = 0;
    const y = parseFloat(sl.top);
    if (wantTop && y <= mid) n += 2;
    if (wantBottom && y > mid) n += 2;
    if (wantLeft && sl.left) n += 1;
    if (wantRight && !sl.left) n += 1;
    return n;
  };
  return [...slots].sort((a, b) => score(b) - score(a));
}

/* ---------- ทรงป้ายพาดหัว ---------- */
// คืน css + wrapper class ตามชื่อทรงจากชีต 20 หรือ renderDirectives.bannerMode
function bannerStyle({ shape, radius, shadow, accent, textColor, isTag, isVertical }) {
  const s = str(shape, 'rounded-rect').toLowerCase();
  const base = `background:${accent}; color:${textColor}; box-shadow:${shadow};`;
  // v3.5: แถบแนวตั้งใช้ทรงเดียว เพราะริบบิ้น/เฉียงจะบิดเพี้ยนเมื่อหมุน 90 องศา
  if (isVertical) return { css: `${base} border-radius:0;`, extra: '' };
  // v3.1: ป้ายแบบเว้นขอบจัดกึ่งกลางภาพ (เจ้าของขอ 28 ก.ค. 69)
  const inset = 'left:50%; transform:translateX(-50%); max-width:88%; padding:0.42em 0.90em;';
  const full = 'left:0; width:100%; padding:0.46em 4%;';

  if (/text-only|underline|none/.test(s)) {
    return {
      css: `left:50%; transform:translateX(-50%); max-width:88%; padding:0.10em 0;
            background:transparent; color:#FFFFFF;
            border-bottom:0.16em solid ${accent}; box-shadow:none;
            text-shadow:0 3px 14px rgba(0,0,0,.55), 0 1px 2px rgba(0,0,0,.8);`,
      extra: '',
    };
  }
  if (/pill|floating/.test(s)) {
    return { css: `${inset} ${base} border-radius:999px;`, extra: '' };
  }
  if (/^rect$|solid|bar/.test(s)) {
    return { css: `${full} ${base} border-radius:0;`, extra: '' };
  }
  if (/ribbon/.test(s)) {
    // ปลายขวาบากเป็นริบบิ้น
    return {
      css: `${inset} ${base} border-radius:0;
            clip-path:polygon(0 0, calc(100% - 0.55em) 0, 100% 50%, calc(100% - 0.55em) 100%, 0 100%);
            padding-right:1.35em;`,
      extra: '',
    };
  }
  if (/skew|diagonal/.test(s)) {
    return {
      css: `${inset.replace('transform:translateX(-50%);', '')} transform:translateX(-50%) skewX(-9deg); ${base} border-radius:0;`,
      extra: 'transform:skewX(9deg); display:inline-block;',
    };
  }
  // rounded-rect (ค่าเริ่มต้น)
  const box = isTag ? inset : full;
  return { css: `${box} ${base} border-radius:${radius}px;`, extra: '' };
}

function buildHtml(payload) {
  const dt = payload?.design?.designTemplate || {};
  const banner = dt.banner || {};
  const bubble = dt.bubble || {};
  const typo = dt.typography || {};
  const rd = payload?.renderDirectives || {};
  const decoration = Array.isArray(dt.decoration) ? dt.decoration : [];

  const W = 1080;
  const H = 1080;

  const scaleKey = ['small', 'medium', 'large'].includes(str(rd.fontScale))
    ? str(rd.fontScale) : 'medium';
  const sc = SCALE[scaleKey];
  const headlinePx = Math.round(H * sc.headline);
  // v3.5: Product Emphasis = large -> ย่อกล่องข้อความ เปิดพื้นที่ให้สินค้า
  const bubblePx = Math.round(H * sc.bubble);

  const palette = banner.palette || {};
  const accentKey = str(banner.defaultAccentKey, 'urgency');
  const accent = str(palette[accentKey], str(palette.urgency, '#D9622B'));
  const headlineColor = readableOn(accent);

  const bannerShapeRaw = str(banner.shape, '');
  const bannerModeRaw = str(rd.bannerMode, '');
  const shapeForBanner = bannerShapeRaw || bannerModeRaw || 'rounded-rect';
  const isTag = /tag|chip|pill|rounded/i.test(bannerModeRaw || bannerShapeRaw);

  // v3.5: ค่าจากชีต 18 LAYOUT_MASTER — ของเดิมส่งมาแล้วแต่ไม่เคยถูกใช้เลย
  // ชีต 18 คุม "อยู่ตรงไหน หนาแค่ไหน ชิดทางไหน เน้นสินค้าไหม"
  // ชีต 20 คุม "รูปทรงอะไร มุมมนเท่าไหร่ มีเงาไหม" — แบ่งหน้าที่กันชัดเจน
  const bannerPos = str(banner.position, 'top').toLowerCase();
  const bannerHeightPct = Math.min(100, Math.max(6, num(banner.heightPercent, 14)));
  const headlineAlign = ['left', 'center', 'right'].includes(str(dt.headlineAlignment).toLowerCase())
    ? str(dt.headlineAlignment).toLowerCase() : 'center';
  const productEmphasis = str(dt.productEmphasis, 'normal').toLowerCase();
  const emphasiseProduct = /large|big|hero/.test(productEmphasis);

  const isVertical = bannerPos === 'left' || bannerPos === 'right';
  let placementCss;
  if (isVertical) {
    const side = bannerPos === 'right' ? 'right:0;' : 'left:0;';
    placementCss = `${side} top:0; height:${bannerHeightPct}%; width:15%;
      display:flex; align-items:center; justify-content:center;
      writing-mode:vertical-rl; transform:rotate(180deg);`;
  } else if (bannerPos === 'bottom') {
    placementCss = `bottom:4.5%; ${isTag ? '' : `min-height:${Math.round(H * bannerHeightPct / 100)}px;`}
      display:flex; align-items:center;`;
  } else {
    placementCss = `top:4.2%; ${isTag ? '' : `min-height:${Math.round(H * bannerHeightPct / 100)}px;`}
      display:flex; align-items:center;`;
  }

  const bStyle = bannerStyle({
    shape: shapeForBanner,
    radius: num(banner.cornerRadius, 24),
    shadow: shadowOf(banner.shadow, 'soft'),
    accent,
    textColor: headlineColor,
    isTag,
    isVertical,
  });

  const hRaw = splitEmoji(payload.headline || '');
  const headline = hRaw.text;

  let overlay = Array.isArray(payload.overlayText) ? payload.overlayText : [];
  if (!overlay.length && Array.isArray(payload?.panel?.overlayText)) {
    overlay = payload.panel.overlayText;
  }
  const stickers = [];
  // v3.2: WF2 บางสูตรส่ง overlayText มาเป็นก้อนเดียวที่มี \n ข้างใน
  // ของเดิมตั้ง nowrap ทำให้ยุบเป็นบรรทัดเดียวยาว จึงแตกออกเป็นกล่องละบรรทัดก่อน
  const rawBlocks = overlay
    .flatMap((t) => String(t ?? '').split(/\r?\n+/))
    .map((t) => { const s = splitEmoji(t); stickers.push(...s.emoji); return s.text; })
    .filter(Boolean);

  // v3.2: เมื่อ WF2 ส่งมาก้อนเดียว มันจะตั้ง maxOverlayBlocks = 1 ด้วย
  // ถ้าเชื่อค่านั้นตรงๆ จะเหลือกล่องเดียวทั้งที่แตกได้หลายบรรทัด
  // v3.4: ผังมาจากชีต 19 คอลัมน์ "Slot Pattern" (ผ่าน bubbleStyle ที่ WF3 ส่งมาทั้งแถว)
  const patternKey = str(
    (dt.bubbleStyle || {})['Slot Pattern'] || bubble.slotPattern || rd.slotPattern,
    DEFAULT_PATTERN
  ).toLowerCase();
  const pattern = PATTERNS[patternKey] || PATTERNS[DEFAULT_PATTERN];

  const configuredMax = num(rd.maxOverlayBlocks, num(bubble.maxCount, 4));
  const wasSingleParagraph = overlay.length === 1 && rawBlocks.length > 1;
  const maxBlocks = Math.min(
    wasSingleParagraph ? rawBlocks.length : configuredMax,
    pattern.slots.length
  );
  const blocks = rawBlocks.slice(0, maxBlocks);

  // ---- กล่องข้อความ: รองรับ rgba / gradient / transparent / เส้นขอบ / ทรง pill ----
  const bubbleBgRaw = str(bubble.background, '#FFFFFF');
  const isGradient = /gradient\(/i.test(bubbleBgRaw);
  const isTransparent = /^transparent$/i.test(bubbleBgRaw);
  const bubbleFg = str(bubble.textColor, '#1B1B1B');
  const bubbleBorder = str(bubble.border, 'none');
  const hasBorder = bubbleBorder && bubbleBorder.toLowerCase() !== 'none';
  const bubbleShape = str(bubble.shape, 'rounded-rect').toLowerCase();
  const bubbleRadius = /pill/.test(bubbleShape) ? 999 : 22;
  const bubbleShadow = shadowOf(bubble.shadow, 'soft');
  // พื้นโปร่งใสต้องมีเงาตัวอักษรไม่งั้นอ่านไม่ออกบนภาพถ่าย
  const bubbleTextShadow = (isTransparent || /rgba\([^)]*0?\.[0-7]\d*\)/.test(bubbleBgRaw))
    ? 'text-shadow:0 2px 8px rgba(0,0,0,.45);' : '';
  const backdrop = /rgba\(/i.test(bubbleBgRaw) ? 'backdrop-filter:blur(6px);' : '';

  const fontHeadline = fontFamily(typo.fontHeadline, 'Anuphan');
  const fontBody = fontFamily(typo.fontBody, 'IBM Plex Sans Thai');
  const headlineWeight = num(typo.headlineWeight, 800);

  const slotOrder = orderSlots(pattern.slots, rd.emptySpaceHint);
  const bubbleHtml = blocks.map((t, i) => {
    const slot = slotOrder[i];
    const pos = slot.left ? `left:${slot.left};` : `right:${slot.right};`;
    return `<div class="bubble" style="top:${slot.top};${pos}"><span>${esc(t)}</span></div>`;
  }).join('\n');

  const showSticker =
    decoration.includes('emoji_prefix') || decoration.includes('sticker') ||
    decoration.includes('sparkle');
  const pool = [...hRaw.emoji, ...stickers].filter(Boolean);
  const leftChar = pool[0] || '\u2728';
  const rightChar = pool[1] || '';
  const stickerHtml = showSticker
    ? `<div class="sticker sticker-left">${esc(leftChar)}</div>` +
      (rightChar ? `<div class="sticker sticker-right">${esc(rightChar)}</div>` : '')
    : '';

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anuphan:wght@400;500;600;700;800&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Kanit:wght@400;500;600;700;800;900&family=Mitr:wght@400;500;600;700&family=Prompt:wght@400;500;600;700&family=Sarabun:wght@400;500;600;700;800&family=Noto+Color+Emoji&display=swap" rel="stylesheet">
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
    position:absolute;
    ${placementCss}
    ${bStyle.css}
    font-family:'${fontHeadline}','Noto Color Emoji',sans-serif;
    font-weight:${headlineWeight};
    font-size:${headlinePx}px;
    line-height:1.18;
    letter-spacing:${str(typo.letterSpacing, '0').replace(/px$/, '')}px;
    white-space:nowrap;
    /* v3.5: การจัดข้อความมาจากชีต 18 คอลัมน์ Headline Alignment */
    text-align:${headlineAlign};
    justify-content:${headlineAlign === 'left' ? 'flex-start' : headlineAlign === 'right' ? 'flex-end' : 'center'};
  }
  .banner-inner { ${bStyle.extra} }
  .sticker {
    position:absolute;
    font-family:'Noto Color Emoji',sans-serif;
    font-size:${Math.round(headlinePx * 1.05)}px;
    line-height:1; z-index:5;
    filter:drop-shadow(0 4px 10px rgba(0,0,0,.28));
  }
  .sticker-left  { top:0.8%; left:2%; }
  .sticker-right { top:2.4%; right:6%; transform:rotate(8deg); }
  .bubble {
    position:absolute;
    background:${bubbleBgRaw};
    color:${bubbleFg};
    ${hasBorder ? `border:${bubbleBorder};` : ''}
    ${backdrop}
    ${bubbleTextShadow}
    font-family:'${fontBody}',sans-serif;
    font-weight:700;
    font-size:${emphasiseProduct ? Math.round(bubblePx * 0.88) : bubblePx}px;
    line-height:1.28;
    padding:0.52em 0.9em;
    border-radius:${bubbleRadius}px;
    box-shadow:${isTransparent ? 'none' : bubbleShadow};
    max-width:${emphasiseProduct ? Math.round(parseFloat(pattern.maxWidth) * 0.85) + '%' : pattern.maxWidth};
    white-space:nowrap;
  }
</style></head>
<body>
  <div class="stage">
    <div class="photo"></div>
    ${stickerHtml}
    <div class="banner" id="banner"><span class="banner-inner">${esc(headline)}</span></div>
    ${bubbleHtml}
  </div>
  <script>
    // v3.1: ป้ายที่กว้าง 100% มี scrollWidth เท่ากับความกว้างภาพเสมอ
    // ของเดิมวัดจากกล่องจึงวนย่อจนชนขั้นต่ำ 18px ทุกครั้ง -> วัดจาก span ข้างในแทน
    function fit(box, measured, maxRatio) {
      if (!box || !measured) return;
      var limit = ${W} * maxRatio;
      var size = parseFloat(getComputedStyle(box).fontSize);
      var guard = 0;
      while (measured.scrollWidth > limit && size > 22 && guard < 60) {
        size -= 2; box.style.fontSize = size + 'px'; guard++;
      }
    }
    var bannerBox = document.getElementById('banner');
    var bannerText = bannerBox ? bannerBox.querySelector('.banner-inner') : null;
    if (!${isVertical}) fit(bannerBox, bannerText, ${isTag ? 0.80 : 0.90});
    document.querySelectorAll('.bubble').forEach(function (b) {
      fit(b, b.firstElementChild || b, ${(parseFloat(pattern.maxWidth) / 100).toFixed(2)});
    });
  </script>
</body></html>`;
}

/* ---------- routes ---------- */

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'beleaf-render-v3' }));

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
      viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1,
    });
    await page.setContent(buildHtml(body), { waitUntil: 'networkidle', timeout: 60000 });
    try { await page.evaluate(() => document.fonts.ready); } catch (_) {}
    await page.waitForTimeout(250);

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

app.listen(PORT, () => console.log(`beleaf-render-v3 listening on ${PORT}`));
