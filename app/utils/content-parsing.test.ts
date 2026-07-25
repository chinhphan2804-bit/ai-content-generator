import { describe, it, expect, vi } from "vitest";
import { decodeHtmlEntities, extractJsonLdDescription, escapeHtml, applyAiContentText, extractMainContent } from "./content-parsing";

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeHtmlEntities("10&ndash;20 days")).toBe("10–20 days");
  });

  it("decodes numeric and hex entities", () => {
    expect(decodeHtmlEntities("&#39;quoted&#39;")).toBe("'quoted'");
    expect(decodeHtmlEntities("&#x27;quoted&#x27;")).toBe("'quoted'");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });

  it("leaves plain text untouched", () => {
    expect(decodeHtmlEntities("no entities here")).toBe("no entities here");
  });
});

describe("extractJsonLdDescription", () => {
  it("finds a Product description in a single JSON-LD block", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","description":"Great shoes &amp; socks"}</script>`;
    expect(extractJsonLdDescription(html)).toEqual({ found: true, description: "Great shoes & socks" });
  });

  it("finds a Product inside an @graph array", () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Thing"},{"@type":"Product","description":"Nice bag"}]}</script>`;
    expect(extractJsonLdDescription(html)).toEqual({ found: true, description: "Nice bag" });
  });

  it("reports found=true with empty description when store declared no description", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","description":""}</script>`;
    expect(extractJsonLdDescription(html)).toEqual({ found: true, description: "" });
  });

  it("reports found=false when there is no Product schema at all", () => {
    const html = `<p>no schema here</p>`;
    expect(extractJsonLdDescription(html)).toEqual({ found: false, description: "" });
  });

  it("skips malformed JSON-LD blocks instead of throwing", () => {
    const html = `<script type="application/ld+json">{not valid json</script>`;
    expect(extractJsonLdDescription(html)).toEqual({ found: false, description: "" });
  });

  it("strips embedded HTML tags from the description", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","description":"<b>Bold</b> item"}</script>`;
    expect(extractJsonLdDescription(html)).toEqual({ found: true, description: "Bold item" });
  });
});

