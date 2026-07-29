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

// เพิ่มเลขนี้ทุกครั้งที่แก้ไฟล์ จะได้เช็กผ่าน /health ว่า deploy ติดหรือยัง
const BUILD = 'v4.7';
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

// v4.1: ผังวางกล่องข้อความ — กำหนดตำแหน่ง ความกว้าง และขนาดตัวอักษร แยกรายผัง
// ของเดิมใช้ขนาดเดียวทุกผัง ทำให้ผังสองคอลัมน์กล่องบวมจนเบียดสินค้า
//   font  = สัดส่วนความสูงภาพ (อ้างอิงงานจริงที่วัดได้ ~4.1% สำหรับผังคอลัมน์เดียว)
//   maxWidth ของผังคอลัมน์เดียวไม่เกิน 53% เพื่อไม่ให้ล้ำกึ่งกลางไปทับสินค้า
const PATTERNS = {
  split: {
    kind: 'blocks', maxWidth: '43%', font: 0.038,
    slots: [
      { top: '27%', left: '5%' }, { top: '27%', right: '5%' },
      { top: '73%', left: '5%' }, { top: '73%', right: '5%' },
      { top: '50%', left: '5%' }, { top: '50%', right: '5%' },
    ],
  },
  // เรียงคอลัมน์เดียว ระยะขอบสลับเล็กน้อยให้ดูเป็นมือคน
  'left-stack': {
    kind: 'blocks', maxWidth: '53%', font: 0.041,
    slots: [
      { top: '27%', left: '4%' },  { top: '41%', left: '9%' },
      { top: '56%', left: '13%' }, { top: '71%', left: '8%' },
      { top: '85%', left: '4%' },  { top: '14%', left: '9%' },
    ],
  },
  'right-stack': {
    kind: 'blocks', maxWidth: '53%', font: 0.041,
    slots: [
      { top: '27%', right: '4%' },  { top: '41%', right: '9%' },
      { top: '56%', right: '13%' }, { top: '71%', right: '8%' },
      { top: '85%', right: '4%' },  { top: '14%', right: '9%' },
    ],
  },
  'four-corners': {
    kind: 'blocks', maxWidth: '39%', font: 0.036,
    slots: [
      { top: '24%', left: '4%' }, { top: '24%', right: '4%' },
      { top: '78%', left: '4%' }, { top: '78%', right: '4%' },
      { top: '51%', left: '4%' }, { top: '51%', right: '4%' },
    ],
  },
  'bottom-arc': {
    kind: 'blocks', maxWidth: '25%', font: 0.033,
    slots: [
      { top: '70%', left: '2%' }, { top: '80%', left: '26%' },
      { top: '80%', right: '26%' }, { top: '70%', right: '2%' },
      { top: '58%', left: '2%' }, { top: '58%', right: '2%' },
    ],
  },
  'top-arc': {
    kind: 'blocks', maxWidth: '25%', font: 0.033,
    slots: [
      { top: '30%', left: '2%' }, { top: '22%', left: '26%' },
      { top: '22%', right: '26%' }, { top: '30%', right: '2%' },
      { top: '42%', left: '2%' }, { top: '42%', right: '2%' },
    ],
  },
  scattered: {
    kind: 'blocks', maxWidth: '37%', font: 0.036,
    slots: [
      { top: '25%', left: '6%' }, { top: '38%', right: '3%' },
      { top: '62%', left: '2%' }, { top: '79%', right: '9%' },
      { top: '50%', left: '28%' }, { top: '88%', left: '12%' },
    ],
  },
  // v4.2: วัดจากภาพอ้างอิงจริง — กล่องพารากราฟกว้าง 49-50% เริ่มที่ 30-31% ไม่ใช่ 46%/36%
  'para-left':   { kind: 'paragraph', maxWidth: '50%', font: 0.040, slots: [{ top: '31%', left: '4%' }] },
  'para-right':  { kind: 'paragraph', maxWidth: '50%', font: 0.040, slots: [{ top: '31%', right: '3%' }] },
  'para-bottom': { kind: 'paragraph', maxWidth: '88%', font: 0.034, slots: [{ top: '58%', left: '6%' }] },
};

