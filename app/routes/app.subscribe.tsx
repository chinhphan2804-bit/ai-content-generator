import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";
import { captureError } from "../monitoring.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  try {
    // isTest: dùng thẻ giả trong lúc phát triển/xét duyệt; chuyển sang tính phí
    // thật khi app đã live trên App Store (production).
    const confirmationUrl = await billing.request({
      plan: MONTHLY_PLAN,
      isTest: process.env.NODE_ENV !== "production",
    });
    return { confirmationUrl };
  } catch (error: any) {
    if (error instanceof Response) {
      // Shopify trả 401 kèm header đặc biệt khi tạo subscription qua session
      // token trong iframe — charge ĐÃ được tạo, chỉ là cần merchant xác nhận
      // ở 1 trang riêng (không thể hiện trong iframe). URL xác nhận nằm ngay
      // trong header này — lấy ra và xử lý y hệt confirmationUrl bình thường.
      const reauthorizeUrl = error.headers.get("x-shopify-api-request-failure-reauthorize-url");
      if (reauthorizeUrl) {
        return { confirmationUrl: reauthorizeUrl };
      }
      // Không có header đó → đây là phiên đăng nhập thật sự hết hạn, để
      // React Router xử lý reauth mặc định, không được nuốt mất.
      throw error;
    }

    // Log + gửi Sentry (nếu đã cấu hình) — không để lộ chi tiết nội bộ cho
    // merchant thấy trên UI, chỉ trả về 1 câu message ngắn gọn.
    captureError(error, { where: "billing.request", errorData: error?.errorData });
    const detail = error?.errorData?.[0]?.message || error?.message || "Unknown billing error";
    return { billingError: detail };
  }
};

export default function Subscribe() {
  const fetcher = useFetcher<any>();
  const isLoading = fetcher.state === "submitting";

  // Trang xác nhận thanh toán nằm trên domain Shopify — phải thoát khỏi
  // iframe của app (mở ở cửa sổ trên cùng) thì merchant mới bấm "Approve" được.
  useEffect(() => {
    if (fetcher.data?.confirmationUrl) {
      open(fetcher.data.confirmationUrl, "_top");
    }
  }, [fetcher.data]);

  return (
    <s-page>
      <ui-title-bar title="Upgrade to Pro"></ui-title-bar>
      <s-layout>
        <s-layout-section>
          <s-card>
            <s-section>
              <h2 style={{ fontSize: "20px", fontWeight: "bold" }}>Pro Plan - Unlimited</h2>
              <div style={{ marginTop: "16px", display: "flex", alignItems: "baseline", gap: "8px" }}>
                <span style={{ fontSize: "24px", fontWeight: "bold" }}>$19.99</span>
                <span style={{ color: "#6d7175" }}>/ month</span>
              </div>
              <s-divider></s-divider>
              {fetcher.data?.billingError && (
                <s-banner tone="critical" heading="Upgrade failed">
                  <p>{fetcher.data.billingError}</p>
                </s-banner>
              )}
              <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <p>✓ Unlimited AI content generation</p>
                <p>✓ Automatic competitor analysis</p>
                <p>✓ Multi-language support (English, Vietnamese...)</p>
                <p>✓ One-click save to Shopify</p>
              </div>
              <div style={{ marginTop: "24px" }}>
                <s-button
                  variant="primary"
                  onClick={() => fetcher.submit({}, { method: "post" })}
                  disabled={isLoading}
                >
                  {isLoading ? "Processing..." : "Upgrade now"}
                </s-button>
              </div>
            </s-section>
          </s-card>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
