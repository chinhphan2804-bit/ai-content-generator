import { useState, useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";
import prisma from "../db.server";
import { decodeHtmlEntities, extractJsonLdDescription, escapeHtml, applyAiContentText, extractMainContent, truncateWithEllipsis } from "../utils/content-parsing";

async function getAdmin(request: Request) {
  return authenticate.admin(request);
}
import Anthropic from "@anthropic-ai/sdk";

// Số lượt "Generate AI Content" miễn phí trước khi cần nâng cấp gói Pro.
const FREE_GENERATE_LIMIT = 5;

// Safety-net rate limit theo ngày cho MỌI shop kể cả đã trả phí "unlimited" —
// chỉ để chặn bug/spam gọi lặp vô hạn, dư sức cho merchant dùng bình thường.
const DAILY_SAFETY_LIMIT = 100;

type Product = { id: string; title: string; price: string; currency: string };
type Message = { role: "user" | "assistant"; content: string };

function renderBold(text: string) {
  // Tự động in đậm: **text** và số tiền ($9.99, USD 9.99, 9.99 USD, v.v.)
  const pattern = /(\*\*.+?\*\*|(?:USD|EUR|GBP|VND|AUD|CAD)\s*[\d,]+(?:\.\d+)?|[$€£₫]\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:USD|EUR|GBP|VND|AUD|CAD))/g;
  const parts = text.split(pattern);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (/(?:USD|EUR|GBP|VND|AUD|CAD|\$|€|£|₫)/.test(part) && /\d/.test(part)) {
      return <strong key={i}>{part}</strong>;
    }
    return part;
  });
}

// bodyText giữ nguyên dòng bullet dạng "- " (từ extractDescriptionWithAI) để
// không mất định dạng gốc — hàm này chỉ lo phần HIỂN THỊ: gom các dòng "- "
// liên tiếp thành 1 <ul> bullet chấm tròn, còn lại render như đoạn văn thường.
function renderBodyText(text: string) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let currentList: string[] = [];

  const flushList = () => {
    if (currentList.length === 0) return;
    elements.push(
      <ul key={`ul-${elements.length}`} style={{ margin: "0 0 8px", paddingLeft: "20px" }}>
        {currentList.map((item, i) => <li key={i} style={{ marginBottom: "4px" }}>{renderBold(item)}</li>)}
      </ul>
    );
    currentList = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^-\s+(.*)/);
    if (bulletMatch) {
      currentList.push(bulletMatch[1]);
      continue;
    }
    flushList();
    if (trimmed) {
      elements.push(<p key={`p-${elements.length}`} style={{ margin: "0 0 8px" }}>{renderBold(trimmed)}</p>);
    }
  }
  flushList();
  return elements;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await getAdmin(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || session.shop || "chinh-dev-store.myshopify.com";
  return { shop };
};

const BLOCKED_DOMAINS = ["reddit.com", "quora.com", "pinterest.com", "youtube.com", "facebook.com", "twitter.com", "instagram.com", "tiktok.com", "forum", "community", "discuss"];

type SearchResult = { title: string; link: string; snippet: string };

// Trả về DANH SÁCH đối thủ đã xếp hạng (ưu tiên trang product/shop trước),
// không chỉ 1 kết quả — để có thể thử lần lượt khi kết quả đầu bị chặn.
async function searchCompetitors(productName: string): Promise<SearchResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: `buy ${productName} -site:reddit.com -site:quora.com -site:pinterest.com -site:youtube.com`, num: 10 }),
  });
  const data = await res.json() as any;
  const organic: SearchResult[] = data.organic || [];
  // Lọc bỏ forum, social media, tin tức
  const nonBlocked = organic.filter(r => !BLOCKED_DOMAINS.some(d => r.link.includes(d)));
  const ecommerce = nonBlocked.filter(r =>
    r.link.includes("amazon.") || r.link.includes("etsy.") || r.link.includes("shopify") ||
    r.link.includes("/product") || r.link.includes("/shop") || r.link.includes("/store") ||
    r.link.includes("/p/") || r.link.includes("/item")
  );
  const rest = nonBlocked.filter(r => !ecommerce.includes(r));
  return [...ecommerce, ...rest];
}

type PageContent = { title: string; metaDesc: string; bodyText: string; raw: string; noDescription?: boolean; resolvedUrl?: string };

// Mỗi nền tảng ecommerce dùng 1 dạng URL riêng cho trang chi tiết 1 sản phẩm
// cụ thể — Shopify: /products/<handle>, Amazon: /dp/<ASIN>, WooCommerce/nhiều
// site khác: /product/<slug> — dùng để tìm link sản phẩm trong 1 trang
// collection/listing, giống hành vi thật của người dùng khi họ vào trang danh
// sách rồi bấm vào 1 sản phẩm để xem mô tả (case thật: Shopify
// /collections/mens-snowboards liệt kê nhiều board, không có mô tả riêng).
const PRODUCT_HREF_PATTERNS = [
  /\/products\/[^"#?]+/, // Shopify
  /\/dp\/[A-Z0-9]{8,12}[^"#?]*/, // Amazon
  /\/gp\/product\/[A-Z0-9]{8,12}[^"#?]*/, // Amazon (dạng cũ)
  /\/product\/[^"#?]+/, // WooCommerce và nhiều site khác
];

function isProductHref(href: string): boolean {
  return PRODUCT_HREF_PATTERNS.some((p) => p.test(href));
}

// Nút tài khoản/tiện ích (đổi thẻ, xem số dư, đăng nhập, giỏ hàng...) thường
// DÙNG CHUNG dạng URL với link sản phẩm thật (case thật: nút "Reload Your
// Balance" trên Amazon /gift-cards trỏ tới /dp/<ASIN> y hệt link 1 gift card
// design, và đứng ngay đầu trang — trước mọi sản phẩm thật trong DOM — nên
// nếu chỉ so khớp URL, đây luôn thắng "link sản phẩm đầu tiên" oan uổng, dẫn
// tới bấm nhầm vào trang "nạp lại số dư" thay vì 1 gift card thật). Lọc theo
// aria-label/chữ hiển thị của link để loại các thao tác tài khoản/tiện ích.
const UTILITY_LINK_TEXT = /\b(redeem|reload|balance|track (your )?order|sign[- ]?in|sign[- ]?up|log[- ]?in|register|view (your )?(cart|bag|account|profile|order)|checkout|wishlist|subscribe|unsubscribe|customer service|contact us|return (an? )?item|refund|apply (a )?coupon|promo code|help center|track package)\b/i;

// So sánh bỏ qua fragment (#...) — 1 link "#userAccount" hay "#reviews" trỏ
// VỀ CHÍNH trang collection (chỉ cuộn tới 1 section), server trả về y hệt nội
// dung trang gốc nên không giúp gì (case thật: Kroger /egift-cards có link
// "#userAccount" đứng ngay đầu trang, nếu so khớp chuỗi y hệt pageUrl sẽ lọt
// lưới vì có thêm fragment nên không "===" pageUrl).
function isSamePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return a === b;
  }
}

// Trả về TỐI ĐA `max` link sản phẩm khác nhau, đúng thứ tự xuất hiện trong
// DOM — không dừng lại ở link khớp URL đầu tiên (dễ trúng nút tiện ích như
// trên), để nơi gọi có thể thử lần lượt từng link cho tới khi có 1 cái trích
// ra được mô tả thật, giống hành vi người dùng thật: bấm vào 1 sản phẩm,
// không ra gì thì quay lại bấm sản phẩm khác.
function extractProductLinks(html: string, pageUrl: string, max = 3): string[] {
  const anchorPattern = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const links: string[] = [];

  for (const m of html.matchAll(anchorPattern)) {
    const attrs = m[1];
    const href = attrs.match(/href="([^"]*)"/i)?.[1];
    if (!href || !isProductHref(href)) continue;

    const ariaLabel = attrs.match(/aria-label="([^"]*)"/i)?.[1] || "";
    const innerText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (UTILITY_LINK_TEXT.test(ariaLabel) || UTILITY_LINK_TEXT.test(innerText)) continue;

    try {
      const resolved = new URL(href, pageUrl).toString();
      if (isSamePage(resolved, pageUrl) || seen.has(resolved)) continue;
      seen.add(resolved);
      links.push(resolved);
      if (links.length >= max) break;
    } catch {
      // href không parse được thành URL hợp lệ — bỏ qua, thử tiếp
    }
  }

  return links;
}

