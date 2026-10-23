import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../fixtures/legacy/',import.meta.url));
const manifest=JSON.parse(readFileSync(path.join(root,'manifest.json'),'utf8'));

export function copyLegacyFixture(name,destination) {
  if(!Object.hasOwn(manifest,name))throw new Error('Unknown legacy fixture');
  const modules=manifest[name].files.map(file=>{
    if(!/^[a-z][a-z0-9-]*\.mjs$/.test(file.name))throw new Error('Invalid legacy module name');
    const content=readFileSync(path.join(root,name,file.name));
    if(content.length!==file.size || createHash('sha256').update(content).digest('hex')!==file.sha256) {
      throw new Error('Legacy fixture checksum mismatch');
    }
    return {name:file.name,content};
  });
  // Validate the complete frozen snapshot before creating any runnable copy.
  mkdirSync(destination,{mode:0o700});
  for(const module of modules)writeFileSync(path.join(destination,module.name),module.content,{flag:'wx',mode:0o600});
  return destination;
}
