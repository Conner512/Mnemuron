import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryView} from '../../../web/console/visuals.mjs';
import {text} from '../../../web/console/catalog.mjs';
import {RETRIEVAL_DEGRADATIONS} from '../../../shared/retrieval-diagnostics.mjs';

test('SEARCH-FEEDBACK-01: failed semantic reads keep editable filters without claiming empty or stale results',()=>{
  for(const locale of ['zh-CN','en']){
    const html=libraryView(key=>text(key,locale),{data:{results:[{memory_id:'synthetic-stale-result',content:'STILL_PRIVATE_PROVIDER_OUTPUT',status:'active'}]},
      query:'Synthetic retained query',searchMode:'semantic',kind:'workflow',status:'active',topic:'Synthetic topic',concept:'Synthetic concept',
      failure:{code:'SEMANTIC_UNAVAILABLE',degradation_code:'VECTOR_FILTER_TOO_BROAD'},pagination:'STALE_PAGE_COUNT'});
    assert.match(html,/data-search-failure/);assert.match(html,/role="alert"/);
    assert.match(html,/id="search-form"/);assert.match(html,/value="Synthetic retained query"/);
    assert.match(html,/value="semantic" selected/);assert.match(html,/value="workflow" selected/);
    assert.match(html,/data-i18n="retrieval_VECTOR_FILTER_TOO_BROAD"/);assert.match(html,/data-retry/);
    assert.doesNotMatch(html,/synthetic-stale-result|STILL_PRIVATE_PROVIDER_OUTPUT|STALE_PAGE_COUNT|data-i18n="resultCount"|class="empty"/);
  }
});

test('SEARCH-FEEDBACK-02: safe reasons are translated; unknown diagnostics never become page content',()=>{
  for(const locale of ['zh-CN','en']){
    for(const code of RETRIEVAL_DEGRADATIONS)assert.notEqual(text('retrieval_'+code,locale),'retrieval_'+code);
    const html=libraryView(key=>text(key,locale),{data:{results:[]},failure:{code:'SEMANTIC_UNAVAILABLE',degradation_code:'PRIVATE_SYNTHETIC_DIAGNOSTIC'}});
    assert.match(html,/data-i18n="retrievalUnavailableReason"/);assert.doesNotMatch(html,/PRIVATE_SYNTHETIC_DIAGNOSTIC/);
  }
});
