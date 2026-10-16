#!/usr/bin/env node
// Локальный MCP: обычный Google Calendar API v3 для личного Gmail.
// Секреты читает с диска и в stdout не пишет. stdout — только JSON-RPC.
import http from "node:http"
import readline from "node:readline"
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync, chmodSync } from "node:fs"

const CLIENT_ENV = "/home/openclaw/.openclaw/google-calendar.env"
const TOKEN_FILE = "/home/openclaw/.openclaw/calendar-v3.json"
const REDIRECT_URI = "http://127.0.0.1:8989/oauth/callback"
const SCOPE = "https://www.googleapis.com/auth/calendar"
const TIME_ZONE = "Europe/Moscow"

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

function clientCredentials() {
  const env = readEnvFile(CLIENT_ENV)
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error("в google-calendar.env нет client id или secret")
  }
  return { clientId, clientSecret }
}

function readRefreshToken() {
  const parsed = JSON.parse(readFileSync(TOKEN_FILE, "utf8"))
  if (!parsed.refresh_token) {
    throw new Error("в calendar-v3.json нет refresh_token")
  }
  return parsed.refresh_token
}

async function refreshAccessToken() {
  const { clientId, clientSecret } = clientCredentials()
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: readRefreshToken(),
    grant_type: "refresh_token",
  })
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  const payload = await response.json()
  if (!response.ok || !payload.access_token) {
    const reason = payload.error || response.status
    throw new Error(`не удалось обновить токен: ${reason}`)
  }
  return payload.access_token
}

function pad(value) {
  return String(value).padStart(2, "0")
}

function formatLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function parseStart(start) {
  const date = new Date(start)
  if (Number.isNaN(date.getTime())) {
    throw new Error("start должен быть датой и временем, например 2026-10-18T15:00:00")
  }
  return date
}

async function calendarFetch(path, options) {
  const accessToken = await refreshAccessToken()
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  })
  const payload = await response.json()
  if (!response.ok) {
    const reason = payload.error?.message || response.status
    throw new Error(String(reason))
  }
  return payload
}

async function createEvent(args) {
  if (!args.start) {
    throw new Error("не назван час начала")
  }
  const startDate = parseStart(args.start)
  const endDate = args.end ? parseStart(args.end) : new Date(startDate.getTime() + 60 * 60 * 1000)
  const timeZone = args.timeZone || TIME_ZONE
  const created = await calendarFetch("/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary: args.summary || "Встреча",
      description: args.description || undefined,
      start: { dateTime: formatLocal(startDate), timeZone },
      end: { dateTime: formatLocal(endDate), timeZone },
    }),
  })
  return {
    id: created.id,
    summary: created.summary,
    start: created.start,
    end: created.end,
    htmlLink: created.htmlLink,
  }
}

async function listEvents(args) {
  const now = new Date()
  const timeMin = args.timeMin || formatLocal(now)
  const timeMax = args.timeMax || formatLocal(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000))
  const params = new URLSearchParams({
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "10",
    timeZone: TIME_ZONE,
  })
  const listed = await calendarFetch(`/calendars/primary/events?${params}`, { method: "GET" })
  return (listed.items || []).map((item) => ({
    id: item.id,
    summary: item.summary,
    start: item.start,
    end: item.end,
    htmlLink: item.htmlLink,
  }))
}

const tools = [
  {
    name: "calendar_create_event",
    description:
      "Создаёт событие в личном Google Calendar через Calendar API v3. Вызывать только если назван час. Часовой пояс Europe/Moscow. Если конец не назван, длительность 1 час. Файл в tasks/ не создавать.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Название. Если не названо — «Встреча»." },
        start: { type: "string", description: "Начало, например 2026-10-18T15:00:00" },
        end: { type: "string", description: "Конец. Пусто — через час после начала." },
        description: { type: "string" },
        timeZone: { type: "string", description: "По умолчанию Europe/Moscow" },
      },
      required: ["start"],
    },
  },
  {
    name: "calendar_list_events",
    description: "Список событий личного Google Calendar. Время по Europe/Moscow.",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string" },
        timeMax: { type: "string" },
      },
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
  if (name === "calendar_create_event") {
    return toolResult(await createEvent(args), false)
  }
  if (name === "calendar_list_events") {
    return toolResult(await listEvents(args), false)
  }
  return toolResult({ error: `неизвестный инструмент ${name}` }, true)
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleMessage(message) {
  if (!message.method) {
    return
  }
  if (message.id === undefined) {
    return
  }
  if (message.method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "calendar-v3", version: "1.0.0" },
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
    void handleMessage(message)
  })
}

function login() {
  const { clientId, clientSecret } = clientCredentials()
  const state = randomBytes(16).toString("hex")
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", SCOPE)
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("state", state)
  process.stderr.write(`${url.toString()}\n`)

  const server = http.createServer((request, response) => {
    const incoming = new URL(request.url || "/", REDIRECT_URI)
    if (incoming.pathname !== "/oauth/callback") {
      response.writeHead(404)
      response.end("not found")
      return
    }
    if (incoming.searchParams.get("state") !== state) {
      response.writeHead(400)
      response.end("state mismatch")
      return
    }
    const code = incoming.searchParams.get("code")
    if (!code) {
      response.writeHead(400)
      response.end("no code")
      return
    }
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    })
    fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    })
      .then(async (tokenResponse) => {
        const payload = await tokenResponse.json()
        if (!tokenResponse.ok || !payload.refresh_token) {
          response.writeHead(502)
          response.end("google did not return a refresh token")
          process.stderr.write(`token exchange failed: ${payload.error || tokenResponse.status}\n`)
          server.close()
          return
        }
        writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: payload.refresh_token }))
        chmodSync(TOKEN_FILE, 0o600)
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        response.end("calendar connected")
        process.stderr.write("refresh token saved\n")
        server.close()
      })
      .catch((error) => {
        response.writeHead(502)
        response.end("token exchange failed")
        process.stderr.write(`${error instanceof Error ? error.message : "exchange failed"}\n`)
        server.close()
      })
  })
  server.listen(8989, "127.0.0.1")
}

if (process.argv[2] === "login") {
  login()
} else {
  serveStdio()
}
