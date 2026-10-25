import type {Locator} from "patchright";
import {BrowserCompanionError,browserStage} from "./errors";
import {readModelOptionRows} from "./models";
import {readChatGptEffortSnapshot,type ChatGptEffortActivation} from "./session";

type Rows=Awaited<ReturnType<typeof readModelOptionRows>>;

/** Inspect the owned model list, including lists mounted only after expansion. */
export async function withChatGptModelOptions<T>(
  menu:ChatGptEffortActivation,activate:()=>Promise<ChatGptEffortActivation>,
  inspect:(scope:Locator,rows:Rows)=>Promise<T>,
  options:{signal?:AbortSignal;visible?:boolean;changesModel?:boolean}={},
):Promise<{menu:ChatGptEffortActivation;value:T}> {
  return browserStage("model_options","ChatGPT did not expose its model options",async()=>{
    options.signal?.throwIfAborted();
    let scope=menu.menu,rows=await readModelOptionRows(scope),expanded=false;
    let original:Awaited<ReturnType<typeof readChatGptEffortSnapshot>>|undefined;
    const usable=async()=>rows.some(row=>row.family)&&(!options.visible
      || await scope.locator('[role="menuitemradio"][data-browser-model-family]').filter({visible:true}).count()===rows.filter(row=>row.family).length);
    try {
      if(!await usable()) {
        original=await readChatGptEffortSnapshot(menu.sliderContainer);
        const view=menu.menu.locator('[data-model-picker-view]');
        if(await view.count()>1)throw new BrowserCompanionError("ChatGPT exposed multiple model picker views","selector_drift");
        const toggle=menu.menu.locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])').filter({visible:true});
        const trigger=await toggle.count()?toggle:menu.menu.locator('[role="menuitem"][aria-expanded]:not([aria-hidden="true"])').filter({visible:true});
        if(await trigger.count()!==1)throw new BrowserCompanionError("ChatGPT model submenu control was missing or ambiguous","selector_drift");
        const submenuId=await trigger.getAttribute("aria-controls");
        const state=await trigger.getAttribute("aria-expanded");
        const simple=await view.count()===1&&await view.getAttribute("data-model-picker-view")==="simple";
        if(simple||state!=="true") {await trigger.click({timeout:5_000,signal:options.signal});expanded=true;}
        if(submenuId) {
          const owned=menu.menu.page().locator(`[id=${JSON.stringify(submenuId)}]`);
          await owned.waitFor({state:"visible",timeout:5_000,signal:options.signal});
          // aria-controls proves ownership even when Radix portals the submenu.
          scope=owned;
        }
        const deadline=Date.now()+5_000;
        do {
          options.signal?.throwIfAborted();
          rows=await readModelOptionRows(scope);
          if(await usable())break;
          await new Promise(resolve=>setTimeout(resolve,50));
        }while(Date.now()<deadline);
        if(!await usable())throw new BrowserCompanionError("ChatGPT model submenu did not expose supported model rows","selector_drift");
      }
      const value=await inspect(scope,rows);
      return {menu,value};
    } finally {
      if(expanded) {
        // Escape changes only the view. Never select a model just to inspect it.
        await menu.menu.page().keyboard.press("Escape");
        const restored=await activate();
        Object.assign(menu,restored);
        if(original&&!options.changesModel) {
          const state=await readChatGptEffortSnapshot(menu.sliderContainer);
          if(state.min!==original.min||state.max!==original.max||state.value!==original.value) {
            throw new BrowserCompanionError("ChatGPT changed the effort while inspecting model options","external_interference");
          }
        }
      }
    }
  });
}
