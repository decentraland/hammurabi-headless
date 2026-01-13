import { declareComponentUsingProtobufJs } from './pb-based-component-helper'
import { PBRealmInfo } from '@dcl/protocol/out-js/decentraland/sdk/components/realm_info.gen'

export const realmInfoComponent = declareComponentUsingProtobufJs(PBRealmInfo, 1106, () => void 0)
