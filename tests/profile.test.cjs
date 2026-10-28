'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const inline=html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
if(!inline)throw Error('App inline script not found');
const profileKey='acoustic-mixture-counter-v1-sound-profile-v1';
const sampleProfile=()=>({
  format:'acoustic-flow-meter-sound-profile',version:1,
  savedAt:'2026-10-28T10:00:00.000Z',
  off:Array(20).fill(-105),on:Array(20).fill(-82)
});
function boot(store=new Map()){
  const callbacks=new Map(),els=new Map();
  let audioDb=-105,clock=1000,nextFrame=null;
  const makeEl=id=>({
    id,disabled:false,value:id==='sensitivity'?'58':'',files:null,
    style:{},textContent:'',
    classList:{add(){},remove(){},toggle(){}},
    setAttribute(){},appendChild(){},remove(){},replaceChildren(){},
    click(){const cb=callbacks.get(id+':click');return cb&&cb();},
    addEventListener(type,cb){callbacks.set(id+':'+type,cb);}
  });
  const element=id=>{if(!els.has(id))els.set(id,makeEl(id));return els.get(id)};
  class AudioContext{
    constructor(){this.sampleRate=44100;this.state='running';}
    async resume(){}
    createMediaStreamSource(){return {connect(){}};}
    createAnalyser(){return {fftSize:4096,frequencyBinCount:2048,smoothingTimeConstant:0.35,getFloatFrequencyData(arr){arr.fill(audioDb);}};}
    addEventListener(){}
  }
  const mediaStream={getAudioTracks(){return [{addEventListener(){}}]},getTracks(){return [{stop(){}}]}};
  const sandbox={
    window:{isSecureContext:true,AudioContext,confirm(){return true},addEventListener(){}},
    document:{getElementById:element,addEventListener(){},createElement(){return makeEl('created')},body:{appendChild(){}}},
    navigator:{mediaDevices:{async getUserMedia(){return mediaStream}}},
    localStorage:{getItem(k){return store.has(k)?store.get(k):null},setItem(k,v){store.set(k,String(v))},removeItem(k){store.delete(k)}},
    performance:{now(){return clock}},requestAnimationFrame(cb){nextFrame=cb;return 1},cancelAnimationFrame(){},
    console,Date,Number,Math,JSON,Float32Array,Array,Object,Blob,
    setTimeout(){},URL:{createObjectURL(){return 'blob:test'},revokeObjectURL(){}}
  };
  vm.runInNewContext(inline,sandbox,{filename:'acoustic-flow-meter-inline.js',timeout:3000});
  return {store,element,callback:(id,type)=>callbacks.get(id+':'+type),setAudio(db){audioDb=db},
    frame(t){clock=t;const f=nextFrame;assert.ok(f,'Frame callback');f(t);},setClock(t){clock=t}};
}
test('embedded JS is syntactically valid',()=>assert.doesNotThrow(()=>new vm.Script(inline)));
test('new browser starts without a sound profile',()=>{
  const app=boot();
  assert.match(app.element('profileStatus').textContent,/не готов/i);
  assert.equal(app.element('exportProfile').disabled,true);
});
test('learning saves a valid spectral profile and next page load restores it',async()=>{
  const app=boot();
  app.element('flow').value='1,5';
  await app.callback('microphone','click')();
  app.setAudio(-105);
  app.setClock(1000);
  await app.callback('learnOff','click')();
  app.frame(1000);app.frame(3100);
  app.setAudio(-82);
  app.setClock(4100);
  await app.callback('learnOn','click')();
  app.frame(4100);app.frame(6250);
  const serialized=app.store.get(profileKey);
  assert.ok(serialized,'profile saved');
  const profile=JSON.parse(serialized);
  assert.equal(profile.version,1);
  assert.equal(profile.off.length,20);
  assert.equal(profile.on.length,20);
  const fresh=boot(app.store);
  assert.equal(fresh.element('offCheck').textContent,'✓');
  assert.equal(fresh.element('onCheck').textContent,'✓');
  assert.equal(fresh.element('exportProfile').disabled,false);
  assert.match(fresh.element('profileStatus').textContent,/сохранён/);
});
test('invalid or damaged profile is rejected',()=>{
  const p=sampleProfile();p.on[3]=99999;
  const app=boot(new Map([[profileKey,JSON.stringify(p)]]));
  assert.equal(app.element('exportProfile').disabled,true);
  assert.match(app.element('help').textContent,/повреждён|несовместим/);
});
test('import persists validated spectral profile',async()=>{
  const app=boot();
  const data=JSON.stringify(sampleProfile());
  app.element('profileFile').files=[{size:data.length,async text(){return data}}];
  await app.callback('profileFile','change')();
  assert.ok(app.store.has(profileKey));
  assert.equal(app.element('exportProfile').disabled,false);
  assert.match(app.element('profileStatus').textContent,/сохранён/);
});
test('deleting profile keeps journal independent',()=>{
  const store=new Map([[profileKey,JSON.stringify(sampleProfile())],
    ['acoustic-mixture-counter-v1-cycles','[{"elapsed":12500,"flow":1.5,"volume":0.3125}]']]);
  const app=boot(store);
  app.callback('clearProfile','click')();
  assert.equal(store.has(profileKey),false);
  assert.equal(app.element('exportProfile').disabled,true);
  assert.equal(store.has('acoustic-mixture-counter-v1-cycles'),true);
});

