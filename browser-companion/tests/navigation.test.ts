import {afterEach,expect,setSystemTime,test} from "bun:test";
import type {BrowserContext,Page} from "patchright";
import {navigatePage} from "../src/navigation";

class NavigationPage {
  current="https://chatgpt.com/";
  loads:string[]=[];
  responseCode=200;
  retryAfter:string|null=null;
  constructor(readonly owner={} as BrowserContext){}
  context=()=>this.owner;
  url=()=>this.current;
  async goto(url:string){this.current=url;this.loads.push(url);return {status:()=>this.responseCode,headerValue:async()=>this.retryAfter};}
  reload=()=>this.goto(this.current);
  asPage=()=>this as unknown as Page;
}
afterEach(()=>setSystemTime());

test("same-page reuse makes no request; explicit recovery reloads once",async()=>{
  const page=new NavigationPage();
  await navigatePage(page.asPage(),page.current);expect(page.loads).toEqual([]);
  await navigatePage(page.asPage(),page.current,{reload:true});expect(page.loads).toEqual([page.current]);
});

test("different chats share spacing and cancellation never starts a waiting load",async()=>{
  const page=new NavigationPage();
  await navigatePage(page.asPage(),'https://chatgpt.com/c/first');
  await expect(navigatePage(page.asPage(),'https://chatgpt.com/c/second',{signal:AbortSignal.timeout(25)})).rejects.toThrow();
  expect(page.loads).toEqual(['https://chatgpt.com/c/first']);
  setSystemTime(Date.now()+3_001);
  await navigatePage(page.asPage(),'https://chatgpt.com/c/second');expect(page.loads).toHaveLength(2);
});

test("waiting recovery never reloads a different page opened by the user",async()=>{
  const page=new NavigationPage();await navigatePage(page.asPage(),'https://chatgpt.com/c/first');
  const recovery=navigatePage(page.asPage(),page.current,{reload:true});
  setTimeout(()=>{page.current='https://chatgpt.com/c/manual';},10);
  await expect(recovery).rejects.toMatchObject({code:'external_interference'});expect(page.loads).toHaveLength(1);
});

test("HTTP 429 applies one cooldown across chats and respects Retry-After",async()=>{
  const page=new NavigationPage();page.responseCode=429;page.retryAfter='120';
  await expect(navigatePage(page.asPage(),'https://chatgpt.com/c/first')).rejects.toMatchObject({code:'rate_limited'});
  page.responseCode=200;setSystemTime(Date.now()+119_000);
  await expect(navigatePage(page.asPage(),'https://chatgpt.com/c/another')).rejects.toMatchObject({code:'rate_limited'});
  expect(page.loads).toHaveLength(1);
  setSystemTime(Date.now()+1_001);await navigatePage(page.asPage(),'https://chatgpt.com/c/another');expect(page.loads).toHaveLength(2);
});

test("a missing Retry-After has a bounded three-minute cooldown",async()=>{
  const page=new NavigationPage();page.responseCode=429;
  await expect(navigatePage(page.asPage(),'https://chatgpt.com/c/first')).rejects.toMatchObject({code:'rate_limited'});
  page.responseCode=200;setSystemTime(Date.now()+180_001);await navigatePage(page.asPage(),'https://chatgpt.com/c/another');expect(page.loads).toHaveLength(2);
});

test("a billing-only rate limit does not block unrelated conversation loads",async()=>{
  const page=new NavigationPage();page.responseCode=429;
  await expect(navigatePage(page.asPage(),'https://chatgpt.com/settings/billing')).rejects.toMatchObject({code:'rate_limited'});
  page.responseCode=200;await navigatePage(page.asPage(),'https://chatgpt.com/c/first');expect(page.loads).toHaveLength(2);
});

test("Retry-After HTTP dates are honored and unrelated browser profiles are independent",async()=>{
  const page=new NavigationPage();page.responseCode=429;page.retryAfter=new Date(Date.now()+60_000).toUTCString();
  await expect(navigatePage(page.asPage(),'https://chatgpt.com/c/first')).rejects.toMatchObject({code:'rate_limited'});
  const independent=new NavigationPage();await navigatePage(independent.asPage(),'https://chatgpt.com/c/second');expect(independent.loads).toHaveLength(1);
  page.responseCode=200;setSystemTime(Date.now()+60_001);await navigatePage(page.asPage(),'https://chatgpt.com/c/second');expect(page.loads).toHaveLength(2);
});
