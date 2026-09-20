// Copies the Swagger UI assets `/docs` needs out of the installed `swagger-ui-dist` package into
// `web/public/docs/`, so Vite's own "copy everything under public/ into dist/" picks them up as
// part of `npm run build` — no fork of Swagger UI committed to git, no CDN dependency at runtime.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = join(ROOT, "node_modules", "swagger-ui-dist");
const DEST_DIR = join(ROOT, "web", "public", "docs");

// Exactly what src/routes/docs.ts's Swagger UI page references — not the whole package (which
// also ships an es-bundle, oauth2 redirect page, and its own index.html we don't use).
const FILES = ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js"];

mkdirSync(DEST_DIR, { recursive: true });

for (const file of FILES) {
	const src = join(SRC_DIR, file);
	if (!existsSync(src)) {
		console.error(`copy-swagger-ui: expected ${src} to exist — has the installed swagger-ui-dist version stopped shipping it?`);
		process.exit(1);
	}
	copyFileSync(src, join(DEST_DIR, file));
}

// The page's own bootstrap. It lives in web/src so it is reviewed like source, and is copied
// here because everything /docs loads must come from the same gitignored directory.
copyFileSync(join(ROOT, "web", "src", "docs-init.js"), join(DEST_DIR, "init.js"));

console.log(`copy-swagger-ui: copied ${FILES.length + 1} files to web/public/docs/`);
