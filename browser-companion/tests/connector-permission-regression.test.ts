import {test,expect} from "bun:test";
import {chromium} from "patchright";
import {join} from "node:path";
import {readChatGptAccount} from "../src/account";
import {inspectConnectorSettings,setConnectorAllowAll,verifyConnectorAllowAll} from "../src/account-settings";
import {privateChromeExecutable} from "../src/chrome-executable";

test.skipIf(process.env.CODEXIFY_TEST_BROWSER_COMPANION_CHROME!=="1")(
  "already-granted permission is proved on the app page; collapsed choices cannot be forged by a label",
  async () => {
    const executablePath=await privateChromeExecutable(join(import.meta.dirname,"../.browsers",`${process.platform}-${process.arch}`));
    const browser=await chromium.launch({executablePath,headless:true});
    try {
      const page=await browser.newPage();
      const appId="asdk_app_fixture",name="Fixture connector";
      let mode:"allow_all"|"read_only"="allow_all";
      let permissionMetadata:string|null=null,selectedLabel="Allow all actions";
      let permissionVisits=0,permissionChanges=0,deleteRequests=0;

      await page.context().route("https://chatgpt.com/**",async route=>{
        const path=new URL(route.request().url()).pathname;
        if(path==="/api/auth/session")return route.fulfill({json:{
          user:{id:"fixture-user"},account:{id:"fixture-account",planType:"pro",structure:"personal"},
        }});
        if(path==="/set-permission"){
          permissionChanges++;mode="allow_all";permissionMetadata=null;selectedLabel="Allow all actions";
          return route.fulfill({json:{ok:true}});
        }
        if(path==="/delete"){deleteRequests++;return route.fulfill({json:{ok:true}});}
        if(path.endsWith("/permissions")){
          permissionVisits++;
          const options=["Ask every time","Read only","Low risk","Allow all actions"].map((label,index)=>
            '<div role="radio" aria-checked="'+String(index===(mode==="allow_all"?3:1))+'" tabindex="0">'+label+'</div>',
          ).join("");
          const html='<h2>Permissions</h2>'+
            '<button type="button" data-action="plugin-permissions">Choose permissions</button>'+
            '<section id="choices" hidden>'+options+'</section>'+
            '<script>'+
            'document.querySelector("[data-action=plugin-permissions]").onclick=()=>document.querySelector("#choices").hidden=false;'+
            'document.querySelectorAll("[role=radio]").forEach(node=>node.onclick=async()=>{'+
            'await fetch("/set-permission",{method:"POST"});'+
            'document.querySelectorAll("[role=radio]").forEach(item=>item.setAttribute("aria-checked",String(item===node)));'+
            '});</script>';
          return route.fulfill({contentType:"text/html; charset=utf-8",body:html});
        }
        if(path==="/settings/plugins-settings/plugin_"+appId){
          const meta=permissionMetadata===null?"":' data-permission="'+permissionMetadata+'"';
          const html='<h2>'+name+'</h2><section>'+
            '<div role="button" id="permission"'+meta+'>'+
            '<svg width="12" height="12"><path d="M1 1L9 9"/></svg>'+
            '<span>Permissions</span><span>Choose permissions</span><span>'+selectedLabel+'</span></div>'+
            '<div><button>Name</button><button>Description</button>'+
            '<button data-action="refresh-tools">Refresh tools</button>'+
            '<button style="color:rgb(255,0,0)" onclick="fetch(\'/delete\',{method:\'POST\'})">Delete</button></div>'+
            '</section>';
          return route.fulfill({contentType:"text/html; charset=utf-8",body:html});
        }
        return route.fulfill({contentType:"text/html; charset=utf-8",body:"<main>ChatGPT</main>"});
      });

      await page.goto("https://chatgpt.com/");
      const account=(await readChatGptAccount(page)).fingerprint;
      const granted=await inspectConnectorSettings(page,appId,name,account);
      expect(granted?.allowAll).toBe(true);
      expect(permissionVisits).toBe(0);

      // An explicit read-only marker defeats a misleading "Allow all" label.
      mode="read_only";permissionMetadata="read_only";selectedLabel="Allow all actions";
      const denied=await inspectConnectorSettings(page,appId,name,account);
      expect(denied?.allowAll).toBe(false);

      // An unknown label cannot silently become a permission proof.
      permissionMetadata=null;selectedLabel="Allow all actions is an available option";
      const ambiguous=await inspectConnectorSettings(page,appId,name,account);
      expect(ambiguous?.allowAll).toBe(false);

      // The collapsed picker must be opened explicitly, and the selected value
      // must still be verified after a new server-backed document navigation.
      const changed=await setConnectorAllowAll(page,appId,account);
      expect(changed).toBe(true);
      await verifyConnectorAllowAll(page,appId,account);
      expect(permissionChanges).toBe(1);
      expect(permissionVisits).toBe(2);
      const verified=await inspectConnectorSettings(page,appId,name,account);
      expect(verified?.allowAll).toBe(true);
      expect(deleteRequests).toBe(0);
      expect(page.context().pages()).toEqual([page]);
    } finally {
      await browser.close();
    }
  },
  60_000,
);
