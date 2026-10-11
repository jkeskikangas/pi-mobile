// Writes public/ from ../PRIVACY.md so the policy has one source.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { marked } from "marked";

const repo = "https://github.com/jkeskikangas/pi-mobile";
const out = new URL("./public/", import.meta.url);

const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
a { color: LinkText; }
table { border-collapse: collapse; width: 100%; font-size: .93rem; display: block; overflow-x: auto; }
th, td { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding: .5rem .6rem; text-align: left; vertical-align: top; }
code { font-size: .9em; }
footer { margin-top: 3rem; font-size: .9rem; opacity: .7; }
</style>
</head>
<body>
${body}
<footer><a href="/">pi-mobile.dev</a> · <a href="/privacy">Privacy</a> · <a href="${repo}">Source</a> · <a href="${repo}/issues">Support</a></footer>
</body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const policy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");
writeFileSync(new URL("privacy.html", out), page("pi mobile privacy policy", marked.parse(policy)));

writeFileSync(new URL("index.html", out), page("pi mobile", `<h1>pi mobile</h1>
<p>Your <a href="https://github.com/earendil-works/pi">pi</a> sessions, on your phone: end-to-end encrypted, with voice.</p>
<ul>
<li><a href="${repo}">Source code and setup</a></li>
<li><a href="/privacy">Privacy policy</a></li>
<li><a href="${repo}/issues">Support</a></li>
</ul>`));

writeFileSync(new URL("404.html", out), page("Not found", `<h1>Not found</h1><p><a href="/">pi-mobile.dev</a></p>`));
