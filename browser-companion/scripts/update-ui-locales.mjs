// Extract only the UI messages needed by automation. Downloaded JavaScript is
// parsed as data with TypeScript; it is never imported or executed.
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const indexUrl=option('--index-url')??'https://chatgpt.com/cdn/assets/70025534-vzdih64izbkkpexj.js';
const cache=option('--source-dir');
const digest=text=>createHash('sha256').update(text).digest('hex');
async function source(url,local){
  if(cache)return readFile(resolve(cache,local),'utf8');
  const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error(`Locale download failed (${response.status}): ${url}`);
  return response.text();
}
function extract(path,source){
  const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  if(tree.parseDiagnostics.length)throw new Error(`Invalid locale module: ${path}`);
  const variables=new Map(),messages={};
  const literal=node=>node&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))?node.text:undefined;
  function visit(fn){const stack=[tree];while(stack.length){const node=stack.pop();fn(node);ts.forEachChild(node,child=>{stack.push(child);});}}
  visit(node=>{
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(node.left)&&literal(node.right)!==undefined)variables.set(node.left.text,literal(node.right));
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&literal(node.initializer)!==undefined)variables.set(node.name.text,literal(node.initializer));
  });
  visit(node=>{
    if(!ts.isPropertyAssignment(node))return;
    const key=literal(node.name),value=literal(node.initializer)??(ts.isIdentifier(node.initializer)?variables.get(node.initializer.text):undefined);
    if(key&&value!==undefined)messages[key]=value;
  });
  if(Object.keys(messages).length<1000)throw new Error(`Locale projection is incomplete: ${path}`);
  return messages;
}
const spec=JSON.parse(await readFile(resolve(root,'ui-locale-keys.json'),'utf8'));
const index=await source(indexUrl,'locale-index.js');
const modules=[...index.matchAll(/"\.\/locales\/([^"/]+)\.json":\(\)=>\w+\(\(\)=>import\(`\.\/([^`]+)`\)/g)].map(match=>({locale:match[1],asset:match[2]}));
if(modules.length<50)throw new Error('The public locale module index changed');
const messages=Object.fromEntries(Object.entries(spec).map(([key,value])=>[key,new Set(value.english)]));
const provenance=[];
for(let offset=0;offset<modules.length;offset+=6){
  const batch=await Promise.all(modules.slice(offset,offset+6).map(async({locale,asset})=>{
    const url=new URL(asset,indexUrl).href,text=await source(url,`${locale}.js`);
    return {locale,url,hash:digest(text),data:extract(locale,text)};
  }));
  for(const {locale,url,hash,data} of batch){
    provenance.push({locale,url,sha256:hash});
    for(const [key,definition] of Object.entries(spec))for(const id of definition.keys){
      const value=data[id];if(value?.trim())messages[key].add(value.normalize('NFKC').replace(/\p{Cf}/gu,'').replace(/\s+/g,' ').trim());
    }
  }
}
const output={sourceIndex:indexUrl,indexSha256:digest(index),sources:provenance.sort((a,b)=>a.locale.localeCompare(b.locale)),messages:Object.fromEntries(Object.entries(messages).map(([key,values])=>[key,[...values].sort()]))};
for(const key of ['effortMedium','effortHigh','counter','thinkControl','rateTitle','expiredTitle'])if(output.messages[key].length<25)throw new Error(`Missing locale coverage for ${key}`);
await writeFile(resolve(root,'ui-locales.json'),JSON.stringify(output,null,2)+'\n');
console.log(`Generated ${Object.keys(messages).length} UI message groups from ${modules.length} official locale modules.`);