// v4.2: ฟอนต์พารากราฟแปรตามจำนวนบรรทัด — วัดได้ 5 บรรทัด 53px / 7 บรรทัด 43px
// ของเดิมใช้ค่าเดียว บรรทัดน้อยเลยดูโหวง บรรทัดเยอะเลยล้น
function paragraphFont(lines) {
  // v4.7: ลดลงจาก v4.5 ราว 8% ทุกช่วง ตามที่เจ้าของแจ้งว่าตัวหนังสือใหญ่ไป
  if (lines <= 4) return 0.046;   // 50px
  if (lines <= 5) return 0.044;   // 48px
  if (lines <= 6) return 0.040;   // 43px
  if (lines <= 7) return 0.037;   // 40px
  if (lines <= 9) return 0.033;   // 36px
  return 0.030;                   // 32px
}
const DEFAULT_PATTERN = 'split';
const DEFAULT_PARAGRAPH_PATTERN = 'para-left';

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
function bannerStyle({ shape, radius, shadow, accent, textColor, isTag }) {
  const s = str(shape, 'rounded-rect').toLowerCase();
  const base = `background:${accent}; color:${textColor}; box-shadow:${shadow};`;
  // v3.1: ป้ายแบบเว้นขอบจัดกึ่งกลางภาพ (เจ้าของขอ 28 ก.ค. 69)
  const inset = 'max-width:88%; padding:0.42em 0.90em;';
  const full = 'width:100%; padding:0.46em 4%;';

  if (/text-only|underline|none/.test(s)) {
    return {
      css: `max-width:88%; padding:0.10em 0;
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
      css: `${inset} ${base} border-radius:0; transform:skewX(-9deg);`,
      extra: 'transform:skewX(9deg); display:inline-block;',
    };
  }
  // rounded-rect (ค่าเริ่มต้น)
  const box = isTag ? inset : full;
  return { css: `${box} ${base} border-radius:${radius}px;`, extra: '' };
}

// v4.5: เลือกอีโมจิให้เข้ากับความหมายของพาดหัว
// ของเดิมใช้เฉพาะอีโมจิที่ WF2 พิมพ์ติดมา ถ้าไม่มีก็ใส่สปาร์กเกิลทุกครั้ง
// ทำให้ทุกภาพในอัลบั้มได้ตัวเดียวกันหมดทั้งที่พาดหัวคนละเรื่อง
// เรียงจากเฉพาะเจาะจงไปหากว้าง เจอคำแรกที่ตรงแล้วหยุด
const EMOJI_MAP = [
  [/เดี๋ยวนะ|เอ๊ะ|จริงมั้ย|จริงไหม|สงสัย|รู้ยัง|ทำไม|[?]|ฯ/, '🤔'],
  [/สายตา|ดวงตา|ตาล้า|แสงสีฟ้า|ลูทีน|จอคอม|มองเห็น/, '👀'],
  [/ปอด|หายใจ|หอบ|ภูมิแพ้|ฝุ่น|PM|มลภาวะ/, '🍃'],
  [/เส้นผม|ผมร่วง|หนังศีรษะ/, '💇'],
  [/หุ่น|เอว|พุง|น้ำหนัก|ไขมัน|เผาผลาญ|กระชับ/, '🔥'],
  [/ลำไส้|ขับถ่าย|ท้องผูก|ไฟเบอร์|ดีท็อกซ์|ตับ/, '🌿'],
  [/ภูมิคุ้มกัน|ป่วย|ไข้|แข็งแรง|วิตามินซี|วิตซี/, '🛡'],
  [/นอน|พักผ่อน|เหนื่อย|อ่อนเพลีย|ล้า/, '😴'],
  [/แดด|ยูวี|UV|กันแดด|ไวต่อแสง/, '☀'],
  [/ริ้วรอย|ชะลอวัย|อ่อนเยาว์|ตีนกา|แก่/, '⏳'],
  [/สิว|อักเสบ|รอยแดง/, '🌸'],
  [/ฝ้า|กระ|จุดด่างดำ|หมองคล้ำ|ดำแดด|กรรมพันธุ์|รอยดำ/, '🌗'],
  [/ดูดซึม|เทคโนโลยี|ไลโปโซม|งานวิจัย|ทดสอบ|มิลลิกรัม|%/, '🔬'],
  [/ราคา|บาท|คุ้ม|โปร|แถม|ส่วนลด|ถูก/, '💸'],
  [/คอลลาเจน|ชุ่มชื้น|เนียน|นุ่ม/, '💧'],
  [/ขาว|ใส|กระจ่าง|ออร่า|ผิว|กลูต้า|สว่าง/, '✨'],
];
const EMOJI_FALLBACK = ['✨', '🌟', '💕', '👏', '💡'];

function emojiForHeadline(headline, seed) {
  const t = str(headline);
  for (const [re, ch] of EMOJI_MAP) {
    if (re.test(t)) return ch;
  }
  return EMOJI_FALLBACK[Math.abs(seed) % EMOJI_FALLBACK.length];
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
  const bubblePx = Math.round(H * sc.bubble); // ค่ากลาง ใช้เมื่อผังไม่ได้กำหนด

  const palette = banner.palette || {};
  const accentKey = str(banner.defaultAccentKey, 'urgency');
  const accent = str(palette[accentKey], str(palette.urgency, '#D9622B'));
  const headlineColor = readableOn(accent);

  const bannerShapeRaw = str(banner.shape, '');
  const bannerModeRaw = str(rd.bannerMode, '');
  const shapeForBanner = bannerShapeRaw || bannerModeRaw || 'rounded-rect';
  const isTag = /tag|chip|pill|rounded/i.test(bannerModeRaw || bannerShapeRaw);

  // v3.6: พาดหัวอยู่บนกึ่งกลางเสมอทุกเพจ (เจ้าของกำหนด 28 ก.ค. 69)
  // ชีต 18 (Banner Position / Alignment / Product Emphasis) เลิกใช้แล้ว
  //   - Position / Alignment: ไม่ใช้ เพราะกึ่งกลางบนหมด
  //   - Product Emphasis: ซ้ำกับ Product Visibility Target ในชีต 66 จึงใช้ของ 66
  //   - Height: ย้ายไปอยู่ชีต 20 ที่เดียวกับทรงป้าย
  const bannerHeightPct = Math.min(40, Math.max(6, num(
    (dt.bannerStyle || {})['Banner Height Percent'] ?? banner.heightPercent, 14
  )));
  const productVisibility = num(rd.productVisibilityTarget, 55);
  const emphasiseProduct = productVisibility >= 60;

  const placementCss = `top:4.2%; left:50%; transform:translateX(-50%);
    ${isTag ? '' : `min-height:${Math.round(H * bannerHeightPct / 100)}px;`}
    display:flex; align-items:center; justify-content:center;`;

  const bStyle = bannerStyle({
    shape: shapeForBanner,
    radius: num(banner.cornerRadius, 24),
    shadow: shadowOf(banner.shadow, 'soft'),
    accent,
    textColor: headlineColor,
    isTag,
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
  // v4.0: ชีต 19 เก็บผังไว้สองช่องต่อสไตล์ — เลือกตามรูปทรงเนื้อหาที่ได้จริง
  //   Slot Pattern       = ใช้เมื่อเนื้อหาเป็นหลายก้อนสั้น
  //   Paragraph Pattern  = ใช้เมื่อเนื้อหาเป็นพารากราฟก้อนเดียว
  // ของเดิมมีช่องเดียว ทำให้ผังกับเนื้อหาไม่ตรงกันทุกครั้งที่ WF2 เปลี่ยน layout
  const styleRow = dt.bubbleStyle || {};
  const useParagraph =
    num(rd.textBlockCountMax, 0) === 1 ||
    (str(rd.bubbleMode) === '' && str(rd.structureType).includes('paragraph'));

  const requested = useParagraph
    ? str(styleRow['Paragraph Pattern'] || bubble.paragraphPattern, DEFAULT_PARAGRAPH_PATTERN)
    : str(styleRow['Slot Pattern'] || bubble.slotPattern, DEFAULT_PATTERN);

  // กันไว้อีกชั้น เผื่อชีตกรอกผิดตระกูล
  let patternKey = requested.toLowerCase();
  if (!PATTERNS[patternKey]) patternKey = useParagraph ? DEFAULT_PARAGRAPH_PATTERN : DEFAULT_PATTERN;
  if (useParagraph && PATTERNS[patternKey].kind !== 'paragraph') patternKey = DEFAULT_PARAGRAPH_PATTERN;
  if (!useParagraph && PATTERNS[patternKey].kind === 'paragraph') patternKey = DEFAULT_PATTERN;

  const pattern = PATTERNS[patternKey];
  const isParagraphLayout = pattern.kind === 'paragraph';
  // v4.1: ขนาดตัวอักษรในกล่องมาจากผัง ถ้าเน้นสินค้าค่อยหรี่ลงอีก 8%
  const paraLineCount = pattern.kind === 'paragraph' ? Math.max(1, rawBlocks.length) : 0;
  const fontRatio = pattern.kind === 'paragraph'
    ? paragraphFont(paraLineCount)
    : num(pattern.font, sc.bubble);
  const bubbleFontPx = Math.round(H * fontRatio * (emphasiseProduct ? 0.92 : 1));

  const configuredMax = num(rd.maxOverlayBlocks, num(bubble.maxCount, 4));
  const wasSingleParagraph = overlay.length === 1 && rawBlocks.length > 1;
  const maxBlocks = Math.min(
    isParagraphLayout ? 1 : (wasSingleParagraph ? rawBlocks.length : configuredMax),
    pattern.slots.length
  );
  const blocks = isParagraphLayout
    ? [rawBlocks.join('\n')]
    : rawBlocks.slice(0, maxBlocks);

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

  // v4.5: ตำแหน่งสติกเกอร์แยกรายเพจ แต่ยึดกับป้ายพาดหัวเสมอ
  // ลำดับความสำคัญ: ค่าที่กรอกในชีต -> คำนวณจาก Page ID -> มุมซ้ายบน
  // คำนวณจาก Page ID เป็นแบบตายตัว เพจเดิมจะได้ตำแหน่งเดิมทุกครั้ง
  // และทั้ง 4 ภาพในชุดเดียวกันจะอยู่ตำแหน่งเดียวกัน ไม่กระโดดไปมา
  const ANCHORS = ['tl', 'tr', 'bl', 'br', 'top', 'bottom', 'left', 'right'];
  const TILTS = [-11, -7, -3, 0, 4, 8, 12];
  const stickerAnchorRaw = str(
    dt.stickerAnchor ||
    (dt.bubbleStyle || {})['Sticker Anchor'] ||
    (dt.bannerStyle || {})['Sticker Anchor'] ||
    ''
  ).toLowerCase();
  const pageKey = str(dt.pageId || dt.designId || '');
  let hash = 0;
  for (let i = 0; i < pageKey.length; i += 1) {
    hash = (hash * 31 + pageKey.charCodeAt(i)) % 100000;
  }
  const stickerAnchor = ANCHORS.includes(stickerAnchorRaw)
    ? stickerAnchorRaw
    : (pageKey ? ANCHORS[hash % ANCHORS.length] : 'tl');
  const stickerTilt = pageKey ? TILTS[(hash >> 3) % TILTS.length] : 0;

  const showSticker =
    decoration.includes('emoji_prefix') || decoration.includes('sticker') ||
    decoration.includes('sparkle');
  const pool = [...hRaw.emoji, ...stickers].filter(Boolean);
  const leftChar = pool[0] || emojiForHeadline(headline, hash);
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
    text-align:center;
  }
  /* v4.3: ต้องเป็น inline-block ไม่งั้น Chrome คืน scrollWidth = 0
     ทำให้ลูปย่อฟอนต์ไม่เคยหมุน (ต้นเหตุตัวหนังสือล้นตั้งแต่ v3.1) */
  .banner-inner { display:inline-block; ${bStyle.extra} }
  .sticker {
    position:absolute;
    font-family:'Noto Color Emoji',sans-serif;
    font-size:${Math.round(headlinePx * 1.05)}px;
    line-height:1; z-index:5;
    filter:drop-shadow(0 4px 10px rgba(0,0,0,.28));
  }
  .sticker-left  { top:0.8%; left:2%; }
  .sticker-right { top:2.4%; right:6%; transform:rotate(8deg); }
  .bubble > span { display:inline-block; }
  .bubble {
    position:absolute;
    background:${bubbleBgRaw};
    color:${bubbleFg};
    ${hasBorder ? `border:${bubbleBorder};` : ''}
    ${backdrop}
    ${bubbleTextShadow}
    font-family:'${fontBody}',sans-serif;
    font-weight:700;
    font-size:${bubbleFontPx}px;
    line-height:1.28;
    padding:0.52em 0.9em;
    border-radius:${bubbleRadius}px;
    box-shadow:${isTransparent ? 'none' : bubbleShadow};
    max-width:${emphasiseProduct ? Math.round(parseFloat(pattern.maxWidth) * 0.85) + '%' : pattern.maxWidth};
    white-space:${isParagraphLayout ? 'pre-line' : 'nowrap'};
    ${isParagraphLayout ? 'text-align:left; line-height:1.5;' : ''}
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
    fit(bannerBox, bannerText, ${isTag ? 0.80 : 0.90});

    // v4.5: เกาะสติกเกอร์เข้ากับป้ายพาดหัว ตำแหน่งแยกรายเพจ
    // ของเดิมฟิกซ์ไว้ที่มุมภาพ (top:0.8% left:2%) ทุกเพจจึงเหมือนกันหมด
    // วัดหลังย่อฟอนต์ป้ายเสร็จ จึงได้ขนาดป้ายจริง และ getBoundingClientRect
    // นับ transform ให้ด้วย ทรงเฉียงกับทรงริบบิ้นจึงเกาะถูกตำแหน่งเหมือนกัน
    if (bannerBox) {
      var bb = bannerBox.getBoundingClientRect();
      var anchor = '${stickerAnchor}';
      var mirror = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl',
                     top: 'top', bottom: 'bottom', left: 'right', right: 'left' };
      document.querySelectorAll('.sticker').forEach(function (s) {
        var r = s.getBoundingClientRect();
        var a = s.classList.contains('sticker-left') ? anchor : (mirror[anchor] || 'tr');
        var cx = bb.left + bb.width / 2 - r.width / 2;
        var cy = bb.top + bb.height / 2 - r.height / 2;
        var x, y;
        if (a === 'tl')          { x = bb.left - r.width * 0.55;  y = bb.top - r.height * 0.45; }
        else if (a === 'tr')     { x = bb.right - r.width * 0.45; y = bb.top - r.height * 0.45; }
        else if (a === 'bl')     { x = bb.left - r.width * 0.50;  y = bb.bottom - r.height * 0.55; }
        else if (a === 'br')     { x = bb.right - r.width * 0.50; y = bb.bottom - r.height * 0.55; }
        else if (a === 'top')    { x = cx;                        y = bb.top - r.height * 0.78; }
        else if (a === 'bottom') { x = cx;                        y = bb.bottom - r.height * 0.22; }
        else if (a === 'left')   { x = bb.left - r.width * 0.78;  y = cy; }
        else                     { x = bb.right - r.width * 0.22; y = cy; }
        s.style.left = Math.min(${W} - r.width - 6, Math.max(6, x)) + 'px';
        s.style.top = Math.min(${H} - r.height - 6, Math.max(6, y)) + 'px';
        s.style.right = 'auto';
        s.style.transform = 'rotate(' + (s.classList.contains('sticker-left') ? ${stickerTilt} : ${-stickerTilt}) + 'deg)';
      });
    }

    // v4.2: กันตัวหนังสือทะลุกล่อง
    // ของเดิมเทียบตัวหนังสือกับความกว้างกล่องเต็ม (ซึ่งรวม padding อยู่แล้ว)
    // จึงหยุดย่อเร็วไปเท่ากับ padding ซ้ายขวา แล้ว nowrap ทำให้ล้นออกนอกพื้นสี
    function fitBubble(box, ratio) {
      var span = box.firstElementChild || box;
      var size = parseFloat(getComputedStyle(box).fontSize);
      var guard = 0;
      while (guard < 80) {
        var padX = size * 0.9 * 2;               // ตรงกับ padding:0.52em 0.9em
        var limit = ${W} * ratio - padX;
        if (span.scrollWidth <= limit) return;
        if (size <= 26) break;                    // ย่อจนสุดแล้วยังไม่พอ
        size -= 1; box.style.fontSize = size + 'px'; guard++;
      }
      // ทางออกสุดท้าย: ยอมให้ตัดบรรทัดในกล่อง ดีกว่าปล่อยให้ล้นออกนอกพื้นสี
      box.style.whiteSpace = 'normal';
      box.style.lineHeight = '1.35';
      box.style.overflowWrap = 'break-word';
    }

    // v4.2: พารากราฟไม่เคยมีตัวกันความสูง ถ้าตัดบรรทัดแล้วยาวเกินก็หลุดขอบล่างเงียบๆ
    function fitParagraph(box, ratio, bottomLimit) {
      // v4.7: ปัญหาที่เห็นใน P001/P007 คือบรรทัดต้นทางยาวเกินกล่อง
      // เบราว์เซอร์เลยตัดลงมา เกิดบรรทัดกำพร้าคำเดียว
      // แก้โดยตั้ง white-space:pre ชั่วคราวเพื่อวัดบรรทัดที่ยาวที่สุดจริงๆ
      // แล้วย่อจนบรรทัดนั้นพอดี จากนั้นคืนค่าเดิมและคุมความสูงตามเดิม
      var span = box.firstElementChild || box;
      var size = parseFloat(getComputedStyle(box).fontSize);
      var guard = 0;
      var prevWS = span.style.whiteSpace;
      span.style.whiteSpace = 'pre';
      while (guard < 90) {
        var padX = size * 0.9 * 2;
        var limit = ${W} * ratio - padX;
        if (span.scrollWidth <= limit) break;
        if (size <= 30) break;
        size -= 1; box.style.fontSize = size + 'px'; guard++;
      }
      span.style.whiteSpace = prevWS || 'pre-line';

      guard = 0;
      while (guard < 90) {
        if (box.getBoundingClientRect().bottom <= bottomLimit) return;
        if (size <= 26) return;
        size -= 1; box.style.fontSize = size + 'px'; guard++;
      }
    }

    var ratio = ${(parseFloat(pattern.maxWidth) / 100).toFixed(3)};
    document.querySelectorAll('.bubble').forEach(function (b) {
      if (${isParagraphLayout}) fitParagraph(b, ratio, ${Math.round(H * 0.92)});
      else fitBubble(b, ratio);
    });

    // v4.6: กันกล่องข้อความทับป้ายพาดหัว
    // บางผังมีช่องสำรองอยู่สูงถึง 14% แต่ป้ายกินลงมาถึงราว 19% (ความสูงป้ายมาจากชีต 20)
    // ตัวจัดลำดับช่องอาจหยิบช่องสูงนั้นมาใช้ กล่องแรกจึงไปทับป้าย
    // แก้ด้วยการเลื่อนทั้งชุดลงเท่ากัน เพื่อรักษาระยะห่างของผังเดิมไว้
    // ถ้าเลื่อนแล้วกล่องล่างสุดจะตกขอบ จะเลื่อนเท่าที่พื้นที่เหลือเท่านั้น
    var bubbles = Array.prototype.slice.call(document.querySelectorAll('.bubble'));
    if (bannerBox && bubbles.length) {
      var safeTop = bannerBox.getBoundingClientRect().bottom + ${Math.round(H * 0.025)};
      var rects = bubbles.map(function (b) { return b.getBoundingClientRect(); });
      var topMost = Math.min.apply(null, rects.map(function (r) { return r.top; }));
      if (topMost < safeTop) {
        var shift = safeTop - topMost;
        var lowest = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
        var room = ${Math.round(H * 0.96)} - lowest;
        if (room < shift) shift = Math.max(0, room);
        if (shift > 0) {
          bubbles.forEach(function (b, i) { b.style.top = (rects[i].top + shift) + 'px'; });
        }
      }
    }
  </script>
</body></html>`;
}

/* ---------- routes ---------- */

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'beleaf-render',
    build: BUILD,
    patterns: Object.keys(PATTERNS),
  }));

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

app.listen(PORT, () => console.log(`beleaf-render ${BUILD} listening on ${PORT}`));
