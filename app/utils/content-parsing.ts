const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&nbsp;": " ", "&ndash;": "–", "&mdash;": "—", "&hellip;": "…",
  "&rsquo;": "’", "&lsquo;": "‘", "&rdquo;": "”", "&ldquo;": "“",
  "&copy;": "©", "&reg;": "®", "&trade;": "™",
};

// Trang scrape về luôn ở dạng HTML thô — &nbsp;, &#39;, &ndash;... phải được
// giải mã thành ký tự thật trước khi đưa lên UI hoặc vào prompt Claude, nếu
// không merchant sẽ thấy nguyên văn mã HTML lộ ra (đã gặp thật với &ndash;).
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-zA-Z]+;/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}

// Nhiều store Shopify khai báo sẵn Product schema (JSON-LD) — đây là mô tả
// "sạch" do chính store khai báo, đáng tin hơn nhiều so với tự bóc chữ hiển
// thị trên trang (dễ dính trúng menu/giỏ hàng nếu trang không có mô tả thật).
// Trả về found=true khi có schema Product (kể cả description rỗng) để phân
// biệt "trang xác nhận không có mô tả" với "trang không có schema để biết".
export function extractJsonLdDescription(html: string): { found: boolean; description: string } {
  const scripts = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
  for (const block of scripts) {
    const jsonText = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const data = JSON.parse(jsonText);
      const items = Array.isArray(data) ? data : (data["@graph"] || [data]);
      for (const item of items) {
        if (item?.["@type"] === "Product") {
          const raw = typeof item.description === "string" ? item.description : "";
          const desc = decodeHtmlEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
          return { found: true, description: desc };
        }
      }
    } catch {
      // JSON-LD lỗi định dạng — bỏ qua, thử script tiếp theo
    }
  }
  return { found: false, description: "" };
}

// Cụm từ đặc trưng của UI filter/sort/phân trang hoặc caption ẩn cho a11y của
// lưới sản phẩm (vd "Swatch type BLACK of Ride Warpig Snowboard Mens") trên
// trang category — không phải mô tả sản phẩm, dù đôi khi dài/nối câu liên tục
// trông giống văn xuôi (vd liệt kê brand: "Arbor Refine by Brand: Arbor...").
const UI_CHROME_PATTERN = /\b(refine by|sort by|show \/ hide|currently refined by|filter(ing)?s?\b|\d+\s*results?\)?|add to (cart|bag|wishlist)|quick view|\bin stock\b|\bout of stock\b|swatch type|image of\b|are you sure you want to remove|no (products|results|items) (were |was )?found|nothing found matching|no products match|skip to content|this (website|site) uses cookies|we use cookies|cookie (policy|notice|consent|settings)|by continuing (to use|past)|accept (all )?cookies|sign up for (our )?newsletter|subscribe to (our )?newsletter|requires? javascript|enable javascript|javascript (is )?(disabled|turned off)|doesn'?t support javascript|choosing a selection results in a( full)? page refresh)/i;

// Trang category/collection thường có rất nhiều chữ UI (bộ lọc, sắp xếp, phân
// trang, caption ẩn của lưới sản phẩm) đứng TRƯỚC đoạn mô tả marketing thật
// trong DOM — lấy thẳng N ký tự đầu tiên (cách cũ) sẽ vớt toàn chữ rác, bỏ lỡ
// đoạn văn có giá trị nằm phía dưới (case thật: christysports.com — mô tả hay
// nằm cuối trang). Chấm điểm "độ giống văn xuôi thật" cho từng khối, kiểu
// thuật toán "readability" đơn giản.
function scoreProseChunk(text: string): number {
  if (text.length < 40) return -1; // filter chip/label thường rất ngắn
  const sentenceEnds = (text.match(/[.!?](\s|$)/g) || []).length;
  // Không có câu hoàn chỉnh nào (không dấu ., !, ?) — gần như chắc chắn đây
  // là chuỗi tên sản phẩm/brand/label nối tiếp nhau, không phải mô tả thật
  // (vd "K2 Maysis Snowboard Boots Mens Ride Insano Snowboard Boots Mens...").
  if (sentenceEnds === 0) return -1;
  const words = text.split(/\s+/).filter(Boolean);
  const avgWordLen = words.reduce((sum, w) => sum + w.length, 0) / (words.length || 1);
  let score = sentenceEnds * 25 + text.length * 0.1;
  if (UI_CHROME_PATTERN.test(text)) score -= 300;
  if (avgWordLen < 3.5) score -= 60; // toàn từ ngắn, ít câu hoàn chỉnh -> khó là văn xuôi thật
  // Phòng vệ chung (không chỉ liệt kê từng cụm từ rác riêng lẻ): mọi loại rác
  // gặp thật đều là câu đơn lẻ (cookie banner, cảnh báo JS, thông báo a11y
  // "Choosing a selection...") — trừ điểm nhẹ cho khối chỉ có đúng 1 câu, để
  // đoạn văn marketing nhiều câu thật luôn thắng khi cả 2 cùng xuất hiện.
  if (sentenceEnds === 1) score -= 30;
  return score;
}

