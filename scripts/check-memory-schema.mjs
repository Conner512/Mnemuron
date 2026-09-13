import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const gatewayRoot=new URL('../adapters/chatgpt-web/',import.meta.url);
export function compileMemorySchema(){
  // Reuse the existing locked Web SDK dependencies in verification only, not core runtime.
  const require=createRequire(new URL('package.json',gatewayRoot));
  const lock=JSON.parse(readFileSync(new URL('package-lock.json',gatewayRoot),'utf8'));
  const versions={};
  for(const name of ['ajv','ajv-formats']){
    versions[name]=require(name+'/package.json').version;
    if(versions[name]!==lock.packages['node_modules/'+name].version)throw new Error('SCHEMA_VALIDATOR_LOCK_MISMATCH');
  }
  const Ajv=require('ajv/dist/2020.js').default;
  // Conditional required fields are declared in a parent/$ref. This is legal JSON Schema.
  const ajv=new Ajv({strict:true,strictRequired:false,allErrors:true,validateSchema:true});
  require('ajv-formats')(ajv);
  const schema=JSON.parse(readFileSync(new URL('../docs/memory-first-v0.1/memory.runtime.schema.json',import.meta.url),'utf8'));
  const validate=ajv.compile(schema);
  return {schema,validate,versions};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2)throw new Error('INVALID_ARGUMENTS');
    const {validate,versions}=compileMemorySchema();
    const example=JSON.parse(readFileSync(new URL('../docs/memory-first-v0.1/memory.runtime.example.json',import.meta.url),'utf8'));
    const valid=validate(example);
    console.log(JSON.stringify({status:valid?'passed':'failed',draft:'2020-12',meta_schema_valid:true,example_valid:valid,versions,network_called:false}));
    process.exitCode=valid?0:1;
  }catch{
    console.error(JSON.stringify({status:'blocked',error_code:'SCHEMA_VALIDATION_UNAVAILABLE',network_called:false}));process.exitCode=1;
  }
}
