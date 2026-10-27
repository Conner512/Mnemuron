// Console routes shared by the server shell and the browser controller.
// Keep in step with the sidebar (render.mjs), the feature map (visuals.mjs) and the ingress routes.
// Navigation order (render.mjs): overview; memory; processing; connections; work; system. Page keys are internal (views,
// feature map, catalog); the URL of each page names what its title says (slugs), so /app/<slug> matches the page in both
// languages. The public ingress allows exactly the slugs, removed pages and moved pages.
export const pages=['overview','memories','summaries','jobs','connections','tasks','models','storage','audit','security'];
// Removed web pages (their backend, CLI and API stay): old links redirect to the overview.
export const removedPages=['privacy','invitations','accounts'];
// Pages whose content moved: old links redirect to the new home instead of the overview.
// entities: names and aliases were replaced by per-memory keywords (filter and map in the library and overview).
// agents: ChatGPT and coding assistants share one connections page.
// usage: call totals and the 14-day chart are on the models page, next to the call limits.
// jobs, storage, tasks: the pages' former URLs, from before each URL said what the page is.
export const movedPages={system:'processing',resume:'projects',entities:'memories',agents:'connections',usage:'models',jobs:'processing',storage:'health',tasks:'projects'};
// URL slug of each page where it differs from the internal key (Processing, Health, Projects & tasks).
export const slugs=Object.freeze({jobs:'processing',storage:'health',tasks:'projects'});
export const slugOf=page=>slugs[page]||page;
export const pagePath=page=>`/app/${slugOf(page)}`;
export const pageOfSlug=slug=>pages.find(p=>slugOf(p)===slug)??null;
export const pageCode=page=>`MN-${String(Math.max(0,pages.indexOf(page))+1).padStart(2,'0')}`;
