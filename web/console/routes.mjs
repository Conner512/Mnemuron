// Console routes shared by the server shell and the browser controller.
// Keep in step with the sidebar (render.mjs), the feature map (visuals.mjs) and the ingress routes.
export const pages=['overview','memories','summaries','tasks','resume','jobs','connections','models','privacy','security','audit','storage','invitations','accounts','system'];
export const pageCode=page=>`MN-${String(Math.max(0,pages.indexOf(page))+1).padStart(2,'0')}`;
