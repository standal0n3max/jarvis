#!/usr/bin/env node
// Локальный MCP: запись траты в Google Sheets и чтение остатка недели.
// Секреты читает с диска и в stdout не пишет. stdout — только JSON-RPC.
import readline from "node:readline"
import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"

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

function serialToIso(serial) {
  const epoch = Date.UTC(1899, 11, 30)
  return new Date(epoch + serial * 86400000).toISOString().slice(0, 10)
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

serveStdio()
