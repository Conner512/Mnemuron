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
}
function setPreference(property,value) {
  if(!valid[property]?.includes(value))return;
  prefs={...prefs,[property]:value};
  try{localStorage.setItem(key,JSON.stringify(prefs));}catch{}
  syncAppearance();document.dispatchEvent(new CustomEvent('appearancechange',{detail:{...prefs}}));
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
