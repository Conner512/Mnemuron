import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {renderPage,sendPage,serveAsset} from '../../../web/console/render.mjs';
import {declarations,rules} from './helpers/css.mjs';
const read=name=>fs.readFileSync(new URL(`../../../web/console/${name}`,import.meta.url),'utf8');

test('Select presentation ships through existing assets and preserves strict CSP',()=>{
 const html=renderPage({title:'memories',page:'memories',account:{account_id:'synthetic-owner',username:'synthetic'}});
 assert.match(html,/<select id="locale"[^>]*disabled/);
 assert.doesNotMatch(html,/<select id="(?:theme|mode)"/);
 assert.doesNotMatch(html,/selects\.mjs|controls\.css|https?:\/\//);
 const result={writeHead(status,headers){this.headers=headers;},end(){}};
 sendPage(result,{title:'login',auth:true});
 assert.match(result.headers['content-security-policy'],/script-src 'self' 'sha256-[A-Za-z0-9+/]{43}=';/);
 assert.match(result.headers['content-security-policy'],/style-src 'self';/);
 assert.doesNotMatch(result.headers['content-security-policy'],/unsafe-inline|unsafe-eval/);
});
test('Select enhancement preserves a native form control and has a native fallback',()=>{
 const js=read('appearance.mjs');
 assert.match(js,/if\(!supportsPopover\)return/);
 assert.match(js,/shell\.append\(select,button,popup,error\)/);
 assert.match(js,/select\.dispatchEvent\(new Event\('input',\{bubbles:true\}\)\)/);
 assert.match(js,/select\.dispatchEvent\(new Event\('change',\{bubbles:true\}\)\)/);
 assert.match(js,/select\.addEventListener\('invalid'/);
 assert.match(js,/document\.addEventListener\('reset'/);
 assert.doesNotMatch(js,/select\.disabled\s*=\s*true|showPicker\(|\.innerHTML\s*=/);
});
test('Select popup state includes keyboard, top-layer positioning and cleanup',()=>{
 const js=read('appearance.mjs');
 for(const name of ['aria-controls','aria-expanded','aria-activedescendant','aria-selected','aria-disabled'])assert.ok(js.includes(name));
 for(const key of ['ArrowDown','ArrowUp','Home','End','Enter','Escape','Tab'])assert.ok(js.includes(`'${key}'`));
 assert.match(js,/\.showPopover\(\)/);assert.match(js,/\.hidePopover\(\)/);
 assert.match(js,/visualViewport/);assert.match(js,/selectControls\.delete\(select\)/);
 const css=read('controls.css');assert.equal(declarations(css,'.select-popup').position,'fixed');
 assert.ok(rules(css).some(r=>r.selectors.includes('.select-option[aria-selected="true"]')));
});
test('Library controller keeps account-bound reads and capability-gated creation',()=>{
 // Rendering contracts are covered by console-workbench; here only the controller wiring.
 const js=read('app.mjs');
 assert.match(js,/libraryView\(t,\{data,query,searchMode,category,status/);
 assert.match(js,/canAct\(capabilities,'memory\.create'\)/);
 assert.match(js,/include_history:'true'/);
 assert.match(js,/state\.accepts\(ticket\)/);
});
test('One existing stylesheet response contains base and control rules',()=>{
 const response={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=String(body);}};
 assert.equal(serveAsset({method:'GET'},response,'/assets/styles.css'),true);
 assert.ok(declarations(response.body,':root')['--sidebar']);assert.equal(declarations(response.body,'.select-popup').position,'fixed');
 assert.equal(serveAsset({method:'GET'},response,'/assets/controls.css'),false);
});
