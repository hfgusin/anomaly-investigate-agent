const $ = id => document.getElementById(id);
function node(tag, text = "", cls = "") { const el = document.createElement(tag); el.textContent = text; el.className = cls; return el; }
function table(headers, rows) {
  const wrap = node("div", "", "auto-table-wrap"), t = node("table", "", "auto-table");
  const head = node("tr"); headers.forEach(h => head.append(node("th",h))); const thead = node("thead"); thead.append(head); t.append(thead);
  const body = node("tbody"); rows.forEach(row => { const tr = node("tr"); row.forEach(v => { const td = node("td"); if (v instanceof Node) td.append(v); else td.textContent = v ?? "—"; tr.append(td); }); body.append(tr); });
  if (!rows.length) { const tr=node("tr"),td=node("td","当前范围没有可展示的数据");td.colSpan=headers.length;tr.append(td);body.append(tr); }
  t.append(body);wrap.append(t);return wrap;
}
function section(title, children) { const el = node("section", "", "auto-section"); el.append(node("h2",title),...children); return el; }
function link(text, href) { const a=node("a",text); a.href=href;a.target="_blank";a.rel="noopener noreferrer";return a; }
function localTime(value) { return value ? new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}) : "采集时间未记录"; }
const labels={live:"接口查询结果（见采集时间）",snapshot:"已保存快照",unavailable:"未取得数据"};
export function setupAutomationDashboard(isVisible) {
  let data=null, sequence=0, timer=null;
  $("automation-date").value = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
  async function load() {
    const seq=++sequence,date=$("automation-date").value;
    $("automation-progress").textContent="读取中…";
    try {
      const r=await fetch(`/api/automation/view?date=${encodeURIComponent(date)}`);
      const result=await r.json(); if(!r.ok)throw new Error(result.error);
      if(seq!==sequence)return;
      data=result;
      const selected=$("automation-region").value;
      const options=new Set([...result.regions.map(r=>r.region),...((result.rules.data?.overview?.values??[]).slice(2).map(r=>r[0]).filter(Boolean))]);
      $("automation-region").replaceChildren(new Option("全部站点",""),...[...options].sort().map(s=>new Option(s,s)));
      $("automation-region").value=options.has(selected)?selected:"";
      render();
      const running=result.job?.status==="running";
      $("automation-progress").textContent=result.job ? `${result.job.phase} · ${result.job.date} · 开始于 ${localTime(result.job.started_at)}` : "已载入真实检查数据；点击刷新数据重新查询。";
      $("automation-refresh").disabled=running;
      if(result.job?.error) $("automation-progress").append(node("p",result.job.error,"auto-warning"));
      clearTimeout(timer);
      if(running && isVisible())timer=setTimeout(load,2500);
    } catch(e) { if(seq===sequence)$("automation-progress").textContent=`读取失败：${e.message}`; }
  }
  function render() {
    if(!data)return;
    const region=$("automation-region").value, filter=r=>!region||r.region===region;
    const stats=data.regions.filter(filter), totals={success:0,failed:0,not_executed:0,unknown:0};
    stats.forEach(r=>Object.keys(totals).forEach(k=>totals[k]+=r[k]??0));
    const cards=node("div","","auto-stats");
    for(const [key,title] of [["success","成功日志"],["failed","失败日志"],["not_executed","未执行日志"],["unknown","未知状态日志"]]) {
      const card=node("div","",`auto-stat ${key}`);card.append(node("span",title),node("strong",data.business.data?totals[key].toLocaleString():"—"));cards.append(card);
    }
    const sources=node("div","","auto-sources");
    for(const [key,title] of [["airflow","Airflow"],["rules","GSheet 规则"],["business","DI 业务日志"]]) {
      const source=data[key],block=node("div","","auto-source");block.append(node("strong",`${title} · ${labels[source.mode]??source.mode}`),node("p",localTime(source.observed_at)));
      if(source.error)block.append(node("p",source.error,"auto-warning"));sources.append(block);
    }
    const explanation=node("div","","auto-warning");data.caveats.forEach(c=>explanation.append(node("p",c)));
    const af=data.airflow.data,run=af?.run?.data??af?.run,task=af?.task?.data??af?.task;
    const airflow=section("运行状态（选定日期的 15:00 逻辑运行）",[
      node("p",run?`DAG：${run.state} · 任务：${task?.state??"未取得"} · 实际 ${localTime(run.start_date)} 至 ${localTime(run.end_date)}`:"该日期尚未取得运行数据。"),
      node("p",run?.dag_run_id??"", "auto-muted"),
      node("p",data.airflow.data?.log?.message??"完整 Airflow 任务日志尚未接入。","auto-muted"),link("打开 Airflow",data.sources.airflow)]);
    const overview=data.rules.data?.overview?.values??[],header=overview[1]??[],sheetDate=String(header[2]??"");
    const overviewRows=overview.slice(2).filter(r=>r[0]&&(!region||r[0]===region));
    const schedules=section("当天调度总览",[
      node("p",`Sheet 状态列日期：${sheetDate||"未知"}；${sheetDate===data.date?"与筛选日期相同":"与筛选日期不同，不用于判断该日是否执行"}。当前规则快照不能替代历史规则。`,"auto-muted"),
      table(["站点","计划时间（SGT）","Sheet 状态","规则页","实际业务时间","失败日志"],overviewRows.map(r=> {
        const actual=stats.find(x=>x.region===r[0]);
        const ruleName=r[4]??"未填写",available=Boolean(data.rules.data?.sheets?.[ruleName]);
        const ruleButton=available?node("button",ruleName):link(ruleName,data.sources.sheet);
        if(available)ruleButton.onclick=()=>{const target=document.getElementById(`auto-rule-${ruleName}`);if(target){target.open=true;target.scrollIntoView({behavior:"smooth"});}};
        return [r[0],r[1]??"未安排",sheetDate===data.date?r[2]??"未记录":"日期不匹配",ruleButton,actual?`${actual.first} → ${actual.last}`:"未查到",actual?.failed??"—"];
      })),link("打开规则工作簿",data.sources.sheet)]);
    const regionSection=section("站点执行汇总",[table(["站点","日志总数","成功","失败","未执行","未知"],stats.map(r=>[r.region,r.log_rows,r.success,r.failed,r.not_executed,r.unknown]))]);
    const groups=(data.business.data?.groups??[]).filter(filter);
    const actions=section("按操作和状态核对",[table(["站点","操作","计划状态","执行模式","实际状态","日志数"],groups.map(r=>[r.region,r.action_type,r.status,r.execution_mode,r.execution_status,r.log_rows]))]);
    const failures=(data.business.data?.details??[]).filter(filter).filter(r=>r.execution_status==="failed");
    const details=failures.map(r=> {
      const el=node("details","","auto-detail");el.append(node("summary",`${r.region} · ${r.date} · item ${r.item_id} · ${r.rule_type??r.action_type}`));
      for(const [key,label] of [["action_type","操作"],["campaign_id","广告 ID"],["execution_mode","执行模式"],["reason","命中原因"],["rule_conditions","执行时记录的规则条件"],["execution_result","接口结果"]])el.append(node("h3",label),node("pre",typeof r[key]==="string"?r[key]:JSON.stringify(r[key]??null,null,2)));
      el.append(node("p",`出处：${data.sources.table} · date=${r.date} · region=${r.region} · item_id=${r.item_id}；当前条件来自日志，规则页仅作对照。`,"auto-muted"));return el;
    });
    const failureSection=section("失败明细与证据",[node("p",`${data.business.data?.detail_scope??"尚未查询明细"}；当前展示 ${failures.length} 条。`,"auto-muted"),...details]);
    const ruleDetails=[];
    for(const [name,value] of Object.entries(data.rules.data?.sheets??{})) {
      if(region&&!name.startsWith(`${region} `))continue;
      const rows=value.values??[],el=node("details","","auto-detail");el.id=`auto-rule-${name}`;el.append(node("summary",`${name} · 规则片段 ${value.range??""}`));
      el.append(node("p","仅展示已读取的第 16–30 行；不是全表，也不是历史规则快照。","auto-muted"),table(rows[0]??[],rows.slice(1)));ruleDetails.push(el);
    }
    const provenance=section("查询出处",[node("p",data.sources.table),node("p",`DI session：${data.business.data?.session_id??"—"} · statements：${(data.business.data?.statement_ids??[]).join(", ")}`),node("pre",data.business.data?.where??`业务 date 在 ${data.date} 00:00:00 至次日 00:00:00（不含）`)]);
    if(data.job?.notice?.length)provenance.append(node("pre",JSON.stringify(data.job.notice,null,2)));
    $("automation-content").replaceChildren(sources,cards,explanation,airflow,schedules,regionSection,actions,failureSection,section("当前站点规则对照",ruleDetails),provenance);
  }
  $("automation-load").onclick=load;
  $("automation-region").onchange=render;
  $("automation-date").onchange=load;
  $("automation-refresh").onclick=async()=>{
    $("automation-refresh").disabled=true;$("automation-progress").textContent="提交刷新请求…";
    try{const r=await fetch(`/api/automation/refresh?date=${encodeURIComponent($("automation-date").value)}`,{method:"POST"});const result=await r.json();if(!r.ok)throw new Error(result.error);await load();}
    catch(e){$("automation-progress").textContent=e.message;$("automation-refresh").disabled=false;}
  };
  setInterval(()=>{if(isVisible()&&$("automation-poll").checked)void load();},60000);
  return {load:()=>{void loadDailyScan();return load();}};
}

