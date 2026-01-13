import { PBRealmInfo } from '@dcl/protocol/out-js/decentraland/sdk/components/realm_info.gen'
import { declareComponentUsingProtobufJs } from './pb-based-component-helper'

export const realmInfoComponent = declareComponentUsingProtobufJs(PBRealmInfo, 1106, () => void 0)
