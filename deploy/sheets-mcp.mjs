#!/usr/bin/env node
// Локальный MCP: запись траты в Google Sheets, чтение журнала Daily и остатка недели.
// Секреты читает с диска и в stdout не пишет. stdout — только JSON-RPC.
import readline from "node:readline"
import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const KEY_FILE = "/home/openclaw/.openclaw/google-sheets.json"
const ENV_FILE = "/home/openclaw/.openclaw/google-sheets.env"
const SCOPE = "https://www.googleapis.com/auth/spreadsheets"
const MONTHS = new Set([
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
])
const DAILY_RANGE = "Daily!A1:Z5001"
const DAILY_DATA_CAP = 5000
const QUERY_LIMIT = 200
const FIELD_LABELS = {
  date: "дата",
  category: "категория",
  type: "тип",
  amount: "сумма",
  item: "трата",
  month: "месяц",
  week: "неделя",
}
const FIELD_ALIASES = {
  date: ["дата", "date"],
  category: ["категория", "category"],
  type: ["тип", "type"],
  amount: ["сумма", "цена", "price", "amount", "стоимость"],
  item: ["трата", "название", "имя", "item", "описание"],
  month: ["месяц", "month"],
  week: ["неделя", "week"],
}
const FIELD_ORDER = ["date", "category", "type", "amount", "item", "month", "week"]
const GROUP_FIELDS = new Set(["category", "type", "month", "week"])

function readEnvFile(path) {
  const values = {}
  const text = readFileSync(path, "utf8")
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue
    }
    const eq = line.indexOf("=")
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
    values[key] = value
  }
  return values
}

function spreadsheetId() {
  const env = readEnvFile(ENV_FILE)
  if (!env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    throw new Error("в google-sheets.env нет GOOGLE_SHEETS_SPREADSHEET_ID")
  }
  return env.GOOGLE_SHEETS_SPREADSHEET_ID
}

function serviceAccount() {
  const parsed = JSON.parse(readFileSync(KEY_FILE, "utf8"))
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("в google-sheets.json нет ключа сервисного аккаунта")
  }
  return parsed
}

function base64url(value) {
  return Buffer.from(value).toString("base64url")
}

async function accessToken() {
  const account = serviceAccount()
  const issued = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: issued,
    exp: issued + 3600,
  }))
  const unsigned = `${header}.${claim}`
  const signer = createSign("RSA-SHA256")
  signer.update(unsigned)
  const assertion = `${unsigned}.${signer.sign(account.private_key, "base64url")}`
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  const payload = await response.json()
  if (!response.ok || !payload.access_token) {
    const reason = payload.error || response.status
    throw new Error(`не удалось получить токен: ${reason}`)
  }
  return payload.access_token
}

async function sheetsFetch(path, options = {}) {
  const token = await accessToken()
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId()}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const reason = payload.error?.message || response.status
    throw new Error(String(reason))
  }
  return payload
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("date нужен в виде YYYY-MM-DD")
  }
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("такой даты нет")
  }
  return { year, month, day, iso: value }
}

function weekNumber(isoDate) {
  const { year, month, day } = parseDate(isoDate)
  const date = new Date(Date.UTC(year, month - 1, day))
  const january = new Date(Date.UTC(year, 0, 1))
  const januaryDay = january.getUTCDay()
  const daysFromMonday = januaryDay === 0 ? 6 : januaryDay - 1
  const weekStart = new Date(january.getTime() - daysFromMonday * 86400000)
  const diff = Math.floor((date.getTime() - weekStart.getTime()) / 86400000)
  return Math.floor(diff / 7) + 1
}

async function categoryNames() {
  const listed = await sheetsFetch("/values/Monthly!A2:A120?valueRenderOption=FORMATTED_VALUE")
  const names = []
  for (const row of listed.values || []) {
    const name = String(row[0] || "").trim()
    if (!name || MONTHS.has(name) || names.includes(name)) {
      continue
    }
    names.push(name)
  }
  if (names.length === 0) {
    throw new Error("на Monthly нет имён категорий")
  }
  return names
}

async function appendExpense(args) {
  const date = parseDate(args.date)
  const item = typeof args.item === "string" ? args.item.trim() : ""
  if (!item) {
    throw new Error("не названа трата")
  }
  const price = typeof args.price === "number" ? args.price : Number(args.price)
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("сумма должна быть числом больше нуля")
  }
  const category = typeof args.category === "string" ? args.category.trim() : ""
  const allowed = await categoryNames()
  if (!allowed.includes(category)) {
    throw new Error(`категория должна быть одной из: ${allowed.join(", ")}`)
  }
  const month = date.month
  const week = weekNumber(date.iso)
  const appended = await sheetsFetch(
    `/values/${encodeURIComponent("Daily!A:F")}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE&includeValuesInResponse=true&responseValueRenderOption=UNFORMATTED_VALUE`,
    {
      method: "POST",
      body: JSON.stringify({
        majorDimension: "ROWS",
        values: [[month, week, date.iso, item, price, category]],
      }),
    },
  )
  return {
    month,
    week,
    date: date.iso,
    item,
    price,
    category,
    updatedRange: appended.updates?.updatedRange || "",
  }
}

