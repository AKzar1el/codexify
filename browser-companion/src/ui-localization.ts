import catalog from '../ui-locales.json';

type Message = keyof typeof catalog.messages;
export function normalizeUiLabel(value:string):string {
  return value.normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/\s+/g,' ').trim();
}
export function escapeUiPattern(value:string):string {return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
export function uiLabels(message:Message):readonly string[] {return catalog.messages[message];}
const labelPatterns=new Map<string,RegExp>();
export function uiLabelPattern(message:Message,exact=true):RegExp {
  const key=`${message}:${exact}`,cached=labelPatterns.get(key);
  if(cached)return cached;
  const choices=uiLabels(message).map(value=>escapeUiPattern(normalizeUiLabel(value)).replace(/ /g,'\\s+'));
  const pattern=new RegExp(`${exact?'^':''}(?:${choices.join('|')})${exact?'$':''}`,'iu');
  labelPatterns.set(key,pattern);return pattern;
}
export function matchesUiLabel(value:string,message:Message):boolean {return uiLabelPattern(message).test(normalizeUiLabel(value));}

const effortMessages={low:'effortInstant',medium:'effortMedium',high:'effortHigh',xhigh:'effortExtraHigh',max:'effortPro'} as const;
export function ambiguousEffortLabel(value:string):boolean {
  return Object.values(effortMessages).filter(message=>matchesUiLabel(value,message)).length>1;
}
export function localizedEffortId(value:string):string|undefined {
  const matches=Object.entries(effortMessages).filter(([,message])=>matchesUiLabel(value,message));
  // Conflicting labels across locales never establish an effort identity.
  return matches.length===1?matches[0]![0]:undefined;
}

const digits=new Map<string,string>();
// UI numbering can differ from the locale's current Intl default. Include every
// decimal numbering system supported by the bundled runtime, not just its default.
for(const numberingSystem of Intl.supportedValuesOf('numberingSystem')) {
  const formatter=new Intl.NumberFormat('en-US',{useGrouping:false,numberingSystem});
  for(let value=0;value<10;value++){
    const formatted=formatter.format(value).replace(/\p{Cf}/gu,'');
    if([...formatted].length===1)digits.set(formatted,String(value));
  }
}
function normalizedNumbers(value:string):string {return normalizeUiLabel(value).replace(/\p{Nd}/gu,digit=>digits.get(digit)??digit);}
function counterPattern(template:string):RegExp {
  const parts=normalizeUiLabel(template).replace(/[.。]$/u,'').split(/(\{(?:value|position|total)\})/);
  return new RegExp('^'+parts.map(part=>part==='{value}'?'(?<value>.+?)':part==='{position}'?'(?<position>\\d+)':part==='{total}'?'(?<total>\\d+)':escapeUiPattern(part).replace(/ /g,'\\s+')).join('')+'[.。]?$','u');
}
const counters=uiLabels('counter').filter(template=>['{value}','{position}','{total}'].every(key=>template.includes(key))).map(counterPattern);
export function parseEffortAnnouncement(value:string):{label:string;position:number;total:number}|undefined {
  const normalized=normalizedNumbers(value);
  for(const pattern of counters){
    const match=pattern.exec(normalized);
    if(match?.groups)return {label:match.groups.value!.trim(),position:Number(match.groups.position),total:Number(match.groups.total)};
  }
  return undefined;
}
const templatePatterns=new Map<Message,RegExp>();
export function uiTemplatePattern(message:Message):RegExp {
  const cached=templatePatterns.get(message);if(cached)return cached;
  const patterns=uiLabels(message).map(template=>normalizeUiLabel(template).split(/(\{[A-Za-z_]+\})/).map(part=>/^\{[A-Za-z_]+\}$/.test(part)?'[\\s\\S]*?':escapeUiPattern(part).replace(/ /g,'\\s+')).join(''));
  const pattern=new RegExp('(?:'+patterns.join('|')+')','iu');
  templatePatterns.set(message,pattern);return pattern;
}
