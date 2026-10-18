import assert from "node:assert/strict"
import test from "node:test"
import { queryMonthlyTable, summarizeMonthly, tableFromMonthlyGrid } from "./sheets-mcp.mjs"

function sectionGrid() {
  return [
    ["Категория", "План", "Факт", "Остаток"],
    ["2026"],
    ["Октябрь", 3000, 1790, 1210],
    ["Быт", 1000, 1200, -200],
    ["Еда", "2 000", 590, 1410],
    ["Ноябрь", 500, 0, 500],
    ["Транспорт", 500, 0, 500],
  ]
}

test("секция месяца не становится категорией и не удваивает сводку", () => {
  const table = tableFromMonthlyGrid(sectionGrid())
  const queried = queryMonthlyTable(table, { month: 10, kind: "category" })
  assert.equal(queried.matched, 2)
  assert.equal(queried.rows[0].category, "Быт")
  assert.equal(queried.rows[0].year, "2026")
  assert.equal(queried.rows[0].month, "Октябрь")
  assert.equal(queried.rows[1].plan, 2000)

  const monthRow = queryMonthlyTable(table, { month: "октябрь", kind: "month" })
  assert.equal(monthRow.matched, 1)
  assert.equal(monthRow.rows[0].plan, 3000)
  assert.equal(monthRow.rows[0].category, undefined)

  const summary = summarizeMonthly(table, { group_by: "category", month: "10" })
  assert.equal(summary.used_month_totals, false)
  assert.deepEqual(summary.total, { count: 2, plan: 3000, fact: 1790, delta: 1210, left: 1210 })
  assert.deepEqual(summary.groups[0], { key: "Быт", count: 1, plan: 1000, fact: 1200, delta: -200, left: -200 })
})

test("сводка по месяцам складывает только категории", () => {
  const summary = summarizeMonthly(tableFromMonthlyGrid(sectionGrid()), { group_by: "month" })
  assert.deepEqual(summary.groups.map((group) => ({ key: group.key, plan: group.plan, fact: group.fact })), [
    { key: "Октябрь", plan: 3000, fact: 1790 },
    { key: "Ноябрь", plan: 500, fact: 0 },
  ])
})

test("плоская таблица с колонкой месяца", () => {
  const table = tableFromMonthlyGrid([
    ["Месяц", "Категория", "План", "Факт"],
    ["Октябрь", "Быт", 100, 40],
    ["Ноябрь", "Быт", 80, 10],
  ])
  const summary = summarizeMonthly(table, { group_by: "month", category: "быт" })
  assert.deepEqual(summary.groups.map((group) => group.key), ["Октябрь", "Ноябрь"])
  assert.equal(summary.total.fact, 50)
  assert.equal(summary.total.delta, 130)
})

test("неизвестный месяц", () => {
  const table = tableFromMonthlyGrid([["Категория", "План"], ["Еда", 1]])
  assert.throws(() => queryMonthlyTable(table, { month: "весна" }), /month/)
})