test('completed auto cycle adds 1s before and 1s after the sound',async()=>{
  const app=boot(new Map([[profileKey,JSON.stringify(sampleProfile())]]));
  app.element('flow').value='1,5';
  await app.callback('microphone','click')();
  await app.callback('autoStart','click')();
  app.setAudio(-82);
  app.frame(1000);app.frame(1450);app.frame(11250);app.frame(12900);
  app.setAudio(-105);
  app.frame(13000);app.frame(13750);
  const c=JSON.parse(app.store.get('acoustic-mixture-counter-v1-cycles'))[0];
  assert.equal(c.source,'auto');
  assert.equal(c.buzzElapsed,12000);
  assert.equal(c.extraMs,2000);
  assert.equal(c.elapsed,14000);
  assert.equal(c.volume,0.35);
  assert.equal(c.interrupted,false);
});
test('a short preliminary buzz is ignored and only full cycle gets correction',async()=>{
  const app=boot(new Map([[profileKey,JSON.stringify(sampleProfile())]]));
  app.element('flow').value='1,5';
  await app.callback('microphone','click')();
  await app.callback('autoStart','click')();
  app.setAudio(-82);app.frame(1000);app.frame(1500);
  app.setAudio(-105);app.frame(1670);app.frame(1920);
  assert.equal(app.store.has('acoustic-mixture-counter-v1-cycles'),false);
  app.setAudio(-82);
  app.frame(2000);app.frame(2450);app.frame(12400);app.frame(14400);
  app.setAudio(-105);app.frame(14500);app.frame(15250);
  const cycles=JSON.parse(app.store.get('acoustic-mixture-counter-v1-cycles'));
  assert.equal(cycles.length,1);
  assert.equal(cycles[0].buzzElapsed,12500);
  assert.equal(cycles[0].extraMs,2000);
  assert.equal(cycles[0].elapsed,14500);
  assert.equal(cycles[0].volume,1.5*14.5/60);
});
test('manual cycle gets zero correction and previous journal entry stays unchanged',()=>{
  const old={elapsed:12500,flow:1.5,volume:0.3125,source:'auto'};
  const app=boot(new Map([['acoustic-mixture-counter-v1-cycles',JSON.stringify([old])]]));
  app.element('flow').value='1,5';
  app.setClock(1000);app.callback('manualStart','click')();
  app.setClock(13000);app.callback('manualStop','click')();
  const cycles=JSON.parse(app.store.get('acoustic-mixture-counter-v1-cycles'));
  assert.equal(cycles.length,2);
  assert.deepEqual(cycles[0],old);
  assert.equal(cycles[1].extraMs,0);
  assert.equal(cycles[1].buzzElapsed,12000);
  assert.equal(cycles[1].elapsed,12000);
  assert.equal(cycles[1].volume,0.3);
});
test('interrupted automatic cycle is flagged and omits unobserved trailing second',async()=>{
  const app=boot(new Map([[profileKey,JSON.stringify(sampleProfile())]]));
  app.element('flow').value='1,5';
  await app.callback('microphone','click')();
  await app.callback('autoStart','click')();
  app.setAudio(-82);
  app.frame(1000);app.frame(1450);app.frame(11250);app.frame(13000);
  app.setClock(13500);app.callback('autoStop','click')();
  const c=JSON.parse(app.store.get('acoustic-mixture-counter-v1-cycles'))[0];
  assert.equal(c.buzzElapsed,12500);
  assert.equal(c.extraMs,1000);
  assert.equal(c.elapsed,13500);
  assert.equal(c.interrupted,true);
});

