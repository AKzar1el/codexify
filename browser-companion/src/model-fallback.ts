import order from "../model-fallback-order.json";

export interface ModelSelection { model:string; effort:string }

/** Unknown models/efforts retain exact selection; their quality is not inferred. */
export function modelFallbacks(model:string,effort:string):readonly ModelSelection[] {
  const index=order.findIndex(option=>option.model===model&&option.effort===effort);
  return index<0?[]:order.slice(index+1);
}

export function modelSelectionAllowed(model:string|null,effort:string|null,actual:ModelSelection):boolean {
  return model!==null&&effort!==null&&((actual.model===model&&actual.effort===effort)
    ||modelFallbacks(model,effort).some(option=>option.model===actual.model&&option.effort===actual.effort));
}
