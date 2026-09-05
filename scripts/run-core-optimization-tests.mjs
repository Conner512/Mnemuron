import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';

const label=process.argv[2];
if (!/^[a-z0-9-]+$/.test(label || '')) throw Error('A safe run label is required');
const root=path.resolve(import.meta.dirname,'..');
const directory=path.join(root,'evidence/core-optimization-v0.2');
mkdirSync(directory,{recursive:true,mode:0o700});
const log=createWriteStream(path.join(directory,`${label}.log`),{mode:0o600});
log.write(JSON.stringify({started_at:new Date().toISOString(),node:process.version,command:['npm','test']})+'\n');
const child=spawn('npm',['test'],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>log.write(chunk));
child.on('exit',code=>{log.end(`\nexit_code=${code}\n`); console.log(JSON.stringify({label,exit_code:code,log:path.join(directory,`${label}.log`)}));process.exitCode=code;});