// Fallback khi platform không khớp bất kỳ pattern nào trong
// PRODUCT_HREF_PATTERNS (case thật: Kroger dùng URL phẳng kiểu
// giftcards.kroger.com/apple-gift-card — không /products/, /dp/, /product/
// gì cả, nên extractProductLinks luôn trả về rỗng và code không "bấm vào"
// được sản phẩm nào, lấy nhầm mô tả DANH MỤC làm Product Description). Mọi
// thẻ sản phẩm trong 1 lưới danh mục đều có ảnh sản phẩm đi kèm 1 link tên
// riêng — dùng cấu trúc "ảnh + link" lặp lại này để nhận diện link sản phẩm
// mà không cần biết trước URL scheme của từng nền tảng.
function extractCardGridLinks(html: string, pageUrl: string, max = 3): string[] {
  const cardPattern = /<img\b[^>]*>[\s\S]{0,600}?<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  const origin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return "";
    }
  })();
  const seen = new Set<string>();
  const links: string[] = [];

  for (const m of html.matchAll(cardPattern)) {
    const attrs = m[1];
    const href = attrs.match(/href="([^"]*)"/i)?.[1];
    if (!href) continue;

    const ariaLabel = attrs.match(/aria-label="([^"]*)"/i)?.[1] || "";
    const innerText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (UTILITY_LINK_TEXT.test(ariaLabel) || UTILITY_LINK_TEXT.test(innerText)) continue;

    try {
      const resolved = new URL(href, pageUrl).toString();
      if (new URL(resolved).origin !== origin) continue; // bỏ link ngoài trang (mạng xã hội, ads...)
      if (isSamePage(resolved, pageUrl) || seen.has(resolved)) continue;
      seen.add(resolved);
      links.push(resolved);
      if (links.length >= max) break;
    } catch {
      // href/origin không parse được — bỏ qua, thử tiếp
    }
  }

  return links;
}

// Heuristic chấm điểm theo khối (extractMainContent) thiên vị đoạn văn dài
// nhiều câu — nên hay chọn nhầm review khách hàng (nhiều câu liên tục) thay
// vì bỏ sót mô tả dạng bullet list như "About this item" của Amazon (mỗi
// bullet chỉ 1 câu ngắn, bị đánh giá thấp dù đây mới là mô tả sản phẩm thật
// sự). Nhờ AI đọc toàn bộ trang và tự trích ra đúng phần mô tả — hiểu được cả
// dạng đoạn văn lẫn dạng bullet list, không bị bó buộc theo 1 khuôn heuristic.
//
// flatText truyền vào đây bị cắt ở `flatText.slice(0, N)` TRƯỚC KHI AI kịp
// đọc — nếu N quá nhỏ, nội dung đứng trước đoạn mô tả thật trong DOM
// (breadcrumb, bảng size, thông số kỹ thuật, badge tin cậy...) ăn hết ngân
// sách, khiến AI chỉ nhận được nửa đầu mô tả và cắt cụt giữa câu (case thật:
// mô tả bundle "System MTN + APX" dài 1956 ký tự nhưng bị cụt ở ký tự 1727 vì
// ~4300 ký tự nội dung khác đứng trước nó trong trang, vượt ngưỡng cũ 6000 —
// đây là dạng bug y hệt "chữ rác đứng trước mô tả thật" từng gặp ở
// christysports.com, chỉ khác chỗ xảy ra: ở input gửi AI, không phải ở
// extractMainContent). Nâng ngưỡng lên 20000 ký tự — dư sức chứa cả phần
// chrome lẫn mô tả thật trên hầu hết trang sản phẩm, chi phí Haiku vẫn không
// đáng kể.
async function extractDescriptionWithAI(flatText: string): Promise<string> {
  if (!flatText || flatText.trim().length < 30) return "";
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      // Tăng từ 500 lên 800 để phòng mô tả gốc dài hơn cả ngân sách output cũ
      // (case thật: bundle nhiều sản phẩm gộp chung 1 mô tả — board + bindings
      // + boots) — nếu vẫn không đủ, có check stop_reason bên dưới để tự
      // thêm "...".
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `The text below was scraped from a product page. Find and return ONLY the genuine product description written by the seller — this could be a prose paragraph, or a bulleted feature list (e.g. under a heading like "About this item" / "Features" / "Details"). Do NOT return customer reviews/testimonials, navigation/filter menus, prices, error messages, cookie notices, or unrelated page chrome.

Preserve the SOURCE FORMATTING: if it's a bulleted/numbered list, output it as a list — one item per line, each starting with "- ". If it's a prose paragraph, keep it as flowing prose. Do not merge a bulleted list into one run-on paragraph, and do not split a paragraph into artificial bullets.

If the text does not contain a genuine product description, respond with exactly: NONE

Scraped text:
"""
${flatText.slice(0, 20000)}
"""

Return ONLY the extracted description (or NONE) — no extra commentary.`,
      }],
    });
    const answer = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    if (!answer || answer.toUpperCase() === "NONE") return "";

    let result = truncateWithEllipsis(answer, 2500);
    // Belt-and-suspenders: dù đã tăng max_tokens, mô tả gốc vẫn có thể dài
    // hơn cả 800 token (ví dụ bundle nhiều sản phẩm) — nếu Claude báo dừng vì
    // hết ngân sách (stop_reason "max_tokens") mà chuỗi kết quả CHƯA chạm mốc
    // 2500 ký tự để tự thêm "...", đánh dấu thủ công ở đây.
    if (response.stop_reason === "max_tokens" && !result.endsWith("...")) {
      result = result.trimEnd() + "...";
    }
    return result;
  } catch {
    // Lỗi gọi Claude (mạng, quota...) — trả rỗng để logic gọi hàm này tự
    // fallback về heuristic cũ (extractMainContent), không chặn luồng chính.
    return "";
  }
}

