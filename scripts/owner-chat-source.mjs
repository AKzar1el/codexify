import {readFileSync} from "node:fs";
import {chatHtml} from "./chat-widget-source.mjs";
const section = (text, opening, closing) => text.split(opening)[1].split(closing)[0];
const style = section(chatHtml, "<style>", "</style>")
  .replace(':root:not([data-theme="light"])', ':host(:not([data-theme="light"]))')
  .replace(':root[data-theme="dark"]', ':host([data-theme="dark"])')
  .replaceAll(":root", ":host")
  .replace("body {", ":host { display:block;");
const widgetBody = section(chatHtml, "<body>", "<script>");
const widgetScript = section(chatHtml, "<script>", "</script>");
export const ownerHtml = readFileSync(new URL("../src/owner_chat.html", import.meta.url), "utf8")
  .replace("<!-- CHAT_TEMPLATE -->", `<template id="chat-template"><style>${style}\n#chat { max-width:none; height:100%; border:0; border-radius:0; display:flex; flex-direction:column; } #panel { display:flex; flex:1; min-height:0; flex-direction:column; } #panel[hidden] { display:none; } #messages { flex:1; max-height:none; min-height:0; }\n</style>${widgetBody}</template>`)
  .replace("/* CHAT_SCRIPT */", widgetScript)
  .replace("/* USAGE_ANALYTICS_SCRIPT */",readFileSync(new URL("../src/analytics_ui.js",import.meta.url),"utf8"))
  .replace("/* STATISTICS_EXTRAS_SCRIPT */",readFileSync(new URL("../src/statistics_extras_ui.js",import.meta.url),"utf8"))
  .replace("/* OWNER_PWA_SCRIPT */",readFileSync(new URL("../src/owner_pwa_ui.js",import.meta.url),"utf8"))
  .replace("/* GLOBAL_SETTINGS_SCRIPT */",readFileSync(new URL("../src/global_settings_ui.js",import.meta.url),"utf8"));

// Match the owner's public install assets before conversation-specific API mocks.
const ownerAssets=new Map([
  ["/manifest.webmanifest", "application/manifest+json", "manifest.webmanifest"],
  ...[180,192,512].map(size=>[`/icons/app-${size}.png`, "image/png", `app-${size}.png`]),
].map(([path,contentType,file])=>[path,{contentType,body:readFileSync(new URL("../src/owner_chat/pwa/"+file,import.meta.url))}]));
export const ownerAssetResponse = path => ownerAssets.get(path);
export function routeOwner(page, pattern, handler, options) {
  return page.route(pattern,(route,request)=>{
    const asset=ownerAssetResponse(new URL(route.request().url()).pathname);
    return asset?route.fulfill(asset):handler(route,request);
  },options);
}
