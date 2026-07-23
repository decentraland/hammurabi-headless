/**
 * This file contains the module bindings for the client VM of the SDK.
 */

import { EngineApiServiceDefinition, CrdtSendToRendererRequest } from '@dcl/protocol/out-js/decentraland/kernel/apis/engine_api.gen'
import { SendBinaryRequest } from '@dcl/protocol/out-js/decentraland/kernel/apis/communications_controller.gen'
import { TestingServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/testing.gen'
import { RpcClientPort } from '@dcl/rpc'
import * as codegen from '@dcl/rpc/dist/codegen'
import { coerceMaybeU8Array } from './marshal-utils'
import { RuntimeServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/runtime.gen'
import { UserIdentityServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/user_identity.gen'
import { UserActionModuleServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/user_action_module.gen'
import { RestrictedActionsServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/restricted_actions.gen'
import { CommunicationsControllerServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/communications_controller.gen'
import { CommsApiServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/comms_api.gen'
import { SignedFetchServiceDefinition } from '@dcl/protocol/out-js/decentraland/kernel/apis/signed_fetch.gen'

export function loadModuleForPort(port: RpcClientPort, moduleName: string) {
  switch (moduleName) {
    case '~system/EngineApi': {
      const originalService = codegen.loadService(port, EngineApiServiceDefinition)
      // Binary payloads normally cross the sandbox boundary as real Uint8Arrays
      // (structured copy). The coercion below is defense in depth for the
      // documented plain-object fallback: without it, protobuf encodes a
      // byte-keyed object as an EMPTY payload and the request silently no-ops.
      return {
        ...originalService,
        async isServer() {
          return { isServer: true }
        },
        async crdtSendToRenderer(payload: CrdtSendToRendererRequest) {
          return await originalService.crdtSendToRenderer({ data: coerceMaybeU8Array(payload.data) })
        }
      }
    }
    case '~system/Runtime':
      return codegen.loadService(port, RuntimeServiceDefinition)
    case '~system/CommunicationsController': {
      const commsService = codegen.loadService(port, CommunicationsControllerServiceDefinition)
      // Same defense-in-depth coercion as crdtSendToRenderer: a plain-object
      // payload would otherwise protobuf-encode as empty bytes and the message
      // would be published with no data.
      return {
        ...commsService,
        async sendBinary(payload: SendBinaryRequest) {
          return await commsService.sendBinary({
            data: (payload.data ?? []).map(coerceMaybeU8Array),
            peerData: (payload.peerData ?? []).map((peer) => ({
              address: peer.address ?? [],
              data: (peer.data ?? []).map(coerceMaybeU8Array)
            }))
          })
        }
      }
    }
    case '~system/UserIdentity':
      return codegen.loadService(port, UserIdentityServiceDefinition)
    case '~system/UserActionModule':
      return codegen.loadService(port, UserActionModuleServiceDefinition)
    case '~system/RestrictedActions':
      return codegen.loadService(port, RestrictedActionsServiceDefinition)
    case '~system/SignedFetch':
      return codegen.loadService(port, SignedFetchServiceDefinition)
    case '~system/CommsApi':
      return codegen.loadService(port, CommsApiServiceDefinition)
    case '~system/Testing':
      return codegen.loadService(port, TestingServiceDefinition)
    default:
      throw new Error('Unknown module ' + moduleName)
  }
}