// Tests for the LLM completion judge's pure parser (lib/llm.js judgeVerdict).
// Locks the behavior that the run engine relies on at step exhaustion:
//   - done=true with empty missing
//   - done=false with missing steps (e.g. "导出所有合同记录" left a dialog open)
//   - unparseable LLM response -> safe {done:false, missing:[]}
import { judgeVerdict } from "../extension/lib/llm.js";
import assert from "node:assert";

let passed = 0;
const ok = (name) => { passed++; console.log("PASS", name); };

// 1) done with no missing
{
  const v = judgeVerdict(JSON.stringify({ done: true, reason: "文件已下载", missing: [] }));
  assert.strictEqual(v.done, true);
  assert.strictEqual(v.missing.length, 0);
  assert.strictEqual(v.reason, "文件已下载");
  ok("done=true -> empty missing");
}

// 2) not done with missing steps (the "导出所有" case: range dialog still open)
{
  const v = judgeVerdict(JSON.stringify({
    done: false,
    reason: "只点了导出，导出范围对话框还开着，未选全部",
    missing: [
      { intent: "选择 全部", verb: "click", target: "全部" },
      { intent: "点击 确认导出", verb: "click", target: "确认导出" },
    ],
  }));
  assert.strictEqual(v.done, false);
  assert.strictEqual(v.missing.length, 2);
  assert.strictEqual(v.missing[0].target, "全部");
  assert.strictEqual(v.missing[1].intent, "点击 确认导出");
  ok("done=false -> carries missing steps");
}

// 3) missing entry missing target/intent -> filled defaults
{
  const v = judgeVerdict(JSON.stringify({ done: false, reason: "x", missing: [{ verb: "click" }] }));
  assert.strictEqual(v.missing[0].target, "");
  assert.strictEqual(v.missing[0].intent, "点击 ");
  ok("missing entry defaults filled");
}

// 4) unparseable -> safe fallback (never throws)
{
  const v = judgeVerdict("不是 json，模型抽风了");
  assert.strictEqual(v.done, false);
  assert.strictEqual(v.missing.length, 0);
  assert.match(v.reason, /无法解析/);
  ok("unparseable -> safe fallback");
}

// 5) JSON embedded in prose (model wrapped in markdown) still parses
{
  const v = judgeVerdict("好的，结果如下：\n```json\n{\"done\":true,\"reason\":\"ok\",\"missing\":[]}\n```");
  assert.strictEqual(v.done, true);
  ok("json embedded in markdown parses");
}

console.log(`\n${passed} passed, 0 failed`);