async function fetchPageContent(url: string, depth = 0): Promise<PageContent> {
  const empty: PageContent = { title: "", metaDesc: "", bodyText: "", raw: "" };
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return empty;
    const html = await res.text();

    // Chỉ chặn sớm khi response quá nhỏ để có nội dung thật (trang lỗi/redirect).
    // KHÔNG dò các từ khoá như "captcha" trong toàn bộ HTML nữa — rất nhiều
    // trang hợp lệ nhúng script reCAPTCHA cho 1 form ở đâu đó trên trang dù
    // nội dung chính hoàn toàn truy cập bình thường (false positive thật đã
    // gặp: Christy Sports — trang tải đủ 634KB nhưng bị vứt bỏ oan vì có chữ
    // "captcha" lẫn trong 1 script không liên quan).
    if (html.length < 500) return empty;

    const metaDesc = decodeHtmlEntities(
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,}?)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']{10,}?)["'][^>]+name=["']description["']/i)?.[1] || ""
    );
    const title = decodeHtmlEntities(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "");

    // Ưu tiên mô tả "sạch" từ JSON-LD nếu store có khai báo — chỉ khi KHÔNG
    // có schema mới tự bóc chữ hiển thị trên trang (dễ dính menu/giỏ hàng).
    const jsonLd = extractJsonLdDescription(html);

    // Không có schema Product nghĩa là trang này rất có thể là trang
    // collection/listing (nhiều sản phẩm), không phải trang chi tiết 1 sản
    // phẩm — thử "bấm vào" sản phẩm đầu tiên tìm được, chỉ 1 cấp (depth === 0)
    // để tránh đệ quy vô hạn nếu link đó lại dẫn tới 1 trang listing khác.
    if (!jsonLd.found && depth === 0) {
      const knownPatternLinks = extractProductLinks(html, url);
      const productLinks = knownPatternLinks.length > 0 ? knownPatternLinks : extractCardGridLinks(html, url);
      for (const productLink of productLinks) {
        const drilled = await fetchPageContent(productLink, depth + 1);
        if (drilled.title || drilled.bodyText || drilled.noDescription) {
          return { ...drilled, resolvedUrl: productLink };
        }
      }
    }

    if (jsonLd.found && !jsonLd.description) {
      // Store tự khai báo description rỗng — tin chắc chắn trang này chưa
      // viết mô tả, KHÔNG lấy tạm chữ menu/giỏ hàng thay thế (gây hiểu lầm).
      return { title, metaDesc, bodyText: "", raw: "", noDescription: true };
    }

    let bodyText: string;
    if (jsonLd.found && jsonLd.description) {
      bodyText = truncateWithEllipsis(jsonLd.description, 2500);
    } else {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
      const cleanedHtml = bodyMatch
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "");

      // Trang không có schema Product (vd trang category/collection, hoặc
      // trang chi tiết nhưng mô tả nằm ở dạng bullet "About this item" như
      // Amazon) — ưu tiên nhờ AI đọc toàn trang trích ra đúng phần mô tả, chỉ
      // fallback về heuristic cũ (extractMainContent) nếu AI lỗi/không trích được gì.
      const flatText = decodeHtmlEntities(cleanedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      const aiExtracted = await extractDescriptionWithAI(flatText);
      bodyText = aiExtracted || extractMainContent(cleanedHtml);
    }

    // Đánh giá "có bị chặn thật không" DỰA TRÊN NỘI DUNG ĐÃ TRÍCH XUẤT — nếu
    // sau khi bóc hết thẻ mà còn quá ít chữ VÀ trang có nhắc tới xác minh con
    // người, đó mới là dấu hiệu đáng tin của 1 trang chặn bot thật sự.
    const looksLikeChallengePage = bodyText.length < 200 &&
      (html.includes("verify you are human") || html.includes("Access Denied"));
    if (looksLikeChallengePage) return empty;

    if (!title && !metaDesc && bodyText.length < 100) return empty;
    const raw = `SEO Title: ${title}\nMeta Description: ${metaDesc}\nNội dung trang: ${bodyText}`;
    return { title, metaDesc, bodyText, raw };
  } catch {
    return empty;
  }
}

type CompetitorContent = {
  url: string; title: string; metaDesc: string; bodyText: string;
  noDescription: boolean; fetchBlocked: boolean; raw: string;
};

const MAX_COMPETITOR_CANDIDATES = 5;

// So khớp TỪ KHOÁ đơn thuần không đủ tin cậy — 1 trang bán vé cáp treo có
// thể chứa nguyên văn "Ski & Snowboard Lift Ticket Prices" trong tiêu đề mà
// chẳng liên quan gì tới việc bán ván trượt (case thật: mountsnow.com được
// coi "liên quan" chỉ vì trùng chữ "snowboard"). Nhờ AI phán đoán ngữ nghĩa
// thật: đây có phải trang bán/giới thiệu ĐÚNG LOẠI sản phẩm không, hay chỉ
// tình cờ trùng từ. Kiểm tra ngay trên title/snippet (trước khi tải trang)
// để vừa chính xác hơn vừa đỡ tốn request tải những trang chắc chắn lạc đề.
async function isRelevantCandidate(productName: string, candidate: SearchResult): Promise<boolean> {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{
        role: "user",
        content: `A merchant sells a product called "${productName}". Is the following Google search result actually a page selling or describing that same type of product (a competing product/category page) — as opposed to unrelated content that just happens to mention a similar word (e.g. a resort's lift-ticket page mentioning "snowboard" in passing, a blog post, a review roundup, an unrelated service or activity)?

Search result title: "${candidate.title}"
Search result snippet: "${candidate.snippet}"

Answer with exactly one word: YES or NO.`,
      }],
    });
    const answer = response.content[0].type === "text" ? response.content[0].text.trim().toUpperCase() : "";
    return answer.startsWith("YES");
  } catch {
    // Lỗi gọi Claude (mạng, quota...) — không chặn luồng chính, coi như có
    // thể liên quan để không bỏ sót đối thủ chỉ vì bước kiểm tra phụ lỗi.
    return true;
  }
}

// Chấm điểm 1 candidate đã tải + đã qua vòng kiểm tra chủ đề: 2 = có product
// description thật (loại tốt nhất) — 1 = tải được nhưng mô tả rỗng/quá ngắn.
function scoreCompetitorFetch(fetched: PageContent): number {
  if (fetched.noDescription || !fetched.bodyText || fetched.bodyText.trim().length < 50) return 1;
  return 2;
}

// Regex chỉ bắt được những cụm từ ĐÃ BIẾT trước (cookie banner, JS warning...)
// — site nào ra lỗi kiểu khác (chưa gặp) sẽ lọt qua. Dùng AI đọc hiểu ngữ
// nghĩa để chặn chung mọi trường hợp, thay vì liệt kê thêm pattern mãi không
// hết (case thật: mountsnow.com trả JSON-LD với description chính là thông
// báo lỗi "The site requires JavaScript..." — bỏ qua hết bộ lọc regex vì
// JSON-LD không đi qua extractMainContent). Dùng model rẻ/nhanh (Haiku) vì
// đây chỉ là câu hỏi yes/no đơn giản, không cần model mạnh.
async function isRealProductDescription(text: string): Promise<boolean> {
  if (!text || text.trim().length < 30) return false;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{
        role: "user",
        content: `Is the following text a genuine product or category marketing description WRITTEN BY THE SELLER — as opposed to a customer review/testimonial (first-person opinions like "I love how...", "This works great for me..."), an error message, a "JavaScript required" notice, a cookie-consent banner, a "no results found" message, or other website UI/navigation text?

Text: """${text.slice(0, 800)}"""

Answer with exactly one word: YES or NO.`,
      }],
    });
    const answer = response.content[0].type === "text" ? response.content[0].text.trim().toUpperCase() : "";
    return answer.startsWith("YES");
  } catch {
    // Lỗi gọi Claude (mạng, quota...) — không chặn luồng chính chỉ vì bước
    // kiểm tra phụ này, coi như nội dung dùng được.
    return true;
  }
}

