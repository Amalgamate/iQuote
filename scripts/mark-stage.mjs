/**
 * Marks a stage complete in CHECKLIST.md and progress.json.
 * Usage: node scripts/mark-stage.mjs 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = Number(process.argv[2]);
if (!Number.isInteger(stage) || stage < 0) {
  console.error("Usage: node scripts/mark-stage.mjs <stageNumber>");
  process.exit(1);
}

const heading = new RegExp(`^## Stage ${stage} `, "m");
const checklistPath = path.join(root, "CHECKLIST.md");
let md = fs.readFileSync(checklistPath, "utf8");
if (!heading.test(md)) {
  console.error(`Stage ${stage} not found in CHECKLIST.md`);
  process.exit(1);
}

const lines = md.split("\n");
let inStage = false;
let nextStage = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith(`## Stage ${stage} `)) inStage = true;
  else if (inStage && lines[i].startsWith("## ")) {
    nextStage = true;
    inStage = false;
  }
  if (inStage && lines[i].startsWith("- [ ]")) {
    lines[i] = lines[i].replace("- [ ]", "- [x]");
  }
}
md = lines.join("\n");
fs.writeFileSync(checklistPath, md);

const progressPath = path.join(root, "progress.json");
const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
if (!progress.completedStages.includes(stage)) progress.completedStages.push(stage);
progress.completedStages.sort((a, b) => a - b);
progress.currentStage = stage;
progress.updatedAt = new Date().toISOString();
progress.notes = `Stage ${stage} marked complete.`;
fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2) + "\n");
console.log(`Marked stage ${stage} complete.`);
