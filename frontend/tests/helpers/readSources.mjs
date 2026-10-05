import { readFileSync, readdirSync } from "node:fs";

const stylesEntry = new URL("../../src/styles.css", import.meta.url);
const translationRoot = new URL("../../src/i18n/", import.meta.url);

export function readStyles(url = stylesEntry, ancestors = new Set()) {
  if (ancestors.has(url.href)) throw new Error("Circular stylesheet import");
  const next = new Set([...ancestors, url.href]);
  return readFileSync(url, "utf8").replace(/@import\s+["']([^"']+)["'];/g, (_match, relative) => readStyles(new URL(relative, url), next));
}

export function readTranslationSources() {
  const sources = [readFileSync(new URL("messages.ts", translationRoot), "utf8")];
  for (const locale of ["ja", "zh", "en"]) {
    const folder = new URL(`${locale}/`, translationRoot);
    for (const name of readdirSync(folder).filter(name => name.endsWith(".ts")).sort()) sources.push(readFileSync(new URL(name, folder), "utf8"));
  }
  return sources.join("\n");
}
