import fs from "fs";
import path from "path";

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith(".ts") || file.endsWith(".tsx")) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk("./app");

files.forEach(file => {
  let content = fs.readFileSync(file, "utf8");
  let modified = false;
  
  if (content.includes("@shopify/shopify-app-remix/server")) {
    content = content.replace(/@shopify\/shopify-app-remix\/server/g, "@shopify/shopify-app-react-router/server");
    modified = true;
  }
  if (content.includes("@shopify/shopify-app-remix/react")) {
    content = content.replace(/@shopify\/shopify-app-remix\/react/g, "@shopify/shopify-app-react-router/react");
    modified = true;
  }
  if (content.includes("@shopify/shopify-app-remix")) {
    content = content.replace(/@shopify\/shopify-app-remix/g, "@shopify/shopify-app-react-router");
    modified = true;
  }
  
  if (modified) {
    fs.writeFileSync(file, content, "utf8");
    console.log(`Updated ${file}`);
  }
});