describe("escapeHtml", () => {
  it("escapes all HTML special characters", () => {
    expect(escapeHtml(`<script>alert("hi") & 'bye'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;hi&quot;) &amp; &#39;bye&#39;&lt;/script&gt;"
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});

describe("applyAiContentText", () => {
  function makeSetters() {
    return {
      setTitle: vi.fn(),
      setMeta: vi.fn(),
      setDesc: vi.fn(),
      setBullets: vi.fn(),
    };
  }

  it("parses a well-formed AI response into all four fields", () => {
    const raw = [
      "SEO TITLE:",
      "Best Running Shoes",
      "",
      "META DESCRIPTION:",
      "Run faster today.",
      "",
      "PRODUCT DESCRIPTION:",
      "Lightweight shoes built for speed.",
      "",
      "BULLET POINTS:",
      "- Feather-light design",
      "- All-day comfort",
      "- Free returns",
    ].join("\n");

    const { setTitle, setMeta, setDesc, setBullets } = makeSetters();
    applyAiContentText(raw, setTitle, setMeta, setDesc, setBullets);

    expect(setTitle).toHaveBeenCalledWith("Best Running Shoes");
    expect(setMeta).toHaveBeenCalledWith("Run faster today.");
    expect(setDesc).toHaveBeenCalledWith("Lightweight shoes built for speed.");
    expect(setBullets).toHaveBeenCalledWith(["Feather-light design", "All-day comfort", "Free returns"]);
  });

  it("does nothing when raw is empty", () => {
    const { setTitle, setMeta, setDesc, setBullets } = makeSetters();
    applyAiContentText("", setTitle, setMeta, setDesc, setBullets);

    expect(setTitle).not.toHaveBeenCalled();
    expect(setMeta).not.toHaveBeenCalled();
    expect(setDesc).not.toHaveBeenCalled();
    expect(setBullets).not.toHaveBeenCalled();
  });

  it("only calls setters for sections actually present", () => {
    const raw = "SEO TITLE:\nOnly a title";
    const { setTitle, setMeta, setDesc, setBullets } = makeSetters();
    applyAiContentText(raw, setTitle, setMeta, setDesc, setBullets);

    expect(setTitle).toHaveBeenCalledWith("Only a title");
    expect(setMeta).not.toHaveBeenCalled();
    expect(setDesc).not.toHaveBeenCalled();
    expect(setBullets).not.toHaveBeenCalled();
  });

  it("pads missing bullets with empty strings", () => {
    const raw = "BULLET POINTS:\n- Only one bullet";
    const { setTitle, setMeta, setDesc, setBullets } = makeSetters();
    applyAiContentText(raw, setTitle, setMeta, setDesc, setBullets);

    expect(setBullets).toHaveBeenCalledWith(["Only one bullet", "", ""]);
  });
});

describe("extractMainContent", () => {
  it("picks exactly the single strongest paragraph instead of merging several (christysports.com bug case)", () => {
    const html = `
      <div class="filters">
        <div>Products (324) 324 Results Sort By: Sort By (trending) Highest $ Lowest $ A - Z Z - A New Arrivals</div>
        <ul>
          <li>Refine by Category: Snowboard selected</li>
          <li>Currently Refined by Category: Snowboards</li>
          <li>Refine by Brand: Arbor Refine by Brand: Bent Metal Refine by Brand: CAPiTA</li>
        </ul>
      </div>
      <div class="product-names">K2 Maysis Snowboard Boots Mens Ride Insano Snowboard Boots Mens Union Reset Pro Snowboard Boots Salomon Sleepwalker Grom Snowboard Kids Lib Tech T Rice Orca Snowboard</div>
      <div class="seo-content">
        <h1>Score Big on Clearance Snowboard Gear</h1>
        <p>Looking for incredible deals on snowboard gear without sacrificing quality? You've hit the jackpot. Our clearance snowboard collection is packed with top-of-the-line boards, boots, and bindings from the brands you trust, all at prices that'll make you want to do a victory lap.</p>
        <p>Check out our full selection of snowboards and gear for every kind of rider today.</p>
      </div>
    `;

    const result = extractMainContent(html);

    expect(result).toContain("hit the jackpot");
    // Chỉ trả về 1 đoạn duy nhất (đoạn điểm cao nhất) — không gộp đoạn yếu hơn vào.
    expect(result).not.toContain("Check out our full selection");
    expect(result).not.toContain("Refine by");
    // Chuỗi tên sản phẩm nối tiếp, không có câu hoàn chỉnh -> không bao giờ được chọn.
    expect(result).not.toContain("K2 Maysis Snowboard Boots");
  });

  it("never selects a run of product names with no sentence punctuation as the description", () => {
    const html = `<div>K2 Maysis Snowboard Boots Mens Ride Insano Snowboard Boots Mens Union Reset Pro Snowboard Boots Salomon Sleepwalker Grom Snowboard Kids Lib Tech T Rice Orca Snowboard</div>`;
    expect(extractMainContent(html)).toBe("");
  });

  it("never selects an empty-category 'no products found' message as the description (the-board-hoard.co.uk bug case)", () => {
    const html = `<div>Skip to content No products were found matching your selection.</div>`;
    expect(extractMainContent(html)).toBe("");
  });

  it("never selects a cookie-consent banner as the description (arborcollective.com bug case)", () => {
    const html = `<div>This website uses cookies to make the experience of this website better. By continuing past this notice and by using this website you agree to our use of cookies.</div>`;
    expect(extractMainContent(html)).toBe("");
  });

  it("never selects a JavaScript-required stub page as the description (mountsnow.com bug case)", () => {
    const html = `<div>The site requires JavaScript to be enabled! The browser you're using doesn't support JavaScript, or has JavaScript turned off. Try again with a browser that supports JavaScript.</div>`;
    expect(extractMainContent(html)).toBe("");
  });

  it("returns empty string when no block passes the prose threshold", () => {
    const html = `<div><li>Sort By</li><li>Filter</li><li>In Stock</li></div>`;
    expect(extractMainContent(html)).toBe("");
  });

  it("truncates the chosen paragraph to maxLength", () => {
    const longSentence = "This is a genuinely long descriptive sentence about a great product. ".repeat(50);
    const html = `<p>${longSentence}</p>`;
    const result = extractMainContent(html, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});