// Xét tối đa top 5 đối thủ (đã xếp hạng), dùng AI loại thẳng candidate lạc đề
// (case thật: mountsnow.com — trang bán vé cáp treo, không phải trang bán
// snowboard) NGAY từ title/snippet trước khi tải trang — vừa chính xác hơn
// so khớp từ khoá vừa đỡ tốn request cho những trang chắc chắn không dùng
// được. Trang tải fail (bị chặn/403/404/timeout — case thật:
// everypossiblediscount.com) cũng bị loại. Phần còn lại chấm điểm ưu tiên
// "có mô tả thật" hơn "mô tả rỗng" (case thật: bulmers-nick-knacks.myshopify.com
// tải OK nhưng để trống mô tả). Dừng sớm ngay khi gặp điểm tuyệt đối.
async function findCompetitorContent(productName: string): Promise<CompetitorContent | null> {
  const candidates = (await searchCompetitors(productName)).slice(0, MAX_COMPETITOR_CANDIDATES);
  if (candidates.length === 0) return null;

  let best: { candidate: SearchResult; fetched: PageContent; score: number } | null = null;

  for (const candidate of candidates) {
    const relevant = await isRelevantCandidate(productName, candidate);
    if (!relevant) continue;

    const fetched = await fetchPageContent(candidate.link);
    // fetchFailed: trang không tải được thật sự (bị chặn/timeout/lỗi mạng) —
    // khác với noDescription (tải được nhưng store khai báo mô tả rỗng).
    const fetchFailed = !fetched.title && !fetched.metaDesc && !fetched.bodyText && !fetched.noDescription;
    const score = fetchFailed ? 0 : scoreCompetitorFetch(fetched);

    if (!best || score > best.score) best = { candidate, fetched, score };
    if (score === 2) break;
  }

  if (best && best.score > 0) {
    const { candidate, fetched } = best;
    let bodyText = fetched.noDescription ? "" : (fetched.bodyText || "");
    let noDescription = fetched.noDescription === true;

    // Kiểm tra lần cuối bằng AI: đoạn text này có thật sự là mô tả sản phẩm
    // không, hay là lỗi/thông báo hệ thống lọt qua được hết bộ lọc regex phía
    // trên (case thật: JSON-LD trả description = thông báo "requires JavaScript").
    if (bodyText && !(await isRealProductDescription(bodyText))) {
      bodyText = "";
      noDescription = true;
    }

    return {
      // resolvedUrl: nếu findCompetitorContent đã tự "bấm vào" 1 sản phẩm cụ
      // thể từ trang collection ban đầu, hiển thị đúng URL sản phẩm đó.
      url: fetched.resolvedUrl || candidate.link,
      title: fetched.title || candidate.title,
      // Khi bị chặn thật, Meta Description vẫn tạm dùng snippet Google (còn
      // hơn không), nhưng Product Description thì KHÔNG — vì snippet Google
      // thường là mảnh ghép giá/size/vận chuyển, không phải mô tả sản phẩm.
      metaDesc: fetched.metaDesc || candidate.snippet,
      bodyText,
      noDescription,
      fetchBlocked: false,
      raw: fetched.raw || `Title: ${candidate.title}\n\n${candidate.snippet}`,
    };
  }

  // Không đối thủ nào trong top 5 vừa tải được vừa đúng chủ đề — dùng kết quả
  // đầu tiên kèm snippet Google làm fallback (còn hơn không), đánh dấu
  // fetchBlocked rõ ràng để UI cảnh báo đúng thay vì hiển thị như nội dung
  // trang thật.
  const first = candidates[0];
  return {
    url: first.link,
    title: first.title,
    metaDesc: first.snippet,
    bodyText: "",
    noDescription: true,
    fetchBlocked: true,
    raw: `Title: ${first.title}\n\n${first.snippet}`,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, billing, session } = await getAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "analyze") {
    // Paywall: shop chưa có subscription active thì chỉ được dùng miễn phí
    // FREE_GENERATE_LIMIT lượt — kiểm tra TRƯỚC khi tốn tiền gọi Claude/Google.
    const isTest = process.env.NODE_ENV !== "production";
    const hasActivePayment = await billing.check({ plans: [MONTHLY_PLAN], isTest });

    const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const usage = await prisma.shopUsage.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    });
    const dailyCountSoFar = usage.dailyCountDate === today ? usage.dailyCount : 0;

    // Safety-net áp dụng cho MỌI shop, kể cả đã trả phí "unlimited".
    if (dailyCountSoFar >= DAILY_SAFETY_LIMIT) {
      return { dailyLimitReached: true, dailyLimit: DAILY_SAFETY_LIMIT };
    }

    if (!hasActivePayment && usage.generateCount >= FREE_GENERATE_LIMIT) {
      return { paywall: true, limit: FREE_GENERATE_LIMIT };
    }

    const productId = formData.get("productId") as string;
    const productName = formData.get("productName") as string;
    const productPrice = formData.get("productPrice") as string;
    const productCurrency = formData.get("productCurrency") as string;
    const priceLabel = productPrice && productPrice !== "0" ? `${productCurrency} ${parseFloat(productPrice).toFixed(2)}` : "";
    const tone = formData.get("tone") as string;
    const toneMap: Record<string, string> = {
      professional: "professional and trustworthy — clear, confident, authoritative",
      friendly: "friendly and conversational — warm, approachable, like talking to a helpful friend",
      luxury: "luxury and premium — elegant, sophisticated, exclusive, aspirational",
      playful: "playful and energetic — fun, bold, enthusiastic, youthful",
      urgent: "urgent and persuasive — scarcity-driven, action-oriented, FOMO-inducing",
      minimalist: "minimalist and clean — simple, direct, no fluff, let the product speak",
      bold: "bold and shocking — use provocative statements, challenge assumptions, create 'wait, what?' moments that stop the reader mid-scroll. Be daring, unexpected, even controversial — as long as it's truthful",
    };
    const toneDesc = toneMap[tone] || toneMap.professional;
    const language = formData.get("language") as string;
    const langInstruction = language === "vi" ? "Write entirely in Vietnamese." : "Write in English.";

    // 1 & 2: Dùng cached nếu có, bỏ qua search & fetch
    const cachedUrl = formData.get("cachedCompetitorUrl") as string;
    let competitorUrl: string;
    let competitorTitle: string;
    let competitorMetaDesc: string;
    let competitorBodyText: string;
    let competitorRaw: string;
    let competitorNoDescription = false;

    let competitorFetchBlocked = false;

    if (cachedUrl) {
      competitorUrl = cachedUrl;
      competitorTitle = formData.get("cachedCompetitorTitle") as string;
      competitorMetaDesc = formData.get("cachedCompetitorMetaDesc") as string;
      competitorBodyText = formData.get("cachedCompetitorBodyText") as string;
      competitorNoDescription = formData.get("cachedCompetitorNoDescription") === "true";
      competitorFetchBlocked = formData.get("cachedCompetitorFetchBlocked") === "true";
      competitorRaw = `SEO Title: ${competitorTitle}\nMeta Description: ${competitorMetaDesc}\nNội dung trang: ${competitorBodyText}`;
    } else {
      const competitor = await findCompetitorContent(productName);
      if (!competitor) {
        return { error: "No competitor found on Google. Try a different product name." };
      }
      competitorUrl = competitor.url;
      competitorTitle = competitor.title;
      competitorMetaDesc = competitor.metaDesc;
      competitorNoDescription = competitor.noDescription;
      competitorFetchBlocked = competitor.fetchBlocked;
      competitorBodyText = competitor.bodyText;
      competitorRaw = competitor.raw;
    }

    // 3. Claude generate AI content + translate competitor (parallel)
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const generatePromise = client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `You are an expert e-commerce copywriter who writes benefit-driven, conversion-focused product content that reads better than any competitor's.

Product: "${productName}"${priceLabel ? `\nPrice: ${priceLabel}` : ""}

Competitor content (ranking #1 on Google - ${competitorUrl}):
${competitorRaw}

Before writing, read the competitor content above and beat it on three specific axes — don't just write generically "compelling" copy:

1. SHORTER. Your PRODUCT DESCRIPTION must read noticeably more concise than the competitor's description — no filler, no repeated ideas, no throat-clearing. If the competitor is already short, make yours even tighter.
2. MORE BENEFITS FOR THE CUSTOMER. First notice which customer benefits the competitor's content already covers. Then surface benefits the competitor left out or buried — savings, time, convenience, emotional payoff, reduced risk, etc. — so a reader sees more real value on this listing than on the competitor's page. Every sentence must answer "what's in it for the customer?", never just restate a feature.
3. A DISTINCTIVE VOICE. Avoid generic e-commerce phrasing that every competitor uses — "high quality", "great value", "perfect for", "you'll love it". Write with a specific, memorable angle that fits the tone below, so this listing stands out from every other listing a shopper has scrolled past today.

Tone: ${toneDesc}.${priceLabel ? ` The price is ${priceLabel} — justify the value so the customer feels it's worth it.` : ""}

