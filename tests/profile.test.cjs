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
