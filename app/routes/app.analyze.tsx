import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";
import prisma from "../db.server";

async function getAdmin(request: Request) {
  return authenticate.admin(request);
}
import Anthropic from "@anthropic-ai/sdk";

// Số lượt "Generate AI Content" miễn phí trước khi cần nâng cấp gói Pro.
const FREE_GENERATE_LIMIT = 5;

type Product = { id: string; title: string; price: string; currency: string };
type Message = { role: "user" | "assistant"; content: string };

function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function renderBold(text: string) {
  // Tự động in đậm: **text** và số tiền ($9.99, USD 9.99, 9.99 USD, v.v.)
  const pattern = /(\*\*.+?\*\*|(?:USD|EUR|GBP|VND|AUD|CAD)\s*[\d,]+(?:\.\d+)?|[\$€£₫]\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:USD|EUR|GBP|VND|AUD|CAD))/g;
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

function parseAiContent(raw: string) {
  const clean = raw.replace(/#+/g, "").replace(/---+/g, "");
  const seoTitle = clean.match(/SEO TITLE:\s*\n?([\s\S]*?)(?=\n\s*META DESCRIPTION:|$)/i)?.[1]?.trim() || "";
  const metaDesc = clean.match(/META DESCRIPTION:\s*\n?([\s\S]*?)(?=\n\s*PRODUCT DESCRIPTION:|$)/i)?.[1]?.trim() || "";
  const productDesc = clean.match(/PRODUCT DESCRIPTION:\s*\n?([\s\S]*?)(?=\n\s*BULLET POINTS:|$)/i)?.[1]?.trim() || "";
  const bulletSection = clean.match(/BULLET POINTS:\s*\n?([\s\S]*?)$/i)?.[1]?.trim() || "";
  const bullets = bulletSection.split("\n").map(l => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean).slice(0, 3);
  return { seoTitle, metaDesc, productDesc, bullets };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await getAdmin(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || session.shop || "chinh-dev-store.myshopify.com";
  return { shop };
};

const BLOCKED_DOMAINS = ["reddit.com", "quora.com", "pinterest.com", "youtube.com", "facebook.com", "twitter.com", "instagram.com", "tiktok.com", "forum", "community", "discuss"];

async function searchCompetitor(productName: string): Promise<{ title: string; link: string; snippet: string } | null> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: `buy ${productName} -site:reddit.com -site:quora.com -site:pinterest.com -site:youtube.com`, num: 10 }),
  });
  const data = await res.json() as any;
  const organic: any[] = data.organic || [];
  // Lọc bỏ forum, social media, tin tức
  const ecommerce = organic.find(r =>
    !BLOCKED_DOMAINS.some(d => r.link.includes(d)) &&
    (r.link.includes("amazon.") || r.link.includes("etsy.") || r.link.includes("shopify") ||
     r.link.includes("/product") || r.link.includes("/shop") || r.link.includes("/store") ||
     r.link.includes("/p/") || r.link.includes("/item"))
  ) || organic.find(r => !BLOCKED_DOMAINS.some(d => r.link.includes(d)));
  return ecommerce || null;
}

type PageContent = { title: string; metaDesc: string; bodyText: string; raw: string; noDescription?: boolean };

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&nbsp;": " ", "&ndash;": "–", "&mdash;": "—", "&hellip;": "…",
  "&rsquo;": "’", "&lsquo;": "‘", "&rdquo;": "”", "&ldquo;": "“",
  "&copy;": "©", "&reg;": "®", "&trade;": "™",
};

