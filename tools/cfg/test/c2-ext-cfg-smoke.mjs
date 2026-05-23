// Smoke test for the c2-ext (SSA + SCC cleanup) CFG view.
//
// Drives index.html headlessly: switches to the c2 backend, types a source
// program with an if/else that joins (forcing a block-parameter / phi at
// the join), flips the CFG tab to Graph view, and asserts the SSA-specific
// shape: a join block that takes a parameter and renders a synthetic
// `x = phi(...)` line as introduced by the c2 visualizer.
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, "..", "index.html");

const SRC = `
i32 main(i32 cond) {
  i32 x;
  if (cond) {
    x = 1;
  } else {
    x = 2;
  }
  return x;
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

// Switch to c2, type the if/else source.
await page.evaluate(() => {
  const bs = document.getElementById("backend-select");
  bs.value = "c2-ext";
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
  const groups = Array.from(document.querySelectorAll(".fn-group"));
  const mainGroup = groups.find((g) => /\bmain\b/.test(g.querySelector("h3")?.textContent || ""));
  const stage = mainGroup?.querySelector(".cfg-stage");
  return {
    backendLabel: document.querySelector("#backend-select option:checked")?.textContent,
    stageCount: document.querySelectorAll(".cfg-stage").length,
    mainNodes: stage ? stage.querySelectorAll(".cfg-node").length : 0,
    mainTrueEdges: stage ? stage.querySelectorAll(".cfg-edge-true").length : 0,
    mainFalseEdges: stage ? stage.querySelectorAll(".cfg-edge-false").length : 0,
    bodyText: stage ? stage.innerText : "",
  };
});
console.log("probe:", { ...probe, bodyText: probe.bodyText.slice(0, 300) + "…" });

assert(probe.backendLabel === "c2-ext (SSA + SCC cleanup)", `backend label should be "c2-ext (SSA + SCC cleanup)", got "${probe.backendLabel}"`);
assert(probe.stageCount === 1, `expected 1 cfg-stage (main only), got ${probe.stageCount}`);
assert(probe.mainNodes >= 4, `if/else with join should produce ≥4 basic blocks (entry, then, else, endif), got ${probe.mainNodes}`);
assert(probe.mainTrueEdges >= 1, "main() should have a true edge from BrIf");
assert(probe.mainFalseEdges >= 1, "main() should have a false edge from BrIf");
assert(/=\s*phi\(/.test(probe.bodyText), "join block should render a synthetic `x = phi(...)` line (c2 SSA marker)");
assert(errs.length === 0, "no page errors should have occurred");

await browser.close();
console.log("c2-ext CFG smoke: PASSED");