export function serialToIso(serial) {
  const epoch = Date.UTC(1899, 11, 30)
  return new Date(epoch + serial * 86400000).toISOString().slice(0, 10)
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ")
}

function sameText(left, right) {
  return String(left).trim().localeCompare(String(right).trim(), "ru", { sensitivity: "accent" }) === 0
}

function headerMatches(header, alias) {
  const name = normalizeHeader(header)
  return name === alias || name.startsWith(`${alias} `) || name.startsWith(`${alias},`) || name.startsWith(`${alias}:`)
}

function fieldForHeader(header) {
  for (const field of FIELD_ORDER) {
    if (FIELD_ALIASES[field].some((alias) => headerMatches(header, alias))) {
      return field
    }
  }
  return null
}

function columnLetter(index) {
  let number = index + 1
  let letters = ""
  while (number > 0) {
    const remainder = (number - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    number = Math.floor((number - 1) / 26)
  }
  return letters
}

export function cellDateIso(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return serialToIso(value)
  }
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10)
  }
  const dotted = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!dotted) {
    return null
  }
  return `${dotted[3]}-${dotted[2]}-${dotted[1]}`
}

function cellAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== "string") {
    return null
  }
  const cleaned = value.replace(/\s/g, "").replace("₽", "").replace(",", ".")
  if (!cleaned) {
    return null
  }
  const number = Number(cleaned)
  return Number.isFinite(number) ? number : null
}

function displayValue(field, value) {
  if (value === undefined || value === null || value === "") {
    return null
  }
  if (field === "date") {
    return cellDateIso(value)
  }
  if (field === "amount") {
    return cellAmount(value)
  }
  return value
}

function looksLikeHeader(row) {
  return (row || []).some((cell) => fieldForHeader(cell) !== null)
}

export function tableFromGrid(grid) {
  const rows = grid || []
  let headerIndex = 0
  if (!looksLikeHeader(rows[0]) && looksLikeHeader(rows[1])) {
    headerIndex = 1
  }
  const headerRow = rows[headerIndex] || []
  const width = rows.reduce((max, row) => Math.max(max, (row || []).length), 0)
  const columns = []
  const usedFields = new Set()
  for (let index = 0; index < width; index += 1) {
    const raw = String(headerRow[index] || "").trim()
    const header = raw || columnLetter(index)
    let field = fieldForHeader(raw)
    if (field && usedFields.has(field)) {
      field = null
    }
    if (field) {
      usedFields.add(field)
    }
    columns.push({ header, field })
  }
  const records = []
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const source = rows[index] || []
    if (source.every((cell) => cell === undefined || cell === null || String(cell).trim() === "")) {
      continue
    }
    const record = { row: index + 1 }
    const fields = {}
    for (let column = 0; column < columns.length; column += 1) {
      const shown = displayValue(columns[column].field, source[column])
      if (shown === null) {
        continue
      }
      record[columns[column].header] = shown
      if (columns[column].field) {
        fields[columns[column].field] = shown
      }
    }
    records.push({ record, fields })
  }
  return {
    columns,
    headers: columns.map((column) => column.header),
    records,
    rangeCapped: rows.length >= DAILY_DATA_CAP + 1,
  }
}

function optionalText(args, key) {
  if (args[key] === undefined || args[key] === null || args[key] === "") {
    return null
  }
  if (typeof args[key] !== "string") {
    throw new Error(`${key} должен быть строкой`)
  }
  const value = args[key].trim()
  return value || null
}

function columnByHeader(table, name) {
  return table.columns.find((column) => sameText(column.header, name)) || null
}

function requireMappedField(table, field) {
  if (table.columns.some((column) => column.field === field)) {
    return
  }
  const label = FIELD_LABELS[field]
  throw new Error(`на Daily нет колонки «${label}». Заголовки: ${table.headers.join(", ")}`)
}