// Trang scrape về luôn ở dạng HTML thô — &nbsp;, &#39;, &ndash;... phải được
// giải mã thành ký tự thật trước khi đưa lên UI hoặc vào prompt Claude, nếu
// không merchant sẽ thấy nguyên văn mã HTML lộ ra (đã gặp thật với &ndash;).
function decodeHtmlEntities(text: string): string {
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
function extractJsonLdDescription(html: string): { found: boolean; description: string } {
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

async function fetchPageContent(url: string): Promise<PageContent> {
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
    if (jsonLd.found && !jsonLd.description) {
      // Store tự khai báo description rỗng — tin chắc chắn trang này chưa
      // viết mô tả, KHÔNG lấy tạm chữ menu/giỏ hàng thay thế (gây hiểu lầm).
      return { title, metaDesc, bodyText: "", raw: "", noDescription: true };
    }

    let bodyText: string;
    if (jsonLd.found && jsonLd.description) {
      bodyText = jsonLd.description.slice(0, 2500);
    } else {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
      bodyText = decodeHtmlEntities(
        bodyMatch
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      ).slice(0, 2500);
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

// Chặn HTML/script lạ lọt vào descriptionHtml khi lưu — nội dung ở đây có thể
// đến từ ô nhập tay của merchant hoặc do AI sinh ra (kể cả từ trang đối thủ
// đã scrape), nên không được tin tưởng tuyệt đối trước khi ghi thành HTML.
function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    if (!hasActivePayment) {
      const usage = await prisma.shopUsage.upsert({
        where: { shop: session.shop },
        update: {},
        create: { shop: session.shop },
      });
      if (usage.generateCount >= FREE_GENERATE_LIMIT) {
        return { paywall: true, limit: FREE_GENERATE_LIMIT };
      }
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
      const competitor = await searchCompetitor(productName);
      if (!competitor) {
        return { error: "No competitor found on Google. Try a different product name." };
      }
      const fetched = await fetchPageContent(competitor.link);
      competitorUrl = competitor.link;
      // fetchFailed: trang không tải được thật sự (bị chặn/timeout/lỗi mạng)
      // — khác với noDescription (tải được nhưng store khai báo rỗng).
      const fetchFailed = !fetched.title && !fetched.metaDesc && !fetched.bodyText && !fetched.noDescription;
      competitorFetchBlocked = fetchFailed;
      competitorTitle = fetched.title || competitor.title;
      // Khi bị chặn thật, Meta Description vẫn tạm dùng snippet Google (còn
      // hơn không), nhưng Product Description thì KHÔNG — vì snippet Google
      // thường là mảnh ghép giá/size/vận chuyển, không phải mô tả sản phẩm,
      // hiển thị ra dễ khiến merchant tưởng đó là nội dung trang thật.
      competitorMetaDesc = fetched.metaDesc || competitor.snippet;
      competitorNoDescription = fetched.noDescription === true || fetchFailed;
      competitorBodyText = (fetched.noDescription || fetchFailed) ? "" : (fetched.bodyText || "");
      competitorRaw = fetched.raw || `Title: ${competitor.title}\n\n${competitor.snippet}`;
    }

    // 3. Claude generate AI content + translate competitor (parallel)
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const generatePromise = client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `You are an expert e-commerce copywriter who writes benefit-driven, conversion-focused product content.

Product: "${productName}"${priceLabel ? `\nPrice: ${priceLabel}` : ""}

Competitor content (ranking #1 on Google - ${competitorUrl}):
${competitorRaw}

Write content that is MORE compelling than the competitor. Tone: ${toneDesc}. Focus entirely on CUSTOMER BENEFITS — what the customer gains, feels, or achieves — not just product features. Every sentence must answer "what's in it for the customer?".${priceLabel ? ` The price is ${priceLabel} — justify the value so the customer feels it's worth it.` : ""}

Output plain text only. No markdown symbols (no ##, no ---, no backticks). Use **double asterisks** only to bold key value phrases — maximum 2-3 words per bold, only the most compelling differentiators.

Format exactly like this:

SEO TITLE:
[under 60 characters — include main keyword and a benefit]

META DESCRIPTION:
[under 160 characters — lead with the top benefit, end with a call-to-action]

PRODUCT DESCRIPTION:
[exactly 50 words — benefit-first, punchy, every word earns its place${priceLabel ? `, make ${priceLabel} feel like a steal` : ""}]

BULLET POINTS:
Choose only the 3 highest-impact benefits. Prioritize: (1) quantified results (numbers, percentages, time saved, money saved), (2) direct product benefits the customer feels immediately. Avoid vague claims like "high quality" or "great value".
- [max 8 words, quantified or direct benefit]
- [max 8 words, quantified or direct benefit]
- [max 8 words, quantified or direct benefit]

${langInstruction}`
      }]
    });

    const translatePromise = language === "vi" && (competitorTitle || competitorMetaDesc || competitorBodyText)
      ? client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Dịch nội dung e-commerce sau sang tiếng Việt, giữ nguyên giọng marketing tự nhiên:

TITLE: ${competitorTitle}
META: ${competitorMetaDesc}
DESCRIPTION: ${competitorBodyText.slice(0, 600)}

Trả về đúng định dạng:
TITLE_VN: [bản dịch]
META_VN: [bản dịch]
DESCRIPTION_VN: [bản dịch]`
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

    // Chỉ tính vào hạn mức free nếu shop CHƯA có subscription active.
    if (!hasActivePayment) {
      await prisma.shopUsage.update({
        where: { shop: session.shop },
        data: { generateCount: { increment: 1 } },
      });
    }

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
      const competitor = await searchCompetitor(productTitle);
      if (competitor) {
        const fetched = await fetchPageContent(competitor.link);
        const fetchFailed = !fetched.title && !fetched.metaDesc && !fetched.bodyText && !fetched.noDescription;
        competitorFetchBlocked = fetchFailed;
        competitorUrl = competitor.link;
        competitorTitle = fetched.title || competitor.title;
        competitorMetaDesc = fetched.metaDesc || competitor.snippet;
        competitorNoDescription = fetched.noDescription === true || fetchFailed;
        competitorBodyText = (fetched.noDescription || fetchFailed) ? "" : (fetched.bodyText || "");
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

function applyAiContentText(
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

export default function Analyze() {
  const { shop } = useLoaderData<typeof loader>();
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
        // @ts-ignore
        while (!window.shopify && retries < 50) {
          await new Promise(r => setTimeout(r, 100));
          retries++;
        }
        
        // @ts-ignore
        if (!window.shopify) {
          throw new Error("Shopify App Bridge failed to load (window.shopify is undefined). Please check your internet connection or ad blocker.");
        }

        // @ts-ignore
        if (window.shopify && window.shopify.ready) {
          // @ts-ignore
          await window.shopify.ready;
        }

        // @ts-ignore
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
      }
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
      if (data.aiContent) setContentSource("generated");
    }
  }, [fetcher.state, fetcher.data]);

  // Handle chat responses (Refine with AI)
  useEffect(() => {
    if (chatFetcher.state === "idle" && chatFetcher.data) {
      setIsChatting(false);
      const data = chatFetcher.data;
      if (data.messages) setMessages(data.messages);
      applyAiContentText(data.reply || "", setEditedTitle, setEditedMetaDesc, setEditedProductDesc, setEditedBullets);
      if (data.reply) setContentSource("generated");
    }
  }, [chatFetcher.state, chatFetcher.data]);

  // Handle save completion
  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.saveSuccess) {
      // @ts-ignore
      if (window.shopify && window.shopify.toast) {
        // @ts-ignore
        window.shopify.toast.show("Content saved to Shopify successfully!");
      }
    }
  }, [saveFetcher.state, saveFetcher.data]);

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
    if (id) {
      loadFetcher.submit({ intent: "load", productId: id }, { method: "post" });
    }
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
    compact?: boolean
  ) {
    const editing = editingFields.has(id);
    return (
      <div key={id}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <span style={{ fontWeight: "bold", fontSize: compact ? "12px" : "13px", color: compact ? "#666" : undefined }}>{label}</span>
          <s-button
            icon={editing ? "check" : "edit"}
            accessibilityLabel={editing ? `Done editing ${label}` : `Edit ${label}`}
            onClick={() => toggleFieldEdit(id)}
          ></s-button>
        </div>
        {editing ? (
          <s-text-field
            label=""
            value={value}
            // @ts-ignore
            multiline={multiline}
            onInput={(e: any) => setValue(e.target.value)}
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
      <s-layout>
        <s-layout-section>
          <s-card>
            <s-section>
              <h2 style={{ fontSize: "18px", fontWeight: "bold", marginBottom: "16px" }}>1. Select product</h2>

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
                You've used all {fetcher.data.limit} free AI generations. Upgrade to the Pro plan for
                unlimited content generation.
              </p>
              <div style={{ marginTop: "8px" }}>
                <s-button href="/app/subscribe" variant="primary">Upgrade to Pro</s-button>
              </div>
            </s-banner>
          )}

          {/* Refine with AI — chatbox to adjust content, shown above the 2 columns */}
          {(editedTitle || editedProductDesc) && selectedProduct && (
            <s-card>
              <s-section>
                <h2 style={{ fontSize: "18px", fontWeight: "bold", marginBottom: "8px" }}>💬 Chat with AI to refine content</h2>
                <p style={{ fontSize: "13px", color: "#666", marginBottom: "12px" }}>
                  Tell the AI how to adjust the content. e.g. "Add free shipping", "Shorten the title", "Make it more friendly"
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
                        <p>Couldn't find a similar product page on Google. You can still generate AI content based on the product name.</p>
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
                            <p>This site blocks automated requests, so we couldn't read its actual content. SEO Title and Meta Description below are a fallback from Google's search result summary — they may not exactly match the live page.</p>
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
                            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit", lineHeight: 1.6, fontSize: "13px", maxHeight: "400px", overflowY: "auto", padding: "8px", background: "#f5f5f5", borderRadius: "4px" }}>
                              {(language === "vi" && cachedCompetitor!.bodyTextVi) || cachedCompetitor!.bodyText || "—"}
                            </pre>
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
                        <p>Click "Generate AI Content" above to create SEO content for this product.</p>
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
