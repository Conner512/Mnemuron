import {text} from './catalog.mjs';
const defaults={theme:'a',mode:'light',locale:'zh-CN'};
const valid={theme:['a','b','c'],mode:['light','dark'],locale:['zh-CN','en']};
const account=document.body.dataset.account || 'signed-out';
const key=`mnemuron.appearance.v1.${account}`;
let prefs={...defaults};
try {const saved=JSON.parse(localStorage.getItem(key)||'{}');for(const k of Object.keys(valid))if(valid[k].includes(saved[k]))prefs[k]=saved[k];}catch{}
export const translate=key=>text(key,prefs.locale);

// Translate chrome in place: never replace a form, a drawer or user-supplied content.
export function syncAppearance() {
  document.documentElement.dataset.theme=prefs.theme;document.documentElement.dataset.mode=prefs.mode;document.documentElement.lang=prefs.locale;
  for(const node of document.querySelectorAll('[data-i18n]'))node.textContent=translate(node.dataset.i18n);
  for(const node of document.querySelectorAll('[data-i18n-placeholder]'))node.placeholder=translate(node.dataset.i18nPlaceholder);
  for(const node of document.querySelectorAll('[data-i18n-aria-label]'))node.setAttribute('aria-label',translate(node.dataset.i18nAriaLabel));
  for(const node of document.querySelectorAll('[data-i18n-title]'))node.title=translate(node.dataset.i18nTitle);
  for(const node of document.querySelectorAll('[data-pref]')) {
    if(node.dataset.prefValue!==undefined)node.setAttribute('aria-pressed',String(node.dataset.prefValue===prefs[node.dataset.pref]));
    else node.value=prefs[node.dataset.pref];
    node.disabled=false;
  }
  if(document.body.dataset.title)document.title=`Mnemuron · ${translate(document.body.dataset.title)}`;
  syncSelectControls();
}
function setPreference(property,value) {
  if(!valid[property]?.includes(value))return;
  prefs={...prefs,[property]:value};
  try{localStorage.setItem(key,JSON.stringify(prefs));}catch{}
  syncAppearance();document.dispatchEvent(new CustomEvent('appearancechange',{detail:{...prefs}}));
}
// Progressive enhancement: keep the original select, name, value, FormData and
// validity as the source of truth. Unsupported browsers keep their native UI.
// Everything lives in this existing asset so old ingress allowlists still work.
const selectControls=new Map();
let openSelect=null,selectCounter=0,selectFrame=0;
const supportsPopover=typeof globalThis.HTMLElement?.prototype?.showPopover==='function';
const put=(node,key,value)=>{if(node.getAttribute(key)!==String(value))node.setAttribute(key,String(value));};
const selectedText=select=>select.selectedOptions[0]?.label || '';
const unavailable=option=>option.disabled || option.hidden || option.parentElement?.disabled || option.parentElement?.hidden;
function selectLabel(select) {
  if(select.getAttribute('aria-label'))return select.getAttribute('aria-label');
  if(select.getAttribute('aria-labelledby'))return select.getAttribute('aria-labelledby').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim();
  return [...select.labels||[]].map(label=>{
    const copy=label.cloneNode(true);
    for(const control of copy.querySelectorAll('select,.select-shell,input,button,.select-popup,.select-error'))control.remove();
    return copy.textContent.trim();
  }).filter(Boolean).join(' ') || select.name || select.id || '';
}
function enabledOptions(record) {
  return [...record.select.options].map((option,index)=>({option,index})).filter(({option})=>!unavailable(option));
}
function syncSelect(record) {
  const {select,button,value,popup}=record;
  const options=[...select.options];
  const signature=JSON.stringify([select.selectedIndex,select.matches(':disabled'),select.required,selectLabel(select),select.getAttribute('aria-describedby'),
    options.map(o=>[o.label,o.value,o.hidden,o.disabled,o.parentElement?.disabled,o.parentElement?.hidden,o.parentElement?.label])]);
  if(record.signature===signature)return;
  record.signature=signature;
  value.textContent=selectedText(select);
  button.disabled=select.matches(':disabled');
  put(button,'aria-label',selectLabel(select));
  put(popup,'aria-label',selectLabel(select));
  put(button,'aria-required',select.required);
  const description=[select.getAttribute('aria-describedby'),!record.error.hidden?record.error.id:''].filter(Boolean).join(' ');
  if(description)put(button,'aria-describedby',description);else button.removeAttribute('aria-describedby');
  put(button,'aria-invalid',!record.error.hidden);
  if(select.dataset.pref==='theme')put(record.shell,'data-palette',select.value);
  if(openSelect===record){
    if(button.disabled){closeSelect();return;}
    renderOptions(record);
    if(!options[record.active]||unavailable(options[record.active]))record.active=enabledOptions(record)[0]?.index ?? -1;
    highlightOption(record);positionSelect(record);
  }
}
function renderOptions(record) {
  const fragment=document.createDocumentFragment();let group=null;
  for(const [index,option] of [...record.select.options].entries()) {
    if(option.hidden || option.parentElement?.hidden)continue;
    const parent=option.parentElement;
    if(parent.tagName==='OPTGROUP' && parent!==group){
      const heading=document.createElement('div');heading.className='select-group';heading.textContent=parent.label;heading.setAttribute('role','presentation');fragment.append(heading);
    }
    group=parent.tagName==='OPTGROUP'?parent:null;
    const row=document.createElement('div');row.className='select-option';row.id=`${record.popup.id}-${index}`;row.dataset.index=String(index);
    row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===record.select.selectedIndex));
    row.setAttribute('aria-disabled',String(!!unavailable(option)));
    const text=document.createElement('span');text.className='select-option-text';text.textContent=option.label;
    if(record.select.dataset.pref==='theme'){
      const swatch=document.createElement('span');swatch.className='select-swatch';swatch.dataset.palette=option.value;swatch.setAttribute('aria-hidden','true');row.append(swatch);
    }
    const check=document.createElement('span');check.className='select-check';check.textContent='✓';check.setAttribute('aria-hidden','true');
    row.append(text,check);fragment.append(row);
  }
  record.popup.replaceChildren(fragment);
}
function highlightOption(record) {
  for(const row of record.popup.querySelectorAll('[role="option"]'))row.classList.toggle('is-active',Number(row.dataset.index)===record.active);
  const active=document.getElementById(`${record.popup.id}-${record.active}`);
  if(active){
    put(record.button,'aria-activedescendant',active.id);
    // Scroll only the popup, never the page or the form's scroll container.
    const row=active.getBoundingClientRect(),box=record.popup.getBoundingClientRect();
    if(row.top<box.top+6)record.popup.scrollTop-=box.top+6-row.top;
    else if(row.bottom>box.bottom-6)record.popup.scrollTop+=row.bottom-box.bottom+6;
  }else record.button.removeAttribute('aria-activedescendant');
}
function positionSelect(record) {
  if(openSelect!==record)return;
  const {button,popup,select}=record;
  const modal=select.closest('dialog');
  if(!button.isConnected || button.disabled || (modal&&!modal.open)){closeSelect();return;}
  const r=button.getBoundingClientRect(),vp=window.visualViewport;
  const left=vp?.offsetLeft||0,top=vp?.offsetTop||0,w=vp?.width||document.documentElement.clientWidth,h=vp?.height||window.innerHeight;
  if(!r.width || r.bottom<top || r.top>top+h || r.right<left || r.left>left+w){closeSelect();return;}
  const margin=10,gap=6,width=Math.min(Math.max(r.width,record.compact?192:160),w-2*margin);
  popup.style.width=`${Math.max(0,width)}px`;
  popup.style.maxHeight='320px';
  const desired=Math.min(popup.scrollHeight+2,320),below=top+h-margin-r.bottom-gap,above=r.top-top-margin-gap;
  const upward=below<desired && above>below,room=Math.max(0,upward?above:below),height=Math.min(desired,room);
  popup.style.maxHeight=`${height}px`;
  const x=Math.min(Math.max(r.left,left+margin),left+w-margin-width);
  popup.style.left=`${x}px`;
  popup.style.top=`${upward?r.top-gap-height:r.bottom+gap}px`;
  put(popup,'data-side',upward?'top':'bottom');
}
function closeSelect({commit=false,focus=false}={}) {
  const record=openSelect;if(!record)return;
  openSelect=null;
  const {select,button,popup}=record;
  if(popup.matches(':popover-open'))popup.hidePopover();
  put(button,'aria-expanded',false);button.removeAttribute('aria-activedescendant');record.buffer='';
  if(commit && !select.matches(':disabled')){
    const option=select.options[record.active];
    if(option&&!unavailable(option)&&record.active!==select.selectedIndex){
      select.selectedIndex=record.active;record.error.hidden=true;record.signature=null;
      syncSelect(record);
      // Exactly one normal input/change pair. Existing preferences, filters and
      // operations receive the same native target they have always used.
      select.dispatchEvent(new Event('input',{bubbles:true}));
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }
  popup.replaceChildren();
  if(focus&&button.isConnected&&!button.disabled)button.focus({preventScroll:true});
}
function showSelect(record) {
  if(record.select.matches(':disabled'))return;
  closeSelect();
  for(const menu of document.querySelectorAll('.account-menu[open]'))menu.open=false;
  syncSelect(record);record.active=record.select.selectedIndex;
  if(!record.select.options[record.active]||unavailable(record.select.options[record.active]))record.active=enabledOptions(record)[0]?.index ?? -1;
  if(record.active<0)return;
  renderOptions(record);openSelect=record;
  try{record.popup.showPopover();}catch{openSelect=null;record.popup.replaceChildren();return;}
  put(record.button,'aria-expanded',true);record.button.focus({preventScroll:true});positionSelect(record);highlightOption(record);
}
function selectKey(record,event) {
  if(event.isComposing || event.ctrlKey || event.metaKey)return;
  const key=event.key,open=openSelect===record;
  if(key==='Escape'&&open){event.preventDefault();event.stopPropagation();closeSelect({focus:true});return;}
  if(key==='Tab'){if(open)closeSelect({commit:true});return;}
  if(['ArrowDown','ArrowUp','Home','End','PageDown','PageUp','Enter',' '].includes(key)){
    event.preventDefault();event.stopPropagation();
    if(!open){showSelect(record);if(key==='Home'||key==='End'){const items=enabledOptions(record);record.active=items[key==='Home'?0:items.length-1]?.index??-1;highlightOption(record);}return;}
    if(key==='Enter'||key===' '){closeSelect({commit:true,focus:true});return;}
    if(event.altKey&&key==='ArrowUp'){closeSelect({commit:true,focus:true});return;}
    const items=enabledOptions(record),index=items.findIndex(item=>item.index===record.active);
    const next=key==='Home'?0:key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,index+({ArrowDown:1,ArrowUp:-1,PageDown:8,PageUp:-8}[key])));
    record.active=items[next]?.index??-1;highlightOption(record);return;
  }
  if(key.length===1&&!event.altKey){
    event.preventDefault();if(!open)showSelect(record);if(openSelect!==record)return;
    const now=Date.now();record.buffer=now-record.typedAt>700?key:(record.buffer||'')+key;record.typedAt=now;
    const repeated=[...record.buffer].every(c=>c===key),query=(repeated?key:record.buffer).toLocaleLowerCase(document.documentElement.lang);
    const items=enabledOptions(record),start=items.findIndex(item=>item.index===record.active);
    for(let n=repeated?1:0;n<items.length+(repeated?1:0);n++){
      const item=items[(Math.max(0,start)+n)%items.length];
      if(item.option.label.trim().toLocaleLowerCase(document.documentElement.lang).startsWith(query)){record.active=item.index;highlightOption(record);break;}
    }
  }
}
export function syncSelectControls() {
  if(!supportsPopover)return;
  for(const [select,record] of selectControls){
    if(!select.isConnected){if(openSelect===record)closeSelect();selectControls.delete(select);}
    else syncSelect(record);
  }
  for(const select of document.querySelectorAll('select:not([multiple]):not([data-native-select])')) {
    if(selectControls.has(select)||select.size>1||select.hidden)continue;
    const shell=document.createElement('span');shell.className='select-shell';
    const button=document.createElement('button');button.type='button';button.className='select-trigger';button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const value=document.createElement('span');value.className='select-value';
    const arrow=document.createElement('span');arrow.className='select-chevron';arrow.setAttribute('aria-hidden','true');button.append(value,arrow);
    const popup=document.createElement('div');popup.className='select-popup';popup.id=`mnm-select-list-${++selectCounter}`;popup.setAttribute('role','listbox');popup.setAttribute('popover','manual');
    const error=document.createElement('span');error.className='select-error';error.id=`${popup.id}-error`;error.hidden=true;
    button.setAttribute('aria-controls',popup.id);
    const record={select,shell,button,value,popup,error,active:-1,signature:null,compact:!!select.closest('.appearance-controls'),buffer:'',typedAt:0};
    // Remain in the original label/form/dialog; top-layer paint avoids clipping
    // without moving a field outside its modal or changing its form ownership.
    select.before(shell);shell.append(select,button,popup,error);
    select.classList.add('select-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
    selectControls.set(select,record);button.dataset.selectName=select.name||select.id;
    button.addEventListener('click',event=>{event.preventDefault();openSelect===record?closeSelect({focus:true}):showSelect(record);});
    button.addEventListener('keydown',event=>selectKey(record,event));
    popup.addEventListener('pointerdown',event=>event.preventDefault());
    popup.addEventListener('click',event=>{event.preventDefault();const option=event.target.closest('[role="option"]');if(option&&option.getAttribute('aria-disabled')!=='true'){record.active=Number(option.dataset.index);closeSelect({commit:true,focus:true});}});
    select.addEventListener('change',()=>{record.error.hidden=true;record.signature=null;syncSelect(record);});
    select.addEventListener('focus',()=>button.focus({preventScroll:true}));
    select.addEventListener('invalid',event=>{event.preventDefault();record.error.textContent=select.validationMessage;record.error.hidden=false;record.signature=null;syncSelect(record);button.focus();});
    syncSelect(record);
  }
}
function scheduleSelectSync(){
  if(selectFrame)return;
  selectFrame=requestAnimationFrame(()=>{selectFrame=0;syncSelectControls();if(openSelect)positionSelect(openSelect);});
}
if(supportsPopover){
  new MutationObserver(scheduleSelectSync).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','hidden','required','label','open','aria-label','aria-labelledby']});
  document.addEventListener('pointerdown',event=>{if(openSelect&&!openSelect.shell.contains(event.target))closeSelect();},true);
  document.addEventListener('focusin',event=>{if(openSelect&&!openSelect.shell.contains(event.target))closeSelect();});
  document.addEventListener('reset',()=>queueMicrotask(()=>{for(const record of selectControls.values()){record.error.hidden=true;record.signature=null;}syncSelectControls();}));
  document.addEventListener('close',event=>{if(event.target.tagName==='DIALOG'&&openSelect&&event.target.contains(openSelect.shell))closeSelect();},true);
  document.addEventListener('toggle',event=>{if(event.target.matches('.account-menu[open]'))closeSelect();},true);
  document.addEventListener('scroll',event=>{if(openSelect&&!openSelect.popup.contains(event.target))scheduleSelectSync();},true);
  window.addEventListener('resize',scheduleSelectSync);
  window.visualViewport?.addEventListener('resize',scheduleSelectSync);window.visualViewport?.addEventListener('scroll',scheduleSelectSync);
  window.addEventListener('pagehide',()=>{closeSelect();cancelAnimationFrame(selectFrame);selectFrame=0;});
}

syncAppearance();
document.addEventListener('change',event=>{
  const property=event.target.dataset.pref;
  if(event.target.dataset.prefValue===undefined)setPreference(property,event.target.value);
});
document.addEventListener('click',async event=>{
  const choice=event.target.closest('button[data-pref-value]');
  if(choice&&!choice.disabled){setPreference(choice.dataset.pref,choice.dataset.prefValue);return;}
  const button=event.target.closest('[data-password-toggle],[data-copy]');if(!button)return;
  if(button.dataset.passwordToggle) {
    const field=document.getElementById(button.dataset.passwordToggle);if(!field)return;
    field.type=field.type==='password'?'text':'password';button.dataset.i18n=field.type==='password'?'showPassword':'hidePassword';button.textContent=translate(button.dataset.i18n);
  } else {
    const node=document.getElementById(button.dataset.copy);if(!node)return;
    try{await navigator.clipboard.writeText(node.textContent);document.getElementById('live-status').textContent=translate('copied');}catch{}
  }
});
// Account menu is local UI only; Escape closes it and restores keyboard focus.
document.addEventListener('keydown',event=>{
  if(event.key==='Escape')for(const menu of document.querySelectorAll('.account-menu[open]')){menu.open=false;menu.querySelector('summary')?.focus();}
});
document.addEventListener('click',event=>{
  for(const menu of document.querySelectorAll('.account-menu[open]'))if(!menu.contains(event.target))menu.open=false;
});