function investigate(task) {
  $("input").value=`/daily-check 排查 automation 服务器的 ${task.dag_id}，运行 ID ${task.dag_run_id}，任务 ${task.task_id}，第 ${task.try_number} 次尝试。读取日志，定位本地代码和实际 Data API SQL，区分已确认事实与假设，最后留底。`;
  $("automation-toggle").click();
  $("input").focus();
}

function renderDailyScan(scan, busy=false) {
  const run=node("button",busy?"扫描中…":"立即扫描");run.disabled=busy;
  run.onclick=async()=>{renderDailyScan(scan,true);
    try{const r=await fetch("/api/daily-scan/run",{method:"POST"});renderDailyScan(r.ok?await r.json():scan);}catch{renderDailyScan(scan);}};
  if(!scan){$("daily-scan").replaceChildren(section("每日失败扫描",[node("p","还没有扫描记录；服务每天北京时间 9 点后自动扫描 D-5～D0。","auto-muted"),run]));return;}
  const head=node("p",`${scan.start_date} 至 ${scan.end_date}（北京时间）· 扫描于 ${localTime(scan.attempted_at)}`,"auto-muted");
  if(scan.status==="failed"){$("daily-scan").replaceChildren(section("每日失败扫描",[head,node("p",`扫描失败：${scan.error}`,"auto-warning"),run]));return;}
  const tasks=scan.result.failed_tasks??[];
  const rows=tasks.map(t=>{const button=node("button","排查");button.onclick=()=>investigate(t);
    return [t.dag_id,localTime(t.start_date),t.task_id,t.try_number,link("日志",t.url),button];});
  $("daily-scan").replaceChildren(section(`每日失败扫描 · ${tasks.length} 个失败任务`,[head,
    node("p",`${scan.result.owner} 名下 ${scan.result.owned_dags?.length??0} 个 DAG；重试后已成功的不算失败。`,"auto-muted"),
    table(["DAG","开始时间","任务","尝试","Airflow","操作"],rows),run]));
}

async function loadDailyScan() {
  try{const r=await fetch("/api/daily-scan");renderDailyScan(r.ok?await r.json():null);}catch{renderDailyScan(null);}
}
