import assert from "node:assert/strict"
import test from "node:test"
import { queryDailyTable, serialToIso, summarizeDaily, tableFromGrid } from "./sheets-mcp.mjs"

const DATE = (Date.UTC(2026, 9, 12) - Date.UTC(1899, 11, 30)) / 86400000

function sampleGrid() {
  return [
    ["Месяц", "Неделя", "Дата", "Трата", "Сумма", "Категория", "Тип трат"],
    [10, 42, DATE, "Cursor", 2500, "софт", "Другое"],
    [10, 42, DATE + 4, "кофе", 290, "кофе", "Еда"],
    [10, 42, DATE + 5, "аптека", 640, "аптека", "Другое"],
  ]
}

test("дата из серийного номера и фильтр по типу", () => {
  const table = tableFromGrid(sampleGrid())
  assert.equal(serialToIso(DATE), "2026-10-12")
  const queried = queryDailyTable(table, { type: "другое" })
  assert.equal(queried.matched, 2)
  assert.equal(queried.rows[0].Дата, "2026-10-12")
  assert.equal(queried.rows[0]["Тип трат"], "Другое")
  assert.equal(queried.rows[1].Трата, "аптека")
  assert.equal(queried.truncated, false)
})

test("сводка по категории внутри типа и обрезка выборки", () => {
  const table = tableFromGrid(sampleGrid())
  const summary = summarizeDaily(table, { group_by: "category", type: "Другое" })
  assert.deepEqual(summary.groups, [
    { key: "софт", sum: 2500, count: 1 },
    { key: "аптека", sum: 640, count: 1 },
  ])
  assert.deepEqual(summary.total, { sum: 3140, count: 2 })
  const queried = queryDailyTable(table, { limit: 1 })
  assert.equal(queried.returned, 1)
  assert.equal(queried.matched, 3)
  assert.equal(queried.truncated, true)
})

test("заголовок со второй строки и фильтр по имени колонки", () => {
  const table = tableFromGrid([
    ["Бюджет"],
    ["Дата", "Сумма", "Группа"],
    ["2026-10-01", "1 200 ₽", "Другое"],
    ["2026-10-02", 300, "Еда"],
  ])
  assert.equal(table.records[0].record.row, 3)
  assert.equal(table.records[0].fields.amount, 1200)
  const queried = queryDailyTable(table, { column: "группа", equals: "Другое", date_from: "2026-10-01", date_to: "2026-10-01" })
  assert.equal(queried.matched, 1)
  assert.equal(queried.rows[0].Группа, "Другое")
})

test("нет колонки типа — ошибка со списком заголовков", () => {
  const table = tableFromGrid([["Дата", "Сумма"], ["2026-10-01", 10]])
  assert.throws(() => queryDailyTable(table, { type: "Другое" }), /Заголовки: Дата, Сумма/)
})
