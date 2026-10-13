function parse(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function taskView(run, events = [], attempts = []) {
  const checkpoint = parse(run.checkpoint, {});
  const calls = parse(run.toolTrace, []);
  const sources = new Map();
  const addSource = (title, sentences, hop = null) => {
    if (typeof title !== "string" || !Array.isArray(sentences)) return;
    const accepted = sentences.filter((item) => typeof item?.citation === "string" && typeof item?.text === "string");
    if (!accepted.length) return;
    if (sources.has(title)) return;
    sources.set(title, { title, hop, sentences: accepted, cited: accepted.filter((item) =>
      run.output.includes(`${item.citation}]`) || run.output.includes(`${item.citation},`)).length });
  };
  for (const call of Array.isArray(calls) ? calls : []) {
    if (call.status !== "completed" || typeof call.result !== "string") continue;
    const result = parse(call.result, {});
    if (result.status !== "ok") continue;
    if (call.name === "open_passage") addSource(result.title, result.sentences);
    if (call.name === "research_hotpot" && Array.isArray(result.evidence)) {
      for (const item of result.evidence) addSource(item.title, item.sentences, item.hop);
    }
  }
  return {
    checkpoint, calls: Array.isArray(calls) ? calls : [], sources: [...sources.values()],
    events: events.map((event) => ({ ...event, detail: parse(event.payload, {}) })),
    attempts, pendingApprovals: (Array.isArray(calls) ? calls : []).filter((call) => call.status === "requested"),
  };
}
