// Keep historical fixture ordering and replay identity without relying on today's date.
// Only captured_at is shifted; production expiry logic and explicit expired rows are untouched.
const offset=Date.now()-Date.parse('2026-09-05T00:00:00Z');
export const recentCapture=iso=>new Date(Date.parse(iso)+offset).toISOString();
