import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import test from 'node:test';
import {ownerHtml} from './owner-chat-source.mjs';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const META='io.github.devnoname120/codexify/markdown-chat';
const png=readFileSync(new URL('../tests/fixtures/attachment-image.png',import.meta.url));
const video=readFileSync(new URL('../tests/fixtures/attachment-video.mp4',import.meta.url));

for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]]) {
test(`${name}: attachments support paste focus, page-wide drop, drafts, retries, media and downloads`,{timeout:45000},async()=>{
 const browser=await engine.launch();let server;
 try {
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:900}}),page=await context.newPage();page.setDefaultTimeout(5000);
  const id='8'.repeat(64),files=new Map(),uploads=[],sent=[],errors=[];let failNext=false;
  page.on('pageerror',e=>errors.push(e.message));
  const messages=[];let revision=0;
  const handler=async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:ownerHtml});
   if(path==='/api/chats')return route.fulfill({headers:{'set-cookie':'codexify-attachment=test-token; Path=/api/chats/; HttpOnly; SameSite=Strict'},json:{chats:[{id,title:'Attachment test',workspace:'test',lastEntryEnd:revision,lastEntryAtMs:Date.now(),lastAgentCallAtMs:Date.now(),agentWaitingUntilMs:Date.now()+120000,totalToolCalls:0}],serverTimeMs:Date.now()}});
   if(path.endsWith('/automation'))return route.fulfill({json:{enabled:true,goal:null,pairing:{status:'unpaired'},action:{status:'idle'},companion:{authenticated:false},presence:{lastAgentCallAtMs:Date.now(),agentWaitingUntilMs:Date.now()+120000},serverTimeMs:Date.now()}});
   if(path.endsWith('/attachments')&&request.method()==='POST'){
    const data=request.postDataBuffer()||Buffer.alloc(0),filename=url.searchParams.get('name'),requestId=url.searchParams.get('requestId');uploads.push({name:filename,pasted:url.searchParams.get('pasted'),requestId,bytes:data});
    if(failNext){failNext=false;return route.fulfill({status:500,body:'Fixture upload failed'});}
    const aid=createHash('sha256').update(requestId).digest('hex').slice(0,32),mime=request.headers()['content-type'];
    const record={id:aid,uniqueName:`attachment-${aid}.${filename.split('.').at(-1)}`,originalName:filename,mimeType:mime,originalMimeType:mime,size:data.length,originalSize:data.length,createdAt:new Date().toISOString(),createdAtMs:Date.now(),lastModifiedAt:new Date(0).toISOString(),lastModifiedAtMs:0,sourceLastModifiedAtMs:0,sourceCreatedAtMs:null,submittedAt:null,submittedAtMs:null,messageId:null,path:`/private/test/attachments/attachment-${aid}`,pasted:url.searchParams.get('pasted')==='true',exists:true};
    files.set(aid,{record,data});return route.fulfill({json:{attachment:record}});
   }
   const match=path.match(/\/attachments\/([a-f0-9]{32})(\/content)?$/);
   if(match){const file=files.get(match[1]);if(!file)return route.fulfill({status:404});
    if(!match[2])return route.fulfill({json:{attachment:file.record}});
    const downloadable=url.searchParams.get('download')==='true'||!file.record.mimeType.match(/^(image|video)\//);
    const headers={'content-type':file.record.mimeType,'accept-ranges':'bytes',...(downloadable?{'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.record.originalName)}`}:{})};
    const range=request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),file.data.length-1):file.data.length-1;return route.fulfill({status:206,headers:{...headers,'content-range':`bytes ${start}-${end}/${file.data.length}`},body:file.data.subarray(start,end+1)});}
    return route.fulfill({headers,body:file.data});
   }
   if(path.endsWith('/send')){
    const body=request.postDataJSON();sent.push(body);revision++;
    const attachments=(body.attachment_ids||[]).map(aid=>{const record=files.get(aid).record;record.messageId=body.request_id;record.submittedAtMs=Date.now();record.submittedAt=new Date().toISOString();return record;});
    messages.push({id:body.request_id,role:'user',markdown:body.message,attachments,start:revision-1,end:revision,created_at_ms:Date.now(),tool_call_count:0});
    return route.fulfill({json:{_meta:{[META]:{sent:{id:body.request_id,end:revision,created_at_ms:Date.now(),tool_call_count:0}}}}});
   }
   return route.fulfill({json:{_meta:{[META]:{chat_file:'/private/test/CHAT.md',revision:String(revision),delivered_through:0,read_through:0,last_agent_call_at_ms:Date.now(),agent_waiting_until_ms:Date.now()+120000,total_tool_calls:0,server_time_ms:Date.now(),messages,has_more:false,unchanged:false}}}});
  };
  server=createServer(async(req,res)=>{
   try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=Buffer.concat(chunks);
    const request={url:()=>`http://127.0.0.1:${server.address().port}${req.url}`,method:()=>req.method,headers:()=>req.headers,postDataBuffer:()=>data,postDataJSON:()=>JSON.parse(data.toString())};
    await handler({request:()=>request,fulfill:async({status=200,headers={},contentType,body,json})=>{
     res.statusCode=status;for(const [key,value]of Object.entries(headers))res.setHeader(key,value);
     if(json!==undefined){res.setHeader('content-type','application/json');body=JSON.stringify(json);}else if(contentType)res.setHeader('content-type',contentType);
     const bytes=Buffer.isBuffer(body)?body:Buffer.from(body||'');res.setHeader('content-length',bytes.length);res.end(bytes);
    }});
   }catch(error){errors.push(error.message);res.statusCode=500;res.end('Fixture error');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await page.goto(`http://127.0.0.1:${server.address().port}/?chat=${id}#test-token`);
  const host=page.locator('#chat-host'),input=host.getByRole('textbox',{name:'Message the agent',exact:true}),picker=host.locator('input[type=file]'),draft=host.locator('.draft-attachments');
  await host.getByRole('button',{name:'Attach files',exact:true}).waitFor();
  await host.getByRole('button',{name:'Stop agent',exact:true}).waitFor();
  await picker.setInputFiles([{name:'picked.png',mimeType:'image/png',buffer:png},{name:'notes résumé.txt',mimeType:'text/plain',buffer:Buffer.from('Some notes')}]);
  await host.getByRole('button',{name:'Open attachment picked.png',exact:true}).waitFor();
  await host.getByRole('button',{name:'Send message',exact:true}).waitFor();assert.equal(await input.inputValue(),'','Attachments switch Stop to Send without text');
  await page.waitForFunction(()=>[...document.querySelector('#chat-host .chat-shell').shadowRoot.querySelectorAll('.draft-attachments .attachment-size')].every(n=>!n.textContent.includes('Uploading')));
  assert.equal(await draft.locator('.attachment-card').count(),2);assert.equal(await draft.locator('img').count(),1,'only images get previews');
  assert.equal(uploads[0].pasted,'false');assert(uploads[0].bytes.equals(png));
  await page.reload();await draft.locator('.attachment-card').first().waitFor();assert.equal(await draft.locator('.attachment-card').count(),2,'ready uploads survive a reload');
  await host.getByRole('button',{name:'Remove attachment picked.png',exact:true}).click();assert.equal(await draft.locator('.attachment-card').count(),1);
  const paste=async()=>input.evaluate((node,bytes)=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(bytes)],'clipboard.png',{type:'image/png',lastModified:0}));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,composed:true,cancelable:true}));},[...png]);
  await page.locator('#chat-search').focus();const beforePaste=uploads.length;await paste();await page.waitForTimeout(100);assert.equal(uploads.length,beforePaste,'paste outside the focused composer is ignored');
  await input.focus();await paste();await host.getByRole('button',{name:'Open attachment clipboard.png',exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelector('#chat-host .chat-shell').shadowRoot.querySelectorAll('.draft-attachments .attachment-size')].every(n=>!n.textContent.includes('Uploading')));
  assert.equal(uploads.at(-1).pasted,'true');
  await page.evaluate(bytes=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(bytes)],'clip.mp4',{type:'video/mp4'}));window.attachmentDrag=dt;document.querySelector('aside header').dispatchEvent(new DragEvent('dragenter',{dataTransfer:dt,bubbles:true,cancelable:true}));},[...video]);
  const overlay=host.getByText('Drop the file here to attach it',{exact:true});await overlay.waitFor();const overlayBox=await overlay.boundingBox();assert(overlayBox.width>=1280&&overlayBox.height>=900,'the drop overlay covers the page');
  await page.evaluate(()=>document.querySelector('aside header').dispatchEvent(new DragEvent('drop',{dataTransfer:window.attachmentDrag,bubbles:true,cancelable:true})));await overlay.waitFor({state:'hidden'});
  await host.getByRole('button',{name:'Open attachment clip.mp4',exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelector('#chat-host .chat-shell').shadowRoot.querySelectorAll('.draft-attachments .attachment-size')].every(n=>!n.textContent.includes('Uploading')));
  assert.equal(uploads.at(-1).pasted,'false');assert.equal(await draft.locator('img').count(),1,'videos have file cards, not thumbnails');
  failNext=true;await picker.setInputFiles({name:'retry.txt',mimeType:'text/plain',buffer:Buffer.from('retry')});await host.getByRole('button',{name:'Retry upload',exact:true}).waitFor();
  assert.equal(await host.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true,'failed files cannot be silently omitted');
  const failedRequest=uploads.at(-1).requestId;await host.getByRole('button',{name:'Retry upload',exact:true}).click();await host.getByRole('button',{name:'Retry upload',exact:true}).waitFor({state:'hidden'});assert.equal(uploads.at(-1).requestId,failedRequest);
  await page.waitForFunction(()=>[...document.querySelector('#chat-host .chat-shell').shadowRoot.querySelectorAll('.draft-attachments .attachment-size')].every(n=>!n.textContent.includes('Uploading')));
  await input.fill('Inspect the attached files');await input.press('Enter');await draft.waitFor({state:'hidden'});await host.locator('.message-attachments .attachment-card').first().waitFor();
  assert.equal(sent.length,1);assert.equal(sent[0].attachment_ids.length,4);assert.equal(sent[0].message,'Inspect the attached files');
  const sentFiles=host.locator('.message-attachments');
  await sentFiles.getByRole('button',{name:'Open attachment clipboard.png',exact:true}).click();await host.getByRole('dialog',{name:'clipboard.png',exact:true}).waitFor();assert.equal(await host.locator('.attachment-viewer img').count(),1);const imageBox=await host.locator('.attachment-viewer img').boundingBox();assert(imageBox.width>160&&imageBox.height>140,'images open at a larger size');await page.keyboard.press('Escape');await host.locator('.attachment-viewer').waitFor({state:'hidden'});
  await sentFiles.getByRole('button',{name:'Open attachment clip.mp4',exact:true}).click();await host.locator('.attachment-viewer video').waitFor();assert.equal(await host.locator('.attachment-viewer video').getAttribute('controls'),'');
  await host.locator('.attachment-viewer video').evaluate(video=>new Promise((resolve,reject)=>{if(video.readyState>=1)return resolve();video.addEventListener('loadedmetadata',resolve,{once:true});video.addEventListener('error',()=>reject(new Error('Fixture video metadata failed')),{once:true});}));
  assert.equal(await host.locator('.attachment-viewer video').evaluate(node=>node.videoWidth),64);await host.getByRole('button',{name:'Close attachment preview',exact:true}).click();
  let resolveDownload;const downloaded=new Promise(resolve=>resolveDownload=resolve);page.on('download',resolveDownload);context.on('page',p=>p.on('download',resolveDownload));
  await sentFiles.getByRole('button',{name:'Open attachment notes résumé.txt',exact:true}).click();const download=await Promise.race([downloaded,new Promise((_,reject)=>setTimeout(()=>reject(new Error('No attachment download')),5000))]);assert.equal(download.suggestedFilename().normalize('NFC'),'notes résumé.txt');
  await picker.setInputFiles({name:'only.txt',mimeType:'text/plain',buffer:Buffer.from('attachment only')});await host.getByRole('button',{name:'Send message',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>[...document.querySelector('#chat-host .chat-shell').shadowRoot.querySelectorAll('.draft-attachments .attachment-size')].every(n=>!n.textContent.includes('Uploading')));
  await input.focus();await input.press('Enter');await draft.waitFor({state:'hidden'});assert.equal(sent.at(-1).message,'');assert.equal(sent.at(-1).attachment_ids.length,1);
  await page.setViewportSize({width:390,height:844});await host.locator('#attach-files:enabled').waitFor();await picker.setInputFiles({name:'mobile.png',mimeType:'image/png',buffer:png});await draft.locator('.attachment-card').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'attachment cards must not make the whole page scroll sideways');
  await page.evaluate(bytes=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(bytes)],'drop.png',{type:'image/png'}));window.mobileDrag=dt;document.querySelector('aside header').dispatchEvent(new DragEvent('dragenter',{dataTransfer:dt,bubbles:true,cancelable:true}));},[...png]);
  await overlay.waitFor();const mobileOverlay=await overlay.boundingBox();assert(mobileOverlay.width>=390&&mobileOverlay.height>=844);await page.evaluate(()=>document.querySelector('aside header').dispatchEvent(new DragEvent('dragleave',{dataTransfer:window.mobileDrag,bubbles:true,cancelable:true})));await overlay.waitFor({state:'hidden'});
  if(process.env.CODEXIFY_WORKSPACE_SCREENSHOTS){mkdirSync(process.env.CODEXIFY_WORKSPACE_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.CODEXIFY_WORKSPACE_SCREENSHOTS}/${name.toLowerCase()}-attachments.png`,fullPage:true});}
  assert.deepEqual(errors,[]);
 }finally{await browser.close();if(server)await new Promise(resolve=>server.close(resolve));}
});
}
