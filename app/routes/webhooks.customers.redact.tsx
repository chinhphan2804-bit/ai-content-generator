import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR: delete customer data stored by this app.
// This app only modifies product descriptions — no customer data to delete.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[GDPR] ${topic} for ${shop} — no customer data to delete`);
  return new Response(null, { status: 200 });
};
