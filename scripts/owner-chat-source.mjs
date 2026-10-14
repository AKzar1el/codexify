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
  .replace("/* GLOBAL_SETTINGS_SCRIPT */",readFileSync(new URL("../src/global_settings_ui.js",import.meta.url),"utf8"));
