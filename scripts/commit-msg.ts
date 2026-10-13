// Runs from the Husky commit-msg hook (and pre-push, for every outgoing commit).
// Commit messages in this repo carry no AI attribution. Naming a product (Claude
// Desktop in the MCP docs, say) is fine; crediting an assistant is not.
import { readFileSync } from "fs";

const RULES: [RegExp, string][] = [
  [/^co-authored-by:.*(claude|anthropic|openai|copilot|gpt)/im, "has an AI Co-Authored-By trailer"],
  [/generated (with|by) \[?(claude|chatgpt|copilot)/i, "has a \"Generated with\" footer"],
  [/@anthropic\.com/i, "has an Anthropic address"],
];

/** Why the message is refused, or null. */
export function checkMessage(message: string): string | null {
  // Ignore the comment lines git adds to the editor template.
  const text = message.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  for (const [re, why] of RULES) if (re.test(text)) return why;
  return null;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("usage: bun scripts/commit-msg.ts <message file>"); process.exit(2); }
  const problem = checkMessage(readFileSync(file, "utf8"));
  if (problem) {
    console.error(`commit-msg: the message ${problem}. Remove it and commit again.`);
    process.exit(1);
  }
}
