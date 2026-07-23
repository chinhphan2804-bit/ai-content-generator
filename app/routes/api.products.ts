import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  
  const response = await admin.graphql(
    `#graphql
    query {
      products(first: 50) {
        edges { 
          node { 
            id 
            title 
            variants(first: 1) { 
              edges { 
                node { 
                  price 
                } 
              } 
            } 
          } 
        }
      }
    }`
  );
  
  const data = await response.json();
  return data;
};
