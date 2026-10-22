(() => {
  "use strict";
  window.CodexifyChatAttachments = class {
    constructor({scope,bridge,saved,changed,error,canOperate}) {
      Object.assign(this,{scope,bridge,changed,error,canOperate});this.items=[];this.closed=false;this.controllers=new Set();this.urls=new Set();this.dragDepth=0;
      const composer=scope.getElementById('composer');
      this.row=document.createElement('div');this.row.className='draft-attachments';this.row.hidden=true;this.row.setAttribute('aria-label','Attachments');composer.prepend(this.row);
      this.picker=document.createElement('input');this.picker.type='file';this.picker.multiple=true;this.picker.hidden=true;this.picker.setAttribute('aria-label','Choose attachments');composer.append(this.picker);
      this.add=document.createElement('button');this.add.type='button';this.add.className='icon-button attach-button';this.add.id='attach-files';this.add.setAttribute('aria-label','Attach files');this.add.title='Attach files';
      this.add.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
      const tools=scope.getElementById('composer-tools');if(tools)tools.insertBefore(this.add,tools.firstChild);else composer.insertBefore(this.add,scope.getElementById('send'));
      this.add.onclick=()=>this.picker.click();this.picker.onchange=()=>{this.addFiles([...this.picker.files],false);this.picker.value='';};
      this.input=scope.getElementById('draft');
      this.paste=event=>{
        if(!this.canOperate()||scope.activeElement!==this.input)return;
        const files=[...(event.clipboardData?.files||[])];if(!files.length)return;
        event.preventDefault();
        const text=event.clipboardData.getData('text/plain');
        if(text){this.input.setRangeText(text,this.input.selectionStart,this.input.selectionEnd,'end');this.input.dispatchEvent(new Event('input',{bubbles:true}));}
        void this.addFiles(files,true);
      };
      this.input.addEventListener('paste',this.paste);
      this.dropTarget=bridge.fileDropTarget||scope.getElementById('chat');
      this.overlayRoot=scope.nodeType===Node.DOCUMENT_NODE?scope.body:scope;
      this.overlay=document.createElement('div');this.overlay.className='attachment-drop-overlay';this.overlay.hidden=true;this.overlay.setAttribute('role','status');this.overlay.textContent='Drop the file here to attach it';this.overlayRoot.append(this.overlay);
      const fileDrag=event=>[...(event.dataTransfer?.types||[])].includes('Files');
      this.enter=event=>{if(fileDrag(event)&&this.canOperate()){event.preventDefault();this.dragDepth++;this.overlay.hidden=false;}};
      this.over=event=>{if(fileDrag(event)){event.preventDefault();if(this.canOperate()){event.dataTransfer.dropEffect='copy';this.overlay.hidden=false;}}};
      this.leave=event=>{if(fileDrag(event)){event.preventDefault();this.dragDepth=Math.max(0,this.dragDepth-1);if(!this.dragDepth)this.overlay.hidden=true;}};
      this.drop=event=>{if(!fileDrag(event))return;event.preventDefault();this.dragDepth=0;this.overlay.hidden=true;if(this.canOperate())void this.addFiles([...(event.dataTransfer?.files||[])],false);};
      for(const [name,handler] of [['dragenter',this.enter],['dragover',this.over],['dragleave',this.leave],['drop',this.drop]])this.dropTarget.addEventListener(name,handler);
      for(const record of Array.isArray(saved)?saved:[])if(this.valid(record))this.items.push({key:record.id,record,state:'ready'});
      this.renderDraft();
      for(const item of this.items)void bridge.getAttachment(item.record.id).then(record=>{if(this.closed)return;item.record=record;if(!record.exists){item.state='failed';item.error='File is missing. Remove it and attach it again.';}this.renderDraft();this.changed();}).catch(()=>{if(this.closed)return;item.state='failed';item.error='Could not load this attachment';this.renderDraft();this.changed();});
    }
    valid(a){return a&&/^[a-f0-9]{32}$/i.test(a.id)&&typeof a.originalName==='string'&&typeof a.mimeType==='string';}
    snapshot(){return this.items.filter(i=>i.state==='ready').map(i=>i.record);}
    blocked(){return this.items.some(i=>i.state!=='ready');}
    count(){return this.items.length;}
    update(){this.add.disabled=!this.canOperate();}
    thumbnailUrl(record){return this.bridge.attachmentThumbnailUrl?.(record.id)||this.bridge.attachmentUrl(record.id);}
    isPastedImage(record){return record.pasted===true&&record.mimeType.startsWith('image/');}
    displayName(record){return this.isPastedImage(record)?'Pasted image':record.originalName;}
    formatSize(n){if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KiB`;return `${(n/1048576).toFixed(1)} MiB`;}
    fileIcon(type){
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
      const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',type.startsWith('video/')?'M4 3h10l6 6v12H4Zm10 0v6h6M9 11v7l6-3.5Z':'M4 3h10l6 6v12H4Zm10 0v6h6M8 13h8M8 17h6');svg.append(path);return svg;
    }
    card(record,url,onClick){
      const card=document.createElement('button');card.type='button';card.className='attachment-card';
      const label=this.displayName(record);
      card.setAttribute('aria-label',`Open attachment ${label}`);
      card.title=`${label}\n${record.mimeType} · ${this.formatSize(record.size||0)}\nCreated: ${record.createdAt||'Uploading'}\nModified: ${record.lastModifiedAt||'Unknown'}`;
      const visual=document.createElement('span');visual.className='attachment-visual';
      if(record.mimeType.startsWith('image/')&&url){
        const image=document.createElement('img');image.alt=label;image.loading='lazy';image.decoding='async';image.src=url;image.onerror=()=>{visual.replaceChildren(this.fileIcon(record.mimeType));};visual.append(image);
      }else visual.append(this.fileIcon(record.mimeType));
      const size=document.createElement('span');size.className='attachment-size';size.textContent=this.formatSize(record.size||0);
      card.append(visual);
      if(!this.isPastedImage(record)){const name=document.createElement('span');name.className='attachment-name';name.textContent=record.originalName;card.append(name);}
      card.append(size);card.onclick=onClick;return card;
    }
    renderDraft(){
      const history=this.scope.getElementById('messages'),top=history.scrollTop,bottom=history.scrollHeight-top-history.clientHeight<50;
      this.row.replaceChildren();this.row.hidden=!this.items.length;
      for(const item of this.items){
        const record=item.record||{originalName:item.file.name||'Pasted image.png',mimeType:item.file.type,size:item.file.size,pasted:item.pasted};
        const wrapper=document.createElement('div');wrapper.className='draft-attachment';
        const url=item.preview||(item.record?this.thumbnailUrl(item.record):null);
        const card=this.card(record,url,()=>{if(item.state==='ready')this.open(item.record);});
        if(item.state!=='ready')card.disabled=true;
        card.querySelector('.attachment-size').textContent=item.state==='uploading'?'Uploading…':item.state==='failed'?item.error:this.formatSize(record.size);
        const remove=document.createElement('button');remove.type='button';remove.className='attachment-remove';remove.setAttribute('aria-label',`Remove attachment ${this.displayName(record)}`);remove.title='Remove attachment';remove.textContent='×';
        remove.onclick=()=>{item.controller?.abort();this.items=this.items.filter(i=>i!==item);if(item.preview){URL.revokeObjectURL(item.preview);this.urls.delete(item.preview);}this.renderDraft();this.changed();};
        wrapper.append(card,remove);
        if(item.state==='failed'&&item.file){const retry=document.createElement('button');retry.type='button';retry.className='attachment-upload-retry';retry.textContent='Retry upload';retry.onclick=()=>void this.upload(item);wrapper.append(retry);}
        this.row.append(wrapper);
      }
      history.scrollTop=bottom?history.scrollHeight:top;
    }
    async addFiles(files,pasted){
      if(this.closed||!this.canOperate())return;
      this.closeViewer();
      if(files.length+this.items.length>20){this.error('Attach up to 20 files to one prompt');return;}
      const added=[];
      for(const file of files){const item={key:crypto.randomUUID(),file,pasted,state:'uploading'};
        if(file.type.startsWith('image/')){item.preview=URL.createObjectURL(file);this.urls.add(item.preview);}this.items.push(item);added.push(item);
      }
      this.renderDraft();this.changed();this.input.focus();
      for(const item of added)if(this.items.includes(item)&&!this.closed)await this.upload(item);
    }
    async upload(item){
      if(this.closed||!this.items.includes(item))return;
      item.state='uploading';item.error=null;item.controller=new AbortController();this.controllers.add(item.controller);this.renderDraft();this.changed();
      try {
        const record=await this.bridge.uploadAttachment(item.file,item.pasted,item.key,item.controller.signal);
        if(this.closed||!this.items.includes(item))return;
        if(!this.valid(record))throw new Error('The upload returned invalid attachment metadata');
        item.record=record;item.state='ready';
        if(item.preview){URL.revokeObjectURL(item.preview);this.urls.delete(item.preview);item.preview=null;}
      }catch(error){if(this.closed||!this.items.includes(item))return;item.state='failed';item.error=error.message||'Attachment upload failed';this.error(item.error);}
      finally{this.controllers.delete(item.controller);if(!this.closed){this.renderDraft();this.changed();}}
    }
    consume(){const files=this.snapshot();this.items=[];this.renderDraft();return files;}
    renderMessage(container,records){
      const valid=(Array.isArray(records)?records:[]).filter(a=>this.valid(a));const signature=JSON.stringify(valid);
      if(container.dataset.attachments===signature)return;container.dataset.attachments=signature;container.replaceChildren();container.hidden=!valid.length;
      for(const record of valid)container.append(this.card(record,this.thumbnailUrl(record),()=>this.open(record)));
    }
    open(record){
      if(!record.mimeType.startsWith('image/')&&!record.mimeType.startsWith('video/')){
        const download=document.createElement('a');download.href=this.bridge.attachmentUrl(record.id,true);download.download=record.originalName;download.hidden=true;this.overlayRoot.append(download);download.click();download.remove();return;
      }
      this.closeViewer();const previous=this.scope.activeElement;
      const label=this.displayName(record);
      const viewer=document.createElement('div');viewer.className='attachment-viewer';viewer.setAttribute('role','dialog');viewer.setAttribute('aria-modal','true');viewer.setAttribute('aria-label',label);
      const close=document.createElement('button');close.type='button';close.className='attachment-viewer-close';close.setAttribute('aria-label','Close attachment preview');close.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 14 14M19 5 5 19"/></svg>';
      const download=document.createElement('a');download.className='attachment-viewer-download';download.textContent='Download original';download.href=this.bridge.attachmentUrl(record.id,true);download.download=record.originalName;
      const media=document.createElement(record.mimeType.startsWith('image/')?'img':'video');media.src=this.bridge.attachmentUrl(record.id);if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';}else media.alt=label;
      viewer.append(close,download,media);
      if(!this.isPastedImage(record)){const name=document.createElement('div');name.className='attachment-viewer-name';name.textContent=record.originalName;viewer.append(name);}
      this.overlayRoot.append(viewer);this.viewer=viewer;
      this.viewerCleanup=()=>{if(media.tagName==='VIDEO')media.pause();media.removeAttribute('src');document.removeEventListener('keydown',this.viewerKey);viewer.remove();if(previous?.isConnected)previous.focus();};
      close.onclick=()=>this.closeViewer();viewer.onclick=event=>{if(event.target===viewer)this.closeViewer();};
      this.viewerKey=event=>{if(event.key==='Escape'){event.preventDefault();this.closeViewer();}else if(event.key==='Tab'){const controls=[close,download,...(media.tagName==='VIDEO'?[media]:[])],current=this.scope.activeElement,index=controls.indexOf(current),next=(index+(event.shiftKey?-1:1)+controls.length)%controls.length;event.preventDefault();controls[next].focus();}};
      document.addEventListener('keydown',this.viewerKey);close.focus();
    }
    closeViewer(){this.viewerCleanup?.();this.viewerCleanup=null;this.viewer=null;}
    close(){this.closed=true;this.closeViewer();for(const controller of this.controllers)controller.abort();for(const url of this.urls)URL.revokeObjectURL(url);this.input.removeEventListener('paste',this.paste);for(const [name,handler]of[['dragenter',this.enter],['dragover',this.over],['dragleave',this.leave],['drop',this.drop]])this.dropTarget.removeEventListener(name,handler);this.overlay.remove();}
  };
})();
