import test from "node:test"
import assert from "node:assert/strict"
import YAML from "yaml"
import { updateYamlPreservingComments } from "../src/config-yaml.js"

test("标量更新保留原有格式、行尾注释和 CRLF", () => {
  const original = "# 面板配置\r\nfeature:\ttrue # 保留说明\r\ncount: 1\r\n"
  const updated = updateYamlPreservingComments(original, { feature: false, count: 2 })

  assert.equal(updated, "# 面板配置\r\nfeature:\tfalse # 保留说明\r\ncount: 2\r\n")
})

test("结构修改增删字段并扩展序列时保留剩余注释", () => {
  const original = [
    "# 根配置注释",
    "settings:",
    "  enabled: true # 功能说明",
    "  labels:",
    "    - alpha",
    "    - beta",
    "removeMe: old",
    "",
  ].join("\n")
  const updated = updateYamlPreservingComments(original, {
    settings: { enabled: false, labels: ["alpha", "beta", "gamma"] },
    added: "new",
  })

  assert.deepEqual(YAML.parse(updated), {
    settings: { enabled: false, labels: ["alpha", "beta", "gamma"] },
    added: "new",
  })
  assert.match(updated, /# 根配置注释/)
  assert.match(updated, /# 功能说明/)
  assert.doesNotMatch(updated, /removeMe/)
})

test("拒绝非对象数据、非对象源配置和无效 YAML", () => {
  for (const data of [null, [], "text"]) {
    assert.throws(() => updateYamlPreservingComments("value: 1\n", data), /配置必须是 YAML 对象/)
  }
  assert.throws(() => updateYamlPreservingComments("- value\n", {}), /原配置必须是 YAML 对象/)
  assert.throws(() => updateYamlPreservingComments("value: [\n", {}))
})