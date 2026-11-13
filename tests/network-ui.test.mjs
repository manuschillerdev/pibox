import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { loadTypeScript } from './load-typescript.mjs';
const { NetworkOverlay } = await loadTypeScript('../src/network-ui.ts');
const { WorkerNetwork } = await loadTypeScript('../src/network.ts');
const tick=()=>new Promise(r=>setImmediate(r));
const theme={fg:(_color,text)=>text,bg:(_color,text)=>text,bold:text=>text};
const listener=(i=0)=>({host:'127.0.0.1',address:'0.0.0.0',port:8080+i,process:'docker:shop-web',docker:{id:`web-${i}`,name:`shop-web-${i}`,containerPort:80,project:'shop',service:'web',replica:String(i)}});
async function fixture(rows,height=24){
  const network=new WorkerNetwork({publishTcp:async()=>12345,unpublishTcp:async()=>{}},'worker','/fixture');
  network.discover=async()=>rows;
  let closed=0;
  const ui=new NetworkOverlay(network,'worker',theme,()=>{},()=>closed++,async()=>{},()=>height);
  await tick();
  return {ui,network,get closed(){return closed;},setHeight(value){height=value;},dispose(){ui.dispose();}};
}

test('compact bordered service table moves selected URL below rows, with prefilled compose/container forms',async()=>{
  const row=listener();const f=await fixture([row]);
  try {
    let screen=f.ui.render(90);
    assert.ok(screen[0].startsWith('╭'));assert.ok(screen.at(-1).endsWith('╯'));
    assert.ok(screen.every(line=>visibleWidth(line)===90));
    assert.match(screen.join('\n'),/shop \/ web/);
    f.ui.handleInput('\r');
    assert.equal(f.ui.input.getValue(),'shop-web');
    assert.match(f.ui.render(90).join('\n'),/http:\/\/shop-web\.pibox-[a-f0-9]{8}\.pibox\.test/);
    f.ui.handleInput('\x1b');
    f.network.published.set('127.0.0.1:8080',{listener:row,name:'custom',mode:'http',hostPort:12345,endpoint:'http://custom.pibox-12345678.localhost'});
    screen=f.ui.render(90);
    const rowLine=screen.findIndex(line=>line.includes('shop / web'));
    const urlLine=screen.findIndex(line=>line.includes('http://custom'));
    assert.ok(urlLine>rowLine);assert.match(screen[rowLine],/Published/);
    f.ui.handleInput('\r');assert.equal(f.ui.input.getValue(),'custom');
  } finally {f.dispose();}
  const plain=await fixture([{...row,docker:{...row.docker,name:'hello-world',project:'',service:''}}]);
  try {plain.ui.handleInput('\r');assert.equal(plain.ui.input.getValue(),'hello-world');}finally{plain.dispose();}
});

test('large lists scroll to selection and keep footer and borders inside height on resize',async()=>{
  const f=await fixture(Array.from({length:100},(_,i)=>listener(i)));
  try {
    for (const height of [12,16,24,40]) {
      f.setHeight(height);
      for (const width of [12,24,40,60,90,120]) {
        let screen=f.ui.render(width);
        for(let i=0;i<15;i++)f.ui.handleInput('\x1b[B');
        screen=f.ui.render(width);
        assert.ok(screen.length<=height,`${height} rows at width ${width}`);
        assert.ok(screen.every(line=>visibleWidth(line)<=Math.min(90,width)));
        assert.match(screen.join('\n'),/Esc/);
        if(width>=24){
          assert.ok(screen.at(-1).endsWith('╯'));
          const selected=f.ui.list.getSelectedItem();
          assert.ok(screen.some(line=>line.includes(selected.label.split(' ')[0])));
        }
      }
    }
    const before=f.ui.list.getSelectedItem().value;
    await f.ui.refresh();f.ui.render(90);
    assert.equal(f.ui.list.getSelectedItem().value,before);
  }finally{f.dispose();}
});

