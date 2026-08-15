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
const BUILD = 'v8.2';
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

// v5.7: วัดความสว่างของสี ใช้ตัดสินว่าเป็นพื้นเข้มหรือพื้นอ่อน
// เกณฑ์ 0.45 ใช้ค่าเดียวกับ readableOn จะได้ไม่ขัดกันเอง
function isDarkColor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(str(color));
  if (!m) return null; // ไม่ใช่ hex ล้วน เช่น gradient หรือ transparent
  const int = parseInt(m[1], 16);
  const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((c) => {
    const t = c / 255;
    return t <= 0.03928 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4);
  });
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) <= 0.45;
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
  'para-bottom': { kind: 'paragraph', maxWidth: '88%', font: 0.034, slots: [{ bottom: '4%', left: '6%', centerX: true }] },
};

// v4.2: ฟอนต์พารากราฟแปรตามจำนวนบรรทัด — วัดได้ 5 บรรทัด 53px / 7 บรรทัด 43px
// ของเดิมใช้ค่าเดียว บรรทัดน้อยเลยดูโหวง บรรทัดเยอะเลยล้น
function paragraphFont(lines) {
  // v4.7: ลดลงจาก v4.5 ราว 8% ทุกช่วง ตามที่เจ้าของแจ้งว่าตัวหนังสือใหญ่ไป
  if (lines <= 4) return 0.052;
  if (lines <= 5) return 0.050;
  if (lines <= 6) return 0.046;
  if (lines <= 7) return 0.047;
  if (lines <= 9) return 0.044;
  return 0.041;                   // 32px
}
const DEFAULT_PATTERN = 'split';
const DEFAULT_PARAGRAPH_PATTERN = 'para-left';

