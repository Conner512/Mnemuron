// Near-duplicate hints on save: after a memory is written, the caller is told which existing memories say much the
// same thing, so an assistant can supersede instead of piling up copies. Advisory only: the save already committed.
// Uses semantic search (one embedding call), because rewordings share few literal tokens. Calibrated on the synthetic
// set with the cosine embedder: the closest pair of distinct memories scored 0.84, reworded duplicates 0.95-0.99.
// Without a ready vector index only a body with the same search tokens (case and punctuation aside) is reported.

export const SIMILAR_SCORE = 0.9, DUPLICATE_SCORE = 0.95, MAX_SIMILAR = 3;

/** [{memory_id, similarity, relation: 'duplicate'|'similar'}], best first; [] when nothing qualifies or on any failure. */
export async function similarMemories(store, auth, memory) {
  if (!memory?.memory_id || !auth?.scopes?.includes('memory:read')) return [];
  try {
    const result = await store.searchMemories(auth, { query: memory.content.slice(0, 2000), mode: 'semantic', limit: MAX_SIMILAR + 1 });
    const retrieval = result.retrieval || {};
    if (!retrieval.degraded && retrieval.effective_mode !== 'lexical') {
      return result.results
        .filter(r => r.memory_id !== memory.memory_id && Number(r.ranking?.semantic_score) >= SIMILAR_SCORE)
        .slice(0, MAX_SIMILAR)
        .map(r => ({ memory_id: r.memory_id, similarity: Number(Number(r.ranking.semantic_score).toFixed(3)),
          relation: r.ranking.semantic_score >= DUPLICATE_SCORE ? 'duplicate' : 'similar' }));
    }
  } catch { /* fall through to the exact check */ }
  try {
    // Same owner and visibility as a read, and never a memory of a deleted project (the semantic path gets this from search).
    return store.db.prepare(`SELECT memory_id, project_id FROM memories WHERE user_id=? AND status='active' AND memory_id<>?
        AND length(content) BETWEEN ? AND ? AND memory_search_tokens(content)=memory_search_tokens(?) LIMIT ?`)
      .all(auth.user_id, memory.memory_id, Math.floor(memory.content.length / 2), memory.content.length * 2, memory.content, MAX_SIMILAR)
      .filter(row => store.webVisibility.visible(auth, row.memory_id) && store.lifecycle.projectState(auth.user_id, row.project_id) !== 'deleted')
      .map(row => ({ memory_id: row.memory_id, similarity: 1, relation: 'duplicate' }));
  } catch { return []; }
}
