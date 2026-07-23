import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { captureError } from "../monitoring.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  try {
    if (session) {
      await db.session.deleteMany({ where: { shop } });
    }
  } catch (error) {
    captureError(error, { where: "webhooks.app.uninstalled", shop });
  }

  return new Response();
};
