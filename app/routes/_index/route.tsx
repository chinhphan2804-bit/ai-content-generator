import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>AI Content Generator</h1>
        <p className={styles.text}>
          Instantly create SEO-optimized product titles, descriptions, and bullet points — powered by Claude AI and real competitor analysis.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Competitor analysis.</strong> Finds the #1 Google result for your product and shows their content side-by-side.
          </li>
          <li>
            <strong>AI-generated content.</strong> Claude AI writes better SEO titles, meta descriptions, and product copy — benefit-first, conversion-focused.
          </li>
          <li>
            <strong>One-click save.</strong> Push the final content directly to your Shopify product. No copy-pasting.
          </li>
        </ul>
      </div>
    </div>
  );
}