test('stopped cleanup entries stay manageable and malicious labels/errors never emit terminal escapes',async()=>{
  const row=listener();row.docker.project='shop\x1b]52;c;bad\x07';row.docker.service='web\u202e';
  const f=await fixture([row]);
  try {
    f.network.published.set('127.0.0.1:8080',{listener:row,name:'saved',mode:'http',hostPort:12345,endpoint:'http://saved.localhost',error:'Cleanup failed \x1b]52;c;error\x07'});
    f.network.discover=async()=>[];await f.ui.refresh();
    let screen=f.ui.render(90).join('\n');
    assert.match(screen,/Cleanup needed/);assert.match(screen,/Cleanup failed/);
    assert.doesNotMatch(screen,/[\x07\u202e]|\x1b\]52/g);
    f.ui.handleInput('\r');screen=f.ui.render(90).join('\n');
    assert.doesNotMatch(screen,/[\x07\u202e]|\x1b\]52/g);
    assert.equal(f.ui.input.getValue(),'saved');
    f.ui.handleInput('\x1b');f.ui.handleInput('u');await tick();
    assert.equal(f.network.published.size,0);
  }finally{f.dispose();}
});
test('name paste cannot inject terminal escapes; focus is forwarded to the input',async()=>{
  const f=await fixture([listener()]);
  try {
    f.ui.handleInput('\r');f.ui.focused=true;assert.equal(f.ui.input.focused,true);
    f.ui.handleInput('\x1b[200~\x1b]52;c;payload\x07\u202e\x1b[201~');
    assert.doesNotMatch(f.ui.input.getValue(),/[\x1b\x07\u202e]/);
    assert.doesNotMatch(f.ui.render(90).join('\n'),/\x1b\]52/);
    f.ui.focused=false;assert.equal(f.ui.input.focused,false);
  }finally{f.dispose();}
});
test('tiny terminals never accept an invisible publish action',async()=>{
  const f=await fixture([listener()]);
  try {
    f.ui.handleInput('\r');let published=0;f.network.publish=async()=>published++;
    f.ui.render(12);f.ui.handleInput('\r');await tick();assert.equal(published,0);
    f.ui.handleInput('\x1b');assert.equal(f.closed,1);
  }finally{f.dispose();}
});
test('short form keeps name, mode and actions visible after invalid save and mode toggle',async()=>{
  const f=await fixture([listener()],12);
  try {
    f.ui.handleInput('\r');f.ui.input.setValue('invalid_name');
    let publishes=0;f.network.publish=async()=>publishes++;
    f.ui.handleInput('\r');await tick();
    for(const width of [60,24]) {
      let screen=f.ui.render(width).map(stripVTControlCharacters);
      assert.ok(screen.length<=12);assert.ok(screen.every(line=>visibleWidth(line)<=width));
      assert.match(screen.join('\n'),/Name/);
      assert.match(screen.join('\n'),/invalid_name/);
      assert.match(screen.join('\n'),/Access: HTTP/);
      assert.match(screen.join('\n'),/Enter Save/);
      assert.match(screen.join('\n'),/Esc Back/);
      f.ui.handleInput('\t');screen=f.ui.render(width);
      assert.match(screen.join('\n'),/Access: TCP/);
      assert.match(screen.join('\n'),/Tab/);
      f.ui.handleInput('\t');
    }
    assert.equal(publishes,0);
    f.setHeight(11);f.ui.render(60);
    f.ui.handleInput('\t');assert.equal(f.ui.mode,'http');
    f.ui.input.setValue('valid');f.ui.handleInput('\r');await tick();
    assert.equal(publishes,0);
  }finally{f.dispose();}
});

test('HTTP publish requires explicit hostname setup confirmation',async()=>{
 const f=await fixture([listener()]);let publishes=0,confirms=0;
 f.network.publish=async()=>{publishes++;};
 try {
  f.ui.render(90);f.ui.handleInput('\r');f.ui.handleInput('\r');await tick();
  assert.equal(publishes,0);assert.match(f.ui.render(90).join('\n'),/cancelled/);
  f.ui.confirmHttp=async()=>{confirms++;return true;};f.ui.handleInput('\r');await tick();
  assert.equal(confirms,1);assert.equal(publishes,1);
 }finally{f.dispose();}
});

test('overlay does not collapse a HTTP 502 into a healthy readiness label',async()=>{
 const row=listener(),f=await fixture([row],26);
 try {
  f.network.published.set('127.0.0.1:8080',{listener:row,name:'web',mode:'http',hostPort:12345,endpoint:'http://web.pibox-test.pibox.test',readiness:{host:'HTTP reachable (OS resolution) · HTTP 502 · upstream unavailable',guest:'HTTP reachable (curl) · HTTP 401',docker:'Not connected'}});
  const screen=f.ui.render(90).join('\n');
  assert.match(screen,/Host: HTTP 502 · upstream unavailable/);
  assert.match(screen,/Guest: HTTP 401/);
 }finally{f.dispose();}
});