// v6.5: ผังเหล่านี้ลำดับช่องคือรูปทรงที่ออกแบบไว้ ห้ามให้ emptySpaceHint สลับ
const FIXED_ORDER_PATTERNS = new Set([
  'right-stack', 'left-stack', 'four-corners', 'bottom-arc', 'top-arc',
]);

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

  // v6.8: พาดหัวตัวอักษรขอบขาว วางทับรูป ไม่มีกล่องพื้นหลัง
  // v7.3: pill-stack — 2 กล่องแคปซูลซ้อนกัน สีต่างกัน
  if (/pill-stack|stack-pill|two-pill/.test(s)) {
    return {
      css: `max-width:96%; padding:0; background:transparent; box-shadow:none;`,
      extra: '',
    };
  }
  if (/outline-bold|outline|stroke/.test(s)) {
    return {
      css: `max-width:97%; padding:0.06em 0;
            background:transparent; box-shadow:none;
            color:${textColor};`,
      extra: `-webkit-text-stroke:0.20em ${accent || '#FFFFFF'};
              paint-order:stroke fill;
              text-shadow:none;
              word-break:keep-all;
              overflow-wrap:normal;
              line-height:1.10;`,
    };
  }
  if (/text-only|underline|none/.test(s)) {
    return {
      css: `max-width:88%; padding:0.10em 0;
            background:transparent; color:#111111;
            border-bottom:0.16em solid ${accent}; box-shadow:none;`,
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
      // v5.2: ต้องคง translateX(-50%) ไว้ด้วย ไม่งั้นทรงเอียงจะเขียนทับการจัดกึ่งกลาง ป้ายจะเลื่อนไปทางขวา
      css: `${inset} ${base} border-radius:0; transform:translateX(-50%) skewX(-9deg);`,
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
  [/นอนดึก|นอนไม่|พักผ่อน|เหนื่อย|อ่อนเพลีย/, '😴'],
  [/แดด|ยูวี|UV|กันแดด|ไวต่อแสง/, '☀'],
  [/ริ้วรอย|ชะลอวัย|อ่อนเยาว์|ตีนกา|แก่/, '⏳'],
  [/สิว|อักเสบ|รอยแดง/, '🌸'],
  [/ฝ้า|กระ|จุดด่างดำ|หมองคล้ำ|ดำแดด|กรรมพันธุ์|รอยดำ/, '🌗'],
  [/ภูมิคุ้มกัน|ป่วย|ไข้|แข็งแรง/, '🛡'],
  [/ดูดซึม|เทคโนโลยี|ไลโปโซม|งานวิจัย|ทดสอบ|มิลลิกรัม|%/, '🔬'],
  [/ราคา|บาท|คุ้ม|โปร|แถม|ส่วนลด|ถูก/, '💸'],
  [/คอลลาเจน|ชุ่มชื้น|เนียน|นุ่ม/, '💧'],
  [/ขาว|ใส|กระจ่าง|ออร่า|ผิว|กลูต้า|สว่าง/, '✨'],
];
const EMOJI_FALLBACK = ['✨', '🌟', '💕', '👏', '💡'];

// v5.8: คลังสติกเกอร์แยกตามโทน ตามสเปกที่เจ้าของกำหนด
//   สุภาพ = เรียบทางการ · กลาง = เครื่องหมายยืนยัน · แซ่บ = ปั่นให้เข้าสถานการณ์
const STICKER_POOL = {
  TONE01: ['\u2728', '\ud83c\udf3f', '\ud83d\udca7', '\ud83c\udf38', '\ud83c\udf3c'],
  TONE02: ['\u2705', '\ud83d\udfe2', '\ud83d\udccc', '\ud83d\udca1', '\u2b50'],
  TONE03: ['\ud83d\udd25', '\ud83d\udca5', '\ud83d\ude31', '\ud83e\udd2f', '\ud83d\udc96', '\u2728', '\ud83d\ude0e'],
};
// จำนวนสติกเกอร์ต่อภาพ และจุดเกาะที่เข้ากับแต่ละโทน
//   สุภาพ วางข้างพาดหัว 1 อัน · กลาง มุมป้าย 2 อัน · แซ่บ กระจาย 3 อัน
// v6.0: กลับมาใช้สติกเกอร์อันเดียวทุกโทน หลายอันแล้วดูซ้ำและรก
//   สิ่งที่ต่างกันตามโทนคือจุดเกาะ ไม่ใช่จำนวน
const STICKER_PLAN = {
  TONE01: { count: 1, anchors: ['left', 'right'] },
  TONE02: { count: 1, anchors: ['tl', 'tr', 'bl', 'br'] },
  TONE03: { count: 1, anchors: ['tl', 'tr', 'top', 'left', 'right'] },
};

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
  // v5.3: ชีต 20 กำหนดคู่สีเองได้ ถ้าเว้นว่างจึงถอยไปใช้พาเลตต์ของธีม
  // ทำให้ล็อกคู่สีตามโทนได้ เช่น ตัวเหลืองบนพื้นดำ ที่ readableOn คิดเองไม่ได้
  const bannerSheet = dt.bannerStyle || {};
  const sheetBg = str(bannerSheet['Background Color'], '');
  const sheetFg = str(bannerSheet['Text Color'], '');
  const accent = sheetBg || str(palette[accentKey], str(palette.urgency, '#D9622B'));
  const headlineColor = sheetFg || readableOn(accent);

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

  // v4.9: ผังพารากราฟยึดจาก layout ของเพจก่อน ไม่ใช่จากชีต 19
  // เหตุผล: ชีต 19 ผูกกับรหัส Bubble Style ซึ่งหลายเพจใช้ร่วมกัน
  // เช่น P001 กับ P014 ใช้ B010 เหมือนกัน ตั้งที่ชีต 19 จะกระทบทั้งคู่
  // ส่วน paragraphPosition มาจากชีต 66 ซึ่งผูกกับ layout รายเพจโดยตรง
  const posMap = { left: 'para-left', right: 'para-right', bottom: 'para-bottom' };
  const layoutPara = posMap[str(rd.paragraphPosition).toLowerCase()] || '';

  // v6.4: ผังกล่องก็ยึดจาก layout ของเพจก่อน เหมือนผังพารากราฟ
  //   ชีต 66 ช่อง Slot Pattern ผูกกับ layout รายเพจโดยตรง
  //   ชีต 19 ผูกกับรหัสบับเบิล ซึ่งหลายเพจใช้ร่วมกัน ตั้งที่นั่นจะกระทบเพจอื่น
  const layoutSlot = str(rd.slotPattern);
  const requested = useParagraph
    ? (layoutPara || str(styleRow['Paragraph Pattern'] || bubble.paragraphPattern, DEFAULT_PARAGRAPH_PATTERN))
    : (layoutSlot || str(styleRow['Slot Pattern'] || bubble.slotPattern, DEFAULT_PATTERN));

  // กันไว้อีกชั้น เผื่อชีตกรอกผิดตระกูล
  let patternKey = requested.toLowerCase();
  if (!PATTERNS[patternKey]) patternKey = useParagraph ? DEFAULT_PARAGRAPH_PATTERN : DEFAULT_PATTERN;
  if (useParagraph && PATTERNS[patternKey].kind !== 'paragraph') patternKey = DEFAULT_PARAGRAPH_PATTERN;
  if (!useParagraph && PATTERNS[patternKey].kind === 'paragraph') patternKey = DEFAULT_PATTERN;

  const pattern = PATTERNS[patternKey];
  const isParagraphLayout = pattern.kind === 'paragraph';
  // v4.1: ขนาดตัวอักษรในกล่องมาจากผัง ถ้าเน้นสินค้าค่อยหรี่ลงอีก 8%
  const paraLineCount = pattern.kind === 'paragraph' ? Math.max(1, rawBlocks.length) : 0;
  // v5.0: พารากราฟก็ฟังค่า Font Scale ด้วย เดิมใช้เฉพาะแบบหลายก้อน
  // ใช้กับโพสต์ภาพเดียวที่ข้อความยาวกว่าปกติ WF2 จะส่ง fontScale = small มาให้
  // v5.1: ย่อพารากราฟลงอีก 12% ทุกกรณี ตามตัวอย่างที่เจ้าของส่งมา
  // v5.7: เจ้าของขอย่อพารากราฟลงอีก 20% จากเดิมที่ย่อไว้ 12% แล้ว
  const paraScale = (scaleKey === 'small' ? 0.80 : scaleKey === 'large' ? 1.12 : 1) * 0.88 * 0.80;
  const fontRatio = pattern.kind === 'paragraph'
    ? paragraphFont(paraLineCount) * paraScale
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
  let bubbleBgRaw = str(bubble.background, '#FFFFFF');
  const isGradient = /gradient\(/i.test(bubbleBgRaw);
  const isTransparent = /^transparent$/i.test(bubbleBgRaw);
  let bubbleFg = str(bubble.textColor, '#1B1B1B');

  // v5.7: พาดหัวกับกล่องข้อความต้องสลับขั้วสีกันเสมอ
  // พาดหัวตัวเข้มพื้นอ่อน -> กล่องต้องตัวอ่อนพื้นเข้ม และกลับกัน
  // ถ้าซ้ำขั้ว ให้สลับสีพื้นกับสีตัวอักษรของกล่อง จะได้คงโทนสีเดิมไว้
  const bannerDark = isDarkColor(accent);
  const bubbleDark = isDarkColor(bubbleBgRaw);
  let polaritySwapped = false;
  if (bannerDark !== null && bubbleDark !== null && bannerDark === bubbleDark) {
    const swapTo = isDarkColor(bubbleFg);
    if (swapTo !== null && swapTo !== bubbleDark) {
      const tmp = bubbleBgRaw;
      bubbleBgRaw = bubbleFg;
      bubbleFg = tmp;
      polaritySwapped = true;
    }
  }
  const bubbleBorder = str(bubble.border, 'none');
  const hasBorder = bubbleBorder && bubbleBorder.toLowerCase() !== 'none';
  const bubbleShape = str(bubble.shape, 'rounded-rect').toLowerCase();
  const bubbleRadius = /pill/.test(bubbleShape) ? 999 : 22;
  const bubbleShadow = shadowOf(bubble.shadow, 'soft');
  // v7.8: พื้นหลังหุ้มตามบรรทัด — เปิดเฉพาะเพจที่ชีต 19 Bubble Shape มีคำว่า hug
  const hugLines = isParagraphLayout && /hug|per-line|line-hug/i.test(bubbleShape);
  // v5.3: เจ้าของสั่งห้ามมีเงาตัวหนังสือทุกตำแหน่ง เพราะอ่านยาก
  // ความอ่านออกบนพื้นโปร่งให้แก้ด้วยการเลือกคู่สีที่ตัดกันแทน
  const bubbleTextShadow = '';
  const backdrop = /rgba\(/i.test(bubbleBgRaw) ? 'backdrop-filter:blur(6px);' : '';

  const fontHeadline = fontFamily(typo.fontHeadline, 'Anuphan');
  const fontBody = fontFamily(typo.fontBody, 'IBM Plex Sans Thai');
  const headlineWeight = num(typo.headlineWeight, 800);

  // v6.5: ผังรูปทรงตายตัวใช้ลำดับตามที่ออกแบบ ไม่เอา hint มาสลับ
  const slotOrder = FIXED_ORDER_PATTERNS.has(patternKey)
    ? pattern.slots
    : orderSlots(pattern.slots, rd.emptySpaceHint);
  // v5.8: โทนมาจากคอลัมน์ Tone Scope ที่เพิ่มไว้ในชีต 19/20
  //   ต้องประกาศก่อนสร้างกล่องข้อความ เพราะติ๊กถูกใช้ค่านี้ด้วย
  const toneRaw = str((dt.bubbleStyle || {})['Tone Scope'] || (dt.bannerStyle || {})['Tone Scope'], '').toUpperCase();
  const toneKey = ['TONE01', 'TONE02', 'TONE03'].includes(toneRaw) ? toneRaw : 'TONE02';

  // v5.8: โทนกลางให้ติ๊กถูกหน้าก้อนที่เป็นสรรพคุณ ตามที่เจ้าของขอ
  //   ใช้เฉพาะแบบหลายก้อน พารากราฟไม่ใส่เพราะเป็นการเล่าเรื่อง
  // v6.2: ใช้บทบาทของภาพเป็นตัวตัดสิน ไม่ใช่จับคำในแต่ละก้อน
  //   ของเดิมจับคำแล้วพัง เพราะ "แต่งหน้าก็ไม่ช่วย" มีคำว่า ช่วย จึงได้ติ๊กถูกทั้งที่เป็นประโยคลบ
  //   บทบาทมาจาก renderDirectives.panelRole ซึ่ง WF2 ส่งมาให้อยู่แล้ว
  const panelRole = str(rd.panelRole).toLowerCase();
  const NEGATIVE_ROLES = ['hook', 'problem', 'overview', 'story'];
  const POSITIVE_ROLES = ['benefit', 'proof', 'product_role', 'explanation', 'usage', 'summary', 'decision'];
  const roleMark = NEGATIVE_ROLES.includes(panelRole) ? '\u2757 '
    : POSITIVE_ROLES.includes(panelRole) ? '\u2705 '
    : '';
  // v6.3: ปิดติ๊กถูก/ตกใจตามคำสั่งเจ้าของ กลับไปหน้าตากล่องข้อความแบบ v5.7
  //   ยังไม่เคยพิสูจน์ว่าติ๊กช่วยจริง จึงปิดไว้ก่อน ไม่ลบโค้ดทิ้ง
  //   เปิดกลับได้ทันที เปลี่ยน ENABLE_ROLE_TICK เป็น true
  //   ส่วนสติกเกอร์ v6.0 และย่อหน้าล่างเกาะขอบ v6.1 ยังอยู่ครบ
  const ENABLE_ROLE_TICK = false;
  const tickTone = ENABLE_ROLE_TICK && toneKey === 'TONE02' && !isParagraphLayout && blocks.length > 1 && Boolean(roleMark);
  // v6.1: แยกสามสถานะ บวก ลบ กลางๆ
  //   บวก  = พูดถึงผลลัพธ์ที่ดีขึ้นหรือคุณสมบัติของสินค้า  ใช้ติ๊กถูก
  //   ลบ   = พูดถึงปัญหาที่ยังไม่ได้แก้                     ใช้เครื่องหมายตกใจ
  //   กลาง = ตัดสินไม่ได้                                   ไม่ใส่อะไรเลย ปลอดภัยกว่าใส่ผิด
  const BETTER = /(ลดลง|จางลง|ดีขึ้น|ขึ้น|ช่วย|เห็นผล|กระจ่าง|เนียน|สม่ำเสมอ|ชุ่มชื้น|ยืดหยุ่น|ฟื้นฟู|บำรุง|ปกป้อง|ครบ|ได้|ไม่ต้อง|%|มก\.|ชนิด|เท่า)/;
  const WORSE = /(หมอง|คล้ำ|ด่างดำ|รอยดำ|สิว|ริ้วรอย|แห้ง|โทรม|ล้า|ลืม|ไหม้|ดำ|กังวล|ไม่มั่นใจ|ปัญหา|สะสม)/;
  const tickPrefix = (t) => {
    const x = str(t);
    if (!x || x.length < 6) return '';
    if (/[?？]$/.test(x)) return '';
    if (/^(ทำไม|ยังไง|อย่างไร|ไหม|มั้ย|สงสัย)/.test(x)) return '';
    if (BETTER.test(x)) return '\u2705 ';
    if (WORSE.test(x)) return '\u2757 ';
    return '';
  };
  const bubbleHtml = blocks.map((t, i) => {
    const slot = slotOrder[i];
    const pos = slot.centerX ? 'left:50%; transform:translateX(-50%);' : (slot.left ? `left:${slot.left};` : `right:${slot.right};`);
    // v6.1: ถ้าผังบอกระยะจากขอบล่าง ให้เกาะขอบล่างจริง จะได้ชิดขอบเหมือนพาดหัวชิดขอบบน
    const vert = slot.bottom ? `bottom:${slot.bottom};` : `top:${slot.top};`;
    const anchorClass = slot.bottom ? ' bubble-bottom' : '';
    const label = tickTone ? roleMark + t : t;
    return `<div class="bubble${anchorClass}" style="${vert}${pos}"><span>${esc(label)}</span></div>`;
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
  const plan = STICKER_PLAN[toneKey];
  const stickerAnchor = ANCHORS.includes(stickerAnchorRaw)
    ? stickerAnchorRaw
    : plan.anchors[hash % plan.anchors.length];
  const stickerTilt = pageKey ? TILTS[(hash >> 3) % TILTS.length] : 0;

  // v5.9: สเปกใหม่ให้ทุกโทนมีสติกเกอร์ จำนวนและตำแหน่งคุมด้วยโทนแทน
  //   ของเดิมเปิดเฉพาะค่าตกแต่ง emoji_prefix/sticker/sparkle
  //   ทำให้เพจที่ตั้งเป็น Line หรือ Arrow ไม่มีสติกเกอร์เลยสักอัน
  const showSticker = true;
  // v6.0: ลำดับการเลือกสติกเกอร์ ให้ตรงเนื้อหาเป็นหลัก
  //   1) อีโมจิที่อยู่ในเนื้อหาอยู่แล้ว = เจตนาของคนเขียน
  //   2) จับคำจากพาดหัวและข้อความบนภาพ ผ่าน EMOJI_MAP
  //   3) คลังตามโทน ใช้เมื่อไม่มีคำไหนตรงเลย
  const tonePool = STICKER_POOL[toneKey];
  const fromContent = [...hRaw.emoji, ...stickers].filter(Boolean);
  const matchText = [headline, ...blocks].join(' ');
  const byKeyword = EMOJI_MAP.find(([re]) => re.test(matchText));
  const first = fromContent[0] || (byKeyword ? byKeyword[1] : tonePool[hash % tonePool.length]);
  const second = fromContent[1] || tonePool[(hash + 3) % tonePool.length] || '\u2728';
  const chosen = /pill-stack|stack-pill|two-pill/i.test(shapeForBanner) ? [first, second === first ? '\u2728' : second] : [first];
  // v7.3: pill-stack — แบ่งพาดหัวเป็น 2 ท่อนให้สมดุล แล้วห่อด้วย pill คนละสี
  const isPillStack = /pill-stack|stack-pill|two-pill/i.test(shapeForBanner);
  const accent2 = str(bannerSheet['Background Color 2'] || bannerSheet['Accent Color 2'], '#A970D8');
  let bannerInnerHtml = `<span class="banner-inner">${esc(headline)}</span>`;
  if (isPillStack) {
    const words = headline.split(/\s+/).filter(Boolean);
    let a = headline, b = '';
    if (words.length > 1) {
      let best = 1e9, at = 1;
      for (let i = 1; i < words.length; i += 1) {
        const l1 = words.slice(0, i).join(' ').length;
        const l2 = words.slice(i).join(' ').length;
        const d = Math.abs(l1 - l2);
        if (d < best) { best = d; at = i; }
      }
      a = words.slice(0, at).join(' ');
      b = words.slice(at).join(' ');
    } else if (headline.length > 10) {
      const mid = Math.round(headline.length / 2);
      a = headline.slice(0, mid); b = headline.slice(mid);
    }
    bannerInnerHtml = `<span class="pill pill-a">${esc(a)}</span>` + (b ? `<span class="pill pill-b">${esc(b)}</span>` : '');
  }
  const CLASSES = ['sticker-left', 'sticker-right', 'sticker-third'];
  const stickerHtml = showSticker
    ? chosen.map((c, i) => `<div class="sticker ${CLASSES[i] || 'sticker-third'}">${esc(c)}</div>`).join('')
    : '';

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anuphan:wght@400;500;600;700;800&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Kanit:wght@400;500;600;700;800;900&family=Mitr:wght@400;500;600;700&family=Prompt:wght@400;500;600;700&family=Sarabun:wght@400;500;600;700;800&family=Bai+Jamjuree:wght@400;500;600;700&family=Chakra+Petch:wght@400;500;600;700&family=Itim&family=Krub:wght@400;500;600;700&family=Noto+Sans+Thai:wght@400;500;600;700;800;900&family=Pridi:wght@400;500;600;700&family=Noto+Color+Emoji&display=swap" rel="stylesheet">
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
  /* v7.3: pill-stack */
  .banner { ${isPillStack ? "flex-direction:column; gap:0.10em; align-items:center;" : ""} }
  .pill {
    display:inline-block; border-radius:999px;
    padding:0.22em 0.72em; color:#FFFFFF; font-weight:800;
    white-space:nowrap; line-height:1.22;
    box-shadow:0 8px 22px rgba(0,0,0,.16);
  }
  .pill-a { background:${accent}; transform:translateX(-3%) rotate(-2.2deg); }
  .pill-b { background:${accent2}; transform:translateX(4%) rotate(1.6deg); }
  .sticker {
    position:absolute;
    font-family:'Noto Color Emoji',sans-serif;
    font-size:${Math.round(headlinePx * 1.05)}px;
    line-height:1; z-index:5;
    filter:drop-shadow(0 4px 10px rgba(0,0,0,.28));
  }
  .sticker-left  { top:0.8%; left:2%; }
  .sticker-right { top:2.4%; right:6%; transform:rotate(8deg); }
  .sticker-third { top:4%; left:8%; transform:rotate(-6deg); }
  .bubble-bottom { top:auto; }
  .bubble > span { display:inline-block; }
  .bubble {
    position:absolute;
    background:${hugLines ? 'transparent' : bubbleBgRaw};
    color:${bubbleFg};
    ${(hasBorder && !hugLines) ? `border:${bubbleBorder};` : ''}
    ${backdrop}
    ${bubbleTextShadow}
    font-family:'${fontBody}',sans-serif;
    font-weight:${isParagraphLayout ? 400 : 500};
    font-size:${bubbleFontPx}px;
    line-height:1.34;
    letter-spacing:0.005em;
    padding:${hugLines ? '0' : (isParagraphLayout ? '0.40em 0.60em' : '0.52em 0.9em')};
    border-radius:${bubbleRadius}px;
    box-shadow:${(isTransparent || hugLines) ? 'none' : bubbleShadow};
    max-width:${emphasiseProduct ? Math.round(parseFloat(pattern.maxWidth) * 0.85) + '%' : pattern.maxWidth};
    white-space:${isParagraphLayout ? 'pre-line' : 'nowrap'};
    ${isParagraphLayout ? `text-align:center; line-height:${hugLines ? '1.52' : '1.5'};` : ''}
  }
  /* v7.7: พารากราฟ — พื้นหลังหุ้มตามความยาวของแต่ละบรรทัด */
  ${hugLines ? `
  .bubble > span {
    display:inline;
    background:${bubbleBgRaw};
    -webkit-box-decoration-break:clone;
    box-decoration-break:clone;
    padding:0.28em 0.72em;
    border-radius:${bubbleRadius}px;
    box-shadow:${isTransparent ? 'none' : bubbleShadow};
    ${hasBorder ? `border:${bubbleBorder};` : ''}
  }` : ''}
</style></head>
<body>
  <div class="stage">
    <div class="photo"></div>
    ${stickerHtml}
    <div class="banner" id="banner">${bannerInnerHtml}</div>
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
    var __outline = ${/outline-bold|outline|stroke/i.test(shapeForBanner) ? 'true' : 'false'};
    fit(bannerBox, bannerText, __outline ? 0.97 : ${isTag ? 0.80 : 0.90});
    // v7.2: ถ้าย่อจนเล็กเกินไป คืนขนาดเดิมแล้วยอมให้ขึ้นบรรทัดใหม่
    if (__outline && bannerBox && parseFloat(getComputedStyle(bannerBox).fontSize) < 56) {
      bannerBox.style.fontSize = '${headlinePx}px';
      bannerBox.style.whiteSpace = 'normal';
      fit(bannerBox, bannerText, 0.97);
    }

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
        var a = s.classList.contains('sticker-left') ? anchor
              : s.classList.contains('sticker-third') ? 'bottom'
              : (mirror[anchor] || 'tr');
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
      // v4.8: เลิกย่อฟอนต์เพื่อกันบรรทัดตัด
      // v4.7 ตั้ง white-space:pre แล้วย่อจนบรรทัดยาวสุดพอดีกล่อง
      // แต่พอเทียบกับโพสต์ Dr.PONG จริงพบว่าเขาตัดกลางคำเต็มไปหมดและยังอ่านดี
      // การกันบรรทัดตัดจึงไม่จำเป็น และทำให้ฟอนต์เล็กเกินเหตุเมื่อบรรทัดยาว
      // เหลือแค่คุมความสูงไม่ให้ล้นขอบล่าง ปล่อยการตัดบรรทัดตามธรรมชาติ
      var size = parseFloat(getComputedStyle(box).fontSize);
      var guard = 0;
      while (guard < 90) {
        if (box.getBoundingClientRect().bottom <= bottomLimit) return;
        if (size <= 40) return;
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
    var bubbles = Array.prototype.slice.call(document.querySelectorAll('.bubble'))
      .filter(function (b) { return !b.classList.contains('bubble-bottom'); });
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
