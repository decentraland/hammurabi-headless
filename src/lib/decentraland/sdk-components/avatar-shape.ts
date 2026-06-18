import { PBAvatarShape } from "@dcl/protocol/out-js/decentraland/sdk/components/avatar_shape.gen";
import { declareComponentUsingProtobufJs } from "./pb-based-component-helper";

// Headless: the AvatarShape component is still declared so its data lives in the
// CRDT (game logic can read it), but there is no visual renderer to create.
export const avatarShapeComponent = declareComponentUsingProtobufJs(PBAvatarShape, 1080, () => {
  // no-op: nothing to render in headless
})
