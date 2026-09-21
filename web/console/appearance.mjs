import {text} from './catalog.mjs';
const defaults={theme:'a',mode:'light',locale:'zh-CN'};
const valid={theme:['a','b','c'],mode:['light','dark'],locale:['zh-CN','en']};
const account=document.body.dataset.account || 'signed-out';
const key=`mnemuron.appearance.v1.${account}`;
let prefs={...defaults};
try {const saved=JSON.parse(localStorage.getItem(key)||'{}');for(const k of Object.keys(valid))if(valid[k].includes(saved[k]))prefs[k]=saved[k];}catch{}
export const translate=key=>text(key,prefs.locale);
function apply() {
  document.documentElement.dataset.theme=prefs.theme;document.documentElement.dataset.mode=prefs.mode;document.documentElement.lang=prefs.locale;
  for(const node of document.querySelectorAll('[data-i18n]'))node.textContent=translate(node.dataset.i18n);
  for(const node of document.querySelectorAll('[data-i18n-placeholder]'))node.placeholder=translate(node.dataset.i18nPlaceholder);
  for(const node of document.querySelectorAll('[data-pref]')){node.value=prefs[node.dataset.pref];node.disabled=false;}
}
apply();
document.addEventListener('change',event=>{
 const property=event.target.dataset.pref;if(!valid[property]?.includes(event.target.value))return;
 prefs={...prefs,[property]:event.target.value};
 try{localStorage.setItem(key,JSON.stringify(prefs));}catch{}
 apply();document.dispatchEvent(new CustomEvent('appearancechange',{detail:{...prefs}}));
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-password-toggle],[data-copy]');if(!button)return;
 if(button.dataset.passwordToggle) {
   const field=document.getElementById(button.dataset.passwordToggle);if(!field)return;
   field.type=field.type==='password'?'text':'password';button.dataset.i18n=field.type==='password'?'showPassword':'hidePassword';button.textContent=translate(button.dataset.i18n);
 } else {
   const node=document.getElementById(button.dataset.copy);if(!node)return;
   try{await navigator.clipboard.writeText(node.textContent);document.getElementById('live-status').textContent=translate('copied');}catch{}
 }
});
