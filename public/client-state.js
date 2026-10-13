/** A history response can race a newer streaming event; never roll a run backwards. */
export function mergeRun(runs, incoming) {
  const previous = runs.get(incoming.id);
  if (!previous || incoming.version > previous.version) runs.set(incoming.id, incoming);
}

/** Select by both session and reset generation before rendering any output. */
export function visibleRuns(runs, session) {
  if (!session) return [];
  return [...runs.values()].filter((run) => run.sessionId === session.id && run.generation === session.generation)
    .sort((a, b) => a.position - b.position);
}