// Cắt về đúng maxLength nhưng đánh dấu rõ bằng "..." khi thật sự có cắt —
// nếu không, nội dung dài bị cụt ngang giữa câu trông như lỗi/tải thiếu chứ
// không phải cố ý giới hạn độ dài. Chỉ thêm "..." khi text.length > maxLength
// (không thêm vào nội dung vốn đã ngắn hơn giới hạn).
export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + "...";
}

// Chỉ lấy ĐÚNG 1 đoạn khớp nhất với "mô tả sản phẩm/danh mục" — cố tình
// KHÔNG gộp nhiều đoạn lại, vì các đoạn nằm rải rác trên trang (tên sản phẩm,
// review, mô tả brand...) ghép chung dễ ra 1 khối lộn xộn sai ngữ cảnh, còn
// tệ hơn cả lấy thiếu.
export function extractMainContent(bodyHtml: string, maxLength = 2500): string {
  const withParagraphBreaks = bodyHtml
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<select[\s\S]*?<\/select>/gi, "")
    .replace(/<button[\s\S]*?<\/button>/gi, "")
    // Đánh dấu ranh giới từng khối TRƯỚC khi bóc hết thẻ, để còn tách được
    // riêng từng đoạn thay vì dính thành 1 chuỗi liên tục không phân biệt được.
    .replace(/<\/(p|div|li|section|article|h[1-6])>/gi, "\n$&");

  const blocks = decodeHtmlEntities(withParagraphBreaks.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let best = "";
  let bestScore = 0;
  for (const text of blocks) {
    const score = scoreProseChunk(text);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }

  return truncateWithEllipsis(best, maxLength);
}

// Chặn HTML/script lạ lọt vào descriptionHtml khi lưu — nội dung ở đây có thể
// đến từ ô nhập tay của merchant hoặc do AI sinh ra (kể cả từ trang đối thủ
// đã scrape), nên không được tin tưởng tuyệt đối trước khi ghi thành HTML.
export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function applyAiContentText(
  raw: string,
  setTitle: (v: string) => void,
  setMeta: (v: string) => void,
  setDesc: (v: string) => void,
  setBullets: (v: string[]) => void
) {
  if (!raw) return;
  const titleMatch = raw.match(/SEO TITLE:\s*(.*?)(?:\n|$)/i);
  const metaMatch = raw.match(/META DESCRIPTION:\s*(.*?)(?:\n|$)/i);
  const descMatch = raw.match(/PRODUCT DESCRIPTION:\s*([\s\S]*?)(?:\n\nBULLET POINTS:|$)/i);
  const bulletsMatch = raw.match(/BULLET POINTS:\s*([\s\S]*?)$/i);

  if (titleMatch) setTitle(titleMatch[1].trim());
  if (metaMatch) setMeta(metaMatch[1].trim());
  if (descMatch) setDesc(descMatch[1].trim());
  if (bulletsMatch) {
    const bs = bulletsMatch[1]
      .split("\n")
      .filter((b: string) => b.trim().startsWith("-"))
      .map((b: string) => b.replace(/^- /, "").trim());
    setBullets([bs[0] || "", bs[1] || "", bs[2] || ""]);
  }
}
