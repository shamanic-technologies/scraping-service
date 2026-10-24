/**
 * Marks past runs of ours SUPPORT (see src/lib/support-marks.ts). Preview by default; `--apply` writes.
 * In prod: docker exec distribute-scraping-service-1 node dist/scripts/mark-support.js \
 *   --kind staff_experiment --reason "..." --by "<session>" [--apply] <runId> [<runId>...]
 * Safe to re-run: an already marked run is counted, never written twice.
 */
import { markSupport, supportMarkRequest } from "../lib/support-marks.js";

function arg(name: string, argv: string[]): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const flags = new Set(["--kind", "--reason", "--by"]);
  const runIds = argv.filter((a, i) => !a.startsWith("--") && !flags.has(argv[i - 1]));
  const body = supportMarkRequest(arg("kind", argv), arg("reason", argv), arg("by", argv), runIds);
  const preview = await markSupport("preview", body);
  console.log(JSON.stringify({ step: "preview", kind: body.kind, runs: body.runIds.length, preview }));
  if (!apply) process.exit(0);
  const result = await markSupport("apply", body);
  console.log(JSON.stringify({ step: "apply", kind: body.kind, result }));
  process.exit(0);
}

main().catch((err) => {
  console.error(`[scraping-service] SUPPORT MARK FAILED: ${err?.message ?? err}`);
  process.exit(1);
});