export function filterDailyRecords(table, args) {
  const dateFrom = optionalText(args, "date_from")
  const dateTo = optionalText(args, "date_to")
  if (dateFrom) {
    parseDate(dateFrom)
  }
  if (dateTo) {
    parseDate(dateTo)
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error("date_from позже date_to")
  }
  const category = optionalText(args, "category")
  const type = optionalText(args, "type")
  const columnName = optionalText(args, "column")
  const equals = optionalText(args, "equals")
  if (columnName && !equals) {
    throw new Error("вместе с column нужен equals")
  }
  if (equals && !columnName) {
    throw new Error("вместе с equals нужен column")
  }
  if (dateFrom || dateTo) {
    requireMappedField(table, "date")
  }
  if (category) {
    requireMappedField(table, "category")
  }
  if (type) {
    requireMappedField(table, "type")
  }
  const column = columnName ? columnByHeader(table, columnName) : null
  if (columnName && !column) {
    throw new Error(`на Daily нет колонки «${columnName}». Заголовки: ${table.headers.join(", ")}`)
  }
  return table.records.filter((entry) => {
    const date = entry.fields.date || null
    if (dateFrom && (!date || date < dateFrom)) {
      return false
    }
    if (dateTo && (!date || date > dateTo)) {
      return false
    }
    if (category && !sameText(entry.fields.category || "", category)) {
      return false
    }
    if (type && !sameText(entry.fields.type || "", type)) {
      return false
    }
    if (column) {
      const value = entry.record[column.header]
      if (value === undefined || !sameText(value, equals)) {
        return false
      }
    }
    return true
  })
}

function groupValue(entry, groupBy, column) {
  if (column) {
    const value = entry.record[column.header]
    if (value === undefined || value === null || String(value).trim() === "") {
      return "(пусто)"
    }
    return String(value)
  }
  const value = entry.fields[groupBy]
  if (value === undefined || value === null || String(value).trim() === "") {
    return "(пусто)"
  }
  return String(value)
}

export function summarizeDaily(table, args) {
  const groupBy = optionalText(args, "group_by")
  if (!groupBy) {
    throw new Error("нужен group_by: category, type, month, week или заголовок колонки")
  }
  let column = null
  if (!GROUP_FIELDS.has(groupBy)) {
    column = columnByHeader(table, groupBy)
    if (!column) {
      throw new Error(`group_by должен быть category, type, month, week или заголовком колонки. Заголовки: ${table.headers.join(", ")}`)
    }
  } else {
    requireMappedField(table, groupBy)
  }
  const matched = filterDailyRecords(table, args)
  const groups = new Map()
  let skippedAmount = 0
  for (const entry of matched) {
    const key = groupValue(entry, groupBy, column)
    const current = groups.get(key) || { key, sum: 0, count: 0 }
    current.count += 1
    const amount = entry.fields.amount
    if (typeof amount === "number") {
      current.sum += amount
    } else {
      skippedAmount += 1
    }
    groups.set(key, current)
  }
  const listed = [...groups.values()].sort((left, right) => right.sum - left.sum || left.key.localeCompare(right.key, "ru"))
  const total = listed.reduce((sum, group) => sum + group.sum, 0)
  return {
    group_by: groupBy,
    groups: listed.map((group) => ({ key: group.key, sum: group.sum, count: group.count })),
    total: { sum: total, count: matched.length },
    skipped_amount: skippedAmount,
    range_capped: table.rangeCapped,
    columns: table.columns,
  }
}

function spreadsheetUrl() {
  const id = spreadsheetId()
  return { url: `https://docs.google.com/spreadsheets/d/${id}` }
}

