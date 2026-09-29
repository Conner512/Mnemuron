import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {renderPage,sendPage,pages} from '../../../web/console/render.mjs';

const account={account_id:'synthetic-theme-owner',username:'Synthetic'};
const shell=(options={})=>renderPage({title:'overview',account,...options});
function bootstrap(html) {
  const match=html.match(/<script data-appearance-account="([^"]*)">([\s\S]*?)<\/script>/);
  assert.ok(match,'saved appearance must be restored by a parser-blocking head script');
  return {account:match[1],source:match[2],index:match.index};
}
function restore(html,records={},unavailable=false) {
  const boot=bootstrap(html),root={dataset:{theme:'a'},lang:'zh-CN'},reads=[];
  vm.runInNewContext(boot.source,{
    document:{documentElement:root,currentScript:{dataset:{appearanceAccount:boot.account}}},
    localStorage:{getItem(key){reads.push(key);if(unavailable)throw new Error('storage unavailable');return records[key]??null;}},
  },{timeout:100});
  return {root,reads};
}

test('saved appearance runs before styles, deferred modules and body on every shell',()=>{
  const shells=pages.map(page=>shell({title:page,page}));
  for(const title of ['login','register','recover','oauthLogin','oauthConsent'])
    shells.push(shell({title,auth:true,authPurpose:title.startsWith('oauth')?'oauth':'console',account:null}));
  for(const html of shells){
    const boot=bootstrap(html);
    assert.ok(boot.index>html.indexOf('<head>'));
    for(const later of ['<link rel="stylesheet"','<script type="module"','<body'])assert.ok(boot.index<html.indexOf(later));
    assert.doesNotMatch(html.slice(boot.index,boot.index+html.slice(boot.index).indexOf('>')),/\b(?:async|defer|src|type)=/);
  }
});

for(const theme of ['a','b','c'])for(const locale of ['zh-CN','en'])
  test(`first paint restores ${theme}/${locale} without a body or module fetch`,()=>{
    // A colour mode saved by an earlier release is ignored: the console ships one light palette.
    const prefs={theme,mode:'dark',locale};
    const {root,reads}=restore(shell(),{[`mnemuron.appearance.v1.${account.account_id}`]:JSON.stringify(prefs)});
    assert.deepEqual(root,{dataset:{theme},lang:locale});
    assert.deepEqual(reads,[`mnemuron.appearance.v1.${account.account_id}`]);
  });

test('first-paint preferences stay isolated by trusted account, including signed-out pages',()=>{
  const records={
    'mnemuron.appearance.v1.synthetic-theme-owner':JSON.stringify({theme:'c',mode:'dark',locale:'en'}),
    'mnemuron.appearance.v1.synthetic-theme-other':JSON.stringify({theme:'b',mode:'light'}),
    'mnemuron.appearance.v1.signed-out':JSON.stringify({theme:'a',mode:'dark'}),
  };
  assert.equal(restore(shell(),records).root.dataset.theme,'c');
  assert.equal(restore(shell({account:{account_id:'synthetic-theme-other'}}),records).root.dataset.theme,'b');
  assert.equal(restore(shell({account:{account_id:'synthetic-theme-new'}}),records).root.dataset.theme,'a');
  const signedOut=restore(shell({auth:true,account:null}),records);
  assert.deepEqual(signedOut.reads,['mnemuron.appearance.v1.signed-out']);
  assert.deepEqual(signedOut.root.dataset,{theme:'a'});
});

test('unavailable, malformed and untrusted preference values keep safe defaults',()=>{
  const key=`mnemuron.appearance.v1.${account.account_id}`;
  for(const value of ['null','[]','false','42','"c"','{broken',JSON.stringify({theme:'<script>',mode:'auto',locale:'unknown'})])
    assert.deepEqual(restore(shell(),{[key]:value}).root,{dataset:{theme:'a'},lang:'zh-CN'});
  assert.deepEqual(restore(shell(),{},true).root,{dataset:{theme:'a'},lang:'zh-CN'});
  assert.deepEqual(restore(shell(),{[key]:JSON.stringify({theme:'c',mode:'invalid',locale:'en'})}).root,
    {dataset:{theme:'c'},lang:'en'});
});

test('CSP permits only the exact fixed bootstrap and existing same-origin modules',()=>{
  const response={writeHead(status,headers){this.status=status;this.headers=headers;},end(html){this.html=html;}};
  sendPage(response,{title:'overview',account});
  const {source}=bootstrap(response.html),hash=createHash('sha256').update(source).digest('base64');
  assert.equal(response.headers['content-security-policy'].match(/(?:^|; )script-src ([^;]+)/)?.[1],`'self' 'sha256-${hash}'`);
  assert.doesNotMatch(response.headers['content-security-policy'],/unsafe-inline|unsafe-eval|nonce-|\*/);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.headers['x-frame-options'],'DENY');
  assert.equal((response.html.match(/<script(?! type="module")/g)||[]).length,1);
});

test('account data is escaped outside the fixed executable bootstrap',()=>{
  const safe=bootstrap(shell());
  const html=shell({account:{account_id:'synthetic-"</script><script>attack()</script>',username:'Synthetic'}});
  const boot=bootstrap(html);
  assert.equal(boot.source,safe.source);
  assert.doesNotMatch(html,/<script>attack/);
  assert.ok(boot.account.includes('&quot;&lt;/script&gt;'));
});
