function startOwnerPwa({bindBackdrop}) {
 const button=document.getElementById('global-install');
 const installed=matchMedia('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: fullscreen), (display-mode: window-controls-overlay)');
 let promptEvent=null,completed=false,dialog=null;
 const isInstalled=()=>completed||installed.matches||navigator.standalone===true;
 const update=()=>{button.hidden=isInstalled();};
 window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();promptEvent=event;update();});
 window.addEventListener('appinstalled',()=>{completed=true;promptEvent=null;dialog?.close();update();});
 installed.addEventListener('change',update);window.addEventListener('pageshow',update);update();
 button.addEventListener('click',async()=>{
  if(isInstalled())return;
  if(promptEvent){const pending=promptEvent;promptEvent=null;button.disabled=true;try{await pending.prompt();const choice=await pending.userChoice;if(choice?.outcome==='accepted')completed=true;}catch{/* Manual instructions remain available when the browser declines. */}finally{button.disabled=false;update();}return;}
  if(!dialog){
   dialog=document.createElement('dialog');dialog.id='pwa-install-dialog';dialog.setAttribute('aria-labelledby','pwa-install-heading');
   const appleMobile=/iPhone|iPad|iPod/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
   const macSafari=/Macintosh/.test(navigator.userAgent)&&/Safari/.test(navigator.userAgent)&&!/Chrome|Chromium/.test(navigator.userAgent);
   const copy=appleMobile?'Open your browser’s Share menu, choose Add to Home Screen, then tap Add. Your private chat address stays with the app.':macSafari?'In Safari, open File → Add to Dock, then choose Add. Your private chat address stays with the app.':'Open your browser’s menu and choose Install app or Add to Home Screen. If that option is missing, open Codexify in a browser that supports web apps.';
   const title=document.createElement('h2');title.id='pwa-install-heading';title.textContent='Install Codexify';const text=document.createElement('p');text.textContent=copy;
   const done=document.createElement('button');done.type='button';done.textContent='Got it';done.addEventListener('click',()=>dialog.close());dialog.append(title,text,done);document.body.append(dialog);bindBackdrop(dialog,()=>dialog.close());
  }
  dialog.showModal();
 });
}
