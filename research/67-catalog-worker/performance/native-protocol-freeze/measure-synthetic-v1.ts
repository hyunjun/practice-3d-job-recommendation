import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { performance as hostClock } from 'node:perf_hooks'
import { installGlobeStream, openGlobe, globePins, globeHeading, globeRegion, expectGlobeTraffic } from './frozen/stage66-34df6ee/source/tests/e2e/helpers/globe-responsiveness'

if (!process.env.GLOBE_QA_WINDOW?.trim()) throw new Error('CPU window CLOSED: main must grant the window before GLOBE_QA_WINDOW is set')
const origin=process.env.GLOBE_QA_ORIGIN ?? 'http://127.0.0.1:5890'
const label=process.env.GLOBE_QA_LABEL ?? 'synthetic-stage66-production'
const runs=Number(process.env.GLOBE_QA_RUNS ?? '5')
const throttle=Number(process.env.GLOBE_QA_THROTTLE ?? '1')
const profiling=process.env.GLOBE_QA_PROFILE === '1'
const qa=path.resolve('.local/research/67-catalog-worker/performance/runs')
const folder=path.join(qa,label)
await mkdir(folder,{recursive:false})
const health=await (await fetch(origin+'/api/health')).json()
if(health.fixture!=='synthetic-public'||new URL(origin).port==='8787') throw new Error('Refusing non-owned synthetic fixture')
const browser=await chromium.launch({channel:'chrome',headless:true})
const aggregate:any[]=[]
const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,Math.max(0,milliseconds)))
const quantile=(values:number[],p:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]??null}
try {
 for(let index=1;index<=runs;index++) {
  const context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:960},deviceScaleFactor:1,reducedMotion:'no-preference',serviceWorkers:'block'})
  const page=await context.newPage()
  const state=await installGlobeStream(page,origin)
  const session=await context.newCDPSession(page)
  await session.send('Emulation.setCPUThrottlingRate',{rate:throttle})
  await session.send('Performance.enable')
  await page.addInitScript({content:`(() => {
   const qa={active:false,frames:[],longTasks:[],latencies:[],pending:[],marks:[],visibility:[]}
   window.__globeQA=qa
   const observer=new PerformanceObserver(list=>{for(const item of list.getEntries()) if(qa.active) qa.longTasks.push({at:item.startTime,duration:item.duration,name:item.name})})
   observer.observe({type:'longtask',buffered:true})
   let last=0
   const frame=(at)=>{
    requestAnimationFrame(frame)
    if(!qa.active){last=0;return}
    if(last)qa.frames.push({at,interval:at-last})
    last=at
    for(const input of [...qa.pending]){
     const heading=document.querySelector('.city-hero-caption h2')
     if(!heading||!heading.textContent?.startsWith(input.city)||heading.getBoundingClientRect().width===0)continue
     qa.pending.splice(qa.pending.indexOf(input),1)
     requestAnimationFrame(painted=>{qa.latencies.push({...input,domObservedAt:at,paintOpportunityAt:painted,latency:painted-input.at})})
    }
   }
   requestAnimationFrame(frame)
   document.addEventListener('pointerdown',event=>{
    if(!qa.active)return
    const target=event.target.closest('.city-row-main,.globe-pin:not(.is-cluster)')
    if(!target)return
    const city=target.getAttribute('aria-label')?.split(',')[0]
    if(city)qa.pending.push({city,at:event.timeStamp,deliveredAt:performance.now(),trusted:event.isTrusted,source:target.classList.contains('city-row-main')?'city-list':'globe-pin'})
   },true)
   document.addEventListener('visibilitychange',()=>{qa.visibility.push({at:performance.now(),hidden:document.hidden})})
  })()`})
  try {
   await openGlobe(page)
   await expect(page.locator('.city-row')).toHaveCount(22)
   await expect(page.locator('.collection-progress')).toContainText('6,600개 공고')
   const graphics=await page.locator('.earth-canvas canvas').evaluate((element:HTMLCanvasElement)=>{const gl=element.getContext('webgl2')!;const ext=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:gl.getParameter(gl.RENDERER),vendor:gl.getParameter(gl.VENDOR),version:gl.getParameter(gl.VERSION),unmasked:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,width:element.width,height:element.height}})
   await page.waitForTimeout(1500)
   const initialPins=await globePins(page)
   const metricBefore=await session.send('Performance.getMetrics')
   if(profiling){await session.send('Profiler.enable');await session.send('Profiler.setSamplingInterval',{interval:1000});await session.send('Profiler.start')}
   await page.evaluate(()=>{const qa=(window as any).__globeQA;qa.active=true;qa.startedAt=performance.now()})
   const actions:any[]=[]
   for(let phase=0;phase<3;phase++){
    const canvas=page.locator('.earth-canvas > canvas')
    const box=await canvas.boundingBox()
    if(!box)throw new Error('Missing live WebGL canvas')
    const start={x:box.x+box.width*0.50,y:box.y+box.height*0.68}
    const beforePins=await globePins(page)
    await page.mouse.move(start.x,start.y)
    await page.mouse.down()
    const began=hostClock.now()
    const inputLag:number[]=[]
    for(let step=0;step<120;step++){
     const due=began+step*(1000/60)
     await sleep(due-hostClock.now())
     inputLag.push(hostClock.now()-due)
     if(phase<2 && step===35){
      state.release((phase+1) as 1|2)
      await page.evaluate(stage=>{const qa=(window as any).__globeQA;qa.marks.push({type:'release-stream',stage,at:performance.now()})},phase+1)
     }
     const angle=step/119*Math.PI*2
     await page.mouse.move(start.x+Math.sin(angle)*box.width*0.19,start.y+(Math.cos(angle)-1)*box.height*0.075)
    }
    await page.mouse.up()
    const afterPins=await globePins(page)
    expect(afterPins).not.toEqual(beforePins)
    const city=['런던','암스테르담','뉴욕'][phase]
    const companyCount=phase===2?3:4
    const latenciesBefore=await page.evaluate(()=>(window as any).__globeQA.latencies.length)
    await page.getByRole('button',{name:`${city}, 추천 회사 ${companyCount}곳 보기`,exact:true}).click()
    await expect(globeHeading(page)).toContainText(city)
    await expect.poll(()=>page.evaluate(()=>(window as any).__globeQA.latencies.length)).toBe(latenciesBefore+1)
    await expect(page.locator('.company-card')).toHaveCount(companyCount)
    actions.push({phase,city,companyCount,inputLagP95:quantile(inputLag,.95),inputLagMax:Math.max(...inputLag),beforePins,afterPins})
    await globeRegion(page).focus()
    await page.keyboard.press(phase===1?'ArrowLeft':'ArrowRight')
    await page.waitForTimeout(1250)
    await page.getByRole('button',{name:'모든 도시',exact:true}).click()
    await page.getByRole('button',{name:'지구 처음 위치로',exact:true}).click()
    await page.waitForTimeout(1250)
   }
   await expect(page.locator('.collection-progress')).toHaveCount(0)
   await expect(page.locator('.map-stats strong')).toHaveText(['7곳','22곳'])
   const measured=await page.evaluate(()=>{const qa=(window as any).__globeQA;qa.active=false;qa.endedAt=performance.now();return qa})
   const metricAfter=await session.send('Performance.getMetrics')
   let profileFile:string|null=null
   if(profiling){const {profile}=await session.send('Profiler.stop');profileFile=`run-${index}.cpuprofile`;await writeFile(path.join(folder,profileFile),JSON.stringify(profile))}
   expectGlobeTraffic(state)
   expect(measured.pending).toEqual([])
   expect(measured.latencies).toHaveLength(3)
   expect(measured.latencies.every((item:any)=>item.trusted)).toBe(true)
   expect(measured.visibility.filter((item:any)=>item.hidden)).toEqual([])
   expect(measured.frames.length).toBeGreaterThan(100)
   const frames=measured.frames.map((item:any)=>item.interval)
   const latencies=measured.latencies.map((item:any)=>item.latency)
   const metrics:any={}
   for(const after of metricAfter.metrics){const before=metricBefore.metrics.find(item=>item.name===after.name);if(before)metrics[after.name]=after.value-before.value}
   const summary={run:index,mode:health.mode,label,throttle,profiling,durationMs:measured.endedAt-measured.startedAt,frames:frames.length,frameMs:{median:quantile(frames,.5),p95:quantile(frames,.95),p99:quantile(frames,.99),max:Math.max(...frames),over25:frames.filter((v:number)=>v>25).length,over50:frames.filter((v:number)=>v>50).length},longTasks:{count:measured.longTasks.length,totalMs:measured.longTasks.reduce((sum:number,item:any)=>sum+item.duration,0),maxMs:Math.max(0,...measured.longTasks.map((item:any)=>item.duration))},selectionMs:{values:latencies,median:quantile(latencies,.5),max:Math.max(...latencies)},scriptSeconds:metrics.ScriptDuration,taskSeconds:metrics.TaskDuration}
   await page.screenshot({path:path.join(folder,`run-${index}-final.png`)})
   await writeFile(path.join(folder,`run-${index}.json`),JSON.stringify({summary,protocol:{version:1,source:'frozen app selected by server cwd; test fixture and runner hashes recorded in protocol manifest',viewport:{width:1440,height:960},headless:true,channel:'chrome',browser:browser.version(),deviceScaleFactor:1,reducedMotion:'no-preference',dateOnlyFrozen:true,nativeRAF:true,initialJobs:6600,streamJobs:[6780,6780],initialCompanies:5,streamCompanies:[6,7],dragPhases:3,dragMoves:120,dragCadenceHz:60,phaseStreamReleaseAtMove:35,keyboardTweenWaitMs:1250,resetTweenWaitMs:1250,selectionStart:'trusted pointerdown event.timeStamp',selectionEnd:'next RAF after expected visible city heading observed; paint opportunity proxy, not compositor presentation timing'},graphics,health,metrics,initialPins,actions,measured,traffic:state.requests,unexpected:state.unexpected,errors:state.errors,profileFile},null,2)+'\n')
   aggregate.push(summary)
   await writeFile(path.join(folder,'summary.json'),JSON.stringify({complete:aggregate.length===runs,requestedRuns:runs,runs:aggregate},null,2)+'\n')
   console.log(JSON.stringify(summary))
  }catch(error){await writeFile(path.join(folder,`run-${index}-failure.json`),JSON.stringify({error:String(error),requests:state.requests,unexpected:state.unexpected,errors:state.errors,recorder:await page.evaluate(()=>(window as any).__globeQA).catch(()=>null)},null,2)+'\n');throw error}
  finally{state.dispose();await context.close()}
 }
}finally{await browser.close()}
