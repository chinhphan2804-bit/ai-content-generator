import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // React Router v7 chạy loader cha/con song song, nên loader này KHÔNG được
  // ăn theo việc app.tsx (cha) đã xác thực — phải tự kiểm tra độc lập.
  await authenticate.admin(request);
  const url = new URL(request.url);
  return redirect(`/app/analyze${url.search}`);
};
