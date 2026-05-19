// Smoke test for the c1 (TAC) CFG view.
//
// Drives index.html headlessly: switches to the c1 backend, types a source
// program that uses && (which can ONLY be represented in c1, not c0),
// flips the CFG tab to Graph view, and asserts the resulting CFG has the
// shape expected from short-circuit lowering: multiple basic blocks, a
// conditional branch, and TAC-shaped instructions in the block bodies.
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, "..", "index.html");

const SRC = `
i32 f() { return 1; }
i32 main() {
  i32 a = 1;
  return a && f();
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

// Switch to c1, type the && source.
await page.evaluate(() => {
  const bs = document.getElementById("backend-select");
  bs.value = "c1";
  bs.dispatchEvent(new Event("change"));
});
await page.evaluate((src) => {
  const s = document.getElementById("source");
  s.value = src;
  s.dispatchEvent(new Event("input"));
}, SRC);
await page.waitForTimeout(400); // debounce + render

// Ensure cfg tab is active in whichever pane it currently lives in.
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

// Switch to Graph view.
await page.click(`#${cfgPane} .panel[data-tab="cfg"] .toggle-group button[data-view="graph"]`);
await page.waitForTimeout(300);

const probe = await page.evaluate(() => {
  // Find the main() function's cfg-stage. fn h3 includes the function name.
  const groups = Array.from(document.querySelectorAll(".fn-group"));
  const mainGroup = groups.find((g) => /\bmain\b/.test(g.querySelector("h3")?.textContent || ""));
  const stage = mainGroup?.querySelector(".cfg-stage");
  return {
    backendLabel: document.querySelector("#backend-select option:checked")?.textContent,
    stageCount: document.querySelectorAll(".cfg-stage").length,
    mainNodes: stage ? stage.querySelectorAll(".cfg-node").length : 0,
    mainEdges: stage ? stage.querySelectorAll(".cfg-edges path").length : 0,
    mainTrueEdges: stage ? stage.querySelectorAll(".cfg-edge-true").length : 0,
    mainFalseEdges: stage ? stage.querySelectorAll(".cfg-edge-false").length : 0,
    bodyText: stage ? stage.innerText : "",
  };
});
console.log("probe:", { ...probe, bodyText: probe.bodyText.slice(0, 200) + "…" });

assert(probe.backendLabel === "c1 (TAC)", `backend label should be "c1 (TAC)", got "${probe.backendLabel}"`);
assert(probe.stageCount === 2, `expected 2 cfg-stages (one per function), got ${probe.stageCount}`);
assert(probe.mainNodes >= 3, `main() && lowering should produce ≥3 basic blocks, got ${probe.mainNodes}`);
assert(probe.mainTrueEdges >= 1, "main() should have a true edge from BrIf");
assert(probe.mainFalseEdges >= 1, "main() should have a false edge from BrIf");
assert(/__t\d+\s*=/.test(probe.bodyText), "main() blocks should contain TAC dest = ... lines");
assert(errs.length === 0, "no page errors should have occurred");

await browser.close();
console.log("c1 CFG smoke: PASSED");
