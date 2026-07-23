import * as Sentry from "@sentry/node";

let initialized = false;

// Chỉ khởi tạo Sentry nếu có SENTRY_DSN trong .env — chưa có thì mọi hàm ở
// đây tự động thành no-op an toàn, không ảnh hưởng gì tới app đang chạy.
// Lấy DSN miễn phí tại sentry.io, dán vào .env: SENTRY_DSN=https://...
export function initMonitoring() {
  if (initialized || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
  initialized = true;
}

// Dùng thay cho console.error() ở mọi chỗ bắt lỗi quan trọng — luôn log ra
// server console để xem ngay, ĐỒNG THỜI gửi lên Sentry (nếu đã cấu hình) để
// nhận cảnh báo thay vì phải tự soi log thủ công.
export function captureError(error: unknown, context?: Record<string, unknown>) {
  console.error(error);
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  }
}
