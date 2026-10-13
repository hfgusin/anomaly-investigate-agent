export type ToolRisk = "read" | "network_read" | "write" | "execute" | "delegate" | "unknown";

type PythonToolPolicy = { risk: ToolRisk; label: string; autoApprove: boolean };
const pythonTools = new Map<string, PythonToolPolicy>();
export function registerPythonTool(name: string, policy: PythonToolPolicy) { pythonTools.set(name, policy); }

export function toolLabel(name: string): string | undefined { return pythonTools.get(name)?.label || undefined; }

export function isAutoApproved(name: string): boolean {
  const policy = pythonTools.get(name);
  return !!policy?.autoApprove && ["read", "network_read"].includes(policy.risk);
}

export function toolRisk(name: string): ToolRisk {
  const python = pythonTools.get(name);
  if (python) return python.risk;
  if (["read_file", "search_workspace", "list_workspace", "research_hotpot", "search_passages", "open_passage", "automation_report"].includes(name)) return "read";
  if (name === "delegate_task") return "delegate";
  if (["fetch_url", "di_export_table", "di_query_sql"].includes(name)) return "network_read";
  if (name === "write_file") return "write";
  if (name === "run_javascript") return "execute";
  return "unknown";
}

export function hasSideEffect(name: string): boolean {
  return ["write", "execute"].includes(toolRisk(name));
}
