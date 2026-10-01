// Tests for the pure probe/jev arbitration policy (lib/probe-policy.js).
// The policy must be ONE explicit rule, not magic numbers in background.js.
import { decideExecutor } from "../extension/lib/probe-policy.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

// 1) jev usable -> jev always wins, regardless of probe score
ok("jev top 0.82 w/ lock 0.6 -> jev", decideExecutor({ jevHasDecision: true, jevTop: 0.82, probeScore: 0.75, lockBar: 0.6 }) === "jev");
ok("jev top 0.60 == lock -> jev (boundary inclusive)", decideExecutor({ jevHasDecision: true, jevTop: 0.6, probeScore: 1, lockBar: 0.6 }) === "jev");
ok("jev top 0.59 < lock -> NOT jev (probe can act)", decideExecutor({ jevHasDecision: true, jevTop: 0.59, probeScore: 1, lockBar: 0.6 }) !== "jev");

// 2) jev absent -> probe only when STRONG match (>=0.8). 导出->导出数据 is 0.75 -> none.
ok("no jev + probe 1.0 exact -> probe", decideExecutor({ jevHasDecision: false, jevTop: 0, probeScore: 1, lockBar: 0.6 }) === "probe");
ok("no jev + probe 0.75 (导出->导出数据) -> none (no hijack)", decideExecutor({ jevHasDecision: false, jevTop: 0, probeScore: 0.75, lockBar: 0.6 }) === "none");
ok("no jev + probe 0.8 boundary -> probe", decideExecutor({ jevHasDecision: false, jevTop: 0, probeScore: 0.8, lockBar: 0.6 }) === "probe");

// 3) jev undecided (low top) AND probe weak -> none (hand to vision/route, no blind click)
ok("jev 0.3 + probe 0.5 -> none", decideExecutor({ jevHasDecision: true, jevTop: 0.3, probeScore: 0.5, lockBar: 0.6 }) === "none");

// 4) configurable lock bar: raising it makes jev win less easily
ok("lock raised to 0.9: jev 0.82 -> probe-eligible path (not jev)", decideExecutor({ jevHasDecision: true, jevTop: 0.82, probeScore: 1, lockBar: 0.9 }) !== "jev");
ok("lock raised to 0.9 + no jev + strong probe -> probe", decideExecutor({ jevHasDecision: false, jevTop: 0, probeScore: 1, lockBar: 0.9 }) === "probe");

// 5) invalid lockBar falls back to 0.6
ok("invalid lockBar -> default 0.6 behaviour", decideExecutor({ jevHasDecision: true, jevTop: 0.5, probeScore: 0, lockBar: "x" }) !== "jev");

console.log(`\n${fail ? "✗" : "✓"} test_probe_policy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
