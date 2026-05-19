// Smoke test for the c0 (statement-CFG) view.
//
// Compiles a function with a while loop and asserts the CFG graph renders:
// basic blocks, at least one back-edge, and at least one true/false pair
// from the loop's BrIf. Guards against renderer regressions when c1 is
// edited.
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, "..", "index.html");

const SRC = `
i32 sum(i32 n) {
  i32 total = 0;
  i32 i = 0;
  while (1) {
    if (i >= n) { return total; }
    total = total + i;
    i = i + 1;
  }
}
`;

function assert(cond, msg) {
  if (!cond) { console.error("ASSERT FAILED:", msg); process.exit(1); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
const errs = [];
page.on("pageerror", (err) => { console.log("PAGE ERROR:", err.message); errs.push(err); });

await page.goto("file://" + indexPath);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => !!window.__viz, null, { timeout: 5000 });

await page.evaluate((src) => {
  const s = document.getElementById("source");
  s.value = src;
  s.dispatchEvent(new Event("input"));
}, SRC);
await page.waitForTimeout(400);

const cfgPane = await page.evaluate(() => {
  for (const id of ["paneA", "paneB"]) {
    if (window.__viz.paneState[id].tabIds.includes("cfg")) {
      window.__viz.paneState[id].active = "cfg";
      window.__viz.applyPane(id);
      return id;
    }
  }
  return null;
});
assert(cfgPane, "cfg tab should be in one of the panes");

await page.click(`#${cfgPane} .panel[data-tab="cfg"] .toggle-group button[data-view="graph"]`);
await page.waitForTimeout(300);

const probe = await page.evaluate(() => {
  const stage = document.querySelector(".cfg-stage");
  return {
    backendLabel: document.querySelector("#backend-select option:checked")?.textContent,
    nodes: stage ? stage.querySelectorAll(".cfg-node").length : 0,
    edges: stage ? stage.querySelectorAll(".cfg-edges path").length : 0,
    trueEdges: stage ? stage.querySelectorAll(".cfg-edge-true").length : 0,
    falseEdges: stage ? stage.querySelectorAll(".cfg-edge-false").length : 0,
    backEdges: stage ? stage.querySelectorAll(".cfg-edge-back").length : 0,
  };
});
console.log("probe:", probe);

assert(probe.backendLabel === "c0 (statement-CFG)", `backend label should be c0, got "${probe.backendLabel}"`);
assert(probe.nodes >= 3, `expected ≥3 basic blocks, got ${probe.nodes}`);
assert(probe.trueEdges >= 1 && probe.falseEdges >= 1, "loop should produce true/false edge pair");
assert(probe.backEdges >= 1, "while loop should produce at least one back-edge");
assert(errs.length === 0, "no page errors should have occurred");

await browser.close();
console.log("c0 CFG smoke: PASSED");
