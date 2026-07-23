import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { captureError } from "../monitoring.server";

// GDPR: shop uninstalled and requests all their data be deleted.
// Delete the shop session from our database.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[GDPR] ${topic} for ${shop} — deleting shop session`);
  try {
    await db.session.deleteMany({ where: { shop } });
  } catch (error) {
    captureError(error, { where: "webhooks.shop.redact", shop });
  }
  return new Response(null, { status: 200 });
};
