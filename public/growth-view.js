function node(tag, text = "") { const n = document.createElement(tag); n.textContent = text; return n; }

export function renderGrowthTopic(target, topic, ask) {
  target.replaceChildren();
  target.append(node("h2", topic.name), node("p", "选择下面的问题填入输入框，或直接用中文提问。查询需要审批；字段以实时 Spark schema 为准。"));
  const source = node("a", `主题来源 · 字段核对 ${topic.verifiedAt}`);
  source.href = topic.source; source.target = "_blank"; source.rel = "noopener noreferrer";
  target.append(source);
  const examples = node("div"); examples.className = "growth-examples";
  for (const question of topic.examples) { const button = node("button", question); button.onclick = () => ask(question); examples.append(button); }
  target.append(examples);
  const rules = node("details"); rules.append(node("summary", "指标口径与注意事项"));
  for (const rule of topic.rules) rules.append(node("p", rule));
  target.append(rules);
  const catalog = node("details"); catalog.append(node("summary", `数据表路由（${topic.tables.length} 张表）`));
  for (const table of topic.tables) {
    const entry = node("details"); entry.append(node("summary", table.label), node("code", table.name),
      node("p", table.purpose), node("p", `粒度：${table.grain}`),
      node("p", `日期列：${table.dateColumn} · 站点列：${table.siteColumn}`)); catalog.append(entry);
  }
  target.append(catalog);
}

export function renderDIResult(artifact) {
  const section = node("details"); section.className = "growth-result"; section.open = true;
  const rows = artifact.preview_rows;
  const sqlRead = artifact.result_kind === "sql";
  section.append(node("summary", sqlRead ? `SQL 查询结果 · DI 返回 ${artifact.returned_rows} 行（非全量总数）`
    : `${artifact.result_kind === "aggregate" ? "聚合结果" : "数据明细"} · 共 ${artifact.row_count} 行`));
  if ((sqlRead ? artifact.returned_rows : artifact.row_count) === 0) section.append(node("p", sqlRead
    ? "查询成功，DI 返回零行；字段探查可以只返回 columns。" : "查询成功，没有匹配数据。"));
  if (sqlRead) section.append(node("p", "只读 SQL 预览，结果可能截断，不代表全量；此调用未生成 CSV。"));
  if (Array.isArray(rows)) {
    section.append(node("p", `预览 ${rows.length} 行${artifact.preview_truncated ? "（已截断，不是全部结果）" : ""}${artifact.preview_cells_truncated ? " · 部分单元格文本已截断" : ""}`));
    const scroll = node("div"); scroll.className = "growth-table-scroll";
    const table = node("table"); const head = node("thead"), tr = node("tr");
    for (const column of artifact.columns ?? []) tr.append(node("th", column)); head.append(tr); table.append(head);
    const body = node("tbody");
    for (const values of rows) { const row = node("tr"); for (const value of values) row.append(node("td", value === null ? "空值" : typeof value === "object" ? JSON.stringify(value) : String(value))); body.append(row); }
    table.append(body); scroll.append(table); section.append(scroll);
  } else section.append(node("p", "历史导出无数据预览，请下载 CSV。"));
  const evidence = node("details"); evidence.append(node("summary", "查询依据 / SQL"), node("p", sqlRead
    ? `Session：${artifact.session_id} · Statement：${artifact.statement_id}`
    : `查询编号：${artifact.query_id} · 最新日期：${artifact.latest_day ?? "见筛选条件"}`), node("pre", artifact.sql ?? ""));
  section.append(evidence);
  return section;
}
