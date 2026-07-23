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
  
  if (content.includes("@remix-run/node")) {
    content = content.replace(/@remix-run\/node/g, "react-router");
    modified = true;
  }
  if (content.includes("@remix-run/react")) {
    content = content.replace(/@remix-run\/react/g, "react-router");
    modified = true;
  }
  
  if (modified) {
    fs.writeFileSync(file, content, "utf8");
    console.log(`Updated ${file}`);
  }
});

// Also fix app.analyze.tsx getAdmin function
const analyzePath = "./app/routes/app.analyze.tsx";
if (fs.existsSync(analyzePath)) {
  let analyzeContent = fs.readFileSync(analyzePath, "utf8");
  const badGetAdmin = `async function getAdmin(request: Request) {\n  if (process.env.NODE_ENV !== "production") {\n    const url = new URL(request.url);\n    const shop = url.searchParams.get("shop") || "chinh-dev-store.myshopify.com";\n    return unauthenticated.admin(shop);\n  }\n  return authenticate.admin(request);\n}`;
  const goodGetAdmin = `async function getAdmin(request: Request) {\n  return authenticate.admin(request);\n}`;
  
  if (analyzeContent.includes(badGetAdmin)) {
    analyzeContent = analyzeContent.replace(badGetAdmin, goodGetAdmin);
    fs.writeFileSync(analyzePath, analyzeContent, "utf8");
    console.log("Fixed getAdmin in app.analyze.tsx");
  }
}
