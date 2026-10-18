import {afterAll,beforeAll,expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,type BrowserContext,type Page} from 'patchright';
import {privateChromeExecutable} from '../src/chrome-executable';
import {uiLabels,localizedEffortId,parseEffortAnnouncement} from '../src/ui-localization';
import {browserEffortIdFromLabel,browserModelFamilyFromLabel,readModelOptionRows,modelsFromDiscoveredEfforts} from '../src/models';
import {chatGptEffortLabelFromAnnouncement} from '../src/session';
import {chatGptModelSelectionMatches,selectModelAndEffort,assertSelectedModelAndEffort} from '../src/model-selection';
import {throwIfSessionAttention,toolApprovalVisible} from '../src/browser-session';
import {classifyPlan} from '../src/account-settings';
import {openNewChat} from '../src/new-chat';
import type {SingleBrowserSurface} from '../src/chatgpt-driver';

const native=process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME==='1';
let context:BrowserContext,page:Page,profile:string;
beforeAll(async()=>{
  if(!native)return;
  profile=await mkdtemp(join(tmpdir(),'localized-ui-'));
  const executablePath=await privateChromeExecutable(join(import.meta.dirname,'../.browsers',`${process.platform}-${process.arch}`));
  context=await chromium.launchPersistentContext(profile,{channel:'chrome',executablePath,headless:true});
  page=context.pages()[0]!;
},30_000);
afterAll(async()=>{await context?.close();if(profile)await rm(profile,{recursive:true,force:true});});

test('published effort aliases retain identity and ambiguous translations fail closed',()=>{
  for(const [id,message] of Object.entries({low:'effortInstant',medium:'effortMedium',high:'effortHigh',xhigh:'effortExtraHigh',max:'effortPro'} as const)) {
    for(const label of uiLabels(message)){
      const groups=['effortInstant','effortMedium','effortHigh','effortExtraHigh','effortPro'] as const;
      const ambiguous=groups.filter(group=>uiLabels(group).includes(label)).length>1;
      expect(localizedEffortId(label)).toBe(ambiguous?undefined:id);
    }
  }
  expect(browserEffortIdFromLabel('Μεσαίο')).toBe('medium');
  expect(browserEffortIdFromLabel('Πολύ υψηλό')).toBe('xhigh');
  expect(browserEffortIdFromLabel('Deep')).toMatch(/^effort-/);
  expect(()=>browserEffortIdFromLabel('عالٍ جدًا')).toThrow('ambiguous');
  expect(browserModelFamilyFromLabel('Νεότερο')).toBe('6');
  expect(browserModelFamilyFromLabel('GPT-7')).toBeUndefined();
});

test('published counter formats and Greek position evidence remain tied to the actual range',()=>{
  for(const template of uiLabels('counter')) {
    const text=template.replace('{value}','Μεσαίο').replace('{position}','2').replace('{total}','5');
    expect(parseEffortAnnouncement(text)).toEqual({label:'Μεσαίο',position:2,total:5});
  }
  expect(parseEffortAnnouncement('متوسط، ٢ من أصل ٥.')).toEqual({label:'متوسط',position:2,total:5});
  expect(chatGptEffortLabelFromAnnouncement('Medio, 2 di 5.',{min:7,max:11,value:8})).toBe('Medio');
  expect(chatGptModelSelectionMatches(['Molto alto, 4 di 5.'],'6','xhigh',true,'GPT-6')).toBeTrue();
  expect(chatGptEffortLabelFromAnnouncement('Μεσαίο, 2 από 5.',{min:7,max:11,value:8})).toBe('Μεσαίο');
  expect(chatGptEffortLabelFromAnnouncement('Μεσαίο, 3 από 5.',{min:7,max:11,value:8})).toBeUndefined();
  expect(chatGptEffortLabelFromAnnouncement('Μεσαίο, 2 από 6.',{min:7,max:11,value:8})).toBeUndefined();
  expect(chatGptModelSelectionMatches(['Πολύ υψηλό, 4 από 5.'],'6','xhigh',true,'GPT-6')).toBeTrue();
  expect(chatGptModelSelectionMatches(['GPT-5.6 Μεσαίο, 2 από 5.'],'6','medium',true,'GPT-6')).toBeFalse();
  expect(modelsFromDiscoveredEfforts('6',[{id:'max',label:'pro',available:true,index:4,reason:null}])[0]?.id).toBe('gpt-6-astra');
});

test('localized plan names retain stable classification',()=>{
  expect(classifyPlan('Δωρεάν').kind).toBe('free');
  expect(classifyPlan('免費版').kind).toBe('free');
  expect(classifyPlan('ChatGPT Δωρεάν Πρόγραμμα').kind).toBe('free');
  expect(classifyPlan('Pro 20x').label).toBe('Pro 20x');
  expect(classifyPlan('Free Piano').kind).toBe('free');
  expect(classifyPlan('ChatGPT Pro 20x Piano').kind).toBe('pro');
  expect(classifyPlan('Νέο πρόγραμμα').label).toBe('Νέο πρόγραμμα');
});