test('compensation starts at unity and is shown next to total volume',()=>{
  const app=boot();
  app.frame(1000);
  assert.equal(app.element('total').textContent,'0,000');
  assert.equal(app.element('compensationK').textContent,'1');
  assert.equal(app.element('compensationPercent').textContent,'+0,000 %');
});
test('saved volume gives linear compensation +0.74 percent per 10 liters',()=>{
  const mk=(volume)=>{
    const store=new Map([['acoustic-mixture-counter-v1-cycles',JSON.stringify([{elapsed:60000,flow:volume,volume}])]]);
    const app=boot(store);app.frame(1000);return app;
  };
  for(const [vol,k,pct] of [
    [0,'1','+0,000 %'],
    [1,'1,00074','+0,074 %'],
    [5,'1,0037','+0,370 %'],
    [10,'1,0074','+0,740 %'],
    [20,'1,0148','+1,480 %'],
    [25,'1,0185','+1,850 %']
  ]){
    const app=mk(vol);
    assert.equal(app.element('compensationK').textContent,k);
    assert.equal(app.element('compensationPercent').textContent,pct);
    assert.equal(app.element('total').textContent,vol.toLocaleString('ru-RU',{minimumFractionDigits:3,maximumFractionDigits:3}));
  }
});
test('compensation responds to current cycle and journal reset without modifying volume',()=>{
  const app=boot();
  app.element('flow').value='60';
  app.setClock(1000);
  app.callback('manualStart','click')();
  app.frame(11000);
  assert.equal(app.element('total').textContent,'10,000');
  assert.equal(app.element('compensationK').textContent,'1,0074');
  app.callback('manualStop','click')();
  const saved=JSON.parse(app.store.get('acoustic-mixture-counter-v1-cycles'));
  assert.equal(saved[0].volume,10);
  assert.equal(saved[0].elapsed,10000);
  app.callback('reset','click')();
  app.frame(11100);
  assert.equal(app.element('total').textContent,'0,000');
  assert.equal(app.element('compensationK').textContent,'1');
});

test('six square numbered tabs exist and begin with independent zero totals',()=>{
  const app=boot();
  for(let i=1;i<=6;i++){
    assert.ok(app.element('tab'+i),'Tab '+i+' should be present');
    app.callback('tab'+i,'click')();
    app.frame(2000+i*100);
    assert.equal(app.element('activeTabNumber').textContent,String(i));
    assert.equal(app.element('total').textContent,'0,000');
    assert.equal(app.element('compensationK').textContent,'1');
    assert.equal(app.element('cycles').textContent,'0');
  }
});
test('each tab has separate flow, measurement journal and coefficient, with original data in tab 1',()=>{
  const old=[{elapsed:10000,flow:60,volume:10,source:'manual'}];
  const store=new Map([
    ['acoustic-mixture-counter-v1-cycles',JSON.stringify(old)],
    ['acoustic-mixture-counter-v1-flow','60']
  ]);
  const app=boot(store);
  app.frame(1000);
  assert.equal(app.element('total').textContent,'10,000');
  assert.equal(app.element('compensationK').textContent,'1,0074');
  assert.equal(app.element('flow').value,'60');
  app.callback('tab2','click')();
  app.frame(2000);
  assert.equal(app.element('total').textContent,'0,000');
  assert.equal(app.element('compensationK').textContent,'1');
  assert.equal(app.element('flow').value,'');
  app.element('flow').value='120';
  app.callback('flow','input')();
  app.setClock(3000);app.callback('manualStart','click')();
  app.setClock(8000);app.callback('manualStop','click')();
  app.frame(8100);
  assert.equal(app.element('total').textContent,'10,000');
  assert.equal(app.element('compensationK').textContent,'1,0074');
  assert.equal(app.store.get('acoustic-mixture-counter-v1-flow-tab-2'),'120');
  assert.equal(JSON.parse(app.store.get('acoustic-mixture-counter-v1-cycles-tab-2')).length,1);
  assert.deepEqual(JSON.parse(app.store.get('acoustic-mixture-counter-v1-cycles')),old);
  app.callback('tab1','click')();app.frame(9000);
  assert.equal(app.element('flow').value,'60');
  assert.equal(app.element('total').textContent,'10,000');
  app.callback('tab3','click')();app.frame(9100);
  assert.equal(app.element('total').textContent,'0,000');
  app.callback('tab2','click')();app.frame(9200);
  assert.equal(app.element('flow').value,'120');
  assert.equal(app.element('total').textContent,'10,000');
});
test('selected tab and all six tab values survive reload while sound profile stays common',()=>{
  const store=new Map([
    [profileKey,JSON.stringify(sampleProfile())],
    ['acoustic-mixture-counter-v1-cycles-tab-4',JSON.stringify([{elapsed:60000,flow:20,volume:20,source:'auto'}])],
    ['acoustic-mixture-counter-v1-flow-tab-4','20']
  ]);
  const app=boot(store);
  app.callback('tab4','click')();app.frame(2000);
  assert.equal(app.element('activeTabNumber').textContent,'4');
  assert.equal(app.element('total').textContent,'20,000');
  assert.equal(app.element('compensationK').textContent,'1,0148');
  const fresh=boot(store);fresh.frame(1000);
  assert.equal(fresh.element('activeTabNumber').textContent,'4');
  assert.equal(fresh.element('total').textContent,'20,000');
  assert.equal(fresh.element('flow').value,'20');
  assert.equal(fresh.element('compensationK').textContent,'1,0148');
  assert.equal(fresh.element('profileStatus').textContent.includes('сохранён'),true);
  fresh.callback('tab1','click')();fresh.frame(1100);
  assert.equal(fresh.element('profileStatus').textContent.includes('сохранён'),true);
});
test('tab switching is blocked during automatic monitoring or manual cycle',async()=>{
  const store=new Map([[profileKey,JSON.stringify(sampleProfile())]]);
  const app=boot(store);
  app.element('flow').value='60';
  await app.callback('microphone','click')();
  await app.callback('autoStart','click')();
  app.callback('tab6','click')();
  assert.equal(app.element('activeTabNumber').textContent,'1');
  app.callback('autoStop','click')();
  app.callback('tab6','click')();
  assert.equal(app.element('activeTabNumber').textContent,'6');
  app.element('flow').value='60';
  app.callback('manualStart','click')();
  app.callback('tab5','click')();
  assert.equal(app.element('activeTabNumber').textContent,'6');
  app.callback('manualStop','click')();
  app.callback('tab5','click')();
  assert.equal(app.element('activeTabNumber').textContent,'5');
});
test('resetting one tab never erases the other tabs or acoustic profile',()=>{
  const store=new Map([
    [profileKey,JSON.stringify(sampleProfile())],
    ['acoustic-mixture-counter-v1-cycles',JSON.stringify([{elapsed:10000,flow:60,volume:10}])],
    ['acoustic-mixture-counter-v1-cycles-tab-2',JSON.stringify([{elapsed:5000,flow:60,volume:5}])]
  ]);
  const app=boot(store);
  app.callback('tab2','click')();app.frame(1000);
  assert.equal(app.element('total').textContent,'5,000');
  app.callback('reset','click')();app.frame(1100);
  assert.equal(app.element('total').textContent,'0,000');
  assert.equal(app.element('compensationK').textContent,'1');
  assert.ok(store.has(profileKey));
  app.callback('tab1','click')();app.frame(1200);
  assert.equal(app.element('total').textContent,'10,000');
  assert.equal(app.element('compensationK').textContent,'1,0074');
  assert.equal(JSON.parse(store.get('acoustic-mixture-counter-v1-cycles-tab-2')).length,0);
});

