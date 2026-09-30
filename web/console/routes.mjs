// Console routes shared by the server shell and the browser controller.
export const pages=['overview','memories','summaries','jobs','connections','models','security','audit','storage','invitations','accounts'];
export const pageCode=page=>`MN-${String(Math.max(0,pages.indexOf(page))+1).padStart(2,'0')}`;
