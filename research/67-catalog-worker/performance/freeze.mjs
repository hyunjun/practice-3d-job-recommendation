import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=process.cwd(), perf=path.resolve('.local/research/67-catalog-worker/performance')
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function walk(directory,prefix=''){const entries={};for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name),name=path.join(prefix,entry.name);if(entry.isDirectory())Object.assign(entries,walk(file,name));else if(entry.isFile())entries[name]=sha(file)}return entries}
function archive(repository,commit,destination){fs.mkdirSync(destination,{recursive:true});const tar=path.join(path.dirname(destination),'source.tar');execFileSync('git',['-C',repository,'archive','--format=tar','--output',tar,commit]);execFileSync('tar',['-xf',tar,'-C',destination])}
function artifacts(from,to){for(const name of ['dist','dist-server','public/pdf']){const target=path.join(to,name);if(fs.existsSync(target))throw new Error('Refusing overwrite '+target);fs.mkdirSync(path.dirname(target),{recursive:true});execFileSync('cp',['-cR',path.join(from,name),target])}fs.symlinkSync(path.join(root,'node_modules'),path.join(to,'node_modules'),'dir')}
function same(hashes,base){for(const [file,hash] of Object.entries(hashes))if(sha(path.join(base,file))!==hash)throw new Error('Changed during freeze: '+base+'/'+file)}
const stage66=path.join(perf,'frozen/stage66-34df6ee'),s66=path.join(stage66,'source')
if(!fs.existsSync(s66)){
 const receipt=JSON.parse(fs.readFileSync('.local/research/66-globe-responsive/candidate-build-01/manifest.json','utf8'))
 const commit=execFileSync('git',['rev-parse','34df6ee'],{encoding:'utf8'}).trim()
 archive(root,commit,s66);same(receipt.inputs,s66);artifacts(receipt.source,s66);same(receipt.artifacts,s66)
 fs.writeFileSync(path.join(stage66,'manifest.json'),JSON.stringify({kind:'exact-stage66-baseline',commit,source:s66,buildReceipt:receipt.buildReceipt,inputs:receipt.inputs,artifacts:receipt.artifacts,tests:receipt.tests,frozenAt:new Date().toISOString(),sourceBuildPairing:'Every committed build input and copied artifact matches independently verified Stage66 build-01 receipt.'},null,2)+'\n')
}
const repository=path.resolve('.local/worktrees/catalog-worker-stage67'),stage67=path.join(perf,'frozen/stage67-prep-072444'),s67=path.join(stage67,'source')
if(!fs.existsSync(s67)){
 const commit=execFileSync('git',['-C',repository,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
 const inputs={};for(const dir of ['src','shared','server','scripts'])Object.assign(inputs,walk(path.join(repository,dir),dir));for(const file of ['index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts'])inputs[file]=sha(path.join(repository,file))
 const outputs={...walk(path.join(repository,'dist'),'dist'),...walk(path.join(repository,'dist-server'),'dist-server')}
 archive(repository,commit,s67)
 for(const file of Object.keys(inputs)){fs.mkdirSync(path.dirname(path.join(s67,file)),{recursive:true});fs.copyFileSync(path.join(repository,file),path.join(s67,file))}
 artifacts(repository,s67);same(inputs,repository);same(inputs,s67);same(outputs,repository);same(outputs,s67)
 fs.writeFileSync(path.join(stage67,'manifest.json'),JSON.stringify({kind:'provisional-stage67-preparation-only',baseCommit:commit,source:s67,reportedBuildFinishedAt:'2026-09-27T07:24:44.961Z',inputs,artifacts:outputs,frozenAt:new Date().toISOString(),eligibleForAggregateTiming:false,sourceBuildPairing:'Current source and existing artifacts copied and stable during copy. No matching source-before/source-after build receipt supplied for this provisional pair; final candidate required before aggregate timing.'},null,2)+'\n')
}
console.log(JSON.stringify({baseline:s66,provisionalCandidate:s67,rootDistWritten:false,buildsInvoked:0}))
