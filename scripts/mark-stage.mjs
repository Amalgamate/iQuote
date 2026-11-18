/**
 * Marks the active stage complete after the caller verifies its evidence.
 * Usage: node scripts/mark-stage.mjs <stageNumber> --verified "evidence summary"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = Number(process.argv[2]);
const verifiedIndex = process.argv.indexOf("--verified");
const evidence = verifiedIndex >= 0 ? process.argv.slice(verifiedIndex + 1).join(" ").trim() : "";
if (!Number.isInteger(stage) || stage < 0 || verifiedIndex < 0 || !evidence) {
  console.error('Usage: node scripts/mark-stage.mjs <stageNumber> --verified "evidence summary"');
  process.exit(1);
}

const checklistPath = path.join(root, "CHECKLIST.md");
let md = fs.readFileSync(checklistPath, "utf8");
const stageHeading = `## Stage ${stage} `;
if (!md.split("\n").some((line) => line.startsWith(stageHeading))) {
  console.error(`Stage ${stage} not found in CHECKLIST.md`);
  process.exit(1);
}

const progressPath = path.join(root, "progress.json");
const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
if (stage !== progress.currentStage) {
  console.error(`Stage ${stage} is not the active stage. progress.json.currentStage is ${progress.currentStage}.`);
  process.exit(1);
}

const lines = md.split("\n");
let inStage = false;
let foundTasks = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith(stageHeading)) inStage = true;
  else if (inStage && lines[i].startsWith("## ")) inStage = false;
  if (inStage && lines[i].startsWith("- [ ]")) {
    lines[i] = lines[i].replace("- [ ]", "- [x]");
    foundTasks = true;
  }
}
if (!foundTasks) {
  console.error(`Stage ${stage} has no unchecked tasks to mark.`);
  process.exit(1);
}

const now = new Date().toISOString();
progress.completedStages = [...new Set([...(progress.completedStages ?? []), stage])].sort((a, b) => a - b);
progress.currentStage = stage + 1;
progress.updatedAt = now;
const priorNotes = typeof progress.notes === "string" ? progress.notes.trim() : "";
progress.notes = `${priorNotes ? `${priorNotes}\n` : ""}Stage ${stage} verified ${now}: ${evidence}`;

// Validate both outputs before writing either tracker file.
const progressText = JSON.stringify(progress, null, 2) + "\n";
JSON.parse(progressText);
fs.writeFileSync(checklistPath, lines.join("\n"));
fs.writeFileSync(progressPath, progressText);
console.log(`Marked stage ${stage} complete.`);
