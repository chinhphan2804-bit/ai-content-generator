import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData || {};

  return (
    <div style={{ padding: "40px", fontFamily: "system-ui, sans-serif", maxWidth: "400px", margin: "0 auto" }}>
      <h2 style={{ fontSize: "24px", marginBottom: "20px" }}>Log in</h2>
      <Form method="post" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: 500 }}>Shop domain</span>
          <input
            type="text"
            name="shop"
            placeholder="example.myshopify.com"
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            autoComplete="on"
            style={{ padding: "8px 12px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "14px" }}
          />
          {errors?.shop && <span style={{ color: "red", fontSize: "12px" }}>{errors.shop}</span>}
        </label>
        <button type="submit" style={{ padding: "10px 16px", backgroundColor: "black", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 600 }}>
          Log in
        </button>
      </Form>
    </div>
  );
}
