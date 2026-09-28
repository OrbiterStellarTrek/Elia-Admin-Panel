/**
 * 完整的 EliaAdminPanel 原生 support 模板。
 * 复制到插件根目录并命名为 elia.support.js，再把示例字段替换成插件自己的配置。
 * 本示例把配置保存在插件目录的 config/example.json。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(pluginDir, "config", "example.json")
// disabled 展示如何禁用单个选项；被禁用的值不会作为有效运行模式保存。
const modeOptions = [
  { label: "均衡", value: "balanced" },
  { label: "快速", value: "fast" },
  { label: "实验模式（禁用）", value: "experimental", disabled: true },
]
const modeValues = modeOptions.filter(option => !option.disabled).map(option => option.value)
const priorityOptions = [
  { label: "低", value: "low" },
  { label: "普通", value: "normal" },
  { label: "高", value: "high" },
]
const priorityValues = priorityOptions.map(option => option.value)
const featureOptions = [
  { label: "失败重试", value: "retry" },
  { label: "发送通知", value: "notify" },
  { label: "缓存结果", value: "cache" },
]
const featureValues = featureOptions.map(option => option.value)
// 各字段的默认类型也决定了表单初始值，例如列表用数组、GSubForm 用对象。
const defaultConfig = {
  enabled: true,
  intervalSeconds: 60,
  serviceUrl: "https://example.com/api",
  demoPassword: "",
  description: "这是 InputTextArea 的多行文本示例。",
  mode: "balanced",
  priority: "normal",
  preferredModes: ["balanced", "fast"],
  labels: ["daily"],
  features: ["retry", "notify"],
  extraTags: ["example", "template"],
  friendIds: [],
  groupIds: [],
  schedule: "0 8 * * *",
  advanced: {
    requestTimeoutSeconds: 15,
    maxRetries: 3,
    notifyOnFailure: true,
    note: "GSubForm 会根据对象字段类型生成对应的子控件。",
  },
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isStringList(value, allowedValues) {
  return Array.isArray(value) && value.every(item => typeof item === "string" && (!allowedValues || allowedValues.includes(item)))
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback
}

// 读取旧配置时补齐默认值，并把列表与嵌套对象规整成模板约定的形状。
function normalizeConfig(value) {
  const saved = isRecord(value) ? value : {}
  const advanced = isRecord(saved.advanced) ? saved.advanced : {}
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : defaultConfig.enabled,
    intervalSeconds: boundedInteger(saved.intervalSeconds, 5, 3600, defaultConfig.intervalSeconds),
    serviceUrl: typeof saved.serviceUrl === "string" ? saved.serviceUrl : defaultConfig.serviceUrl,
    demoPassword: typeof saved.demoPassword === "string" ? saved.demoPassword : "",
    description: typeof saved.description === "string" ? saved.description : defaultConfig.description,
    mode: modeValues.includes(saved.mode) ? saved.mode : defaultConfig.mode,
    priority: priorityValues.includes(saved.priority) ? saved.priority : defaultConfig.priority,
    preferredModes: isStringList(saved.preferredModes, modeValues) ? [...new Set(saved.preferredModes)] : [...defaultConfig.preferredModes],
    labels: isStringList(saved.labels) ? [...new Set(saved.labels)] : [...defaultConfig.labels],
    features: isStringList(saved.features, featureValues) ? [...new Set(saved.features)] : [...defaultConfig.features],
    extraTags: isStringList(saved.extraTags) ? [...new Set(saved.extraTags)] : [...defaultConfig.extraTags],
    friendIds: isStringList(saved.friendIds) ? [...new Set(saved.friendIds)] : [...defaultConfig.friendIds],
    groupIds: isStringList(saved.groupIds) ? [...new Set(saved.groupIds)] : [...defaultConfig.groupIds],
    schedule: typeof saved.schedule === "string" ? saved.schedule : defaultConfig.schedule,
    advanced: {
      requestTimeoutSeconds: boundedInteger(advanced.requestTimeoutSeconds, 1, 3600, defaultConfig.advanced.requestTimeoutSeconds),
      maxRetries: boundedInteger(advanced.maxRetries, 0, 10, defaultConfig.advanced.maxRetries),
      notifyOnFailure: typeof advanced.notifyOnFailure === "boolean" ? advanced.notifyOnFailure : defaultConfig.advanced.notifyOnFailure,
      note: typeof advanced.note === "string" ? advanced.note : defaultConfig.advanced.note,
    },
  }
}

// 保存前在服务端重复校验；前端控件限制不能替代服务端校验。
function validateConfig(data) {
  if (!isRecord(data)) return "配置数据无效"
  if (typeof data.enabled !== "boolean") return "启用状态无效"
  if (!Number.isSafeInteger(Number(data.intervalSeconds)) || Number(data.intervalSeconds) < 5 || Number(data.intervalSeconds) > 3600) return "运行间隔必须是 5 到 3600 秒之间的整数"
  if (typeof data.serviceUrl !== "string" || data.serviceUrl.length > 2048) return "服务地址无效"
  if (typeof data.demoPassword !== "string" || data.demoPassword.length > 1024) return "密码框示例内容无效"
  if (typeof data.description !== "string" || data.description.length > 4000) return "说明文本不能超过 4000 个字符"
  if (!modeValues.includes(data.mode)) return "运行模式无效"
  if (!priorityValues.includes(data.priority)) return "优先级无效"
  if (!isStringList(data.preferredModes, modeValues)) return "多选运行模式无效"
  if (!isStringList(data.labels) || !isStringList(data.extraTags)) return "标签必须是字符串列表"
  if (!isStringList(data.features, featureValues)) return "功能选项无效"
  if (!isStringList(data.friendIds) || !isStringList(data.groupIds)) return "好友和群组 ID 必须是字符串列表"
  if (typeof data.schedule !== "string" || data.schedule.length > 120 || ![5, 6].includes(data.schedule.trim().split(/\s+/).length)) return "Cron 需要填写 5 段或 6 段表达式"
  if (!isRecord(data.advanced)) return "高级配置必须是对象"
  if (!Number.isSafeInteger(Number(data.advanced.requestTimeoutSeconds)) || Number(data.advanced.requestTimeoutSeconds) < 1 || Number(data.advanced.requestTimeoutSeconds) > 3600) return "请求超时必须是 1 到 3600 秒之间的整数"
  if (!Number.isSafeInteger(Number(data.advanced.maxRetries)) || Number(data.advanced.maxRetries) < 0 || Number(data.advanced.maxRetries) > 10) return "重试次数必须是 0 到 10 之间的整数"
  if (typeof data.advanced.notifyOnFailure !== "boolean") return "失败通知状态无效"
  if (typeof data.advanced.note !== "string" || data.advanced.note.length > 2000) return "高级说明不能超过 2000 个字符"
  return ""
}

// 配置文件尚不存在时返回默认值；JSON 格式错误会抛出，避免静默覆盖损坏配置。
async function readExampleConfig() {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath, "utf8")))
  } catch (error) {
    if (error.code === "ENOENT") return normalizeConfig(defaultConfig)
    throw error
  }
}

export function supportPanel() {
  return {
    pluginInfo: {
      name: "ExamplePlugin",
      title: "示例插件",
      description: "展示 EliaAdminPanel 原生配置入口和全部控件",
      author: "示例作者",
      link: "https://example.com",
      icon: "mdi:puzzle-outline",
      iconColor: "#6f78d8",
    },
    configInfo: {
      schemas: [
        // 每个 SOFT_GROUP_BEGIN 会开始一个独立的设置分组。
        { label: "基础设置", component: "SOFT_GROUP_BEGIN" },
        {
          field: "enabled",
          label: "启用插件",
          // Switch 的值是 boolean。
          component: "Switch",
        },
        {
          field: "intervalSeconds",
          label: "运行间隔（秒）",
          component: "InputNumber",
          required: true,
          // componentProps 会传给对应控件；InputNumber 输出 number。
          componentProps: { min: 5, max: 3600, step: 5, placeholder: "60" },
        },
        {
          field: "serviceUrl",
          label: "服务地址",
          // 未指定 component 时默认也是 Input；此处显式写出便于复制。
          component: "Input",
          componentProps: { placeholder: "https://example.com/api", autocomplete: "url" },
        },
        {
          field: "demoPassword",
          label: "密码框（仅演示）",
          component: "Input",
          // type=password 只负责遮挡输入；本示例仍将值写入普通 JSON，不能存真实密钥。
          bottomHelpMessage: "此示例会将输入写入普通 JSON 文件，只演示密码框外观，请勿填写真实密钥。",
          componentProps: { type: "password", autocomplete: "new-password", placeholder: "示例值" },
        },
        {
          field: "description",
          label: "说明文本",
          component: "InputTextArea",
          // rows 和 placeholder 等原生属性通过 componentProps 设置。
          componentProps: { rows: 4, placeholder: "可输入多行文本" },
        },
        {
          field: "mode",
          label: "运行模式（Select）",
          component: "Select",
          required: true,
          // 默认单选；options 可用字符串数组或 { label, value, disabled } 对象数组。
          componentProps: { options: modeOptions, allowClear: true },
        },
        {
          field: "priority",
          label: "优先级（RadioGroup）",
          component: "RadioGroup",
          // RadioGroup 返回单个 value。
          componentProps: { options: priorityOptions },
        },
        {
          field: "preferredModes",
          label: "多选运行模式",
          component: "Select",
          // mode=multiple 的 Select 返回 value 数组。
          componentProps: { mode: "multiple", options: modeOptions, allowClear: true },
        },
        {
          field: "labels",
          label: "标签（Select tags）",
          component: "Select",
          // mode=tags 允许新增 options 之外的自定义字符串。
          componentProps: { mode: "tags", options: [{ label: "日常", value: "daily" }, { label: "测试", value: "test" }], allowClear: true },
        },
        {
          field: "features",
          label: "功能选项（CheckboxGroup）",
          component: "CheckboxGroup",
          // CheckboxGroup 同样返回 value 数组。
          componentProps: { options: featureOptions, allowClear: true },
        },
        // EasyCron 在当前 Yunzai 运行时校验 5 段或 6 段表达式。
        { label: "定时与名单", component: "SOFT_GROUP_BEGIN" },
        {
          field: "schedule",
          label: "定时表达式",
          component: "EasyCron",
          bottomHelpMessage: "支持 5 段或 6 段格式，保存前会使用当前 Yunzai 运行时校验。",
        },
        {
          field: "extraTags",
          label: "自定义标签（GTags）",
          // GTags 编辑任意字符串列表，不需要预先提供 options。
          component: "GTags",
        },
        {
          field: "friendIds",
          label: "好友名单",
          // 选项取自当前机器人账号的好友缓存，配置值为好友 QQ 号数组。
          component: "GSelectFriend",
          bottomHelpMessage: "从当前机器人账号的好友缓存中选择；保存为 QQ 号字符串数组。",
        },
        {
          field: "groupIds",
          label: "群组名单",
          // 选项取自当前机器人账号的群缓存，配置值为群号数组。
          component: "GSelectGroup",
          bottomHelpMessage: "从当前机器人账号的群缓存中选择；保存为群号字符串数组。",
        },
        { label: "高级配置", component: "SOFT_GROUP_BEGIN" },
        {
          field: "advanced",
          label: "高级参数（GSubForm）",
          // GSubForm 根据 getConfigData 返回的对象字段递归生成子控件。
          component: "GSubForm",
        },
      ],
      async getConfigData() {
        // 返回对象的字段名必须与 schemas[].field 对应。
        return readExampleConfig()
      },
      async setConfigData(data, { Result }) {
        const error = validateConfig(data)
        if (error) return Result.error(error)

        const next = normalizeConfig(data)
        await mkdir(path.dirname(configPath), { recursive: true })
        await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
        return Result.ok({}, "示例配置已保存")
      },
      actions: {
        // 面板会在执行 action 前确认；args 是提交的 JSON 参数，本示例不调用外部服务。
        async preview(args, { Result }) {
          const message = isRecord(args) && typeof args.message === "string" ? args.message.slice(0, 200) : ""
          return Result.ok({ message }, "示例操作已完成，没有触发外部副作用")
        },
      },
    },
  }
}