test.skipIf(!native)('model identity excludes translated descriptions and rejects an unknown variant',async()=>{
  await page.setContent(`<div role="menu">
    <button role="menuitemradio" aria-checked="true"><span data-menu-row-label>GPT-5.5</span><span data-menu-row-description>Η διαθεσιμότητα αλλάζει στις 20 Οκτωβρίου</span></button>
    <button role="menuitemradio" aria-checked="false">GPT-5.5 Preview</button>
    <button role="menuitemradio" data-model-id="gpt-6-sol" aria-checked="false">GPT-6</button>
    <button role="menuitemradio" data-model-id="gpt-6-sol" aria-checked="false">GPT-5.6</button>
  </div>`);
  expect(await readModelOptionRows(page.locator('[role="menu"]'))).toEqual([
    {family:'5.5',label:'GPT-5.5',checked:true},
    {family:undefined,label:'GPT-5.5 Preview',checked:false},
    {family:'6',label:'GPT-6',checked:false},
    {family:undefined,label:'GPT-5.6',checked:false},
  ]);
});

for(const locale of [
  {
    "code": "el",
    "name": "Greek",
    "search": "Αναζήτηση",
    "think": "Σκέψη",
    "medium": "Μεσαίο",
    "newChat": "Νέα συνομιλία",
    "expired": "Η περίοδος λειτουργίας σου έληξε",
    "rateTitle": "Υπερβολικά πολλά αιτήματα",
    "rateBody": "Στέλνετε αιτήματα πολύ γρήγορα. Περιορίσαμε προσωρινά την πρόσβαση στις συνομιλίες σας για να προστατεύσουμε τα δεδομένα σας.",
    "subscriptionFailure": "Η φόρτωση της συνδρομής απέτυχε: offline. Αν το σφάλμα επιμένει, επισκεφτείτε το help.openai.com και ανοίξτε το συννεφάκι συνομιλίας για να επικοινωνήσετε με την Υποστήριξη.",
    "genericError": "Παρουσιάστηκε σφάλμα",
    "approval": "Να επιτρέπεται στο ChatGPT να χρησιμοποιεί το Fixture;"
  },
  {
    "code": "it",
    "name": "Italian",
    "search": "Cerca",
    "think": "Pensa",
    "medium": "Medio",
    "newChat": "Nuova chat",
    "expired": "La sessione è scaduta",
    "rateTitle": "Troppe richieste",
    "rateBody": "Fai richieste in modo troppo veloce. Abbiamo limitato temporaneamente l'accesso alle conversazioni per proteggere i tuoi dati.",
    "subscriptionFailure": "Impossibile caricare l'abbonamento: offline. Se l'errore persiste, visita help.openai.com e apri la bolla della chat per contattare l'assistenza.",
    "genericError": "Si è verificato un errore",
    "approval": "Consentire a ChatGPT di usare Fixture?"
  }
] as const) {
test.skipIf(!native)(`${locale.name} Think toggle and a semantic toggle do not require an English accessible name`,async()=>{
  for(const semantic of [false,true]){
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true" style="min-height:24px"></div>
      <button type="button" ${semantic?'data-testid="think-button"':''} aria-pressed="false">${semantic?'✦':locale.think}</button>
      <button type="button" aria-pressed="false">${locale.search}</button></form>
      <script>document.querySelector('button').onclick=event=>{const button=event.currentTarget;button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));};</script>`);
    const capabilities={models:[{id:'gpt-5.6-luna' as const,label:'GPT-5.6 Luna',family:null,efforts:[{id:'medium',label:locale.medium,index:null,available:true,reason:null,lunaThink:true}]}]};
    const selected=await selectModelAndEffort(page,'gpt-5.6-luna','medium',capabilities);
    await assertSelectedModelAndEffort(page,selected);
    expect(await page.locator('button').first().getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('button').last().getAttribute('aria-pressed')).toBe('false');
  }
});

test.skipIf(!native)(`${locale.name} New chat fallback reuses the same page`,async()=>{
  await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:`<html lang="${locale.code}"><meta charset="utf-8"><form><div id="prompt-textarea" contenteditable="true" style="min-height:24px"></div></form><a href="/?new-chat-fixture=1">${locale.newChat}</a></html>`}));
  try {
    const surface:SingleBrowserSurface={page:async()=>page,navigate:async url=>{await page.goto(url);return page;},reveal:async()=>{},beginAction:async()=>{},endAction:async()=>{},close:async()=>{}};
    await openNewChat(surface,null);
    await page.waitForURL('https://chatgpt.com/?new-chat-fixture=1');
    expect(page.url()).toBe('https://chatgpt.com/?new-chat-fixture=1');
    expect(context.pages()).toEqual([page]);
  }finally{await context.unroute('https://chatgpt.com/**');}
});

test.skipIf(!native)(`${locale.name} session and failure UI are recognized without scanning normal answer text`,async()=>{
  const cases=[
    ['authentication_required',`<div role="dialog">${locale.expired}</div>`],
    ['rate_limited',`<div role="dialog"><h2>${locale.rateTitle}</h2><p>${locale.rateBody}</p></div>`],
    ['failed',`<div role="alert">${locale.subscriptionFailure}</div>`],
    ['failed',`<div role="alert">${locale.genericError}. <a href="https://help.openai.com/">help.openai.com</a></div>`],
  ];
  for(const [code,html] of cases){
    await page.setContent('<meta charset="utf-8">'+html!);
    const failure=await throwIfSessionAttention(page).then(()=>undefined,error=>error);
    expect({html,code:failure?.code}).toMatchObject({code});
  }
  await page.setContent(`<article><div class="markdown">${locale.genericError}. help.openai.com</div></article>`);
  await throwIfSessionAttention(page);
  await page.setContent('<div role="alert"><a href="https://help.openai.com/">help.openai.com</a></div>');
  await throwIfSessionAttention(page);
  expect(await toolApprovalVisible(page)).toBeFalse();
  await page.setContent(`<div role="dialog">${locale.approval}</div>`);
  expect(await toolApprovalVisible(page)).toBeTrue();
},15_000);

}
