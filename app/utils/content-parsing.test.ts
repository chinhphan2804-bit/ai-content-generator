import { describe, it, expect, vi } from "vitest";
import { decodeHtmlEntities, extractJsonLdDescription, escapeHtml, applyAiContentText } from "./content-parsing";

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
