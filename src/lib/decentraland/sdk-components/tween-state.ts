import { PBTweenState } from "@dcl/protocol/out-js/decentraland/sdk/components/tween_state.gen";
import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";

/**
 * TweenState is written by the HOST and read by the scene — it is how a scene
 * learns that a tween finished (`@dcl/sdk`'s `tweenSystem.tweenCompleted`).
 * Nothing to apply to a BabylonEntity, so `applyChanges` is a no-op; the value
 * only has to reach the scene's CRDT (see `logic/tweens.ts`).
 */
export const tweenStateComponent = declareComponentUsingProtobufJs(PBTweenState, 1103, () => void 0)
