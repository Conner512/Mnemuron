// Console routes shared by the server shell and the browser controller.
// Keep in step with the sidebar (render.mjs), the feature map (visuals.mjs) and the ingress routes.
// Navigation order (render.mjs): overview; memory; processing; connections; work; system. Slugs are kept where a page
// moved (jobs = processing capabilities, connections = ChatGPT, storage = health) so the public ingress needs no change.
export const pages=['overview','memories','summaries','jobs','connections','agents','tasks','models','storage','usage','audit','security'];
// Removed web pages (their backend, CLI and API stay): old links redirect to the overview.
export const removedPages=['privacy','invitations','accounts'];
// Pages whose content moved: old links redirect to the new home instead of the overview.
// entities: names and aliases were replaced by per-memory keywords (filter and map in the library and overview).
export const movedPages={system:'jobs',resume:'tasks',entities:'memories'};
export const pageCode=page=>`MN-${String(Math.max(0,pages.indexOf(page))+1).padStart(2,'0')}`;
