#!/usr/bin/env node
// Assemble an isolated SRD workspace from explicit, clean Git sources.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const names=['SRD-Docker-Infra','SRD-Backend','SRD-Frontend','SRD-Database','SRD-Docs'];
const flags=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(!key.startsWith('--')||flags.has(key))throw Error(`Unknown or duplicate option: ${key}`);
  if(key==='--check'||key==='--allow-dirty'){flags.set(key,true);continue;}
  if(!['--infra','--backend','--frontend','--database','--docs','--dest'].includes(key)||!process.argv[i+1])throw Error(`Missing value: ${key}`);
  flags.set(key,process.argv[++i]);
}
const check=flags.has('--check');
const options={'SRD-Docker-Infra':'--infra','SRD-Backend':'--backend','SRD-Frontend':'--frontend','SRD-Database':'--database','SRD-Docs':'--docs'};
for(const name of names)if(!flags.get(options[name]))throw Error(`Required: ${options[name]}`);
const sources=new Map(names.map(name=>[name,path.resolve(String(flags.get(options[name])))]));
if(!check&&!flags.has('--dest'))throw Error('--dest is required for assembly');
const destination=flags.has('--dest')?path.resolve(String(flags.get('--dest'))):null;
function git(cwd,...args){return execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
const gitSources={};
const trackedFiles=new Map();
for(const [name,dir] of sources){
  if(!fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory())throw Error(`Source missing: ${name}`);
  const top=path.resolve(git(dir,'rev-parse','--show-toplevel'));
  if(top.toLowerCase()!==dir.toLowerCase())throw Error(`Not Git root: ${name}`);
  const remote=git(dir,'remote','get-url','origin');
  if(!new RegExp(`(?:/|:)jsgh1/${name}(?:\\.git)?$`,'i').test(remote))throw Error(`Unexpected origin for ${name}`);
  const dirty=git(dir,'status','--porcelain').length>0;
  if(dirty&&!flags.has('--allow-dirty'))throw Error(`Dirty source: ${name}`);
  trackedFiles.set(name,new Set(execFileSync('git',['ls-files','-z'],{cwd:dir,stdio:['ignore','pipe','pipe']}).toString('utf8').split('\0').filter(Boolean)));
  gitSources[name]={path:dir,sha:git(dir,'rev-parse','HEAD'),branch:git(dir,'branch','--show-current'),remote,dirty};
}
const required=[['SRD-Docker-Infra','compose.yaml'],['SRD-Docker-Infra','docker/php.Dockerfile'],['SRD-Backend','services/identity/artisan'],['SRD-Backend','packages/php'],['SRD-Frontend','apps/web/package.json'],['SRD-Database','database/03_dcl/01_grants/initialize-services.sh'],['SRD-Docs','Entregables/PDF']];
for(const [repo,relative] of required)if(!fs.existsSync(path.join(sources.get(repo),relative)))throw Error(`Missing ${repo}/${relative}`);
if(destination){
  for(const dir of sources.values())if(destination.toLowerCase()===dir.toLowerCase()||destination.toLowerCase().startsWith(dir.toLowerCase()+path.sep))throw Error('Destination inside source');
  if(fs.existsSync(destination)&&fs.readdirSync(destination).length)throw Error('Destination is populated');
}
const denyDir=new Set(['.git','.github','.gradle','.expo','vendor','node_modules','.local','dist','qa-backups','qa-evidencias','qa-tests','storage','test-results','playwright-report','coverage']);
function allowed(relative,entry){
  const base=path.basename(relative);
  if(entry.isSymbolicLink())throw Error(`Symbolic link not supported: ${relative}`);
  if(base==='.git')return false;
  if(entry.isDirectory())return !denyDir.has(base);
  if(/^\.env(?:\.|$)/.test(base)&&!/^\.env(?:\.production)?\.example$/.test(base))return false;
  if(['.turnserver.conf','mysql-lab.env'].includes(base)||/\.(sqlite|log|pem|key)$/i.test(base))return false;
  return true;
}
const files=new Map(),collisions=[];
function include(repo,sourceRelative,targetRelative,overlay=false){
  const origin=path.join(sources.get(repo),sourceRelative);
  if(!fs.existsSync(origin))throw Error(`Missing ${repo}/${sourceRelative}`);
  const walk=(dir,relative)=>{
    for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const next=path.join(relative,entry.name);
      if(!allowed(next,entry))continue;
      if(entry.isDirectory())walk(path.join(dir,entry.name),next);
      else if(entry.isFile()){
        const gitRelative=path.join(sourceRelative,next).replaceAll('\\','/').replace(/^\.\//,'');
        if(!trackedFiles.get(repo).has(gitRelative))continue;
        const target=path.join(targetRelative,next).replaceAll('\\','/');
        const source=path.join(dir,entry.name);
        const hash=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        const previous=files.get(target.toLowerCase());
        if(previous){
          if(previous.sha256!==hash&&!overlay)throw Error(`Unsafe collision: ${target}`);
          if(previous.sha256!==hash&&overlay&&!/^services\/[^/]+\/database\/migrations\/[^/]+\.php$/.test(target))throw Error(`Unexpected overlay: ${target}`);
          collisions.push({path:target,from:previous.repository,to:repo,identical:previous.sha256===hash});
        }
        files.set(target.toLowerCase(),{path:target,source,repository:repo,sha256:hash});
      }
    }
  };
  const stat=fs.statSync(origin);
  if(stat.isDirectory())walk(origin,'');else throw Error(`Expected directory: ${repo}/${sourceRelative}`);
}
include('SRD-Docker-Infra','.','');
include('SRD-Backend','services','services');
include('SRD-Backend','packages','packages');
include('SRD-Backend','contracts','contracts');
include('SRD-Frontend','apps','apps');
include('SRD-Database','services','services',true);
include('SRD-Database','database','database');
const entries=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
const manifest={schema:1,createdAt:new Date().toISOString(),sources:gitSources,files:entries.map(({path,repository,sha256})=>({path,repository,sha256})),collisions};
const summary={mode:check?'check':'assemble',destination,fileCount:entries.length,collisions:collisions.length,sources:Object.fromEntries(Object.entries(gitSources).map(([k,v])=>[k,{sha:v.sha,dirty:v.dirty}]))};
if(check){console.log(JSON.stringify(summary));process.exit(0)}
fs.mkdirSync(destination,{recursive:true});
for(const entry of entries){
  const target=path.join(destination,entry.path);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(entry.source,target);
  const copiedHash=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if(copiedHash!==entry.sha256)throw Error(`Copied file differs: ${entry.path}`);
}
fs.writeFileSync(path.join(destination,'srd-provenance.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(summary));