Output plain text only. No markdown symbols (no ##, no ---, no backticks). Use **double asterisks** only to bold key value phrases — maximum 2-3 words per bold, only the most compelling differentiators.

Format exactly like this:

SEO TITLE:
[under 60 characters — include main keyword and a benefit]

META DESCRIPTION:
[under 160 characters — lead with the top benefit, end with a call-to-action]

PRODUCT DESCRIPTION:
[maximum 50 words, and shorter than the competitor's description above whenever theirs is under 50 words — benefit-first, punchy, every word earns its place${priceLabel ? `, make ${priceLabel} feel like a steal` : ""}]

BULLET POINTS:
Choose only the 3 highest-impact benefits, prioritizing ones the competitor's content does NOT already emphasize. Prioritize: (1) quantified results (numbers, percentages, time saved, money saved), (2) direct product benefits the customer feels immediately. Avoid vague claims like "high quality" or "great value".
- [max 8 words, quantified or direct benefit]
- [max 8 words, quantified or direct benefit]
- [max 8 words, quantified or direct benefit]

${langInstruction}`
      }]
    });

    const translatePromise = language === "vi" && (competitorTitle || competitorMetaDesc || competitorBodyText)
      ? client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: `Dịch nội dung e-commerce sau sang tiếng Việt, giữ nguyên giọng marketing tự nhiên. QUAN TRỌNG — giữ nguyên định dạng gốc của DESCRIPTION: nếu là danh sách bullet (mỗi dòng bắt đầu bằng "-"), bản dịch cũng phải là danh sách bullet, đúng số dòng, mỗi dòng bắt đầu bằng "-"; nếu là đoạn văn xuôi thì giữ nguyên dạng văn xuôi. Không gộp các bullet lại thành 1 đoạn.

TITLE: ${competitorTitle}
META: ${competitorMetaDesc}
DESCRIPTION: ${competitorBodyText.slice(0, 2500)}

Trả về đúng định dạng:
TITLE_VN: [bản dịch]
META_VN: [bản dịch]
DESCRIPTION_VN: [bản dịch — giữ đúng định dạng gốc]`
        }]
      })
      : Promise.resolve(null);

    const [aiResponse, translateResponse] = await Promise.all([generatePromise, translatePromise]);

    const aiContent = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : "";

    let competitorTitleVi = "";
    let competitorMetaDescVi = "";
    let competitorBodyTextVi = "";
    if (translateResponse) {
      const t = translateResponse.content[0].type === "text" ? translateResponse.content[0].text : "";
      competitorTitleVi = t.match(/TITLE_VN:\s*(.*?)(?:\n|$)/i)?.[1]?.trim() || "";
      competitorMetaDescVi = t.match(/META_VN:\s*(.*?)(?:\n|$)/i)?.[1]?.trim() || "";
      competitorBodyTextVi = t.match(/DESCRIPTION_VN:\s*([\s\S]*?)$/i)?.[1]?.trim() || "";
    }

    // dailyCount tính cho MỌI shop (safety-net); generateCount (hạn mức free
    // vĩnh viễn) chỉ tính khi shop CHƯA có subscription active.
    await prisma.shopUsage.update({
      where: { shop: session.shop },
      data: {
        dailyCount: dailyCountSoFar + 1,
        dailyCountDate: today,
        ...(!hasActivePayment ? { generateCount: { increment: 1 } } : {}),
      },
    });

    return {
      competitorUrl,
      competitorTitle,
      competitorMetaDesc,
      competitorBodyText,
      competitorNoDescription,
      competitorFetchBlocked,
      competitorTitleVi,
      competitorMetaDescVi,
      competitorBodyTextVi,
      aiContent,
      productId,
      productName,
      messages: [
        { role: "assistant", content: aiContent }
      ] as Message[]
    };
  }

  if (intent === "chat") {
    const productName = formData.get("productName") as string;
    const userMessage = formData.get("message") as string;
    const historyRaw = formData.get("history") as string;
    const history: Message[] = JSON.parse(historyRaw || "[]");

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const aiResponse = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: `You are an expert SEO copywriter helping refine product content for "${productName}" on Shopify.

When the user requests a change, ALWAYS return the COMPLETE updated content in this EXACT format — no exceptions:

SEO TITLE:
[strictly under 60 characters — one line only]

META DESCRIPTION:
[strictly under 160 characters — one line only]

PRODUCT DESCRIPTION:
[2-4 sentences, benefit-focused]

BULLET POINTS:
- [max 8 words]
- [max 8 words]
- [max 8 words]

Rules:
- Output plain text only. No markdown (no ##, no ---, no backticks).
- Use **double asterisks** only to bold 2-3 key phrases maximum.
- Never merge sections. SEO Title must be under 60 chars — never longer.
- Always return all 4 sections, even if only one section was changed.`,
      messages: [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage }
      ]
    });

    const reply = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : "";
    return {
      reply,
      messages: [
        ...history,
        { role: "user", content: userMessage },
        { role: "assistant", content: reply }
      ] as Message[]
    };
  }

  if (intent === "load") {
    const productId = formData.get("productId") as string;

    // Fetch Shopify product data
    const shopifyRes = await admin.graphql(
      `query GetProduct($id: ID!) {
        product(id: $id) {
          title
          descriptionHtml
          seo { title description }
          metafield(namespace: "ai_content", key: "tone") { value }
        }
      }`,
      { variables: { id: productId } }
    );
    const shopifyData = await shopifyRes.json() as any;
    const product = shopifyData?.data?.product;
    const productTitle = product?.title || "";
    const seoTitle = product?.seo?.title || "";
    const metaDesc = product?.seo?.description || "";
    const savedTone = product?.metafield?.value || "";
    const html = product?.descriptionHtml || "";
    const paragraphs = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)]
      .map((m: RegExpMatchArray) => m[1].replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
    const bullets = paragraphs.filter((p: string) => p.startsWith("• ")).map((p: string) => p.slice(2));
    const descLines = paragraphs.filter((p: string) => !p.startsWith("• "));
    const productDesc = descLines.join("\n");
    const hasContent = !!(seoTitle || metaDesc || productDesc);

    // Fetch competitor từ Google (luôn lấy từ website thật)
    let competitorUrl = "", competitorTitle = "", competitorMetaDesc = "", competitorBodyText = "";
    let competitorNoDescription = false;
    let competitorFetchBlocked = false;
    if (productTitle) {
      const competitor = await findCompetitorContent(productTitle);
      if (competitor) {
        competitorUrl = competitor.url;
        competitorTitle = competitor.title;
        competitorMetaDesc = competitor.metaDesc;
        competitorNoDescription = competitor.noDescription;
        competitorFetchBlocked = competitor.fetchBlocked;
        competitorBodyText = competitor.bodyText;
      }
    }

    return {
      loaded: true, hasContent,
      loadedSeoTitle: seoTitle, loadedMetaDesc: metaDesc,
      loadedDescription: productDesc, loadedBullets: bullets, savedTone,
      competitorUrl, competitorTitle, competitorMetaDesc, competitorBodyText,
      competitorNoDescription, competitorFetchBlocked,
    };
  }

  if (intent === "save") {
    const productId = formData.get("productId") as string;
    if (!productId) return { saveError: "No product selected" };
    const seoTitle = formData.get("seoTitle") as string;
    const metaDesc = formData.get("metaDesc") as string;
    const productDesc = formData.get("productDesc") as string;
    const bullets: string[] = JSON.parse(formData.get("bullets") as string || "[]");
    const tone = formData.get("tone") as string;
    const descriptionHtml = [
      ...productDesc.split("\n").filter(Boolean),
      ...bullets.filter(Boolean).map(b => `• ${b}`),
    ].map(l => `<p>${escapeHtml(l)}</p>`).join("");
    const metafields = tone ? [{ namespace: "ai_content", key: "tone", value: tone, type: "single_line_text_field" }] : [];
    const response = await admin.graphql(
      `mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id title handle }
          userErrors { field message }
        }
      }`,
      { variables: { input: { id: productId, descriptionHtml, seo: { title: seoTitle, description: metaDesc }, metafields } } }
    );
    const data = await response.json() as any;
    const errors = data.data.productUpdate.userErrors;
    if (errors.length > 0) return { saveError: errors[0].message };
    const saved = data.data.productUpdate.product;
    return { saveSuccess: true, savedTitle: saved.title, savedHandle: saved.handle };
  }

  return null;
};

type CompetitorData = {
  url: string;
  title: string;
  metaDesc: string;
  bodyText: string;
  noDescription?: boolean;
  fetchBlocked?: boolean;
  titleVi?: string;
  metaDescVi?: string;
  bodyTextVi?: string;
};

export default function Analyze() {
  useLoaderData<typeof loader>();
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const selectedProduct = products.find(p => p.id === selectedProductId) || null;
  const [tone, setTone] = useState("professional");
  const [language, setLanguage] = useState("en");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isChatting, setIsChatting] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatMessage, setChatMessage] = useState("");

  const [editedTitle, setEditedTitle] = useState("");
  const [editedMetaDesc, setEditedMetaDesc] = useState("");
  const [editedProductDesc, setEditedProductDesc] = useState("");
  const [editedBullets, setEditedBullets] = useState<string[]>(["", "", ""]);
  const [editingFields, setEditingFields] = useState<Set<string>>(new Set());
  const [contentSource, setContentSource] = useState<"none" | "saved" | "generated">("none");
  // true khi có nội dung chưa lưu vào Shopify — điều khiển Contextual Save Bar.
  const [isDirty, setIsDirty] = useState(false);
  const saveBarRef = useRef<any>(null);

  const toggleFieldEdit = (field: string) => {
    setEditingFields(prev => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const [cachedCompetitor, setCachedCompetitor] = useState<CompetitorData | null>(null);
  const [competitorNotFound, setCompetitorNotFound] = useState(false);

  const [copyDone, setCopyDone] = useState(false);

  const fetcher = useFetcher<any>();
  const chatFetcher = useFetcher<any>();
  const loadFetcher = useFetcher<any>();
  const saveFetcher = useFetcher<any>();

  const [fetchError, setFetchError] = useState<string | null>(null);

  // Fetch GraphQL directly from frontend (Team's tech stack requirement)
  useEffect(() => {
    async function fetchProducts() {
      try {
        // Wait for App Bridge to load and patch the global fetch
        let retries = 0;
        while (!window.shopify && retries < 50) {
          await new Promise(r => setTimeout(r, 100));
          retries++;
        }

        if (!window.shopify) {
          throw new Error("Shopify App Bridge failed to load (window.shopify is undefined). Please check your internet connection or ad blocker.");
        }

        if (window.shopify && window.shopify.ready) {
          await window.shopify.ready;
        }

        const token = await window.shopify?.idToken();

        const res = await fetch("/api/products", {
          headers: {
            "Authorization": `Bearer ${token}`
          }
        });
        const json = await res.json();
        if (json.errors) {
          console.error("GraphQL Errors:", json.errors);
          setFetchError(JSON.stringify(json.errors));
        } else {
          const mapped = json.data?.products?.edges.map((e: any) => ({
            id: e.node.id,
            title: e.node.title,
            price: e.node.variants?.edges?.[0]?.node?.price || "0",
            currency: "VND"
          })) || [];
          setProducts(mapped);
          if (mapped.length === 0) {
            setFetchError("Store has 0 products.");
          }
        }
      } catch (err: any) {
        console.error("GraphQL Fetch Error:", err);
        setFetchError(err.message || String(err));
      }
    }
    fetchProducts();
  }, []);

  // Handle load response (saved content + competitor, on product select)
  useEffect(() => {
    if (loadFetcher.state === "idle" && loadFetcher.data?.loaded) {
      const data = loadFetcher.data;
      if (data.hasContent) {
        setEditedTitle(data.loadedSeoTitle || "");
        setEditedMetaDesc(data.loadedMetaDesc || "");
        setEditedProductDesc(data.loadedDescription || "");
        const bs = data.loadedBullets || [];
        setEditedBullets([bs[0] || "", bs[1] || "", bs[2] || ""]);
        if (data.savedTone) setTone(data.savedTone);
        setContentSource("saved");
      } else {
        // Sản phẩm chưa từng lưu content nào — cũng là kết quả hợp lệ của
        // "discard" (bỏ nội dung generate chưa lưu, quay về trạng thái trống).
        setEditedTitle("");
        setEditedMetaDesc("");
        setEditedProductDesc("");
        setEditedBullets(["", "", ""]);
        setMessages([]);
        setContentSource("none");
      }
      setIsDirty(false); // vừa nạp lại đúng sự thật từ Shopify, chưa có gì cần lưu
      if (data.competitorUrl) {
        setCachedCompetitor({
          url: data.competitorUrl,
          title: data.competitorTitle,
          metaDesc: data.competitorMetaDesc,
          bodyText: data.competitorBodyText,
          noDescription: data.competitorNoDescription,
          fetchBlocked: data.competitorFetchBlocked,
        });
        setCompetitorNotFound(false);
      } else {
        setCompetitorNotFound(true);
      }
    }
  }, [loadFetcher.state, loadFetcher.data]);

  // Handle fetcher responses (AI generation)
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      setIsAnalyzing(false);
      const data = fetcher.data;
      if (data.messages) setMessages(data.messages);
      if (data.competitorUrl) {
        setCachedCompetitor({
          url: data.competitorUrl,
          title: data.competitorTitle,
          metaDesc: data.competitorMetaDesc,
          bodyText: data.competitorBodyText,
          noDescription: data.competitorNoDescription,
          fetchBlocked: data.competitorFetchBlocked,
          titleVi: data.competitorTitleVi,
          metaDescVi: data.competitorMetaDescVi,
          bodyTextVi: data.competitorBodyTextVi,
        });
        setCompetitorNotFound(false);
      }
      applyAiContentText(data.aiContent || "", setEditedTitle, setEditedMetaDesc, setEditedProductDesc, setEditedBullets);
      if (data.aiContent) {
        setContentSource("generated");
        setIsDirty(true); // nội dung mới generate chưa được lưu vào Shopify
      }
    }
  }, [fetcher.state, fetcher.data]);

  // Handle chat responses (Refine with AI)
  useEffect(() => {
    if (chatFetcher.state === "idle" && chatFetcher.data) {
      setIsChatting(false);
      const data = chatFetcher.data;
      if (data.messages) setMessages(data.messages);
      applyAiContentText(data.reply || "", setEditedTitle, setEditedMetaDesc, setEditedProductDesc, setEditedBullets);
      if (data.reply) {
        setContentSource("generated");
        setIsDirty(true); // nội dung vừa refine qua chat chưa được lưu vào Shopify
      }
    }
  }, [chatFetcher.state, chatFetcher.data]);

  // Handle save completion
  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.saveSuccess) {
      setIsDirty(false); // vừa lưu xong, không còn gì khác biệt với Shopify
      if (window.shopify && window.shopify.toast) {
        window.shopify.toast.show("Content saved to Shopify successfully!");
      }
    }
  }, [saveFetcher.state, saveFetcher.data]);

  // Show/hide Contextual Save Bar theo isDirty — chuẩn Built for Shopify cho form có thay đổi chưa lưu.
  useEffect(() => {
    const bar = saveBarRef.current;
    if (!bar) return;
    if (isDirty) bar.show?.();
    else bar.hide?.();
  }, [isDirty]);

  const handleProductSelect = (e: any) => {
    const id = e.target.value;
    setSelectedProductId(id);
    setEditedTitle("");
    setEditedMetaDesc("");
    setEditedProductDesc("");
    setEditedBullets(["", "", ""]);
    setMessages([]);
    setCachedCompetitor(null);
    setCompetitorNotFound(false);
    setEditingFields(new Set());
    setContentSource("none");
    setIsDirty(false);
    if (id) {
      loadFetcher.submit({ intent: "load", productId: id }, { method: "post" });
    }
  };

  // Discard: nạp lại đúng nội dung đang thật sự nằm trên Shopify (hoặc rỗng
  // nếu sản phẩm chưa từng lưu), bỏ mọi chỉnh sửa/nội dung generate chưa lưu.
  const handleDiscard = () => {
    if (!selectedProduct) return;
    loadFetcher.submit({ intent: "load", productId: selectedProduct.id }, { method: "post" });
  };

  const handleAnalyze = () => {
    if (!selectedProduct) return;
    setIsAnalyzing(true);
    setMessages([]);
    const payload: Record<string, string> = {
      intent: "analyze",
      productId: selectedProduct.id,
      productName: selectedProduct.title,
      productPrice: selectedProduct.price,
      productCurrency: selectedProduct.currency,
      tone,
      language,
    };
    if (cachedCompetitor) {
      payload.cachedCompetitorUrl = cachedCompetitor.url;
      payload.cachedCompetitorTitle = cachedCompetitor.title;
      payload.cachedCompetitorMetaDesc = cachedCompetitor.metaDesc;
      payload.cachedCompetitorBodyText = cachedCompetitor.bodyText;
      payload.cachedCompetitorNoDescription = cachedCompetitor.noDescription ? "true" : "false";
      payload.cachedCompetitorFetchBlocked = cachedCompetitor.fetchBlocked ? "true" : "false";
    }
    fetcher.submit(payload, { method: "post" });
  };

  const handleChat = () => {
    if (!chatMessage.trim() || !selectedProduct || isChatting) return;
    setIsChatting(true);
    chatFetcher.submit(
      {
        intent: "chat",
        productName: selectedProduct.title,
        message: chatMessage,
        history: JSON.stringify(messages),
      },
      { method: "post" }
    );
    setChatMessage("");
  };

  const handleSave = () => {
    if (!selectedProduct) return;
    saveFetcher.submit(
      {
        intent: "save",
        productId: selectedProduct.id,
        seoTitle: editedTitle,
        metaDesc: editedMetaDesc,
        productDesc: editedProductDesc,
        bullets: JSON.stringify(editedBullets.filter(Boolean)),
        tone
      },
      { method: "post" }
    );
  };

  function renderEditableField(
    id: string,
    label: string,
    value: string,
    setValue: (v: string) => void,
    multiline?: number,
    compact?: boolean,
    bulletDot?: boolean
  ) {
    const editing = editingFields.has(id);
    const editButton = (
      <s-button
        icon={editing ? "check" : "edit"}
        accessibilityLabel={editing ? `Done editing ${label}` : `Edit ${label}`}
        onClick={() => toggleFieldEdit(id)}
      ></s-button>
    );

    if (bulletDot) {
      // Bullet: tất cả trên 1 dòng — dấu chấm, nội dung, icon edit ở cuối.
      return (
        <div key={id} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "13px" }}>•</span>
          <div style={{ flex: 1 }}>
            {editing ? (
              <s-text-field
                label=""
                value={value}
                onInput={(e: any) => { setValue(e.target.value); setIsDirty(true); }}
              />
            ) : (
              <div style={{ padding: "8px", background: "#f5f5f5", borderRadius: "4px", fontSize: "13px" }}>
                {renderBold(value || "—")}
              </div>
            )}
          </div>
          {editButton}
        </div>
      );
    }

    return (
      <div key={id}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <span style={{ fontWeight: "bold", fontSize: compact ? "12px" : "13px", color: compact ? "#666" : undefined }}>
            {label}
          </span>
          {editButton}
        </div>
        {editing ? (
          <s-text-field
            label=""
            value={value}
            // @ts-expect-error -- multiline is a valid s-text-field attribute missing from its TS types
            multiline={multiline}
            onInput={(e: any) => { setValue(e.target.value); setIsDirty(true); }}
          />
        ) : (
          <div style={{ padding: "8px", background: "#f5f5f5", borderRadius: "4px", fontSize: "13px" }}>
            {renderBold(value || "—")}
          </div>
        )}
      </div>
    );
  }

  return (
    <s-page>
      <ui-title-bar title="AI Content Generator"></ui-title-bar>
      {/* Contextual Save Bar — App Bridge tự hiện ở đầu admin khi isDirty=true */}
      {/* @ts-expect-error -- ref is a valid prop on any DOM/custom element but missing from ui-save-bar's TS types */}
      <ui-save-bar id="content-save-bar" ref={saveBarRef} discardConfirmation>
        <button variant="primary" onClick={handleSave}>Save</button>
        <button onClick={handleDiscard}>Discard</button>
      </ui-save-bar>
      <s-layout>
        <s-layout-section>
          <s-card>
            <s-section>
              <h2 style={{ fontSize: "18px", fontWeight: "bold", marginBottom: "16px" }}>Select a product</h2>

              {fetchError && (
                <s-banner tone="critical" heading="GraphQL Error">
                  <p>{fetchError}</p>
                </s-banner>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "16px", marginTop: fetchError ? "16px" : "0" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span>Product</span>
                  <select style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc" }} value={selectedProductId} onInput={handleProductSelect}>
                    <option value="">-- Select a product --</option>
                    {products.map(p => (
                      <option key={p.id} value={p.id}>{p.title}</option>
                    ))}
                  </select>
                </label>

                <div style={{ display: "flex", gap: "16px" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1 }}>
                    <span>Tone</span>
                    <select style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc" }} value={tone} onInput={(e: any) => setTone(e.target.value)}>
                      <option value="professional">Professional & Trustworthy</option>
                      <option value="friendly">Friendly & Approachable</option>
                      <option value="luxury">Luxury & Premium</option>
                      <option value="playful">Playful & Energetic</option>
                      <option value="urgent">Urgent & Persuasive (FOMO)</option>
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1 }}>
                    <span>Output language</span>
                    <select style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc" }} value={language} onInput={(e: any) => setLanguage(e.target.value)}>
                      <option value="en">English</option>
                      <option value="vi">Vietnamese</option>
                    </select>
                  </label>
                </div>
              </div>

              <s-button variant="primary" disabled={!selectedProduct || isAnalyzing} onClick={handleAnalyze}>
                {isAnalyzing ? "Generating..." : "Generate AI Content"}
              </s-button>
            </s-section>
          </s-card>

          {fetcher.data?.error && (
            <s-banner tone="critical" heading="Error">
              <p>{fetcher.data.error}</p>
            </s-banner>
          )}

          {fetcher.data?.paywall && (
            <s-banner tone="warning" heading="Free plan limit reached">
              <p>
                You&apos;ve used all {fetcher.data.limit} free AI generations. Upgrade to the Pro plan for
                unlimited content generation.
              </p>
              <div style={{ marginTop: "8px" }}>
                <s-button href="/app/subscribe" variant="primary">Upgrade to Pro</s-button>
              </div>
            </s-banner>
          )}

          {fetcher.data?.dailyLimitReached && (
            <s-banner tone="warning" heading="Daily limit reached">
              <p>
                You&apos;ve reached the {fetcher.data.dailyLimit} generations/day limit for this store. This resets
                tomorrow. If you need a higher limit, please contact support.
              </p>
            </s-banner>
          )}

          {/* Refine with AI — chatbox to adjust content, shown above the 2 columns */}
          {(editedTitle || editedProductDesc) && selectedProduct && (
            <s-card>
              <s-section>
                <h2 style={{ fontSize: "18px", fontWeight: "bold", marginBottom: "8px" }}>💬 Chat with AI to refine content</h2>
                <p style={{ fontSize: "13px", color: "#666", marginBottom: "12px" }}>
                  Tell the AI how to adjust the content. e.g. &quot;Add free shipping&quot;, &quot;Shorten the title&quot;, &quot;Make it more friendly&quot;
                </p>

                {messages.some(m => m.role === "user") && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
                    {messages.slice(messages.findIndex(m => m.role === "user")).map((m, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "8px 12px",
                          borderRadius: "6px",
                          fontSize: "13px",
                          background: m.role === "user" ? "#e3f2fd" : "#f0f0f0",
                        }}
                      >
                        {m.role === "user" ? `You: ${m.content}` : "✓ Content updated below"}
                      </div>
                    ))}
                  </div>
                )}

                {isChatting && (
                  <div style={{ marginBottom: "12px" }}>
                    <s-spinner size="base"></s-spinner>
                  </div>
                )}

                <div style={{ display: "flex", gap: "12px", alignItems: "flex-end" }}>
                  {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- layout wrapper only forwards Enter keydown from the text field inside, not itself interactive */}
                  <div
                    style={{ flex: 1 }}
                    onKeyDown={(e: any) => {
                      if (e.key === "Enter" && chatMessage.trim() && !isChatting) handleChat();
                    }}
                  >
                    <s-text-field
                      label="Refine request"
                      value={chatMessage}
                      onInput={(e: any) => setChatMessage(e.target.value)}
                      placeholder="Type your request... (Enter to send)"
                    />
                  </div>
                  <s-button onClick={handleChat} disabled={!chatMessage.trim() || isChatting}>
                    Send
                  </s-button>
                </div>
              </s-section>
            </s-card>
          )}

          {/* 2 columns: Column 1 - Top competitor | Column 2 - AI content */}
          {(editedTitle || editedProductDesc || isAnalyzing || loadFetcher.state === "submitting") && selectedProduct && (
            <div style={{ display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>

              {/* Column 1: Top competitor content */}
              <div style={{ flex: 1, minWidth: "320px" }}>
                <s-card>
                  <s-section>
                    <h2 style={{ fontSize: "18px", fontWeight: "bold", marginBottom: "12px" }}>🔍 Top competitor content</h2>

                    {loadFetcher.state === "submitting" || (!cachedCompetitor && !competitorNotFound) ? (
                      <s-spinner size="base"></s-spinner>
                    ) : competitorNotFound ? (
                      <s-banner tone="warning" heading="No competitor found">
                        <p>Couldn&apos;t find a similar product page on Google. You can still generate AI content based on the product name.</p>
                      </s-banner>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        <a
                          href={cachedCompetitor!.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: "12px", wordBreak: "break-all", color: "#999" }}
                        >
                          {cachedCompetitor!.url}
                        </a>
                        {cachedCompetitor!.fetchBlocked && (
                          <s-banner tone="warning" heading="Couldn't load this page directly">
                            <p>This site blocks automated requests, so we couldn&apos;t read its actual content. SEO Title and Meta Description below are a fallback from Google&apos;s search result summary — they may not exactly match the live page.</p>
                          </s-banner>
                        )}
                        <s-divider></s-divider>
                        <div>
                          <span style={{ fontWeight: "bold", fontSize: "13px", display: "block" }}>SEO Title</span>
                          <span style={{ fontSize: "11px", color: "#999", display: "block", marginBottom: "4px" }}>
                            {cachedCompetitor!.fetchBlocked
                              ? "Fallback from Google's search result — this page couldn't be loaded directly."
                              : "Read from the page source (View Page Source) — shown only in the browser tab, not on the page itself."}
                          </span>
                          <div style={{ padding: "8px", background: "#f5f5f5", borderRadius: "4px", fontSize: "13px" }}>
                            {(language === "vi" && cachedCompetitor!.titleVi) || cachedCompetitor!.title || "—"}
                          </div>
                        </div>
                        <div>
                          <span style={{ fontWeight: "bold", fontSize: "13px", display: "block" }}>Meta Description</span>
                          <span style={{ fontSize: "11px", color: "#999", display: "block", marginBottom: "4px" }}>
                            {cachedCompetitor!.fetchBlocked
                              ? "Fallback from Google's search result — this page couldn't be loaded directly."
                              : "Read from the page source (View Page Source) — an SEO tag for search engines, never rendered on the page."}
                          </span>
                          <div style={{ padding: "8px", background: "#f5f5f5", borderRadius: "4px", fontSize: "13px" }}>
                            {(language === "vi" && cachedCompetitor!.metaDescVi) || cachedCompetitor!.metaDesc || "—"}
                          </div>
                        </div>
                        <div>
                          <span style={{ fontWeight: "bold", fontSize: "13px", display: "block", marginBottom: "4px" }}>Product Description</span>
                          {cachedCompetitor!.noDescription ? (
                            <div style={{ padding: "8px", background: "#fff4e5", borderRadius: "4px", fontSize: "13px", color: "#8a5a00" }}>
                              {cachedCompetitor!.fetchBlocked
                                ? "Couldn't load this page's content (it blocks automated requests) — no reliable product description available."
                                : "This competitor page has no product description — it left this field empty."}
                            </div>
                          ) : (
                            <div style={{ lineHeight: 1.6, fontSize: "13px", maxHeight: "400px", overflowY: "auto", padding: "8px", background: "#f5f5f5", borderRadius: "4px" }}>
                              {renderBodyText((language === "vi" && cachedCompetitor!.bodyTextVi) || cachedCompetitor!.bodyText || "—")}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </s-section>
                </s-card>
              </div>

              {/* Column 2: AI content — each field has its own edit icon */}
              <div style={{ flex: 1, minWidth: "320px" }}>
                <s-card>
                  <s-section>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                      <h2 style={{ fontSize: "18px", fontWeight: "bold" }}>✨ AI Content</h2>
                      {contentSource === "saved" && !isAnalyzing && (
                        <s-badge tone="info">Saved in Shopify</s-badge>
                      )}
                      {contentSource === "generated" && !isAnalyzing && (
                        <s-badge tone="success">Generated</s-badge>
                      )}
                    </div>

                    {isAnalyzing || loadFetcher.state === "submitting" ? (
                      <s-spinner></s-spinner>
                    ) : !editedTitle && !editedMetaDesc && !editedProductDesc ? (
                      <s-banner tone="info" heading="No content yet">
                        <p>Click &quot;Generate AI Content&quot; above to create SEO content for this product.</p>
                      </s-banner>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {renderEditableField("title", "SEO Title", editedTitle, setEditedTitle)}
                        {renderEditableField("metaDesc", "Meta Description", editedMetaDesc, setEditedMetaDesc, 2)}
                        {renderEditableField("productDesc", "Product Description", editedProductDesc, setEditedProductDesc, 4)}
                        <div>
                          <span style={{ fontWeight: "bold", display: "block", marginBottom: "8px" }}>Bullet Points</span>
                          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            {editedBullets.map((b, i) =>
                              renderEditableField(
                                `bullet-${i}`,
                                `Bullet ${i + 1}`,
                                b,
                                (val) => {
                                  const next = [...editedBullets];
                                  next[i] = val;
                                  setEditedBullets(next);
                                },
                                undefined,
                                true,
                                true
                              )
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    <s-divider></s-divider>

                    {saveFetcher.data?.saveError && (
                      <s-banner tone="critical" heading="Save failed">
                        <p>{saveFetcher.data.saveError}</p>
                      </s-banner>
                    )}
                    {saveFetcher.data?.saveSuccess && (
                      <s-banner tone="success" heading="Saved to Shopify">
                        <p>{saveFetcher.data.savedTitle} has been updated.</p>
                      </s-banner>
                    )}

                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "16px", marginTop: "16px" }}>
                      <s-button onClick={() => {
                        navigator.clipboard.writeText(`${editedTitle}\n\n${editedMetaDesc}\n\n${editedProductDesc}\n\n${editedBullets.filter(Boolean).join("\n")}`);
                        setCopyDone(true);
                        setTimeout(() => setCopyDone(false), 2000);
                      }}>
                        {copyDone ? "✓ Copied!" : "Copy text"}
                      </s-button>
                      <s-button
                        variant="primary"
                        onClick={handleSave}
                        disabled={isAnalyzing || (!editedTitle && !editedMetaDesc && !editedProductDesc)}
                      >
                        Save to Shopify
                      </s-button>
                    </div>
                  </s-section>
                </s-card>
              </div>

            </div>
          )}
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
