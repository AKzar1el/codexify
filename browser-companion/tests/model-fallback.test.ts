import { expect, test } from "bun:test";
import { modelFallbacks, modelSelectionAllowed } from "../src/model-fallback";
import { SingleWindowCoordinator, type BrowserDriver } from "../src/browser-window";
import { protocolBuild, type ExecuteActionRequest } from "../src/protocol";

test("fallbacks follow the requested priority without upgrading or guessing unknown efforts",()=>{
  expect(modelFallbacks("gpt-6-astra","max").slice(0,3)).toEqual([
    {model:"gpt-5.6-sol",effort:"max"},{model:"gpt-6-sol",effort:"xhigh"},{model:"gpt-6-sol",effort:"high"},
  ]);
  expect(modelSelectionAllowed("gpt-5.6-sol","max",{model:"gpt-6-sol",effort:"xhigh"})).toBeTrue();
  expect(modelSelectionAllowed("gpt-6-sol","high",{model:"gpt-6-astra",effort:"max"})).toBeFalse();
  expect(modelSelectionAllowed("gpt-6-sol","high",{model:"future-model",effort:"deep"})).toBeFalse();
  expect(modelFallbacks("gpt-6-sol","effort-custom")).toEqual([]);
  expect(modelSelectionAllowed("future-model","deep",{model:"future-model",effort:"deep"})).toBeTrue();
  expect(modelSelectionAllowed(null,null,{model:"gpt-6-sol",effort:"high"})).toBeFalse();
});

test("the coordinator records a verified fallback while retaining the preferred request",async()=>{
  const build=protocolBuild("fallback-test");
  const request:ExecuteActionRequest={actionId:"fallback",idempotencyKey:"fallback-key",url:"https://chatgpt.com/c/fallback",expectedUrl:"https://chatgpt.com/c/fallback",pairingGeneration:1,connectorName:"Fixture",expectedAccountFingerprint:"account",model:"gpt-6-astra",effort:"max",prompt:{kind:"offline_goal",goalRevision:1},autoApproveToolCalls:false};
  const driver:BrowserDriver={
    health:async()=>({authenticated:true,accountFingerprint:"account",status:"idle",detail:null}),
    login:async()=>({authenticated:true,accountFingerprint:"account",status:"idle",detail:null}),
    capabilities:async()=>{throw Error("Unexpected discovery");},reveal:async()=>{},
    execute:async execution=>{
      execution.emit({type:"model_verified",model:"gpt-5.6-sol",effort:"max"});
      execution.emit({type:"connector_verified"});execution.emit({type:"send_accepted"});
      execution.emit({type:"submission_complete",canonicalUrl:request.expectedUrl});
    },
  };
  const coordinator=new SingleWindowCoordinator(driver,build);await coordinator.execute(request);
  const events=[];for await(const event of coordinator.events(request.actionId,0))events.push(event);
  expect(events.at(-1)?.type).toBe("submission_complete");
  expect((await coordinator.action(request.actionId))?.selected).toEqual({model:"gpt-5.6-sol",effort:"max"});
  expect(request.model).toBe("gpt-6-astra");expect(request.effort).toBe("max");await coordinator.close();
});
