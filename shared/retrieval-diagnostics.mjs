// Public, fixed retrieval reasons. Provider messages, endpoints and credentials never cross this boundary.
export const RETRIEVAL_DEGRADATIONS=Object.freeze([
  'EGRESS_DENIED','BUDGET_EXHAUSTED','VECTOR_NOT_READY','VECTOR_DISABLED','VECTOR_STALE',
  'VECTOR_FILTER_TOO_BROAD','VECTOR_SCOPE_TOO_BROAD','RELEVANCE_NOT_CONFIGURED','AUTH_FAILED',
  'NOT_CONFIGURED','VECTOR_UNAVAILABLE','VECTOR_AUTH_FAILED','VECTOR_COLLECTION_MISSING','VECTOR_PROFILE_MISMATCH',
]);
export const isRetrievalDegradation=code=>RETRIEVAL_DEGRADATIONS.includes(code);
export const isRetrievalQueryLimit=code=>code==='VECTOR_FILTER_TOO_BROAD'||code==='VECTOR_SCOPE_TOO_BROAD';
