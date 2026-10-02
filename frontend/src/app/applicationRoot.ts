export function applicationRoot(document: Pick<Document, "getElementById">): HTMLElement {
  const root = document.getElementById("root");
  if (!root) throw new Error("Application root #root is missing");
  return root;
}
