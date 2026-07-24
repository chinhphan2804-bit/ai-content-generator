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