test('quick microphone and auto buttons sit immediately under tab row above results',()=>{
  const marker=html.indexOf('class="quick-actions"');
  assert.ok(marker>html.indexOf('id="tab6"'));
  assert.ok(marker<html.indexOf('aria-label="Результаты измерений"'));
  const section=html.slice(marker,html.indexOf('</section>',marker));
  for(const id of ['microphone','microphoneOff','autoStart','autoStop']){
    assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,'Unique control '+id);
    assert.ok(section.includes('id="'+id+'"'),'Control in quick actions: '+id);
  }
});
test('quick actions replace microphone start with disconnect and auto start with stop',async()=>{
  const app=boot(new Map([[profileKey,JSON.stringify(sampleProfile())]]));
  app.element('flow').value='1,5';
  assert.equal(app.element('microphone').hidden,false);
  assert.equal(app.element('microphoneOff').hidden,true);
  assert.equal(app.element('autoStart').hidden,false);
  assert.equal(app.element('autoStop').hidden,true);
  await app.callback('microphone','click')();
  assert.equal(app.element('microphone').hidden,true);
  assert.equal(app.element('microphoneOff').hidden,false);
  assert.equal(app.element('autoStart').disabled,false);
  await app.callback('autoStart','click')();
  assert.equal(app.element('autoStart').hidden,true);
  assert.equal(app.element('autoStop').hidden,false);
  app.callback('autoStop','click')();
  assert.equal(app.element('autoStart').hidden,false);
  assert.equal(app.element('autoStop').hidden,true);
  await app.callback('microphoneOff','click')();
  assert.equal(app.element('microphone').hidden,false);
  assert.equal(app.element('microphoneOff').hidden,true);
});
test('quick start remains disabled until profile and flow are ready',async()=>{
  const app=boot();
  await app.callback('microphone','click')();
  assert.equal(app.element('autoStart').hidden,false);
  assert.equal(app.element('autoStart').disabled,true);
});
