import YAML from "yaml"

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value)

function scalarText(value) {
  if (typeof value === "string") return JSON.stringify(value)
  if (value === null) return "null"
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return String(value)
  throw new TypeError("配置中包含无法写入的值")
}

function collectScalarEdits(document, original, current, next, path, edits) {
  const node = document.getIn(path, true)
  if (YAML.isMap(node) && isRecord(current) && isRecord(next)) {
    const keys = node.items.map(pair => YAML.isScalar(pair.key) ? pair.key.value : pair.key.toJSON())
    if (keys.length !== Object.keys(next).length) return false
    return keys.every(key => Object.hasOwn(next, String(key))
      && collectScalarEdits(document, original, current[String(key)], next[String(key)], [...path, key], edits))
  }
  if (YAML.isSeq(node) && Array.isArray(current) && Array.isArray(next)) {
    if (current.length !== next.length) {
      const edit = sequenceEdit(document, original, path, next)
      if (!edit) return false
      edits.push(edit)
      return true
    }
    return current.every((item, index) =>
      collectScalarEdits(document, original, item, next[index], [...path, index], edits))
  }
  if (YAML.isScalar(node) && (next === null || typeof next !== "object")) {
    if (Object.is(current, next)) return true
    if (!node.range) return false
    const [start, end] = node.range
    const separator = start === end && !/\s/.test(original[start - 1] || "") ? " " : ""
    edits.push({ start, end, text: separator + scalarText(next) })
    return true
  }
  if (YAML.isScalar(node) && node.value === null && Array.isArray(next)) {
    const edit = sequenceEdit(document, original, path, next)
    if (!edit) return false
    edits.push(edit)
    return true
  }
  return false
}

function replaceNode(document, path, value, previous) {
  const isEmptyScalar = YAML.isScalar(previous) && previous.value === null && previous.range?.[0] === previous.range?.[1]
  const parent = isEmptyScalar ? document.getIn(path.slice(0, -1), true) : null
  const pair = YAML.isMap(parent) ? parent.items.find(item => item.value === previous) : null
  const inlineComment = isEmptyScalar ? previous.comment : undefined
  if (inlineComment) previous.comment = undefined
  document.setIn(path, document.createNode(value))
  const replacement = document.getIn(path, true)
  if (!previous || !replacement || typeof replacement !== "object") return
  if (isEmptyScalar) {
    if (inlineComment && pair && YAML.isScalar(pair.key)) pair.key.comment = inlineComment.trimEnd()
    return
  }
  for (const property of ["comment", "commentBefore", "spaceBefore"]) {
    if (previous[property] !== undefined && replacement[property] === undefined) {
      replacement[property] = previous[property]
    }
  }
}

function updateNode(document, path, value) {
  const node = document.getIn(path, true)

  if (YAML.isMap(node) && isRecord(value)) {
    const existingKeys = node.items.map(pair => YAML.isScalar(pair.key) ? pair.key.value : pair.key.toJSON())
    for (const key of existingKeys) {
      if (!Object.hasOwn(value, String(key))) document.deleteIn([...path, key])
    }
    for (const [key, next] of Object.entries(value)) {
      const existingKey = existingKeys.find(current => String(current) === key)
      const childPath = [...path, existingKey === undefined ? key : existingKey]
      if (existingKey === undefined) document.setIn(childPath, next)
      else updateNode(document, childPath, next)
    }
    return
  }

  if (YAML.isSeq(node) && Array.isArray(value)) {
    const oldLength = node.items.length
    for (let index = 0; index < Math.min(oldLength, value.length); index++) {
      updateNode(document, [...path, index], value[index])
    }
    node.items.splice(value.length)
    for (let index = oldLength; index < value.length; index++) node.add(value[index])
    return
  }

  if (YAML.isScalar(node) && (value === null || typeof value !== "object") && typeof node.value === typeof value) {
    node.value = value
    return
  }
  replaceNode(document, path, value, node)
}

function sequenceEdit(document, original, path, value) {
  const previous = document.getIn(path, true)
  if (!previous?.range) return null
  const [start, nodeEnd, commentEnd] = previous.range
  const inlineComment = YAML.isScalar(previous) && previous.value === null ? previous.comment : undefined
  const end = inlineComment ? commentEnd : nodeEnd
  const updated = YAML.parseDocument(original)
  updateNode(updated, path, value)
  const rendered = updated.toString()
  const newNode = YAML.parseDocument(rendered).getIn(path, true)
  if (!newNode?.range) return null

  const eol = original.includes("\r\n") ? "\r\n" : "\n"
  let text = rendered.slice(newNode.range[0], newNode.range[1]).replace(/\r?\n/g, eol)
  const oldLineStart = original.lastIndexOf("\n", start - 1) + 1
  const newLineStart = rendered.lastIndexOf("\n", newNode.range[0] - 1) + 1
  const oldIndent = YAML.isSeq(previous) ? start - oldLineStart : original.slice(oldLineStart, start).match(/^ */)[0].length + 2
  const newIndent = newNode.range[0] - newLineStart
  if (oldIndent !== newIndent) {
    text = text.split(eol).map((line, index) => index === 0 || !line ? line :
      " ".repeat(Math.max(0, line.match(/^ */)[0].length + oldIndent - newIndent)) + line.trimStart()).join(eol)
  }

  if (!YAML.isSeq(previous)) {
    if (inlineComment) {
      text = ` #${inlineComment.trimEnd()}${eol}${" ".repeat(oldIndent)}${text}`
    } else {
      const renderedPrefix = rendered.slice(newLineStart, newNode.range[0])
      text = renderedPrefix.includes(":") ? ` ${text}` : `${eol}${" ".repeat(oldIndent)}${text}`
    }
  }
  if (!/\r?\n$/.test(original.slice(start, end))) text = text.replace(/\r?\n$/, "")
  return { start, end, text }
}

export function updateYamlPreservingComments(originalContent, data) {
  if (!isRecord(data)) throw new TypeError("配置必须是 YAML 对象")
  const document = YAML.parseDocument(originalContent)
  if (document.errors.length) throw document.errors[0]
  if (!YAML.isMap(document.contents)) throw new TypeError("原配置必须是 YAML 对象")
  const edits = []
  if (collectScalarEdits(document, originalContent, document.toJS(), data, [], edits)) {
    return edits.sort((left, right) => right.start - left.start).reduce((content, edit) =>
      content.slice(0, edit.start) + edit.text + content.slice(edit.end), originalContent)
  }
  updateNode(document, [], data)
  return document.toString()
}