async function loadDaily() {
  const listed = await sheetsFetch(
    `/values/${encodeURIComponent(DAILY_RANGE)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
  )
  return tableFromGrid(listed.values || [])
}

export function queryDailyTable(table, args) {
  const matched = filterDailyRecords(table, args)
  let limit = QUERY_LIMIT
  if (args.limit !== undefined && args.limit !== null && args.limit !== "") {
    const parsed = typeof args.limit === "number" ? args.limit : Number(args.limit)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > QUERY_LIMIT) {
      throw new Error(`limit — целое число от 1 до ${QUERY_LIMIT}`)
    }
    limit = parsed
  }
  return {
    columns: table.columns,
    rows: matched.slice(0, limit).map((entry) => entry.record),
    matched: matched.length,
    returned: Math.min(matched.length, limit),
    truncated: matched.length > limit,
    range_capped: table.rangeCapped,
  }
}

async function queryDaily(args) {
  return queryDailyTable(await loadDaily(), args)
}

async function summaryDaily(args) {
  return summarizeDaily(await loadDaily(), args)
}

async function weekLeft() {
  const listed = await sheetsFetch("/values/Notify!A1:D2?valueRenderOption=UNFORMATTED_VALUE")
  const row = listed.values?.[1] || []
  const day = typeof row[1] === "number" ? serialToIso(row[1]) : null
  const week = typeof row[2] === "number" ? row[2] : null
  const money = typeof row[3] === "number" && Number.isFinite(row[3]) ? row[3] : null
  return {
    day,
    week,
    money,
    empty: money === null,
  }
}

const tools = [
  {
    name: "sheets_append_expense",
    description:
      "Добавляет одну трату строкой на лист Daily. Месяц и неделя считаются сами, как WEEKNUM с понедельника. Нал и карта в таблицу не пишутся. Категория — имя с листа Monthly, буква в букву.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Дата траты, YYYY-MM-DD" },
        item: { type: "string", description: "Краткое имя траты" },
        price: { type: "number", description: "Сумма в рублях" },
        category: { type: "string", description: "Имя категории с листа Monthly" },
      },
      required: ["date", "item", "price", "category"],
    },
  },
  {
    name: "sheets_week_left",
    description:
      "Читает остаток денег на текущую неделю из Notify. Если ячейка пустая, money будет null: число выдумывать нельзя.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "sheets_spreadsheet_url",
    description:
      "Возвращает ссылку на таблицу бюджета. Адрес брать только отсюда, в vault его нет.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "sheets_query_daily",
    description:
      "Читает строки листа Daily. Фильтры необязательны: date_from и date_to в виде YYYY-MM-DD, category и type — текст заголовков «категория» и «тип». column и equals фильтруют любую колонку по точному значению. В ответе не больше 200 строк. Если truncated=true, выборка обрезана. Суммы, которых нет в ответе, не выдумывать.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Начало периода, YYYY-MM-DD" },
        date_to: { type: "string", description: "Конец периода, YYYY-MM-DD" },
        category: { type: "string", description: "Категория, как в колонке" },
        type: { type: "string", description: "Тип траты, как в колонке" },
        column: { type: "string", description: "Заголовок любой колонки Daily" },
        equals: { type: "string", description: "Точное значение этой колонки" },
        limit: { type: "integer", description: "Сколько строк вернуть, от 1 до 200" },
      },
    },
  },
  {
    name: "sheets_summary_daily",
    description:
      "Суммы и число строк Daily. group_by: category, type, month, week или точный заголовок колонки. Те же фильтры, что у sheets_query_daily. Если skipped_amount больше нуля, часть строк без числа в сумме. Число, которого в ответе нет, не выдумывать.",
    inputSchema: {
      type: "object",
      properties: {
        group_by: { type: "string", description: "category, type, month, week или заголовок колонки" },
        date_from: { type: "string", description: "Начало периода, YYYY-MM-DD" },
        date_to: { type: "string", description: "Конец периода, YYYY-MM-DD" },
        category: { type: "string", description: "Категория, как в колонке" },
        type: { type: "string", description: "Тип траты, как в колонке" },
        column: { type: "string", description: "Заголовок любой колонки Daily" },
        equals: { type: "string", description: "Точное значение этой колонки" },
      },
      required: ["group_by"],
    },
  },
]

function toolResult(payload, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError,
  }
}

async function callTool(name, args) {
  if (name === "sheets_append_expense") {
    return toolResult(await appendExpense(args), false)
  }
  if (name === "sheets_week_left") {
    return toolResult(await weekLeft(), false)
  }
  if (name === "sheets_spreadsheet_url") {
    return toolResult(spreadsheetUrl(), false)
  }
  if (name === "sheets_query_daily") {
    return toolResult(await queryDaily(args), false)
  }
  if (name === "sheets_summary_daily") {
    return toolResult(await summaryDaily(args), false)
  }
  return toolResult({ error: `неизвестный инструмент ${name}` }, true)
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleMessage(message) {
  if (!message.method || message.id === undefined) {
    return
  }
  if (message.method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sheets", version: "1.0.0" },
      },
    })
    return
  }
  if (message.method === "tools/list") {
    reply({ jsonrpc: "2.0", id: message.id, result: { tools } })
    return
  }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments || {})
      reply({ jsonrpc: "2.0", id: message.id, result })
    } catch (error) {
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: toolResult({ error: error instanceof Error ? error.message : "ошибка" }, true),
      })
    }
    return
  }
  if (message.method === "ping") {
    reply({ jsonrpc: "2.0", id: message.id, result: {} })
    return
  }
  reply({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "method not found" },
  })
}

function serveStdio() {
  let pending = 0
  let stdinClosed = false
  const finishIfIdle = () => {
    if (stdinClosed && pending === 0) {
      process.exit(0)
    }
  }
  const lines = readline.createInterface({ input: process.stdin })
  lines.on("line", (line) => {
    if (!line.trim()) {
      return
    }
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    pending += 1
    void handleMessage(message).finally(() => {
      pending -= 1
      finishIfIdle()
    })
  })
  lines.on("close", () => {
    stdinClosed = true
    finishIfIdle()
  })
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  return import.meta.url === pathToFileURL(entry).href
}

if (isDirectRun()) {
  serveStdio()
}
